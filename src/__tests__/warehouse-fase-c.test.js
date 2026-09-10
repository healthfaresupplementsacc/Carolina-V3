'use strict';
/**
 * FASE C do controle de estoque (Bruno 09-10): PERMISSOES POR PESSOA.
 *  - auth: funcoes = perfil + dadas por pessoa − tiradas por pessoa; niveis de estoque
 *  - rbac router: /me, /login-functions, /login-function (grant|revoke|inherit), /inbox por funcao
 *  - warehouse: quem so PROPOE nao aplica (entrada/take/transfer/count viram proposta,
 *    com notificacao dirigida a quem aprova); organizar exige "Organizar"; aprovar exige
 *    "Aprovar"; ninguem aprova a propria proposta
 * Express real em socket efemero; services mockados. PINs FICTICIOS.
 */
const express = require('express');
const { resolveLogin, stockLevel, canViewStock, stockLevelsOf } = require('../v3/data/auth');
const { createRbacRouter } = require('../v3/rbac/router');
const { createWarehouseRouter } = require('../v3/warehouse/router');
const { createVeeqoCache } = require('../v3/warehouse/veeqo-cache');
const { StockRequestService } = require('../v3/services/StockRequestService');

const PINS = {
  '111111': { id: 1, name: 'Admin', role: 'admin', rank: 100, functions: ['*'] },
  '222222': { id: 2, name: 'Henrique', role: 'manager', rank: 50, functions: ['view_stock', 'stock_propose', 'stock_organize'] },
  '333333': { id: 3, name: 'Larissa', role: 'operator', rank: 10, functions: ['view_stock', 'stock_approve'] },
  '444444': { id: 4, name: 'Caroline', role: 'operator', rank: 10, functions: ['view_stock'] },
  '555555': { id: 5, name: 'Bruno', role: 'admin', rank: 100, functions: ['manage_users', 'view_stock', 'stock_change', 'stock_approve'] },
};

describe('auth: funções por pessoa somam ao perfil', () => {
  test('perfil + dadas − tiradas; níveis de estoque derivam das funções', async () => {
    const db = { query: async () => ({ rows: [{ id: 2, name: 'Henrique', role: 'manager', rank: 50,
      functions: ['view_stock', 'manage_people'], granted: ['stock_propose', 'stock_approve'], revoked: ['manage_people'] }] }) };
    const l = await resolveLogin(db, '9' + Math.random().toString().slice(2, 7));
    expect(l.functions.sort()).toEqual(['stock_approve', 'stock_propose', 'view_stock']);
    expect(stockLevel(l, 'propose')).toBe(true);
    expect(stockLevel(l, 'change')).toBe(false);
    expect(canViewStock(l)).toBe(true);
    expect(stockLevelsOf(l)).toMatchObject({ propose: true, approve: true, change: false, organize: false, view: true });
  });
  test('manage_stock (antigo) vale como todos os níveis', () => {
    const l = { functions: ['manage_stock'] };
    expect(['organize', 'propose', 'change', 'approve', 'setup'].every((x) => stockLevel(l, x))).toBe(true);
  });
});

/* ── harness compartilhado ── */
function makeDb(state) {
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      if (/FROM v3\.app_logins l JOIN v3\.app_roles r ON r\.id = l\.role_id LEFT JOIN v3\.role_functions/.test(q)) {
        const l = PINS[params[0]];
        return { rows: l ? [{ id: l.id, name: l.name, role: l.role, rank: l.rank, functions: l.functions, granted: [], revoked: [] }] : [] };
      }
      if (q.startsWith('INSERT INTO v3.audit_log')) { state.audit.push(params[0] || params[1]); return { rows: [] }; }
      if (/COUNT\(\*\)::int AS count/.test(q)) return { rows: [{ count: 0, oldest_age_min: null }] };
      if (/SELECT key, label, category FROM v3\.app_functions/.test(q)) return { rows: [{ key: 'stock_propose', label: 'Propor', category: 'estoque' }, { key: 'stock_change', label: 'Mudar', category: 'estoque' }] };
      if (/FROM v3\.app_logins l JOIN v3\.app_roles r ON r\.id = l\.role_id ORDER BY/.test(q)) {
        return { rows: [{ id: 2, name: 'Henrique', active: true, role: 'manager', role_name: 'Manager', role_functions: ['view_stock'], overrides: state.overrides }] };
      }
      if (q.startsWith('SELECT key FROM v3.app_functions WHERE key')) return { rows: params[0].startsWith('stock_') ? [{ key: params[0] }] : [] };
      if (q.startsWith('SELECT id, name FROM v3.app_logins WHERE id')) return { rows: params[0] === 2 ? [{ id: 2, name: 'Henrique' }] : [] };
      if (q.startsWith('INSERT INTO v3.login_functions')) { state.overrides[params[1]] = params[2]; return { rows: [] }; }
      if (q.startsWith('DELETE FROM v3.login_functions')) { delete state.overrides[params[1]]; return { rows: [] }; }
      if (/FROM v3\.notifications WHERE status = 'pending' AND audience IS NOT NULL/.test(q)) return { rows: state.notifications };
      if (q.startsWith('SELECT COALESCE(nickname, canonical_name) AS name FROM v3.products')) return { rows: [{ name: 'BENF-300' }] };
      if (q.startsWith('INSERT INTO v3.notifications')) { state.notifications.push({ id: 900, type: 'stock_request', payload: JSON.parse(params[0]), status: 'pending', audience: JSON.parse(params[1]), link: params[2] }); return { rows: [] }; }
      if (q.startsWith('INSERT INTO v3.stock_change_requests')) { const row = { id: 77, product_id: params[0], kind: params[1], direction: params[2], qty: params[3], status: 'pending', proposed_by_login: params[10], meta: params[12] ? JSON.parse(params[12]) : null }; state.requests.push(row); return { rows: [row] }; }
      if (q.startsWith('SELECT * FROM v3.stock_change_requests WHERE id')) { const r = state.requests.find((x) => x.id === params[0]); return { rows: r ? [r] : [] }; }
      if (q.startsWith('UPDATE v3.stock_change_requests')) { const r = state.requests.find((x) => x.id === params[0]); if (r) r.status = 'approved'; return { rows: r ? [r] : [] }; }
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(q)) return {};
      return { rows: [] };
    },
    async connect() { return this; }, release() {},
  };
}
function baseRow() {
  return { product_id: 10, name: 'Benfotiamine 300mg', nickname: 'BENF-300', base_sku: 'HF-BENF-300',
    skus: [{ id: 1, sku: 'HF-BENF-300', channel: 'veeqo', units_per_pack: 1, confirmed: true, role: 'base' }],
    shelf_qty: 46, box_qty: 180, unplaced_qty: 0, total: 226, reserved: 12, available: 214, separated: 0,
    veeqo: { physical: 226 }, veeqo_total: 226, status: ['ok'], bins: [{ id: 4, bin_code: 'A03', qty: 46 }], boxes: [] };
}
let server, base, stock, state, requests;
async function boot() {
  if (server) await new Promise((r) => server.close(r));
  state = { audit: [], overrides: {}, notifications: [], requests: [] };
  const rows = [baseRow()];
  const op = (name) => jest.fn(async (p) => ({ movement: { id: 900, kind: name }, duplicate: false, applied: p.qty || p.found || 0, bin: null, box: null }));
  stock = { overview: async () => rows.map((r) => ({ ...r })), productDetail: async () => ({ product: rows[0], open_orders: [], movements: [], issues: [], requests: [] }),
    storeIn: op('store_in'), count: op('count'), takeOut: op('take'), reverse: op('reverse'), place: op('place'), move: op('move'), adjust: op('adjust'), separate: op('separate') };
  const db = makeDb(state);
  db.query = ((orig) => async (sql, params) => {
    const q = String(sql).replace(/\s+/g, ' ');
    if (/SELECT qty, product_id FROM v3\.stock_bins WHERE id/.test(q)) return { rows: [{ qty: 46, product_id: 10 }] };
    return orig(sql, params);
  })(db.query.bind(db));
  requests = new StockRequestService({ db, stock });
  const movements = { reasons: async () => [], requireReason: async (code) => ({ code, label_pt: code, direction: code === 'producao' ? 'in' : (code === 'contagem' ? 'count' : 'out') }), list: async () => ({ rows: [], total: 0 }), csv: async () => '', batches: async () => [] };
  const veeqoCache = createVeeqoCache({ veeqo: { listSellables: async () => [{ sku: 'HF-BENF-300', type: 'variant', wh: { physical: 226 } }] } });
  await veeqoCache.warm();
  const app = express();
  app.use('/', createRbacRouter({ db }));
  app.use('/', createWarehouseRouter({ db, stock, requests, veeqoCache, movements }));
  server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
  base = `http://127.0.0.1:${server.address().port}`;
}
async function call(method, path, body, pin) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-admin-pin': pin }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  return { status: r.status, body: j };
}
beforeEach(boot);
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('rbac router', () => {
  test('/me devolve funções e níveis de estoque', async () => {
    const r = await call('GET', '/api/v3/rbac/me', undefined, '222222');
    expect(r.status).toBe(200);
    expect(r.body.data.stock_levels).toMatchObject({ propose: true, organize: true, change: false, approve: false, view: true });
  });
  test('/login-functions e /login-function: só manage_users; grant/revoke/inherit gravam por pessoa', async () => {
    let r = await call('GET', '/api/v3/rbac/login-functions', undefined, '222222');
    expect(r.status).toBe(403);
    r = await call('GET', '/api/v3/rbac/login-functions', undefined, '555555');
    expect(r.status).toBe(200); expect(r.body.data.logins[0].name).toBe('Henrique');
    r = await call('POST', '/api/v3/rbac/login-function', { login_id: 2, function_key: 'stock_change', state: 'grant' }, '555555');
    expect(r.status).toBe(200); expect(state.overrides.stock_change).toBe(true);
    r = await call('POST', '/api/v3/rbac/login-function', { login_id: 2, function_key: 'stock_change', state: 'revoke' }, '555555');
    expect(state.overrides.stock_change).toBe(false);
    r = await call('POST', '/api/v3/rbac/login-function', { login_id: 2, function_key: 'stock_change', state: 'inherit' }, '555555');
    expect(state.overrides.stock_change).toBeUndefined();
    r = await call('POST', '/api/v3/rbac/login-function', { login_id: 2, function_key: 'stock_change', state: 'maybe' }, '555555');
    expect(r.status).toBe(400);
    expect(state.audit).toContain('rbac.login_function');
  });
  test('/inbox: só o que tem destinatário e bate com minhas funções', async () => {
    state.notifications.push({ id: 1, type: 'stock_request', payload: {}, status: 'pending', audience: { functions: ['stock_approve'] }, link: '#x' });
    state.notifications.push({ id: 2, type: 'x', payload: {}, status: 'pending', audience: { login_ids: [4] }, link: '#y' });
    let r = await call('GET', '/api/v3/rbac/inbox', undefined, '333333');   // aprova
    expect(r.body.data.notifications.map((n) => n.id)).toEqual([1]);
    r = await call('GET', '/api/v3/rbac/inbox', undefined, '444444');       // só vê; id 4
    expect(r.body.data.notifications.map((n) => n.id)).toEqual([2]);
    r = await call('GET', '/api/v3/rbac/inbox', undefined, '111111');       // admin (*) vê os por função
    expect(r.body.data.count).toBe(1);
  });
});

describe('warehouse: níveis por pessoa', () => {
  test('quem só PROPÕE: entrada vira proposta, nada muda, quem aprova é avisado', async () => {
    const r = await call('POST', '/api/v3/warehouse/product/10/entrada', { qty: 20, reason_code: 'producao', batch_number: 'BR-2026-0431' }, '222222');
    expect(r.status).toBe(200);
    expect(r.body.data.proposed).toBe(true);
    expect(r.body.data.request).toMatchObject({ kind: 'entrada', direction: 'in', qty: 20, proposed_by_login: 'Henrique' });
    expect(r.body.data.request.meta).toMatchObject({ reason_code: 'producao', ref_type: 'batch', ref_id: 'BR-2026-0431' });
    expect(stock.storeIn).not.toHaveBeenCalled();
    expect(state.notifications[0]).toMatchObject({ audience: { functions: ['stock_approve', 'manage_stock'] }, link: '#estoque-aprovacoes?req=77' });
  });
  test('quem só PROPÕE: saída, transferência e contagem viram proposta com o motivo no meta', async () => {
    let r = await call('POST', '/api/v3/warehouse/product/10/take', { qty: 3, reason_code: 'amostra' }, '222222');
    expect(r.body.data.proposed).toBe(true); expect(r.body.data.request.kind).toBe('take'); expect(stock.takeOut).not.toHaveBeenCalled();
    r = await call('POST', '/api/v3/warehouse/product/10/transfer', { qty: 30, destination: 'fba', shipment_ref: 'FBA1' }, '222222');
    expect(r.body.data.proposed).toBe(true); expect(r.body.data.request).toMatchObject({ kind: 'transfer', direction: 'out', qty: 30 });
    r = await call('POST', '/api/v3/warehouse/product/10/count', { bin_id: 4, found: 40 }, '222222');   // sistema 46 → 40
    expect(r.body.data.proposed).toBe(true); expect(r.body.data.request).toMatchObject({ kind: 'count', direction: 'out', qty: 6 });
    expect(r.body.data.request.meta).toMatchObject({ computed_qty: 40 });
    expect(stock.count).not.toHaveBeenCalled();
    r = await call('POST', '/api/v3/warehouse/product/10/count', { bin_id: 4, found: 46 }, '222222');   // sem diferença
    expect(r.body.data.unchanged).toBe(true);
  });
  test('Organizar: quem propõe também organiza; quem só vê não; quem muda o total aplica direto', async () => {
    let r = await call('POST', '/api/v3/warehouse/product/10/place', { qty: 5, bin_id: 4 }, '222222');
    expect(r.status).toBe(200); expect(stock.place).toHaveBeenCalled();
    r = await call('POST', '/api/v3/warehouse/product/10/place', { qty: 5, bin_id: 4 }, '444444');
    expect(r.status).toBe(403);
    r = await call('POST', '/api/v3/warehouse/product/10/entrada', { qty: 20 }, '555555');
    expect(r.status).toBe(200); expect(r.body.data.proposed).toBeUndefined(); expect(stock.storeIn).toHaveBeenCalled();
  });
  test('Aprovar: exige o nível; quem propôs não aprova a própria', async () => {
    await call('POST', '/api/v3/warehouse/product/10/take', { qty: 3, reason_code: 'amostra' }, '222222');
    let r = await call('POST', '/api/v3/warehouse/requests/77/approve', {}, '222222');   // propôs e tem só propor
    expect(r.status).toBe(403);
    r = await call('POST', '/api/v3/warehouse/requests/77/approve', {}, '444444');       // só vê
    expect(r.status).toBe(403);
    r = await call('POST', '/api/v3/warehouse/requests/77/approve', {}, '333333');       // aprova (outra pessoa)
    expect(r.status).toBe(200);
    expect(stock.takeOut).toHaveBeenCalledTimes(1);
    expect(stock.takeOut.mock.calls[0][0]).toMatchObject({ kind: 'take', reason_code: 'amostra', actor_name: 'Larissa' });
  });
  test('auto-aprovação bloqueada mesmo com Aprovar (Bruno: nunca a própria)', async () => {
    const db = makeDb({ audit: [], overrides: {}, notifications: [], requests: [] });
    const svc = new StockRequestService({ db, stock: { pick: async () => ({ movement: { id: 1 }, applied: 1 }) } });
    await svc.propose({ product_id: 10, kind: 'take', direction: 'out', qty: 1, login: 'Larissa', login_id: 3 });
    await expect(svc.approve({ id: 77, login: 'Larissa' })).rejects.toMatchObject({ code: 'self_approval' });
  });
  test('Configurar: cadastrar prateleira exige o nível (quem propõe não configura)', async () => {
    const r = await call('POST', '/api/v3/warehouse/locations/bin', { bin_code: 'A09', product_id: 10 }, '222222');
    expect(r.status).toBe(403);
  });
});
