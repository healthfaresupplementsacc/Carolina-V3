'use strict';
/**
 * FILA DE IMPRESSÃO — /api/v3/print-queue/* (S15.34, Bruno 08-19).
 *
 *  1. AUTH TRIPLA: PIN de admin · sessão do kiosk (Bearer + X-Session-Token) ·
 *     x-print-token do .28. Nenhuma das três → 401.
 *  2. CICLO: queued → taken → done, com o carimbo label_printed_at nas caixas.
 *  3. HONESTIDADE DE ESTADO: tomar duas vezes → 409; re-tomar só depois de 10 min.
 *  4. CANCELAR: quem pediu ou admin; nunca depois de fechado.
 *  5. is_test some da fila de trabalho, mas fica na tabela (REGRA #0).
 *
 * Express de verdade num socket efêmero (padrão do warehouse-router.test.js);
 * banco em memória. PINs e tokens FICTÍCIOS.
 */
const express = require('express');
const { createPrintQueueRouter } = require('../v3/print-queue/router');
const { PrintQueueService } = require('../v3/print-queue/service');

const ADMIN_PIN = '111111';    // fictício: manage_stock
const VIEWER_PIN = '222222';   // fictício: só view_stock
const OP_PIN = '333333';       // fictício: sem função de estoque
const PAGE_TOKEN = 'page-token-ficticio';
const PRINT_TOKEN = 'print-token-ficticio';
const SESSION = 'sessao-ficticia-do-kiosk';
const SANDBOX_SESSION = 'sessao-ficticia-sandbox';

/** Banco falso: só as tabelas que a fila toca. */
function makeDb(state) {
  let seq = 0;
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();

      if (/FROM v3\.app_logins l/.test(q)) {
        const map = {
          [ADMIN_PIN]: { id: 1, name: 'Henrique', role: 'manager', rank: 50, functions: ['view_stock', 'manage_stock'] },
          [VIEWER_PIN]: { id: 2, name: 'Visitante', role: 'viewer', rank: 20, functions: ['view_stock'] },
          [OP_PIN]: { id: 3, name: 'Simone', role: 'operator', rank: 10, functions: ['do_pnp'] },
        };
        const l = map[params[0]];
        return { rows: l ? [l] : [] };
      }
      if (/FROM v3\.operator_sessions s/.test(q)) {
        if (params[0] === SESSION) return { rows: [{ session_id: 9, person_id: 5, display_name: 'Vitor', is_sandbox: false }] };
        if (params[0] === SANDBOX_SESSION) return { rows: [{ session_id: 10, person_id: 6, display_name: 'Teste', is_sandbox: true }] };
        return { rows: [] };
      }
      if (q.startsWith('INSERT INTO v3.audit_log')) {
        state.audit.push({ action: params[0], target: params[1], meta: JSON.parse(params[2]) });
        return { rows: [] };
      }
      if (q.startsWith('INSERT INTO v3.print_queue')) {
        seq += 1;
        const job = {
          id: seq, kind: params[0], payload: JSON.parse(params[1]),
          requested_by: params[2], requested_login_id: params[3],
          target: params[4], is_test: params[5], status: 'queued',
          taken_by: null, taken_at: null, done_at: null, error_note: null,
          created_at: new Date(state.now), age_min: 0,
        };
        state.jobs.push(job);
        return { rows: [job] };
      }
      if (/FROM v3\.print_queue WHERE id/.test(q)) {
        const j = state.jobs.find((x) => x.id === params[0]);
        return { rows: j ? [withAge(j, state)] : [] };
      }
      if (/COUNT\(\*\)::int AS n FROM v3\.print_queue/.test(q)) {
        return { rows: [{ n: state.jobs.filter((j) => j.status === 'queued' && !j.is_test).length }] };
      }
      if (/FROM v3\.print_queue/.test(q) && q.startsWith('SELECT')) {
        // lista: WHERE status = $1 (opcional) AND is_test = false (opcional)
        const wantStatus = /status = \$1/.test(q) ? params[0] : null;
        const noTest = /is_test = false/.test(q);
        let rows = state.jobs.filter((j) => (!wantStatus || j.status === wantStatus)
          && (!noTest || !j.is_test));
        rows = /created_at ASC/.test(q)
          ? rows.slice().sort((a, b) => a.id - b.id)
          : rows.slice().sort((a, b) => b.id - a.id);
        const limit = params[params.length - 1];
        return { rows: rows.slice(0, limit).map((j) => withAge(j, state)) };
      }
      if (q.startsWith("UPDATE v3.print_queue SET status = 'taken'")) {
        const j = state.jobs.find((x) => x.id === params[0]);
        if (!j) return { rows: [] };
        const staleMin = j.taken_at ? (state.now - j.taken_at) / 60000 : 0;
        const canTake = j.status === 'queued' || (j.status === 'taken' && staleMin > 10);
        if (!canTake) return { rows: [] };
        j.status = 'taken'; j.taken_by = params[1]; j.taken_at = state.now;
        return { rows: [withAge(j, state)] };
      }
      if (q.startsWith("UPDATE v3.print_queue SET status = 'done'")) {
        const j = state.jobs.find((x) => x.id === params[0]);
        if (!j || !['queued', 'taken'].includes(j.status)) return { rows: [] };
        j.status = 'done'; j.done_at = state.now;
        j.taken_by = j.taken_by || params[1]; j.taken_at = j.taken_at || state.now;
        return { rows: [withAge(j, state)] };
      }
      if (q.startsWith("UPDATE v3.print_queue SET status = 'error'")) {
        const j = state.jobs.find((x) => x.id === params[0]);
        if (!j || !['queued', 'taken'].includes(j.status)) return { rows: [] };
        j.status = 'error'; j.done_at = state.now; j.error_note = params[2];
        j.taken_by = j.taken_by || params[1];
        return { rows: [withAge(j, state)] };
      }
      if (q.startsWith("UPDATE v3.print_queue SET status = 'cancelled'")) {
        const j = state.jobs.find((x) => x.id === params[0]);
        if (!j || !['queued', 'taken'].includes(j.status)) return { rows: [] };
        j.status = 'cancelled'; j.done_at = state.now;
        return { rows: [withAge(j, state)] };
      }
      if (q.startsWith('UPDATE v3.stock_boxes SET label_printed_at')) {
        state.stamped.push(...params[0]);
        return { rows: params[0].map((id) => ({ id })) };
      }
      return { rows: [] };
    },
  };
}

function withAge(j, state) {
  return Object.assign({}, j, { age_min: Math.round((state.now - j.created_at.getTime()) / 60000) });
}

const boxLabels = (ids) => ({
  labels: ids.map((id) => ({ kind: 'box', id, code: 'BOX-' + id,
    line2: 'BENF-300', line3: '110 garrafas', url: '/scan/?x=BOX-' + id })),
});

let server, base, state, queue;

async function boot() {
  if (server) await new Promise((r) => server.close(r));
  state = { jobs: [], audit: [], stamped: [], now: Date.now() };
  const db = makeDb(state);
  queue = new PrintQueueService({ db });
  const app = express();
  app.use('/', createPrintQueueRouter({ db, queue }));
  server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
  base = `http://127.0.0.1:${server.address().port}`;
}

async function call(method, path, body, headers = {}) {
  const r = await fetch(base + path, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  return { status: r.status, body: j };
}

const asAdmin = { 'x-admin-pin': ADMIN_PIN };
const asKiosk = { authorization: 'Bearer ' + PAGE_TOKEN, 'x-session-token': SESSION };
const asStation = { 'x-print-token': PRINT_TOKEN };

beforeAll(() => {
  process.env.OPERATOR_PAGE_TOKEN = PAGE_TOKEN;
  process.env.PRINT_EVENT_TOKEN = PRINT_TOKEN;
});
beforeEach(async () => { await boot(); });
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('Fila de impressão — auth tripla', () => {
  test('sem credencial nenhuma → 401', async () => {
    const r = await call('GET', '/api/v3/print-queue');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthorized');
  });

  test('PIN de admin lê a fila', async () => {
    const r = await call('GET', '/api/v3/print-queue', undefined, asAdmin);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data.jobs)).toBe(true);
  });

  test('kiosk (Bearer + sessão) lê e escreve', async () => {
    await queue.enqueue({ kind: 'box_label', payload: boxLabels([5]), requested_by: 'Henrique' });
    const list = await call('GET', '/api/v3/print-queue', undefined, asKiosk);
    expect(list.status).toBe(200);
    const take = await call('POST', '/api/v3/print-queue/1/take', {}, asKiosk);
    expect(take.status).toBe(200);
    expect(take.body.data.job.taken_by).toBe('Vitor');   // o nome da SESSÃO, não do corpo
  });

  test('Bearer certo sem sessão → 401 (o token da página sozinho não é ninguém)', async () => {
    const r = await call('GET', '/api/v3/print-queue', undefined,
      { authorization: 'Bearer ' + PAGE_TOKEN });
    expect(r.status).toBe(401);
  });

  test('sessão inválida → 401', async () => {
    const r = await call('GET', '/api/v3/print-queue', undefined,
      { authorization: 'Bearer ' + PAGE_TOKEN, 'x-session-token': 'inventada' });
    expect(r.status).toBe(401);
  });

  test('x-print-token do .28 lê e escreve', async () => {
    await queue.enqueue({ kind: 'box_label', payload: boxLabels([5]), requested_by: 'Henrique' });
    const r = await call('POST', '/api/v3/print-queue/1/take', { by: 'printmon .28' }, asStation);
    expect(r.status).toBe(200);
    expect(r.body.data.job.taken_by).toBe('printmon .28');
  });

  test('token de impressão errado → 401', async () => {
    const r = await call('GET', '/api/v3/print-queue', undefined, { 'x-print-token': 'errado' });
    expect(r.status).toBe(401);
  });

  test('PIN sem função de estoque → 401 (não é gente de estoque)', async () => {
    const r = await call('GET', '/api/v3/print-queue', undefined, { 'x-admin-pin': OP_PIN });
    expect(r.status).toBe(401);
  });

  test('view_stock lê mas não muda estado (403)', async () => {
    await queue.enqueue({ kind: 'box_label', payload: boxLabels([5]), requested_by: 'Henrique' });
    const read = await call('GET', '/api/v3/print-queue', undefined, { 'x-admin-pin': VIEWER_PIN });
    expect(read.status).toBe(200);
    const write = await call('POST', '/api/v3/print-queue/1/take', {}, { 'x-admin-pin': VIEWER_PIN });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('forbidden');
  });
});

describe('Fila de impressão — ciclo de vida', () => {
  test('queued → taken → done, e o carimbo cai nas caixas do payload', async () => {
    await queue.enqueue({ kind: 'box_label', payload: boxLabels([5, 7]), requested_by: 'Henrique' });

    const list = await call('GET', '/api/v3/print-queue', undefined, asStation);
    expect(list.body.data.jobs).toHaveLength(1);
    expect(list.body.data.jobs[0].status).toBe('queued');
    expect(list.body.data.jobs[0].payload.labels).toHaveLength(2);

    const take = await call('POST', '/api/v3/print-queue/1/take', { by: 'printmon' }, asStation);
    expect(take.body.data.job.status).toBe('taken');
    expect(take.body.data.job.taken_at).toBeTruthy();

    const done = await call('POST', '/api/v3/print-queue/1/done', { by: 'printmon' }, asStation);
    expect(done.body.data.job.status).toBe('done');
    expect(state.stamped.sort()).toEqual([5, 7]);       // label_printed_at nas duas
  });

  test('etiqueta de PRATELEIRA não carimba caixa nenhuma', async () => {
    await queue.enqueue({ kind: 'bin_labels', requested_by: 'Henrique',
      payload: { labels: [{ kind: 'bin', id: 3, code: 'A03B2', line2: 'S2', line3: '' }] } });
    await call('POST', '/api/v3/print-queue/1/take', {}, asStation);
    await call('POST', '/api/v3/print-queue/1/done', {}, asStation);
    expect(state.stamped).toEqual([]);
  });

  test('tomar o mesmo job duas vezes → 409 not_queued', async () => {
    await queue.enqueue({ kind: 'box_label', payload: boxLabels([5]), requested_by: 'Henrique' });
    expect((await call('POST', '/api/v3/print-queue/1/take', {}, asStation)).status).toBe(200);
    const again = await call('POST', '/api/v3/print-queue/1/take', {}, asStation);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('not_queued');
  });

  test('job travado há mais de 10 min pode ser RE-TOMADO (o estado nunca mente sozinho)', async () => {
    await queue.enqueue({ kind: 'box_label', payload: boxLabels([5]), requested_by: 'Henrique' });
    await call('POST', '/api/v3/print-queue/1/take', { by: 'estação A' }, asStation);
    state.now += 11 * 60 * 1000;                        // 11 minutos depois
    const retake = await call('POST', '/api/v3/print-queue/1/take', { by: 'estação B' }, asStation);
    expect(retake.status).toBe(200);
    expect(retake.body.data.job.taken_by).toBe('estação B');
    // e a fila 'queued' continua honesta: o job nunca voltou pra ela
    const q = await call('GET', '/api/v3/print-queue?status=queued', undefined, asStation);
    expect(q.body.data.jobs).toHaveLength(0);
  });

  test('erro na estação registra o motivo e tira da fila', async () => {
    await queue.enqueue({ kind: 'box_label', payload: boxLabels([5]), requested_by: 'Henrique' });
    await call('POST', '/api/v3/print-queue/1/take', {}, asStation);
    const r = await call('POST', '/api/v3/print-queue/1/error',
      { by: 'printmon', note: 'acabou a etiqueta' }, asStation);
    expect(r.body.data.job.status).toBe('error');
    expect(r.body.data.job.error_note).toBe('acabou a etiqueta');
    expect(state.stamped).toEqual([]);                  // erro não carimba nada
    const q = await call('GET', '/api/v3/print-queue', undefined, asStation);
    expect(q.body.data.jobs).toHaveLength(0);
  });

  test('concluir duas vezes → 409 not_open', async () => {
    await queue.enqueue({ kind: 'box_label', payload: boxLabels([5]), requested_by: 'Henrique' });
    await call('POST', '/api/v3/print-queue/1/done', {}, asStation);
    const again = await call('POST', '/api/v3/print-queue/1/done', {}, asStation);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('not_open');
  });

  test('job que não existe → 404', async () => {
    const r = await call('POST', '/api/v3/print-queue/999/take', {}, asStation);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
  });
});

describe('Fila de impressão — cancelar', () => {
  test('quem pediu cancela o próprio', async () => {
    await queue.enqueue({ kind: 'box_label', payload: boxLabels([5]), requested_by: 'Henrique' });
    const r = await call('POST', '/api/v3/print-queue/1/cancel', {}, asAdmin);
    expect(r.status).toBe(200);
    expect(r.body.data.job.status).toBe('cancelled');
  });

  test('a estação NÃO cancela o pedido de outra pessoa (403)', async () => {
    await queue.enqueue({ kind: 'box_label', payload: boxLabels([5]), requested_by: 'Henrique' });
    const r = await call('POST', '/api/v3/print-queue/1/cancel', { by: 'printmon' }, asStation);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('forbidden');
  });

  test('não cancela o que já saiu da impressora (409)', async () => {
    await queue.enqueue({ kind: 'box_label', payload: boxLabels([5]), requested_by: 'Henrique' });
    await call('POST', '/api/v3/print-queue/1/done', {}, asStation);
    const r = await call('POST', '/api/v3/print-queue/1/cancel', {}, asAdmin);
    expect(r.status).toBe(409);
  });
});

describe('Fila de impressão — listagem e teste', () => {
  test('sem status vem só o que espera, mais antigo primeiro', async () => {
    await queue.enqueue({ kind: 'box_label', payload: boxLabels([1]), requested_by: 'Henrique' });
    await queue.enqueue({ kind: 'box_label', payload: boxLabels([2]), requested_by: 'Henrique' });
    await call('POST', '/api/v3/print-queue/1/done', {}, asStation);
    const r = await call('GET', '/api/v3/print-queue', undefined, asStation);
    expect(r.body.data.jobs.map((j) => j.id)).toEqual([2]);
  });

  test('status=all traz tudo, mais recente primeiro', async () => {
    await queue.enqueue({ kind: 'box_label', payload: boxLabels([1]), requested_by: 'Henrique' });
    await queue.enqueue({ kind: 'box_label', payload: boxLabels([2]), requested_by: 'Henrique' });
    await call('POST', '/api/v3/print-queue/1/done', {}, asStation);
    const r = await call('GET', '/api/v3/print-queue?status=all', undefined, asAdmin);
    expect(r.body.data.jobs.map((j) => j.id)).toEqual([2, 1]);
  });

  test('status inválido → 400 em PT-BR sem em dash', async () => {
    const r = await call('GET', '/api/v3/print-queue?status=inventado', undefined, asAdmin);
    expect(r.status).toBe(400);
    expect(r.body.error.message).not.toMatch(/—/);
  });

  test('pedido de SANDBOX fica na tabela mas some da fila de trabalho', async () => {
    await queue.enqueue({ kind: 'box_label', payload: boxLabels([5]),
      requested_by: 'Teste', is_test: true });
    expect(state.jobs).toHaveLength(1);                    // REGRA #0: registrou
    const real = await call('GET', '/api/v3/print-queue', undefined, asStation);
    expect(real.body.data.jobs).toHaveLength(0);           // a estação não imprime teste
    const sandbox = await call('GET', '/api/v3/print-queue', undefined,
      { authorization: 'Bearer ' + PAGE_TOKEN, 'x-session-token': SANDBOX_SESSION });
    expect(sandbox.body.data.jobs).toHaveLength(1);        // quem testou vê o próprio
    expect(await queue.queuedCount()).toBe(0);             // e não conta pro celular
  });

  test('cada mudança de estado deixa uma linha de auditoria', async () => {
    await queue.enqueue({ kind: 'box_label', payload: boxLabels([5]), requested_by: 'Henrique' });
    await call('POST', '/api/v3/print-queue/1/take', {}, asStation);
    await call('POST', '/api/v3/print-queue/1/done', {}, asStation);
    expect(state.audit.map((a) => a.action)).toEqual(
      ['print_queue_queued', 'print_queue_taken', 'print_queue_done']);
  });

  test('kind inválido nunca entra na fila', async () => {
    await expect(queue.enqueue({ kind: 'shipping_label', payload: {} })).rejects.toThrow(/kind inválido/);
    expect(state.jobs).toHaveLength(0);
  });
});

// ── ETIQUETAS DE ENVIO (S15.37) ────────────────────────────────────────────
// O serviço de etiquetas é injetado como dependência opcional; aqui ele é um
// dublê. O que se testa é o ROUTER: rotas novas, auth do PDF numa aba nova, e o
// gancho do /done que carimba printed_at. A composição do PDF de verdade está em
// shipping-labels.test.js.
describe('Fila de impressão — etiquetas de envio', () => {
  let shipping, calls;

  async function bootShipping() {
    if (server) await new Promise((r) => server.close(r));
    state = { jobs: [], audit: [], stamped: [], now: Date.now() };
    calls = { compose: [], marked: [] };
    const db = makeDb(state);
    queue = new PrintQueueService({ db });
    shipping = {
      preview: async (day) => ({ day: day || '2026-08-19', ready: [], counts: { ready: 0, printed: 0, to_print: 0 } }),
      compose: async (p) => {
        calls.compose.push(p);
        const job = await queue.enqueue({
          kind: 'shipping_labels', requested_by: p.requested_by, is_test: p.is_test,
          payload: { day: p.day || '2026-08-19', count: 2, pages: 3, file_id: 1,
            shipment_ids: ['901', '902'], groups: [{ nickname: 'BENF-300', count: 2, location: 'A03B2' }] },
        });
        const final = p.take ? await queue.take(job.id, p.requested_by) : job;
        return { job: final, file_id: 1, counts: { labels: 2, pages: 3, groups: 1, failed: 0 } };
      },
      markPrinted: async (job) => { calls.marked.push(job.id); return { labels: 2, lines: 2 }; },
      fileForJob: async (jobId) => (state.jobs.find((j) => j.id === Number(jobId))
        ? { id: 1, mime: 'application/pdf', bytes: Buffer.from('%PDF-1.7 fake'), pages: 3 } : null),
    };
    const app = express();
    app.use('/', createPrintQueueRouter({ db, queue, shipping }));
    server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
    base = `http://127.0.0.1:${server.address().port}`;
  }

  beforeEach(async () => { await bootShipping(); });

  test('preview responde pra quem pode ler', async () => {
    const r = await call('GET', '/api/v3/print-queue/shipping-labels/preview?day=2026-08-19',
      undefined, asAdmin);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ day: '2026-08-19', counts: { ready: 0 } });
  });

  test('a rota de preview NÃO é engolida pelo /:id', async () => {
    // '/shipping-labels/preview' casaria com '/:id' se registrada depois
    const r = await call('GET', '/api/v3/print-queue/shipping-labels/preview', undefined, asAdmin);
    expect(r.status).toBe(200);
    expect(r.body.data.counts).toBeDefined();
  });

  test('sem credencial → 401, igual ao resto da fila', async () => {
    expect((await call('GET', '/api/v3/print-queue/shipping-labels/preview')).status).toBe(401);
    expect((await call('POST', '/api/v3/print-queue/shipping-labels', {})).status).toBe(401);
  });

  test('login sem manage_stock não compõe (só lê)', async () => {
    const asViewer = { 'x-admin-pin': VIEWER_PIN };
    expect((await call('GET', '/api/v3/print-queue/shipping-labels/preview', undefined, asViewer)).status).toBe(200);
    expect((await call('POST', '/api/v3/print-queue/shipping-labels', {}, asViewer)).status).toBe(403);
  });

  test('kiosk compõe e o PACKER é a pessoa da sessão', async () => {
    const r = await call('POST', '/api/v3/print-queue/shipping-labels',
      { day: '2026-08-19', take: true }, asKiosk);
    expect(r.status).toBe(200);
    expect(calls.compose[0].packer_id).toBe('5');       // person_id da sessão do Vitor
    expect(r.body.data.job.status).toBe('taken');
    expect(r.body.data.file_url).toBe('/api/v3/print-queue/1/file');
    expect(r.body.data.counts).toMatchObject({ labels: 2, pages: 3 });
  });

  test('admin pelo celular não é quem embala: packer nulo', async () => {
    await call('POST', '/api/v3/print-queue/shipping-labels', { day: '2026-08-19' }, asAdmin);
    expect(calls.compose[0].packer_id).toBeNull();
    expect(calls.compose[0].requested_by).toBe('Henrique');
  });

  test('reprint e shipment_ids chegam no serviço', async () => {
    await call('POST', '/api/v3/print-queue/shipping-labels',
      { reprint: true, shipment_ids: ['901'] }, asAdmin);
    expect(calls.compose[0]).toMatchObject({ reprint: true, shipment_ids: ['901'] });
  });

  test('o PDF abre com ?t= (aba nova não manda header)', async () => {
    await call('POST', '/api/v3/print-queue/shipping-labels', {}, asKiosk);
    const r = await fetch(base + '/api/v3/print-queue/1/file?t=' + SESSION);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/application\/pdf/);
    expect(r.headers.get('content-disposition')).toMatch(/inline; filename="etiquetas-envio-/);
    expect(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF');
  });

  test('o PDF abre com ?pin= do admin', async () => {
    await call('POST', '/api/v3/print-queue/shipping-labels', {}, asAdmin);
    const r = await fetch(base + '/api/v3/print-queue/1/file?pin=' + ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/application\/pdf/);
  });

  test('PDF sem credencial nenhuma → 401 (a query não é porta aberta)', async () => {
    await call('POST', '/api/v3/print-queue/shipping-labels', {}, asAdmin);
    expect((await fetch(base + '/api/v3/print-queue/1/file')).status).toBe(401);
    expect((await fetch(base + '/api/v3/print-queue/1/file?t=token-errado')).status).toBe(401);
    expect((await fetch(base + '/api/v3/print-queue/1/file?pin=000000')).status).toBe(401);
  });

  test('PDF de job que não existe → 404', async () => {
    const r = await fetch(base + '/api/v3/print-queue/999/file?pin=' + ADMIN_PIN);
    expect(r.status).toBe(404);
  });

  test('done de etiqueta de envio carimba printed_at', async () => {
    await call('POST', '/api/v3/print-queue/shipping-labels', { take: true }, asKiosk);
    const r = await call('POST', '/api/v3/print-queue/1/done', {}, asKiosk);
    expect(r.status).toBe(200);
    expect(r.body.data.stamped).toEqual({ labels: 2, lines: 2 });
    expect(calls.marked).toEqual([1]);
  });

  test('done de outro tipo não chama o carimbo de etiqueta', async () => {
    await queue.enqueue({ kind: 'box_label', payload: boxLabels([5]), requested_by: 'Henrique' });
    const r = await call('POST', '/api/v3/print-queue/1/done', {}, asStation);
    expect(r.status).toBe(200);
    expect(r.body.data.stamped).toBeUndefined();
    expect(calls.marked).toEqual([]);
  });

  test('sem o serviço injetado as rotas dizem 503 e o resto da fila segue', async () => {
    if (server) await new Promise((r) => server.close(r));
    const db = makeDb(state);
    const app = express();
    app.use('/', createPrintQueueRouter({ db, queue: new PrintQueueService({ db }) }));
    server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
    base = `http://127.0.0.1:${server.address().port}`;
    expect((await call('GET', '/api/v3/print-queue/shipping-labels/preview', undefined, asAdmin)).status).toBe(503);
    expect((await call('GET', '/api/v3/print-queue', undefined, asAdmin)).status).toBe(200);
  });

  test('nada novo pra imprimir chega como 409, não como 500', async () => {
    // o compose lança ShippingLabelsError (outro módulo, outra classe): o
    // sendError precisa traduzir pelo CONTRATO {code,status}, senão o operador
    // vê "erro interno" quando na verdade não há nada pra imprimir.
    shipping.compose = async () => {
      const e = new Error('Nada novo pra imprimir: todas as etiquetas do dia já saíram.');
      e.code = 'nothing_to_print'; e.status = 409; throw e;
    };
    const r = await call('POST', '/api/v3/print-queue/shipping-labels', {}, asAdmin);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('nothing_to_print');
  });

  test('erro de verdade continua 500 (não vira 4xx silencioso)', async () => {
    shipping.compose = async () => { throw new Error('banco caiu'); };
    const r = await call('POST', '/api/v3/print-queue/shipping-labels', {}, asAdmin);
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('internal');
  });

  test('shipping_labels é kind válido na fila', async () => {
    const job = await queue.enqueue({ kind: 'shipping_labels', payload: { file_id: 1 }, requested_by: 'V' });
    expect(job.kind).toBe('shipping_labels');
  });
});
