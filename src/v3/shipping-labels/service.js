'use strict';
/**
 * HEALTHFARE V3 — ETIQUETAS DE ENVIO, o compositor (S15.37, Bruno 08-19).
 *
 * A META DO DIA: "começar a imprimir ainda hoje" do NOSSO sistema, não da tela
 * da Veeqo. O que este módulo faz, em uma frase: pega as etiquetas do dia na
 * Veeqo, carimba em cada uma o rodapé (produto · local · garrafas · envelope ·
 * quem separa/embala), agrupa por PRODUTO na ordem de caminhada do armazém, põe
 * uma folha divisória na frente de cada grupo, e devolve UM PDF só.
 *
 * POR QUE AGRUPAR POR PRODUTO E ORDENAR POR LOCAL
 * A Veeqo entrega as etiquetas na ordem em que os pedidos entraram, que é uma
 * ordem aleatória do ponto de vista de quem anda no armazém. Separar assim é ir e
 * voltar na mesma prateleira o dia inteiro. Agrupado por produto e ordenado por
 * área/prateleira/bin, a pilha de papel VIRA a rota: pega a pilha, anda uma vez
 * pelo corredor, acabou. A folha divisória existe pra essa pilha poder ser
 * cortada em montes sem ninguém ler etiqueta por etiqueta.
 *
 * DUAS COISAS QUE ESTE MÓDULO NÃO FAZ, DE PROPÓSITO
 *  1. NÃO escreve estoque. Nem uma linha. Quem mexe em quantidade é o
 *     StockService, porta única. Imprimir etiqueta não é dar baixa.
 *  2. NÃO carimba printed_at ao compor. Compor não é imprimir — o papel pode não
 *     sair (impressora sem papel, aba fechada). Só o /done da fila, que é alguém
 *     dizendo "saiu", carimba. Um sistema que marca como impresso o que ainda não
 *     saiu ensina o operador a não confiar no sistema.
 *
 * DEDUPLICAÇÃO
 * Sem `reprint`, shipment que já tem printed_at é PULADO. Duas etiquetas no mesmo
 * pacote é pacote perdido. Reimprimir continua possível, mas é uma decisão
 * explícita (reprint:true) com linha de auditoria — não um duplo-clique.
 */

const { PDFDocument } = require('pdf-lib');
const { loadTiers, pickEnvelope } = require('./envelope');
const { stampLabel, addDivider, loadFonts } = require('./footer');

/** Erro de negócio com código estável (o router traduz pra HTTP). */
class ShippingLabelsError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

/** Tarefas de P&P abertas = quem está separando/imprimindo agora. */
const PICKER_SLUGS = ['order_printing', 'order_printing_2', 'stock_organization'];

const nyToday = (tz) => new Date().toLocaleDateString('en-CA', { timeZone: tz || 'America/New_York' });

class ShippingLabelsService {
  constructor(deps = {}) {
    this.db = deps.db;
    this.veeqo = deps.veeqo;
    this.queue = deps.queue;
    this.tz = deps.tz || 'America/New_York';
  }

  /**
   * Quem está com tarefa de P&P ABERTA agora (evento sem ended_at). Esses são os
   * separadores; o rodapé mostra o ID do dashboard (v3.persons.id), que é o
   * "employee ID" que o Bruno pediu — não existe outra matrícula no sistema.
   *
   * Mais de uma pessoa junto = todos os IDs, separados por vírgula. Ninguém com
   * tarefa aberta = lista vazia, e o rodapé escreve '?'. Nunca chutamos.
   *
   * @returns {Promise<string[]>} ids como texto
   */
  async pickerIds() {
    try {
      const r = await this.db.query(
        `SELECT DISTINCT e.person_id
           FROM v3.events e
           JOIN v3.activity_types a ON a.id = e.activity_type_id
          WHERE e.ended_at IS NULL
            AND e.deleted_at IS NULL
            AND (a.slug = ANY($1::text[]) OR a.slug LIKE 'packaging%')
          ORDER BY e.person_id`, [PICKER_SLUGS]);
      return (r.rows || []).map((x) => String(x.person_id));
    } catch (e) {
      // sem picker o rodapé escreve '?' — nunca derruba a impressão
      console.error('[shipping-labels] pickers:', e.message);
      return [];
    }
  }

  /**
   * Resolve SKU → produto (nickname, cor, local). Uma query só pros SKUs do dia,
   * no MESMO padrão da picklist (data/router.js:1015): melhor bin = o de maior
   * quantidade; melhor caixa idem.
   *
   * @param {string[]} skus
   * @returns {Promise<Map<string, object>>} SKU maiúsculo → {product_id, nickname, ...}
   */
  async productsBySku(skus) {
    const out = new Map();
    const list = [...new Set((skus || []).filter(Boolean).map((s) => String(s).trim().toUpperCase()))];
    if (!list.length) return out;
    const r = await this.db.query(`
      WITH best_bin AS (
        SELECT DISTINCT ON (product_id) product_id, bin_code, shelf_code, area, qty
          FROM v3.stock_bins WHERE active AND product_id IS NOT NULL
         ORDER BY product_id, qty DESC),
      best_box AS (
        SELECT DISTINCT ON (product_id) product_id, box_number, area
          FROM v3.stock_boxes WHERE status='in_storage' AND product_id IS NOT NULL
         ORDER BY product_id, qty DESC)
      SELECT UPPER(ps.sku) AS sku, ps.product_id,
             COALESCE(ps.units_per_pack, 1) AS units_per_pack,
             COALESCE(p.nickname, p.canonical_name, ps.sku) AS nickname,
             p.bottle_color,
             bb.bin_code, bb.shelf_code, bb.area AS bin_area,
             bx.box_number AS pallet_box, bx.area AS pallet_area
        FROM v3.product_skus ps
        LEFT JOIN v3.products p ON p.id = ps.product_id
        LEFT JOIN best_bin bb ON bb.product_id = ps.product_id
        LEFT JOIN best_box bx ON bx.product_id = ps.product_id
       WHERE UPPER(ps.sku) = ANY($1::text[])`, [list]);
    for (const row of (r.rows || [])) out.set(row.sku, row);
    return out;
  }

  /** Quais shipments já foram IMPRESSOS (printed_at carimbado). */
  async printedShipments(ids) {
    const out = new Set();
    const list = (ids || []).map(String).filter(Boolean);
    if (!list.length) return out;
    const r = await this.db.query(
      `SELECT shipment_id FROM v3.shipping_label_prints
        WHERE source='veeqo' AND shipment_id = ANY($1::text[]) AND printed_at IS NOT NULL`,
      [list]);
    for (const row of (r.rows || [])) out.add(String(row.shipment_id));
    return out;
  }

  /**
   * O que dá pra imprimir num dia: pedidos enviados na Veeqo naquele dia que têm
   * shipment, já resolvidos (produto, local, garrafas, envelope) e marcados com
   * quem já foi impresso.
   *
   * Read-only puro: não grava nada, não enfileira nada. É o que a tela mostra
   * ANTES de alguém apertar o botão.
   *
   * @param {string} day YYYY-MM-DD (NY)
   */
  async preview(day) {
    const d = day || nyToday(this.tz);
    const orders = await this.veeqo.ordersShippedOn(d);

    // SKUs de todos os pedidos numa query só (nunca uma query por pedido)
    const skus = [];
    for (const o of orders) for (const li of (o.line_items || [])) {
      const s = (li.sellable && li.sellable.sku_code) || '';
      if (s) skus.push(s);
    }
    const bySku = await this.productsBySku(skus);
    const tiers = await loadTiers(this.db);

    const ready = [];
    for (const o of orders) {
      const shipment = this._firstShipment(o);
      if (!shipment) continue;    // sem etiqueta comprada não há o que imprimir

      const built = this._describeOrder(o, bySku, tiers);
      ready.push(Object.assign({
        order_number: o.number || String(o.id || ''),
        external_order_id: String(o.id || ''),
        shipment_id: String(shipment.id),
        tracking: shipment.tracking_number || null,
        carrier: (shipment.carrier && shipment.carrier.name) || null,
        service: shipment.service_name || null,
        channel: (o.channel && (o.channel.name || o.channel.type_code)) || null,
      }, built));
    }

    const printed = await this.printedShipments(ready.map((x) => x.shipment_id));
    for (const x of ready) x.printed_at = printed.has(x.shipment_id) ? true : null;

    // já impresso primeiro? não: a ordem da tela é a ordem de caminhada, igual à
    // do PDF, pra tela e papel contarem a mesma história.
    ready.sort(this._walkOrder);

    return {
      day: d,
      ready,
      counts: {
        ready: ready.length,
        printed: ready.filter((x) => x.printed_at).length,
        to_print: ready.filter((x) => !x.printed_at).length,
      },
    };
  }

  /** A primeira allocation com shipment (é onde vive o id da etiqueta). */
  _firstShipment(order) {
    for (const a of (order.allocations || [])) {
      if (a && a.shipment && a.shipment.id) return a.shipment;
    }
    return null;
  }

  /**
   * Produtos, garrafas e envelope de UM pedido.
   * SKU sem mapeamento vira nickname = o próprio SKU (REGRA #0: mostra o que tem,
   * nunca esconde a linha) e entra no grupo dele.
   */
  _describeOrder(order, bySku, tiers) {
    const products = [];
    const colors = [];
    let bottles = 0;
    for (const li of (order.line_items || [])) {
      const sku = ((li.sellable && li.sellable.sku_code) || '').trim();
      if (!sku) continue;
      const p = bySku.get(sku.toUpperCase()) || null;
      const qty = Number(li.quantity) || 0;
      const per = p ? (Number(p.units_per_pack) || 1) : 1;
      const b = qty * per;
      bottles += b;
      if (p && p.bottle_color) colors.push(p.bottle_color);
      products.push({
        product_id: p ? p.product_id : null,
        nickname: p ? p.nickname : sku,      // sem mapeamento: o SKU é o nome
        sku,
        bottles: b,
        bin_code: p ? (p.bin_code || null) : null,
        shelf_code: p ? (p.shelf_code || null) : null,
        area: p ? (p.bin_area || p.pallet_area || null) : null,
      });
    }
    return {
      products,
      bottles,
      envelope: pickEnvelope(tiers, bottles, colors),
      mixed: products.length > 1,
    };
  }

  /** Ordem de caminhada: área, prateleira, bin; sem local no fim. */
  _walkOrder(a, b) {
    const key = (x) => {
      const p = (x.products && x.products[0]) || {};
      return {
        has: !!(p.area || p.shelf_code || p.bin_code),
        s: [p.area || '', p.shelf_code || '', p.bin_code || ''].join('|'),
        n: (p.nickname || '').toString(),
      };
    };
    const ka = key(a); const kb = key(b);
    if (ka.has !== kb.has) return ka.has ? -1 : 1;   // sem local vai pro fim
    return ka.s.localeCompare(kb.s) || ka.n.localeCompare(kb.n)
      || String(a.order_number).localeCompare(String(b.order_number));
  }

  /**
   * Agrupa por PRODUTO (nickname do primeiro produto) e ordena os grupos por
   * local. Dentro do grupo, ordem de pedido — só pra ser estável entre duas
   * composições iguais.
   */
  groupByProduct(items) {
    const groups = new Map();
    for (const it of items) {
      const p = (it.products && it.products[0]) || {};
      const key = p.product_id != null ? 'p:' + p.product_id : 'sku:' + (p.sku || '?');
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          nickname: p.nickname || p.sku || '(sem nome)',
          location: p.bin_code || p.shelf_code || p.area || null,
          area: p.area || '', shelf_code: p.shelf_code || '', bin_code: p.bin_code || '',
          envelope: it.envelope || null,
          items: [],
        });
      }
      const g = groups.get(key);
      g.items.push(it);
      // envelope do grupo só quando TODOS concordam (senão fica em branco na
      // divisória: um número errado ali faria alguém pegar o envelope errado)
      if (g.envelope !== it.envelope) g.envelope = null;
    }
    const out = [...groups.values()];
    for (const g of out) {
      g.items.sort((a, b) => String(a.order_number).localeCompare(String(b.order_number)));
      g.count = g.items.length;
    }
    out.sort((a, b) => {
      const ha = !!(a.area || a.shelf_code || a.bin_code);
      const hb = !!(b.area || b.shelf_code || b.bin_code);
      if (ha !== hb) return ha ? -1 : 1;
      return [a.area, a.shelf_code, a.bin_code].join('|')
        .localeCompare([b.area, b.shelf_code, b.bin_code].join('|'))
        || a.nickname.localeCompare(b.nickname);
    });
    return out;
  }

  /**
   * COMPÕE o PDF do dia e enfileira o trabalho.
   *
   * @param {object} p
   *   day?          YYYY-MM-DD (default hoje NY)
   *   shipment_ids? só esses shipments (senão, o dia inteiro)
   *   reprint?      inclui o que já foi impresso
   *   take?         já toma o job pra quem pediu (a estação imprime na hora)
   *   packer_id?    id da pessoa da sessão do kiosk (null no admin)
   *   requested_by  nome de quem pediu
   *   is_test?      sessão sandbox
   * @returns {Promise<{job, file_id, counts}>}
   */
  async compose(p = {}) {
    const day = p.day || nyToday(this.tz);
    const pre = await this.preview(day);

    let items = pre.ready;
    if (Array.isArray(p.shipment_ids) && p.shipment_ids.length) {
      const want = new Set(p.shipment_ids.map(String));
      items = items.filter((x) => want.has(x.shipment_id));
    }
    if (!p.reprint) items = items.filter((x) => !x.printed_at);

    if (!items.length) {
      throw new ShippingLabelsError('nothing_to_print',
        p.reprint ? 'Nenhuma etiqueta encontrada para esse dia.'
          : 'Nada novo pra imprimir: todas as etiquetas do dia já saíram.', 409);
    }

    const pickers = await this.pickerIds();
    const groups = this.groupByProduct(items);

    // ── monta o PDF ────────────────────────────────────────────────────────
    const out = await PDFDocument.create();
    const fonts = await loadFonts(out);
    const failed = [];
    let labels = 0;

    for (const g of groups) {
      addDivider(out, {
        nickname: g.nickname, count: g.count, location: g.location, envelope: g.envelope,
      }, fonts);
      for (const it of g.items) {
        let bytes;
        try {
          bytes = await this.veeqo.getLabelPdf(it.shipment_id);
        } catch (e) {
          // Uma etiqueta que a Veeqo não entrega NÃO pode matar as outras 40. Ela
          // fica de fora, é registrada, e some da contagem — quem imprimiu vê o
          // número menor e vai atrás. Melhor 40 impressas + 1 avisada do que 0.
          failed.push({ shipment_id: it.shipment_id, order_number: it.order_number, reason: e.message });
          console.error('[shipping-labels] etiqueta ' + it.shipment_id + ':', e.message);
          continue;
        }
        const first = (it.products && it.products[0]) || {};
        await stampLabel(out, bytes, {
          nicknames: (it.products || []).map((x) => x.nickname),
          sku: first.sku,
          bin_code: first.bin_code,
          shelf_code: first.shelf_code,
          bottles: it.bottles,
          envelope: it.envelope,
          picker_ids: pickers,
          packer_id: p.packer_id || null,
        }, fonts);
        it._stamped = true;
        labels += 1;
      }
    }

    if (!labels) {
      throw new ShippingLabelsError('nothing_to_print',
        'Nenhuma etiqueta pôde ser baixada da Veeqo.', 409);
    }

    const pdf = Buffer.from(await out.save());
    const pages = out.getPageCount();
    const printedItems = items.filter((x) => x._stamped);

    // ── grava arquivo + fila + histórico ───────────────────────────────────
    const fileRow = await this.db.query(
      `INSERT INTO v3.print_files (mime, bytes, pages) VALUES ('application/pdf', $1, $2) RETURNING id`,
      [pdf, pages]);
    const fileId = fileRow.rows[0].id;

    const job = await this.queue.enqueue({
      kind: 'shipping_labels',
      requested_by: p.requested_by || null,
      requested_login_id: p.requested_login_id || null,
      is_test: !!p.is_test,
      payload: {
        day,
        count: labels,
        pages,
        file_id: fileId,
        shipment_ids: printedItems.map((x) => x.shipment_id),
        groups: groups.filter((g) => g.items.some((i) => i._stamped)).map((g) => ({
          nickname: g.nickname,
          count: g.items.filter((i) => i._stamped).length,
          location: g.location,
        })),
        failed: failed.length ? failed : undefined,
      },
    });

    await this.db.query(`UPDATE v3.print_files SET job_id = $1 WHERE id = $2`, [job.id, fileId]);

    // histórico por etiqueta. printed_at fica NULL: compor não é imprimir.
    for (const it of printedItems) {
      const prods = it.products || [];
      await this.db.query(
        `INSERT INTO v3.shipping_label_prints
           (source, external_order_id, shipment_id, order_number, channel,
            product_ids, nicknames, bottles, envelope, picker_ids, packer_id, job_id, is_test)
         VALUES ('veeqo',$1,$2,$3,$4,$5::int[],$6::text[],$7,$8,$9::text[],$10,$11,$12)
         ON CONFLICT (source, shipment_id) DO UPDATE
           SET job_id = EXCLUDED.job_id, composed_at = NOW(),
               picker_ids = EXCLUDED.picker_ids, packer_id = EXCLUDED.packer_id,
               envelope = EXCLUDED.envelope, bottles = EXCLUDED.bottles`,
        [it.external_order_id, it.shipment_id, it.order_number, it.channel,
          prods.map((x) => x.product_id).filter((x) => x != null),
          prods.map((x) => x.nickname),
          it.bottles, it.envelope, pickers, p.packer_id || null, job.id, !!p.is_test]);
    }

    let finalJob = job;
    if (p.take) finalJob = await this.queue.take(job.id, p.requested_by || null);

    return {
      job: finalJob,
      file_id: fileId,
      counts: { labels, pages, groups: groups.length, failed: failed.length },
    };
  }

  /**
   * O papel SAIU (o /done da fila chamou aqui). Carimba printed_at nas etiquetas
   * do job e printed_at nas linhas de pedido correspondentes.
   *
   * NÃO mexe em pnp_order_lines.status de propósito: a Veeqo já marcou o pedido
   * como 'shipped' quando a etiqueta foi COMPRADA, então as nossas linhas já
   * nascem 'shipped'. Rebaixar pra 'printed' seria andar pra trás na vida do
   * pedido e confundir todo relatório que conta enviados.
   *
   * @returns {Promise<{labels:number, lines:number}>}
   */
  async markPrinted(job) {
    if (!job || job.kind !== 'shipping_labels') return { labels: 0, lines: 0 };
    const ids = (job.payload && Array.isArray(job.payload.shipment_ids))
      ? job.payload.shipment_ids.map(String).filter(Boolean) : [];
    if (!ids.length) return { labels: 0, lines: 0 };

    let labels = 0; let lines = 0;
    try {
      const r = await this.db.query(
        `UPDATE v3.shipping_label_prints SET printed_at = NOW()
          WHERE source='veeqo' AND shipment_id = ANY($1::text[]) AND printed_at IS NULL
          RETURNING external_order_id`, [ids]);
      labels = (r.rows || []).length;

      const orderIds = [...new Set((r.rows || []).map((x) => x.external_order_id).filter(Boolean))];
      if (orderIds.length) {
        const l = await this.db.query(
          `UPDATE v3.pnp_order_lines SET printed_at = NOW()
            WHERE source='veeqo' AND external_order_id = ANY($1::text[])
              AND printed_at IS NULL
              AND status NOT IN ('cancelled')
            RETURNING id`, [orderIds]);
        lines = (l.rows || []).length;
      }
    } catch (e) {
      // o papel já saiu fisicamente; falhar o carimbo não desfaz isso
      console.error('[shipping-labels] carimbo printed_at:', e.message);
    }
    return { labels, lines };
  }

  /** Bytes do PDF de um job (o navegador abre isso numa aba). */
  async fileForJob(jobId) {
    const r = await this.db.query(
      `SELECT id, mime, bytes, pages FROM v3.print_files
        WHERE job_id = $1 ORDER BY id DESC LIMIT 1`, [Number(jobId)]);
    return r.rows[0] || null;
  }
}

module.exports = { ShippingLabelsService, ShippingLabelsError, PICKER_SLUGS };
