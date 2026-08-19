'use strict';
/**
 * HEALTHFARE V3 — Warehouse MOBILE (S15.35, Bruno 08-19).
 *
 * "dá pra usar o sistema de inventário todo e impressão todo do iPhone."
 *
 * Quatro rotas montadas pelo warehouse/router com o MESMO `route()` (mesma auth,
 * mesmo RBAC, mesmo envelope). Nada aqui é uma regra nova de negócio: é recorte.
 *
 *  GET  mobile/bootstrap      abre o app numa chamada só (hoje seriam três, e a
 *                             primeira é a mais gorda do sistema)
 *  GET  mobile/scan/resolve   ler o código com a câmera do iPhone, com PIN de admin
 *  POST mobile/print/submit   "imprime esta etiqueta" no bolso, papel no armazém
 *  GET  mobile/printers       estado das impressoras de bolso (só leitura)
 *
 * POR QUE UM ENDPOINT PRÓPRIO E NÃO `?fields=`
 * O corte é diferente em três recursos ao mesmo tempo (produtos, propostas,
 * locais). Três query strings escondendo isso seria mais difícil de ler do que um
 * contrato explícito. A Row COMPLETA continua vindo do `/product/:id` quando o
 * dedo abre o produto — o celular só evita baixar 40 Rows completas no 4G.
 *
 * ESCRITA DE ESTOQUE: NENHUMA. bootstrap/scan/printers leem; print/submit escreve
 * só a fila de impressão. Toda mudança de quantidade do celular continua passando
 * pelas rotas que já existem → StockService.
 */

const { createOpWarehouse } = require('./op-warehouse');

/** Teto de propostas no bootstrap: acima disso é a tela de Aprovar, não a home. */
const REQUESTS_CAP = 50;
/** Teto de etiquetas por pedido de impressão (papel de verdade, não vale a pena). */
const LABELS_CAP = 60;

const intOf = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

const idsOf = (v) => {
  if (Array.isArray(v)) return v.map(intOf).filter((x) => x);
  return String(v || '').split(',').map((x) => intOf(x)).filter((x) => x);
};

/**
 * A linha de produto que o CELULAR precisa. Tudo que ele mostra numa lista de
 * dedo: nome, os quatro números que decidem, o status e se a Veeqo concorda.
 * Fora: skus[], bins[], boxes[], movimentos — isso é a ficha, não a lista.
 */
function projectProduct(r) {
  return {
    product_id: r.product_id,
    name: r.name,
    nickname: r.nickname || r.name,
    base_sku: r.base_sku || null,
    total: r.total,
    shelf_qty: r.shelf_qty,
    box_qty: r.box_qty,
    unplaced_qty: r.unplaced_qty,
    reserved: r.reserved,
    available: r.available,
    days_of_stock: r.days_of_stock == null ? null : r.days_of_stock,
    status: Array.isArray(r.status) ? r.status : [],
    veeqo_match: r.veeqo_match || 'unknown',
  };
}

/** Seletor de local: só o que preenche uma lista de escolha no telefone. */
function projectBin(b) {
  return { id: b.id, bin_code: b.bin_code, shelf_code: b.shelf_code || null,
    area: b.area || null, product_id: b.product_id == null ? null : b.product_id,
    qty: b.qty == null ? 0 : Number(b.qty),
    capacity: b.capacity == null ? null : Number(b.capacity) };
}

function projectBox(x) {
  return { id: x.id, box_number: x.box_number, area: x.area || null,
    product_id: x.product_id == null ? null : x.product_id,
    qty: x.qty == null ? 0 : Number(x.qty),
    batch_number: x.batch_number || null, sealed: !!x.sealed };
}

/**
 * Monta as peças do celular.
 *
 * @param {object} deps {db, stock, requests, locations, queue, rowsWithVeeqo,
 *                       kpisFrom, attentionFrom, pendingSummary, labelsFor}
 *   As quatro últimas são as funções que o warehouse/router JÁ tem: reusar em vez
 *   de reimplementar é o que garante que o celular e o dashboard nunca mostrem
 *   números diferentes do mesmo fato.
 */
function createMobile(deps = {}) {
  const db = deps.db;
  const requests = deps.requests;
  const locations = deps.locations;
  const queue = deps.queue || null;
  const rowsWithVeeqo = deps.rowsWithVeeqo;
  const kpisFrom = deps.kpisFrom;
  const attentionFrom = deps.attentionFrom;
  const pendingSummary = deps.pendingSummary;
  const labelsFor = deps.labelsFor;
  // op-warehouse resolve TUDO (bin → caixa → UPC → SKU). Chamar direto = se a
  // ordem de resolução mudar, muda pros dois de uma vez. Zero lógica duplicada.
  const opw = deps.opWarehouse || createOpWarehouse({ db });

  /**
   * GET mobile/bootstrap?full=1
   * Sem `full`, `products[]` traz só quem tem status não vazio: a home do celular
   * é "o que precisa de mim", não um catálogo.
   */
  async function bootstrap(req) {
    const full = String((req.query && req.query.full) || '') === '1';
    const [rows, pending] = await Promise.all([rowsWithVeeqo(null), pendingSummary()]);
    const kpis = Object.assign(kpisFrom(rows), { pending_requests: pending.count });

    const interesting = (r) => Array.isArray(r.status)
      && r.status.some((s) => s && s !== 'ok');
    const products = (full ? rows : rows.filter(interesting)).map(projectProduct);

    // as propostas pendentes (a ação #1 do celular: Bruno aprova andando)
    let pendingRows = [];
    try {
      pendingRows = await requests.list({ status: 'pending' });
    } catch (e) {
      console.error('[mobile] propostas:', e.message);
    }
    if (pendingRows.length > REQUESTS_CAP) pendingRows = pendingRows.slice(0, REQUESTS_CAP);

    // locais: seletor de Organizar/Mover. Degrada pra vazio, nunca derruba a home.
    let locs = { bins: [], boxes: [] };
    try {
      const raw = await locations.list();
      locs = { bins: (raw.bins || []).map(projectBin),
        boxes: (raw.boxes || []).map(projectBox) };
    } catch (e) {
      console.error('[mobile] locais:', e.message);
    }

    // a fila de impressão em um número. Sem a tabela ainda (migration 073 não
    // aplicada) isso vira 0 e a tela Imprimir avisa; a home continua abrindo.
    let queued = 0;
    if (queue) {
      try { queued = await queue.queuedCount(); }
      catch (e) { console.error('[mobile] fila:', e.message); }
    }

    const login = req.login || {};
    return {
      kpis,
      attention: attentionFrom(rows),
      pending_summary: pending,
      products,
      products_full: full,
      products_total: rows.length,
      requests: pendingRows,
      locations: locs,
      queue: { queued },
      me: { name: login.name || 'admin', role: login.role || null,
        functions: Array.isArray(login.functions) ? login.functions : [] },
      generated_at: new Date().toISOString(),
    };
  }

  /** GET mobile/scan/resolve?barcode= — o mesmo resolve do operador, com PIN. */
  async function scanResolve(req) {
    const raw = String((req.query && req.query.barcode) || '').trim();
    if (!raw) throw new Error('barcode obrigatório');
    const hit = await opw.resolveBarcode(raw.slice(0, 200));
    return Object.assign({ raw }, hit);
  }

  /**
   * POST mobile/print/submit {kind, bins?, boxes?, note?}
   *
   * As etiquetas são resolvidas AGORA, com a mesma função do GET /labels, e vão
   * congeladas no payload. Se a caixa mudar de quantidade entre o pedido e o
   * papel, sai o que o admin viu quando apertou. Etiqueta é foto de um momento.
   *
   * picklist não tem etiqueta: o payload é a data, e quem desenha é a estação.
   */
  async function printSubmit(req) {
    if (!queue) throw new Error('fila de impressão indisponível');
    const b = req.body || {};
    const kind = String(b.kind || '').trim();
    if (!['bin_labels', 'box_label', 'picklist'].includes(kind)) {
      throw new Error('kind inválido (bin_labels, box_label ou picklist)');
    }
    const note = b.note ? String(b.note).trim().slice(0, 300) : null;
    const login = req.login || {};

    let payload;
    let labels = [];
    if (kind === 'picklist') {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))
        ? String(b.date)
        : new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      payload = { date, note };
    } else {
      const binIds = idsOf(b.bins);
      const boxIds = idsOf(b.boxes);
      if (!binIds.length && !boxIds.length) {
        throw new Error('lista inválida: escolha pelo menos uma prateleira ou caixa');
      }
      if (binIds.length + boxIds.length > LABELS_CAP) {
        throw new Error(`lista inválida: máximo de ${LABELS_CAP} etiquetas por vez`);
      }
      labels = await labelsFor(binIds, boxIds);
      // "não existe" no texto é o que statusFor lê pra devolver 404 em vez de 500
      if (!labels.length) {
        throw new Error('nenhuma etiqueta encontrada: essa prateleira ou caixa não existe');
      }
      payload = { labels, note };
    }

    const job = await queue.enqueue({
      kind, payload,
      requested_by: login.name || 'admin',
      requested_login_id: login.id || null,
      target: b.target ? String(b.target).slice(0, 40) : 'any',
      is_test: false,
    });
    return { job_id: job.id, queued: labels.length || 1, labels, job };
  }

  /**
   * GET mobile/printers — recorte de bolso do /api/v3/data/printers.
   * Lê as MESMAS tabelas (printer_status + print_jobs), sem tocar no data router
   * (arquivo grande demais pra crescer). Read-only, sempre.
   */
  async function printers() {
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const rows = (await db.query(
      `SELECT printer, status_label, error_label, updated_at
         FROM v3.printer_status ORDER BY printer`)).rows;
    let jobsByPrinter = {};
    try {
      const jr = await db.query(
        `SELECT printer, COUNT(*)::int AS jobs
           FROM v3.print_jobs
          WHERE (created_at AT TIME ZONE 'America/New_York')::date = $1::date
          GROUP BY printer`, [day]);
      for (const r of jr.rows) jobsByPrinter[r.printer] = Number(r.jobs) || 0;
    } catch (e) {
      console.error('[mobile] jobs de hoje:', e.message);
      jobsByPrinter = {};
    }
    return {
      printers: rows.map((r) => ({
        name: r.printer,
        status_label: r.status_label || null,
        error_label: r.error_label && r.error_label !== 'none' ? r.error_label : null,
        jobs_today: jobsByPrinter[r.printer] || 0,
        updated_at: r.updated_at || null,
      })),
      date: day,
    };
  }

  return { bootstrap, scanResolve, printSubmit, printers,
    projectProduct, projectBin, projectBox };
}

module.exports = { createMobile, projectProduct, projectBin, projectBox,
  REQUESTS_CAP, LABELS_CAP };
