'use strict';
/**
 * HEALTHFARE V3 — Warehouse hub — FAMÍLIA de SKUs por produto (Bruno 08-18/08-19).
 *
 * A REGRA DO BRUNO (dita mais de uma vez; memória 'sku-parent-single-unit'):
 * casepack (-C2/-C3/-C4, "x3 kit", "Beet Root 2000mg - C4") é SKU DIFERENTE na
 * Veeqo e nos marketplaces, mas FISICAMENTE não existe. Toda garrafa fica solta
 * no mesmo lugar da unidade avulsa e o operador junta o pacote só na hora de
 * embalar. Então o estoque conta UNIDADES sob o SKU PAI: uma linha por produto
 * físico, e o LOCAL pertence ao pai.
 *
 * A Veeqo manda na identificação (não dá pra renomear SKU nos marketplaces; a
 * gente se adapta a ela), e TODO SKU da Veeqo importa — é a ponte com ela.
 *
 * O modelo (V1 verificado na API da Veeqo, estudo S15 §10.4):
 *   • O estoque FÍSICO da família mora no SKU BASE — a garrafa (ProductVariant),
 *     units_per_pack = 1.
 *   • Os casepacks são KITS do Veeqo: o Veeqo deriva a disponibilidade deles do
 *     base e, ao enviar um kit, decrementa o base pelas unidades.
 *   • Logo: pacotes disponíveis por membro = floor(garrafas disponíveis ÷ units).
 *   • E NUNCA somar base + kit: é a MESMA garrafa contada duas vezes (memória
 *     'merge-safety-rules', estudo §10.4).
 *
 * O QUE MUDOU EM 08-19 (migration 077): o merge agora LIMPA. Antes ele só movia
 * os SKUs e deixava o produto esvaziado como fantasma no hub (print do Bruno:
 * 'AKKERM-INULIN' duas vezes, 'Apple Cider Vinegar' só com "x4 kit", 'Banaba
 * Leaf 3000mg' sem SKU, 190+ linhas). Agora ele:
 *   1) move os SKUs pro pai,
 *   2) move o ESTOQUE do fantasma pro pai, pelo StockService (nunca SQL de
 *      quantidade aqui — porta única), idempotente por source_ref,
 *   3) marca o fantasma como absorvido (merged_into_product_id) pra TODO caminho
 *      de leitura filtrar num lugar só,
 * e tudo isso é REVERSÍVEL pelo unmerge.
 */

// Merge em cadeia (A→B, depois B→C) tem que terminar em C, nunca ficar apontando
// pro meio. 10 saltos é folga absurda pra um armazém; o teto só existe pra um
// ciclo malformado no banco não virar loop infinito.
const MAX_MERGE_DEPTH = 10;

class FamilyRepo {
  /**
   * @param {object} deps deps.db (pool pg), deps.veeqoCache (createVeeqoCache),
   *                      deps.stock (StockService — ÚNICO escritor de quantidade)
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this.veeqoCache = deps.veeqoCache || null;
    this.stock = deps.stock || null;
  }

  async _veeqoBySku() {
    if (!this.veeqoCache) return {};
    try { return await this.veeqoCache.bySku(); } catch (_) { return {}; }
  }

  /**
   * Raiz da cadeia de merge: se o produto pedido já foi absorvido, o pai de
   * verdade é quem o absorveu (e assim por diante). Sem isso um merge em cima de
   * um fantasma criaria uma corrente que nenhuma leitura resolve.
   */
  async _rootOf(productId) {
    let id = Number(productId);
    for (let i = 0; i < MAX_MERGE_DEPTH; i += 1) {
      const r = await this.db.query(
        'SELECT id, merged_into_product_id FROM v3.products WHERE id = $1', [id]);
      const row = r.rows[0];
      if (!row) throw new Error('produto não existe: ' + id);
      if (row.merged_into_product_id == null) return id;
      id = Number(row.merged_into_product_id);
    }
    throw new Error('merge inválido: cadeia de merges longa demais no produto ' + productId);
  }

  /**
   * Família do produto: base + membros com tipo Veeqo, disponível do Veeqo e
   * pacotes derivados.
   * @param {number} productId
   * @param {number|null} availableBottles disponível NOSSO (pra derived_packs)
   */
  async forProduct(productId, availableBottles = null) {
    const id = Number(productId);
    const rows = (await this.db.query(`
      SELECT id, product_id, sku, channel, units_per_pack, barcode, is_base, confirmed_at
        FROM v3.product_skus WHERE product_id = $1
       ORDER BY units_per_pack, channel, sku`, [id])).rows;
    const vq = await this._veeqoBySku();
    // mesma ordem de escolha da base que o StockService._buildRow usa: marcado
    // por humano > avulsa da Veeqo > menor pacote que existir.
    const veeqoRows = rows.filter((s) => s.channel === 'veeqo');
    const baseRow = rows.find((s) => s.is_base)
      || veeqoRows.find((s) => Number(s.units_per_pack) === 1)
      || veeqoRows.slice().sort((a, b) => Number(a.units_per_pack) - Number(b.units_per_pack))[0]
      || null;
    const members = rows.map((s) => {
      const v = vq[String(s.sku).trim().toUpperCase()] || null;
      const units = Number(s.units_per_pack) || 1;
      const avail = availableBottles == null ? null : Number(availableBottles);
      return {
        id: s.id, sku: s.sku, channel: s.channel, units_per_pack: units,
        barcode: s.barcode || null,
        is_base: !!s.is_base,
        confirmed: !!s.confirmed_at,
        role: baseRow && s.id === baseRow.id ? 'base' : 'member',
        veeqo_type: v ? v.type : null,
        veeqo_available: v && v.wh ? v.wh.available : null,
        derived_packs: avail == null ? null : Math.max(0, Math.floor(avail / units)),
      };
    });
    // produtos que foram absorvidos por este: o hub mostra "3 absorvidos" e o
    // unmerge precisa da lista pra oferecer o desfazer.
    const absorbed = (await this.db.query(`
      SELECT id, canonical_name, nickname, merged_at
        FROM v3.products WHERE merged_into_product_id = $1 ORDER BY id`, [id])).rows;
    return {
      base: baseRow ? { sku: baseRow.sku, channel: baseRow.channel,
        units_per_pack: Number(baseRow.units_per_pack) || 1 } : null,
      members,
      children: members.filter((m) => m.role !== 'base'),
      sku_count: members.length,
      absorbed: absorbed.map((a) => ({ product_id: a.id, name: a.canonical_name,
        nickname: a.nickname || a.canonical_name, merged_at: a.merged_at })),
    };
  }

  /**
   * Anexa (ou corrige) um SKU de canal a este produto. Confirma na hora — quem
   * mexeu no hub sabe o que está fazendo e o rastro fica no audit do router.
   * p: {product_id, sku, channel, units_per_pack?, is_base?, person_id?}
   */
  async attach(p = {}) {
    const sku = String(p.sku || '').trim();
    if (!sku) throw new Error('sku obrigatório');
    if (!p.product_id) throw new Error('product_id obrigatório');
    const channel = String(p.channel || 'veeqo').trim();
    const units = Number(p.units_per_pack) > 0 ? Number(p.units_per_pack) : 1;
    const productId = Number(p.product_id);
    // marcar base: só UMA por produto (índice único parcial do 077), então a
    // anterior sai antes — senão o INSERT estoura e o operador leva um 500.
    if (p.is_base) {
      await this.db.query(
        'UPDATE v3.product_skus SET is_base = false WHERE product_id = $1 AND is_base', [productId]);
    }
    const r = await this.db.query(`
      INSERT INTO v3.product_skus (product_id, sku, channel, units_per_pack, is_base, confirmed_by_person_id, confirmed_at)
      VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (channel, sku) DO UPDATE
        SET product_id = EXCLUDED.product_id,
            units_per_pack = EXCLUDED.units_per_pack,
            is_base = EXCLUDED.is_base,
            confirmed_by_person_id = EXCLUDED.confirmed_by_person_id,
            confirmed_at = NOW()
      RETURNING *`,
    [productId, sku, channel, units, !!p.is_base, p.person_id || null]);
    return r.rows[0];
  }

  /** Desvincula um SKU (remove o mapeamento; não mexe em estoque). */
  async detach(skuId) {
    const r = await this.db.query(
      'DELETE FROM v3.product_skus WHERE id = $1 RETURNING *', [Number(skuId)]);
    if (!r.rows[0]) throw new Error('SKU não existe: ' + skuId);
    return r.rows[0];
  }

  /**
   * MERGE que LIMPA (Bruno 08-19). Duas linhas do hub que são a MESMA garrafa
   * viram uma só:
   *
   *   1) os SKUs do fantasma passam pro pai (mapeamento);
   *   2) o ESTOQUE do fantasma passa pro pai — bins, caixas, "a organizar" e as
   *      Separadas — SEMPRE pelo StockService.moveProduct (par de movimentos com
   *      source 'sku_merge' + audit; nunca SQL de quantidade daqui);
   *   3) o fantasma é RETIRADO (merged_into_product_id), não apagado: movimentos,
   *      batches e pedidos antigos continuam apontando pra ele sem virar órfãos,
   *      e toda leitura filtra num lugar só.
   *
   * Idempotente: reenviar o mesmo merge não move estoque duas vezes (source_ref
   * 'sku_merge:<from>:<into>') e não erra se o fantasma já estiver retirado.
   *
   * @param {object} p {from_product_id, into_product_id, person_id?, client?}
   * @returns {{parent, moved_skus, moved_qty, retired_product_id, stock, duplicate}}
   */
  async merge(p = {}) {
    const fromRaw = Number(p.from_product_id); const intoRaw = Number(p.into_product_id);
    if (!fromRaw || !intoRaw) throw new Error('from_product_id e into_product_id obrigatórios');
    if (fromRaw === intoRaw) throw new Error('merge: produtos iguais');
    // o destino pode já ter sido absorvido por outro: o pai de verdade é a raiz
    const into = await this._rootOf(intoRaw);
    const from = fromRaw;
    if (from === into) throw new Error('merge: produtos iguais');

    const parentRow = (await this.db.query(
      'SELECT id, canonical_name, nickname FROM v3.products WHERE id = $1', [into])).rows[0];
    if (!parentRow) throw new Error('produto não existe: ' + into);
    const ghostRow = (await this.db.query(
      'SELECT id, canonical_name, nickname, merged_into_product_id FROM v3.products WHERE id = $1',
      [from])).rows[0];
    if (!ghostRow) throw new Error('produto não existe: ' + from);

    // 2) ESTOQUE primeiro: se mover o estoque falhar, os SKUs ainda não saíram do
    // lugar e o hub continua mostrando a verdade. O contrário deixaria garrafa
    // órfã numa linha sem SKU.
    let stockOut = { moved_qty: 0, bins: 0, boxes: 0, unplaced: 0, duplicate: true };
    if (this.stock && typeof this.stock.moveProduct === 'function') {
      stockOut = await this.stock.moveProduct({
        from_product_id: from, to_product_id: into,
        person_id: p.person_id || null, actor_type: 'admin',
        source: 'sku_merge', source_ref: `sku_merge:${from}:${into}`,
        note: `merge de SKU: ${ghostRow.canonical_name} vira ${parentRow.canonical_name}`,
      });
    }

    // 1) SKUs
    const moved = (await this.db.query(
      'UPDATE v3.product_skus SET product_id = $2 WHERE product_id = $1 RETURNING *',
      [from, into])).rows;

    // 3) retira o fantasma (idempotente: se já estava retirado, WHERE não pega)
    const retired = (await this.db.query(`
      UPDATE v3.products
         SET merged_into_product_id = $2, merged_at = NOW(), merged_by_person_id = $3
       WHERE id = $1 AND merged_into_product_id IS NULL
       RETURNING id`, [from, into, p.person_id || null])).rows[0] || null;

    // merge em cima de um fantasma: quem apontava pro fantasma passa a apontar
    // pro novo pai, senão a cadeia fica com 2 saltos e alguma leitura vai errar.
    await this.db.query(
      'UPDATE v3.products SET merged_into_product_id = $2 WHERE merged_into_product_id = $1',
      [from, into]);

    return {
      parent: { product_id: into, name: parentRow.canonical_name,
        nickname: parentRow.nickname || parentRow.canonical_name },
      moved_skus: moved.map((s) => ({ id: s.id, sku: s.sku, channel: s.channel,
        units_per_pack: Number(s.units_per_pack) || 1 })),
      moved_qty: Number(stockOut.moved_qty) || 0,
      retired_product_id: from,
      already_retired: !retired,
      stock: { bins: stockOut.bins, boxes: stockOut.boxes, unplaced: stockOut.unplaced,
        duplicate: !!stockOut.duplicate },
      // compat com quem já lia o formato antigo {moved, skus}
      moved: moved.length, skus: moved,
    };
  }

  /**
   * UNMERGE: desfaz um merge. Limpa merged_into_product_id (o produto volta a
   * aparecer no hub) e devolve os SKUs que tinham ido pro pai.
   *
   * Quais SKUs voltam: os que o merge levou, que é o que está no audit_log da
   * operação. Sem esse rastro a gente não adivinha — devolver "os que parecem
   * dele" seria chutar, e merge errado é desastre de expedição. Nesse caso o
   * produto volta VAZIO e o humano reanexa o que for dele.
   *
   * O ESTOQUE não volta sozinho: as garrafas estão fisicamente no lugar do pai
   * agora. Quem quiser separar de novo faz uma movimentação normal, com o
   * operador na frente da prateleira. `moved_qty_back` é sempre 0 e vai
   * explícito no retorno pra ninguém achar que voltou.
   *
   * @param {object} p {product_id, person_id?}
   */
  async unmerge(p = {}) {
    const id = Number(p.product_id);
    if (!id) throw new Error('product_id obrigatório');
    const cur = (await this.db.query(
      'SELECT id, canonical_name, nickname, merged_into_product_id FROM v3.products WHERE id = $1',
      [id])).rows[0];
    if (!cur) throw new Error('produto não existe: ' + id);
    if (cur.merged_into_product_id == null) {
      throw new Error('produto não está absorvido: ' + id);
    }
    const parentId = Number(cur.merged_into_product_id);

    // SKUs que ESTE merge levou, do rastro da própria operação
    let skuIds = [];
    try {
      const a = await this.db.query(`
        SELECT after_data FROM v3.audit_log
         WHERE action = 'warehouse.family_merge' AND target_id = $1
         ORDER BY id DESC LIMIT 20`, [parentId]);
      for (const row of (a.rows || [])) {
        const d = typeof row.after_data === 'string' ? JSON.parse(row.after_data) : row.after_data;
        if (d && Number(d.from_product_id) === id && Array.isArray(d.sku_ids)) {
          skuIds = d.sku_ids.map(Number).filter(Boolean);
          break;
        }
      }
    } catch (_) { skuIds = []; }

    let back = [];
    if (skuIds.length) {
      back = (await this.db.query(
        `UPDATE v3.product_skus SET product_id = $2
          WHERE id = ANY($1::int[]) AND product_id = $3 RETURNING *`,
        [skuIds, id, parentId])).rows;
    }

    const restored = (await this.db.query(`
      UPDATE v3.products
         SET merged_into_product_id = NULL, merged_at = NULL, merged_by_person_id = NULL
       WHERE id = $1
       RETURNING id, canonical_name, nickname`, [id])).rows[0];

    return {
      product: { product_id: restored.id, name: restored.canonical_name,
        nickname: restored.nickname || restored.canonical_name },
      was_merged_into: parentId,
      returned_skus: back.map((s) => ({ id: s.id, sku: s.sku, channel: s.channel,
        units_per_pack: Number(s.units_per_pack) || 1 })),
      moved_qty_back: 0,   // estoque físico fica com o pai; separar é operação de armazém
    };
  }
}

module.exports = { FamilyRepo, MAX_MERGE_DEPTH };
