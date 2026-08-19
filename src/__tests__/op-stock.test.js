'use strict';
/**
 * op-stock — handlers de estoque do operador (S15 Fase 2, Bruno 08-18).
 *
 * O que este teste trava (as regras que o Bruno decidiu):
 *   1. "Peguei do estoque" NÃO escreve movimento. Vira proposta pendente.
 *      (o INSERT cru de op.js — R076 — morreu; se voltar, este teste cai)
 *   2. "Danificada" aplica na hora (fato físico) → issue nas Separadas.
 *   3. Contagem sem prateleira/caixa é 400 location_required.
 *   4. "Registrado hoje" junta as três fontes, ordena por data e mapeia o estado.
 *   5. Sandbox marca is_test em tudo.
 * Mini-DB em memória no shape real da 058/060/071 (padrão do
 * stock-request-service.test.js). Nunca toca banco de verdade.
 */
const { createOpStock } = require('../v3/warehouse/op-stock');
const { StockRequestService } = require('../v3/services/StockRequestService');

// já no shape do SELECT (canonical_name AS product)
const PRODUCTS = { 10: { product: 'Magnesium Glycinate', nickname: 'Mag' },
  11: { product: 'Berberine', nickname: null } };

function makeDb() {
  const state = { requests: [], issues: [], movements: [], audit: [], nextId: 1 };
  const clone = (o) => ({ ...o });
  const prod = (id) => PRODUCTS[id] || { product: 'Produto ' + id, nickname: null };
  const api = {
    state,
    async connect() { return api; },
    release() {},
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK') return { rows: [] };
      if (q.startsWith('INSERT INTO v3.stock_change_requests')) {
        const row = { id: state.nextId++, product_id: params[0], kind: params[1], direction: params[2],
          qty: params[3], bin_id: params[4], box_id: params[5], issue_id: params[6],
          reason: params[7], note: params[8], proposed_by_person_id: params[9],
          proposed_by_login: params[10], is_test: params[11], status: 'pending',
          created_at: state.clock ? state.clock() : new Date().toISOString() };
        state.requests.push(row);
        return { rows: [clone(row)] };
      }
      if (q.startsWith('INSERT INTO v3.audit_log')) { state.audit.push({ action: params[2] }); return { rows: [] }; }
      // decisão do admin (usada só pra provar o mapeamento de estado no recent)
      if (/SELECT \* FROM v3\.stock_change_requests WHERE id = \$1/.test(q)) {
        const r = state.requests.find((x) => x.id === params[0]);
        return { rows: r ? [clone(r)] : [] };
      }
      if (/UPDATE v3\.stock_change_requests SET status = 'rejected'/.test(q)) {
        const r = state.requests.find((x) => x.id === params[0]);
        if (r) { r.status = 'rejected'; r.decided_by_login = params[1]; }
        return { rows: r ? [clone(r)] : [] };
      }
      // leitura do "Registrado hoje" — três SELECTs
      if (/FROM v3\.stock_change_requests q JOIN v3\.products p/.test(q)) {
        const rows = state.requests
          .filter((r) => r.proposed_by_person_id === params[0] && !!r.is_test === !!params[1])
          .map((r) => ({ id: r.id, kind: r.kind, qty: r.qty, note: r.reason || r.note,
            created_at: r.created_at, status: r.status, ...prod(r.product_id) }));
        return { rows };
      }
      if (/FROM v3\.stock_issues i JOIN v3\.products p/.test(q)) {
        const rows = state.issues
          .filter((r) => r.person_id === params[0] && !!r.is_test === !!params[1])
          .map((r) => ({ id: r.id, qty: r.qty, note: r.note, reason: r.reason,
            created_at: r.created_at, ...prod(r.product_id) }));
        return { rows };
      }
      if (/FROM v3\.stock_movements m LEFT JOIN v3\.products p/.test(q)) {
        const rows = state.movements
          .filter((r) => r.person_id === params[0] && !!r.is_test === !!params[1] && r.kind === 'restock')
          .map((r) => ({ id: r.id, qty: r.qty, note: r.note, created_at: r.created_at, ...prod(r.product_id) }));
        return { rows };
      }
      throw new Error('query não mapeada no mock: ' + q.slice(0, 120));
    },
  };
  return api;
}

/** StockService falso: só registra as chamadas (a porta única é testada em stock-service.test.js). */
function fakeStock(db) {
  const calls = [];
  return {
    calls,
    separate: jest.fn(async (p) => {
      calls.push({ name: 'separate', p });
      const issue = { id: 500 + calls.length, product_id: p.product_id, qty: p.qty,
        reason: p.reason, person_id: p.person_id, note: p.note, is_test: !!p.is_test,
        created_at: new Date().toISOString() };
      if (db) db.state.issues.push(issue);
      return { movement: { id: 900 + calls.length }, duplicate: false, applied: p.qty, issue };
    }),
    pick: jest.fn(async () => { throw new Error('pick não deve ser chamado pelo operador'); }),
  };
}

function build(opts = {}) {
  const db = opts.db || makeDb();
  const stock = opts.stock || fakeStock(db);
  const requests = new StockRequestService({ db, stock });
  return { db, stock, requests, op: createOpStock({ db, stock, requests }) };
}

const SESSION = { person_id: 5, display_name: 'Simone', is_sandbox: false };
const SANDBOX = { person_id: 8, display_name: '🧪 Sandbox', is_sandbox: true };

describe('op-stock — take (peguei do estoque)', () => {
  test('pick vira PROPOSTA pendente, sem nenhum movimento no livro-razão', async () => {
    const { db, stock, op } = build();
    const out = await op.take(SESSION, { product_id: 10, qty: 3, kind: 'pick', reason: 'pedido 12-345' });
    expect(out.status).toBeUndefined();          // 200
    expect(out.body).toMatchObject({ ok: true, kind: 'take', status: 'pending' });
    expect(out.body.request_id).toBeTruthy();
    // R076 morreu: NADA foi escrito em v3.stock_movements
    expect(db.state.movements).toHaveLength(0);
    expect(stock.pick).not.toHaveBeenCalled();
    const req = db.state.requests[0];
    expect(req).toMatchObject({ kind: 'take', direction: 'out', qty: 3, status: 'pending',
      proposed_by_person_id: 5, proposed_by_login: 'Simone', is_test: false });
    expect(req.reason).toBe('pedido 12-345');
    expect(db.state.audit.map((a) => a.action)).toContain('stock_request.propose');
  });

  test('sandbox propõe com is_test true (não contamina o estoque real)', async () => {
    const { db, op } = build();
    await op.take(SANDBOX, { product_id: 10, qty: 1, kind: 'pick' });
    expect(db.state.requests[0].is_test).toBe(true);
    expect(db.state.requests[0].proposed_by_person_id).toBe(8);
  });

  test('damaged aplica na hora via separate → issue nas Separadas', async () => {
    const { db, stock, op } = build();
    const out = await op.take(SESSION, { product_id: 10, qty: 2, kind: 'damaged', reason: 'label torta' });
    expect(out.body).toMatchObject({ ok: true, kind: 'damaged', applied: 2 });
    expect(out.body.issue_id).toBeTruthy();
    expect(stock.separate).toHaveBeenCalledTimes(1);
    const p = stock.separate.mock.calls[0][0];
    expect(p).toMatchObject({ product_id: 10, qty: 2, reason: 'other', person_id: 5, source: 'op_kiosk' });
    expect(p.note).toBe('label torta');
    // danificada NÃO cria proposta: é fato consumado
    expect(db.state.requests).toHaveLength(0);
  });

  test('damaged com reason label/seal usa o motivo real; qualquer outro cai em other', async () => {
    const { stock, op } = build();
    await op.take(SESSION, { product_id: 10, qty: 1, kind: 'damaged', reason: 'label' });
    await op.take(SESSION, { product_id: 10, qty: 1, kind: 'damaged', reason: 'seal' });
    await op.take(SESSION, { product_id: 10, qty: 1, kind: 'damaged', reason: 'caiu no chão' });
    expect(stock.separate.mock.calls.map((c) => c[0].reason)).toEqual(['label', 'seal', 'other']);
  });

  test('validações: produto e quantidade (400, nunca 500)', async () => {
    const { op } = build();
    expect((await op.take(SESSION, { qty: 1, kind: 'pick' })).status).toBe(400);
    expect((await op.take(SESSION, { product_id: 10, qty: 0 })).status).toBe(400);
    expect((await op.take(SESSION, { product_id: 10, qty: 9999999 })).status).toBe(400);
    expect((await op.take(SESSION, { product_id: 10, qty: 'abc' })).status).toBe(400);
  });
});

describe('op-stock — propose (entrada / contagem / devolução)', () => {
  test('entrada vira proposta direction in', async () => {
    const { db, op } = build();
    const out = await op.propose(SESSION, { product_id: 11, kind: 'entrada', qty: 80, reason: 'chegou da linha' });
    expect(out.body).toMatchObject({ ok: true, kind: 'entrada', status: 'pending' });
    expect(db.state.requests[0]).toMatchObject({ kind: 'entrada', direction: 'in', qty: 80 });
  });

  test('count SEM bin nem box é 400 location_required', async () => {
    const { db, op } = build();
    const out = await op.propose(SESSION, { product_id: 10, kind: 'count', qty: 17 });
    expect(out.status).toBe(400);
    expect(out.body.error).toBe('location_required');
    expect(db.state.requests).toHaveLength(0);
  });

  test('count COM bin registra a nota da contagem', async () => {
    const { db, op } = build();
    const out = await op.propose(SESSION, { product_id: 10, kind: 'count', qty: 17, bin_id: 4 });
    expect(out.body.status).toBe('pending');
    expect(db.state.requests[0]).toMatchObject({ kind: 'count', direction: 'in', qty: 17, bin_id: 4 });
    expect(db.state.requests[0].note).toBe('contagem: found=17');
  });

  test('return_in aceita box_id; kind desconhecido é 400', async () => {
    const { db, op } = build();
    await op.propose(SESSION, { product_id: 10, kind: 'return_in', qty: 2, box_id: 9 });
    expect(db.state.requests[0]).toMatchObject({ kind: 'return_in', direction: 'in', box_id: 9 });
    const bad = await op.propose(SESSION, { product_id: 10, kind: 'take', qty: 2 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('kind_invalid');
  });

  test('propose sem produto/qty é 400', async () => {
    const { op } = build();
    expect((await op.propose(SESSION, { kind: 'entrada', qty: 5 })).body.error).toBe('product_required');
    expect((await op.propose(SESSION, { product_id: 10, kind: 'entrada', qty: 0 })).body.error).toBe('qty_required');
  });
});

describe('op-stock — recent (Registrado hoje)', () => {
  test('junta propostas + danificadas + reposições, mais novo primeiro, com estado', async () => {
    const { db, op } = build();
    const t = (min) => new Date(Date.UTC(2026, 7, 18, 12, min, 0)).toISOString();
    await op.take(SESSION, { product_id: 10, qty: 3, kind: 'pick', reason: 'pedido' });
    db.state.requests[0].created_at = t(10);
    await op.propose(SESSION, { product_id: 11, kind: 'entrada', qty: 50 });
    db.state.requests[1].created_at = t(30);
    db.state.requests[1].status = 'approved';
    await op.take(SESSION, { product_id: 10, qty: 1, kind: 'damaged', reason: 'lacre' });
    db.state.issues[0].created_at = t(20);
    db.state.movements.push({ id: 77, kind: 'restock', product_id: 10, qty: 12,
      person_id: 5, is_test: false, note: 'repôs a prateleira', created_at: t(40) });

    const { items } = (await op.recent(SESSION)).body;
    expect(items.map((i) => i.kind)).toEqual(['restock', 'entrada', 'damaged', 'take']);
    expect(items.map((i) => i.status)).toEqual(['applied', 'approved', 'applied', 'pending']);
    expect(items.map((i) => i.qty)).toEqual([12, 50, 1, 3]);
    const take = items[3];
    expect(take.product).toBe('Magnesium Glycinate');
    expect(take.nickname).toBe('Mag');
    expect(take.note).toBe('pedido');
    // ids únicos entre fontes diferentes (req/issue/mov nunca colidem)
    expect(new Set(items.map((i) => i.id)).size).toBe(4);
  });

  test('proposta recusada aparece como rejected', async () => {
    const { db, requests, op } = build();
    const out = await op.take(SESSION, { product_id: 10, qty: 3, kind: 'pick' });
    await requests.reject({ id: out.body.request_id, login: 'Admin' });
    const { items } = (await op.recent(SESSION)).body;
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('rejected');
  });

  test('cada operador vê só o que ele registrou, e sandbox só o de teste', async () => {
    const { db, op } = build();
    await op.take(SESSION, { product_id: 10, qty: 3, kind: 'pick' });
    await op.take(SANDBOX, { product_id: 10, qty: 4, kind: 'pick' });
    const mine = (await op.recent(SESSION)).body.items;
    const sand = (await op.recent(SANDBOX)).body.items;
    expect(mine).toHaveLength(1);
    expect(mine[0].qty).toBe(3);
    expect(sand).toHaveLength(1);
    expect(sand[0].qty).toBe(4);
  });

  test('teto de 30 itens', async () => {
    const { db, op } = build();
    for (let i = 0; i < 35; i++) await op.take(SESSION, { product_id: 10, qty: 1, kind: 'pick' });
    const { items } = (await op.recent(SESSION)).body;
    expect(items.length).toBe(30);
  });
});
