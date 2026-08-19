'use strict';
/**
 * QA harness do BACKEND do admin mobile (S15.29 / S15.34 / S15.35).
 * Rodar da RAIZ do projeto:  node docs/architecture/_qa/qa-mobile-backend.js
 *
 * Diferente dos harnesses de página (qa-op-estoque, qa-dashboard), este NÃO abre
 * navegador: ele sobe os ROUTERS DE VERDADE (warehouse + print-queue) num express
 * efêmero contra um banco em memória com o formato do Postgres, e percorre a
 * jornada inteira que o celular faz num dia:
 *
 *   1. abrir o app  → GET mobile/bootstrap
 *   2. ler um código → GET mobile/scan/resolve
 *   3. mandar imprimir a etiqueta da caixa → POST mobile/print/submit
 *   4. a estação .28 puxa → GET print-queue → take → done  (e o carimbo cai)
 *   5. conferir que o número do celular = o número do dashboard
 *
 * É o teste de CONTRATO que os agentes do front stubam nas fixtures. Se este
 * harness passar, a página do celular tem exatamente esses payloads pra consumir.
 *
 * Nunca fala com banco de produção nem com rede. PINs e tokens FICTÍCIOS.
 */
const express = require('express');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const { createWarehouseRouter } = require(path.join(ROOT, 'src/v3/warehouse/router'));
const { createPrintQueueRouter } = require(path.join(ROOT, 'src/v3/print-queue/router'));
const { PrintQueueService } = require(path.join(ROOT, 'src/v3/print-queue/service'));

const results = [];
const rec = (group, name, pass, detail) => {
  results.push({ group, name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  console.log((pass ? 'PASS ' : 'FAIL ') + '[' + group + '] ' + name + (detail ? '  ·  ' + detail : ''));
};
const eq = (group, name, got, want) => {
  const a = JSON.stringify(got); const b = JSON.stringify(want);
  rec(group, name, a === b, a === b ? '' : 'esperado ' + b + ', veio ' + a);
};

// ── credenciais fictícias ────────────────────────────────────────
const ADMIN_PIN = '111111';
const VIEWER_PIN = '222222';
const PAGE_TOKEN = 'qa-page-token';
const PRINT_TOKEN = 'qa-print-token';
const KIOSK_SESSION = 'qa-kiosk-session';
process.env.OPERATOR_PAGE_TOKEN = PAGE_TOKEN;
process.env.PRINT_EVENT_TOKEN = PRINT_TOKEN;

// ── estado do "banco" ────────────────────────────────────────────
const state = {
  now: Date.now(),
  audit: [],
  jobs: [],
  boxesStamped: [],
  bins: [
    { id: 1, bin_code: 'A03B2', shelf_code: 'S4', area: 'Corredor A', product_id: 42,
      qty: 4, min_qty: 10, capacity: 48, active: true, product: 'Benfotiamine 300' },
    { id: 2, bin_code: 'A04A1', shelf_code: 'S4', area: 'Corredor A', product_id: 99,
      qty: 50, min_qty: 10, capacity: 48, active: true, product: 'Rutin 500' },
  ],
  boxes: [
    { id: 8, box_number: 'BX-0451', area: 'MEZ', product_id: 42, qty: 110,
      status: 'in_storage', batch_number: 'L-2026-08', sealed: true, product: 'Benfotiamine 300' },
  ],
  pending: [{ age_min: 12 }, { age_min: 260 }],
  printers: [
    { printer: 'EPSON C6000', status_label: 'Ready', error_label: 'none', updated_at: '2026-08-19T14:00:00Z' },
    { printer: 'Zebra ZD621', status_label: 'Paused', error_label: 'media out', updated_at: '2026-08-19T13:10:00Z' },
  ],
  printJobs: [{ printer: 'EPSON C6000', jobs: 37 }],
};

const LOGINS = {
  [ADMIN_PIN]: { id: 1, name: 'Bruno', role: 'admin', rank: 100, functions: ['view_stock', 'manage_stock'] },
  [VIEWER_PIN]: { id: 2, name: 'Visitante', role: 'viewer', rank: 20, functions: ['view_stock'] },
};

let jobSeq = 0;
const db = {
  async query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    if (/FROM v3\.app_logins l/.test(q)) {
      const l = LOGINS[params[0]];
      return { rows: l ? [l] : [] };
    }
    if (/FROM v3\.operator_sessions s/.test(q)) {
      return { rows: params[0] === KIOSK_SESSION
        ? [{ session_id: 3, person_id: 7, display_name: 'Simone', is_sandbox: false }] : [] };
    }
    if (q.startsWith('INSERT INTO v3.audit_log')) {
      // dois formatos: o hub manda (person, action, ...) e a fila manda (action, id, ...)
      state.audit.push(/actor_person_id, action/.test(q) && /VALUES \('admin', NULL/.test(q)
        ? params[0] : params[1]);
      return { rows: [] };
    }
    if (/COUNT\(\*\)::int AS count/.test(q) && /stock_change_requests/.test(q)) {
      return { rows: [{ count: state.pending.length,
        oldest_age_min: Math.max(...state.pending.map((p) => p.age_min)) }] };
    }
    if (/FROM v3\.stock_bins b/.test(q) && /ANY\(\$1::int\[\]\)/.test(q)) {
      return { rows: state.bins.filter((b) => params[0].includes(b.id)) };
    }
    if (/FROM v3\.stock_boxes x/.test(q) && /ANY\(\$1::int\[\]\)/.test(q)) {
      return { rows: state.boxes.filter((x) => params[0].includes(x.id)) };
    }
    if (/FROM v3\.stock_bins b/.test(q)) return { rows: state.bins };
    if (/FROM v3\.stock_boxes x/.test(q)) return { rows: state.boxes };
    if (/FROM v3\.product_skus/.test(q)) return { rows: [] };
    if (/FROM v3\.printer_status/.test(q)) return { rows: state.printers };
    if (/FROM v3\.print_jobs/.test(q)) return { rows: state.printJobs };

    // ── v3.print_queue ──
    if (q.startsWith('INSERT INTO v3.print_queue')) {
      jobSeq += 1;
      const job = { id: jobSeq, kind: params[0], payload: JSON.parse(params[1]),
        requested_by: params[2], requested_login_id: params[3], target: params[4],
        is_test: params[5], status: 'queued', taken_by: null, taken_at: null,
        done_at: null, error_note: null, created_at: new Date(state.now), age_min: 0 };
      state.jobs.push(job); return { rows: [job] };
    }
    if (/FROM v3\.print_queue WHERE id/.test(q)) {
      const j = state.jobs.find((x) => x.id === params[0]);
      return { rows: j ? [j] : [] };
    }
    if (/COUNT\(\*\)::int AS n FROM v3\.print_queue/.test(q)) {
      return { rows: [{ n: state.jobs.filter((j) => j.status === 'queued' && !j.is_test).length }] };
    }
    if (/FROM v3\.print_queue/.test(q) && q.startsWith('SELECT')) {
      const wantStatus = /status = \$1/.test(q) ? params[0] : null;
      const noTest = /is_test = false/.test(q);
      let rows = state.jobs.filter((j) => (!wantStatus || j.status === wantStatus) && (!noTest || !j.is_test));
      rows = /created_at ASC/.test(q) ? rows.slice().sort((a, b) => a.id - b.id)
        : rows.slice().sort((a, b) => b.id - a.id);
      return { rows: rows.slice(0, params[params.length - 1]) };
    }
    if (q.startsWith("UPDATE v3.print_queue SET status = 'taken'")) {
      const j = state.jobs.find((x) => x.id === params[0]);
      if (!j) return { rows: [] };
      const staleMin = j.taken_at ? (state.now - j.taken_at) / 60000 : 0;
      if (!(j.status === 'queued' || (j.status === 'taken' && staleMin > 10))) return { rows: [] };
      j.status = 'taken'; j.taken_by = params[1]; j.taken_at = state.now; return { rows: [j] };
    }
    if (q.startsWith("UPDATE v3.print_queue SET status = 'done'")) {
      const j = state.jobs.find((x) => x.id === params[0]);
      if (!j || !['queued', 'taken'].includes(j.status)) return { rows: [] };
      j.status = 'done'; j.done_at = state.now;
      j.taken_by = j.taken_by || params[1]; return { rows: [j] };
    }
    if (q.startsWith("UPDATE v3.print_queue SET status = 'error'")) {
      const j = state.jobs.find((x) => x.id === params[0]);
      if (!j || !['queued', 'taken'].includes(j.status)) return { rows: [] };
      j.status = 'error'; j.error_note = params[2]; return { rows: [j] };
    }
    if (q.startsWith("UPDATE v3.print_queue SET status = 'cancelled'")) {
      const j = state.jobs.find((x) => x.id === params[0]);
      if (!j || !['queued', 'taken'].includes(j.status)) return { rows: [] };
      j.status = 'cancelled'; return { rows: [j] };
    }
    if (q.startsWith('UPDATE v3.stock_boxes SET label_printed_at')) {
      state.boxesStamped.push(...params[0]);
      return { rows: params[0].map((id) => ({ id })) };
    }
    return { rows: [] };
  },
};

// ── services falsos (o que já é testado em outro lugar) ──────────
const ROWS = [
  { product_id: 42, name: 'Benfotiamine 300 mg', nickname: 'Benfotiamine 300', base_sku: 'HF-BENF-300',
    skus: [], shelf_qty: 4, box_qty: 110, unplaced_qty: 24, total: 138, reserved: 12,
    pending_out: 0, pending_in: 0, available: 126, separated: 0, min_units: 20,
    days_of_stock: 8.4, sold_7d: 105, sold_30d: 400, veeqo: null, veeqo_match: 'unknown',
    status: ['low', 'organizar'],
    bins: [{ id: 1, bin_code: 'A03B2', shelf_code: 'S4', area: 'Corredor A', qty: 4, min_qty: 10, needs_restock: true }],
    boxes: [{ id: 8, box_number: 'BX-0451', area: 'MEZ', qty: 110 }] },
  { product_id: 99, name: 'Rutin 500 mg', nickname: 'Rutin 500', base_sku: 'HF-RUT-500',
    skus: [], shelf_qty: 50, box_qty: 0, unplaced_qty: 0, total: 50, reserved: 4,
    pending_out: 0, pending_in: 0, available: 46, separated: 0, min_units: 10,
    days_of_stock: 45.2, sold_7d: 7, sold_30d: 30, veeqo: null, veeqo_match: 'unknown',
    status: ['ok'],
    bins: [{ id: 2, bin_code: 'A04A1', shelf_code: 'S4', area: 'Corredor A', qty: 50, min_qty: 10, needs_restock: false }],
    boxes: [] },
];

const stockWrites = [];
const stock = {
  overview: async (o) => (o && o.product_id
    ? ROWS.filter((r) => r.product_id === o.product_id).map((r) => JSON.parse(JSON.stringify(r)))
    : ROWS.map((r) => JSON.parse(JSON.stringify(r)))),
  productDetail: async () => null,
  storeIn: async (p) => { stockWrites.push(p); return { applied: p.qty }; },
  place: async (p) => { stockWrites.push(p); return { applied: p.qty }; },
  move: async (p) => { stockWrites.push(p); return { applied: p.qty }; },
  adjust: async (p) => { stockWrites.push(p); return { applied: p.qty }; },
  separate: async (p) => { stockWrites.push(p); return { applied: p.qty }; },
  pick: async (p) => { stockWrites.push(p); return { applied: p.qty }; },
  count: async (p) => { stockWrites.push(p); return { applied: p.qty }; },
  resolveIssue: async (p) => { stockWrites.push(p); return { issue: { id: 1, product_id: 42 } }; },
};

const REQUESTS = [
  { id: 501, kind: 'count', direction: 'in', qty: 18, product: 'Benfotiamine 300', product_id: 42,
    proposed_by: 'Simone', age_min: 260, bin_code: 'A03B2', box_number: null, status: 'pending' },
  { id: 502, kind: 'entrada', direction: 'in', qty: 110, product: 'Rutin 500', product_id: 99,
    proposed_by: 'Vitor', age_min: 12, bin_code: null, box_number: 'BX-0452', status: 'pending' },
];
const requests = {
  list: async (o) => REQUESTS.filter((r) => !o.status || r.status === o.status),
  propose: async () => ({}), approve: async () => ({}), reject: async () => ({}),
  pendingByProduct: async () => ({}),
};

const opWarehouse = {
  resolveBarcode: async (raw) => {
    if (raw === 'A03B2') return { kind: 'bin', bin: state.bins[0] };
    if (raw === 'BX-0451') return { kind: 'box', box: state.boxes[0] };
    if (raw === '012345678905') return { kind: 'product', product: { product_id: 42, name: 'Benfotiamine 300 mg' } };
    return { kind: 'unknown', raw };
  },
};

const veeqoCache = {
  bySku: async () => ({}),
  warm: async () => {},
  checkedAt: () => new Date().toISOString(),
};

// ── sobe o servidor com os routers DE VERDADE ────────────────────
let base;
async function boot() {
  const app = express();
  const queue = new PrintQueueService({ db });
  app.use('/', createPrintQueueRouter({ db, queue }));
  app.use('/', createWarehouseRouter({ db, stock, requests, veeqoCache, printQueue: queue, opWarehouse }));
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  base = 'http://127.0.0.1:' + server.address().port;
  return server;
}

async function call(method, urlPath, body, headers = {}) {
  const r = await fetch(base + urlPath, {
    method, headers: Object.assign({ 'content-type': 'application/json' }, headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  return { status: r.status, body: j };
}

const M = '/api/v3/warehouse/mobile';
const asAdmin = { 'x-admin-pin': ADMIN_PIN };
const asViewer = { 'x-admin-pin': VIEWER_PIN };
const asStation = { 'x-print-token': PRINT_TOKEN };
const asKiosk = { authorization: 'Bearer ' + PAGE_TOKEN, 'x-session-token': KIOSK_SESSION };

async function main() {
  const server = await boot();
  try {
    // ── 1. abrir o app no celular ──────────────────────────────
    const noPin = await call('GET', M + '/bootstrap');
    rec('1 · abrir', 'sem PIN o app não abre (401)', noPin.status === 401, noPin.status);

    const boot1 = await call('GET', M + '/bootstrap', undefined, asAdmin);
    rec('1 · abrir', 'bootstrap responde 200', boot1.status === 200, boot1.status);
    const d = boot1.body.data;
    eq('1 · abrir', 'me = quem está com o celular na mão',
      d.me, { name: 'Bruno', role: 'admin', functions: ['view_stock', 'manage_stock'] });
    rec('1 · abrir', 'a fila pendente vem no topo, com a idade da mais velha',
      d.pending_summary.count === 2 && d.pending_summary.oldest_age_min === 260,
      JSON.stringify(d.pending_summary));
    rec('1 · abrir', 'as 2 propostas vêm junto, sem segunda chamada',
      d.requests.length === 2 && d.requests[0].id === 501, d.requests.length);
    rec('1 · abrir', 'sem full=1 só vem o produto que precisa de atenção',
      d.products.length === 1 && d.products[0].product_id === 42,
      d.products.map((p) => p.nickname).join(', '));
    rec('1 · abrir', 'e o app sabe que existem mais produtos', d.products_total === 2, d.products_total);
    rec('1 · abrir', 'o produto vem enxuto: 13 campos, sem bins/boxes/skus',
      Object.keys(d.products[0]).length === 13 && !d.products[0].bins && !d.products[0].skus,
      Object.keys(d.products[0]).length + ' campos');
    rec('1 · abrir', 'atenção em PT-BR e sem em dash',
      d.attention.length > 0 && d.attention.every((a) => !/—/.test(a.text)),
      d.attention.length + ' avisos');
    rec('1 · abrir', 'locais no formato de seletor',
      d.locations.bins.length === 2 && d.locations.boxes.length === 1
      && d.locations.bins[0].bin_code === 'A03B2', JSON.stringify(d.locations.bins[0]));
    rec('1 · abrir', 'a fila de impressão começa vazia', d.queue.queued === 0, d.queue.queued);

    const full = await call('GET', M + '/bootstrap?full=1', undefined, asAdmin);
    rec('1 · abrir', 'full=1 traz o catálogo inteiro',
      full.body.data.products.length === 2 && full.body.data.products_full === true,
      full.body.data.products.length);

    // ── 2. os números do celular = os do dashboard ─────────────
    const web = await call('GET', '/api/v3/warehouse/overview', undefined, asAdmin);
    eq('2 · uma verdade só', 'KPIs iguais aos do dashboard', full.body.data.kpis, web.body.data.kpis);
    eq('2 · uma verdade só', 'lista de atenção idêntica', full.body.data.attention, web.body.data.attention);
    eq('2 · uma verdade só', 'resumo da fila idêntico',
      full.body.data.pending_summary, web.body.data.pending_summary);
    rec('2 · uma verdade só', 'o total do produto é o mesmo nos dois',
      full.body.data.products[0].total === web.body.data.products[0].total,
      full.body.data.products[0].total + ' vs ' + web.body.data.products[0].total);

    // ── 3. ler um código com a câmera ──────────────────────────
    const bin = await call('GET', M + '/scan/resolve?barcode=A03B2', undefined, asAdmin);
    rec('3 · ler código', 'prateleira resolve pra bin',
      bin.body.data.kind === 'bin' && bin.body.data.bin.bin_code === 'A03B2', bin.body.data.kind);
    const box = await call('GET', M + '/scan/resolve?barcode=BX-0451', undefined, asAdmin);
    rec('3 · ler código', 'caixa resolve pra box', box.body.data.kind === 'box', box.body.data.kind);
    const upc = await call('GET', M + '/scan/resolve?barcode=012345678905', undefined, asAdmin);
    rec('3 · ler código', 'UPC da garrafa cai no produto',
      upc.body.data.kind === 'product' && upc.body.data.product.product_id === 42, upc.body.data.kind);
    const nada = await call('GET', M + '/scan/resolve?barcode=NAO-EXISTE-999', undefined, asAdmin);
    rec('3 · ler código', 'código desconhecido volta unknown com o texto lido, nunca erro',
      nada.status === 200 && nada.body.data.kind === 'unknown' && nada.body.data.raw === 'NAO-EXISTE-999',
      nada.status + ' ' + nada.body.data.kind);

    // ── 4. mandar imprimir do bolso ────────────────────────────
    const viewerTry = await call('POST', M + '/print/submit', { kind: 'box_label', boxes: [8] }, asViewer);
    rec('4 · imprimir', 'quem só olha não manda imprimir (403)', viewerTry.status === 403, viewerTry.status);

    const sub = await call('POST', M + '/print/submit',
      { kind: 'box_label', boxes: [8], note: 'selar antes de subir' }, asAdmin);
    rec('4 · imprimir', 'submit responde 200 com job_id', sub.status === 200 && sub.body.data.job_id === 1,
      JSON.stringify(sub.body.data && sub.body.data.job_id));
    eq('4 · imprimir', 'a etiqueta sai resolvida, pronta pra prévia na tela',
      sub.body.data.labels, [{ kind: 'box', id: 8, code: 'BX-0451', line2: 'Benfotiamine 300',
        line3: '110 garrafas · lote L-2026-08', url: '/scan/?x=BX-0451' }]);
    const web2 = await call('GET', '/api/v3/warehouse/labels?boxes=8', undefined, asAdmin);
    eq('4 · imprimir', 'a etiqueta do celular é IGUAL à do dashboard',
      sub.body.data.labels, web2.body.data.labels);

    const ghost = await call('POST', M + '/print/submit', { kind: 'box_label', boxes: [4242] }, asAdmin);
    rec('4 · imprimir', 'caixa que não existe → 404 e nada entra na fila',
      ghost.status === 404 && state.jobs.length === 1, ghost.status + ' / ' + state.jobs.length + ' job(s)');

    const boot2 = await call('GET', M + '/bootstrap', undefined, asAdmin);
    rec('4 · imprimir', 'a fila enfileirada aparece no bootstrap seguinte',
      boot2.body.data.queue.queued === 1, boot2.body.data.queue.queued);

    // ── 5. a estação .28 puxa ──────────────────────────────────
    const semToken = await call('GET', '/api/v3/print-queue');
    rec('5 · estação', 'sem credencial a fila não abre (401)', semToken.status === 401, semToken.status);

    const fila = await call('GET', '/api/v3/print-queue', undefined, asStation);
    rec('5 · estação', 'a estação vê o trabalho esperando',
      fila.body.data.jobs.length === 1 && fila.body.data.jobs[0].status === 'queued',
      fila.body.data.jobs.length + ' na fila');
    rec('5 · estação', 'o payload chega com a etiqueta congelada',
      fila.body.data.jobs[0].payload.labels[0].code === 'BX-0451',
      fila.body.data.jobs[0].payload.labels[0].code);

    const take = await call('POST', '/api/v3/print-queue/1/take', { by: 'printmon .28' }, asStation);
    rec('5 · estação', 'toma o trabalho', take.body.data.job.status === 'taken', take.body.data.job.status);
    const take2 = await call('POST', '/api/v3/print-queue/1/take', {}, asStation);
    rec('5 · estação', 'ninguém toma duas vezes (409 not_queued)',
      take2.status === 409 && take2.body.error.code === 'not_queued', take2.status);

    const done = await call('POST', '/api/v3/print-queue/1/done', { by: 'printmon .28' }, asStation);
    rec('5 · estação', 'conclui o trabalho', done.body.data.job.status === 'done', done.body.data.job.status);
    eq('5 · estação', 'o carimbo label_printed_at cai na caixa impressa', state.boxesStamped, [8]);

    const vazia = await call('GET', '/api/v3/print-queue', undefined, asStation);
    rec('5 · estação', 'a fila esvazia depois de impresso', vazia.body.data.jobs.length === 0,
      vazia.body.data.jobs.length);

    // ── 6. o kiosk também serve de estação ─────────────────────
    await call('POST', M + '/print/submit', { kind: 'bin_labels', bins: [1, 2] }, asAdmin);
    const kioskList = await call('GET', '/api/v3/print-queue', undefined, asKiosk);
    rec('6 · kiosk', 'a estação logada vê a fila', kioskList.body.data.jobs.length === 1,
      kioskList.body.data.jobs.length);
    const kioskTake = await call('POST', '/api/v3/print-queue/2/take', {}, asKiosk);
    rec('6 · kiosk', 'e toma em nome de quem está logado',
      kioskTake.body.data.job.taken_by === 'Simone', kioskTake.body.data.job.taken_by);
    const semSessao = await call('GET', '/api/v3/print-queue', undefined,
      { authorization: 'Bearer ' + PAGE_TOKEN });
    rec('6 · kiosk', 'o token da página sozinho não é ninguém (401)', semSessao.status === 401, semSessao.status);
    const erro = await call('POST', '/api/v3/print-queue/2/error',
      { note: 'acabou a etiqueta' }, asKiosk);
    rec('6 · kiosk', 'erro registra o motivo e tira da fila',
      erro.body.data.job.status === 'error' && erro.body.data.job.error_note === 'acabou a etiqueta',
      erro.body.data.job.error_note);

    // ── 7. cancelar ────────────────────────────────────────────
    await call('POST', M + '/print/submit', { kind: 'picklist' }, asAdmin);
    const naoMeu = await call('POST', '/api/v3/print-queue/3/cancel', {}, asStation);
    rec('7 · cancelar', 'a estação não cancela pedido de outra pessoa (403)', naoMeu.status === 403, naoMeu.status);
    const meu = await call('POST', '/api/v3/print-queue/3/cancel', {}, asAdmin);
    rec('7 · cancelar', 'quem pediu cancela o próprio', meu.body.data.job.status === 'cancelled',
      meu.body.data.job.status);

    // ── 8. impressoras ─────────────────────────────────────────
    const pr = await call('GET', M + '/printers', undefined, asAdmin);
    rec('8 · impressoras', 'duas impressoras no recorte de bolso', pr.body.data.printers.length === 2,
      pr.body.data.printers.length);
    rec('8 · impressoras', "'none' não vira alarme falso no celular",
      pr.body.data.printers[0].error_label === null, String(pr.body.data.printers[0].error_label));
    rec('8 · impressoras', 'erro de verdade aparece',
      pr.body.data.printers[1].error_label === 'media out', pr.body.data.printers[1].error_label);
    rec('8 · impressoras', 'jobs de hoje por impressora',
      pr.body.data.printers[0].jobs_today === 37 && pr.body.data.printers[1].jobs_today === 0,
      pr.body.data.printers.map((x) => x.jobs_today).join('/'));

    // ── 9. invariante ──────────────────────────────────────────
    rec('9 · invariante', 'NADA no celular escreveu quantidade de estoque',
      stockWrites.length === 0, stockWrites.length + ' escrita(s)');
    rec('9 · invariante', 'cada transição da fila deixou auditoria',
      state.audit.filter((a) => String(a).startsWith('print_queue_')).length >= 6,
      state.audit.filter((a) => String(a).startsWith('print_queue_')).join(', '));
    rec('9 · invariante', 'cada submit deixou uma linha warehouse.mobile_print_submit',
      state.audit.filter((a) => a === 'warehouse.mobile_print_submit').length === 3,
      state.audit.filter((a) => a === 'warehouse.mobile_print_submit').length);
  } finally {
    await new Promise((r) => server.close(r));
  }

  const failed = results.filter((r) => !r.pass);
  console.log('\n' + '='.repeat(60));
  console.log(`${results.length - failed.length}/${results.length} checks passaram`);
  if (failed.length) {
    console.log('\nFALHAS:');
    for (const f of failed) console.log('  [' + f.group + '] ' + f.name + '  ·  ' + f.detail);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('harness explodiu:', e); process.exit(1); });
