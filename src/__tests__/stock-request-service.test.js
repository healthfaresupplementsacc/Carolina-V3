'use strict';
/**
 * StockRequestService — a fila de aprovação do Warehouse hub (S15 Fase 1).
 *  1. propor sempre registra (REGRA #0: ninguém é bloqueado)
 *  2. aprovar aplica EXATAMENTE uma vez, pelo StockService (porta única)
 *  3. aprovar de novo é no-op (idempotente) — dois cliques não deduzem duas vezes
 *  4. recusar fecha sem aplicar nada
 *  5. pendingByProduct devolve {product_id:{out,in}} pro número "pendente" da Row
 * Mini-DB em memória com o shape real da 071.
 */
const { StockRequestService } = require('../v3/services/StockRequestService');

function makeDb() {
  const state = { requests: [], audit: [], nextId: 1 };
  const clone = (o) => ({ ...o });
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
          decided_by_login: null, decided_at: null, applied_movement_id: null,
          created_at: new Date().toISOString() };
        state.requests.push(row);
        return { rows: [clone(row)] };
      }
      if (/SELECT \* FROM v3\.stock_change_requests WHERE id = \$1/.test(q)) {
        const r = state.requests.find((x) => x.id === params[0]);
        return { rows: r ? [clone(r)] : [] };
      }
      if (/UPDATE v3\.stock_change_requests SET status = 'approved'/.test(q)) {
        const r = state.requests.find((x) => x.id === params[0] && x.status === 'pending');
        if (!r) return { rows: [] };
        r.status = 'approved'; r.decided_by_login = params[1]; r.decided_by_person_id = params[2];
        r.decision_note = params[3]; r.applied_movement_id = params[4]; r.decided_at = new Date().toISOString();
        return { rows: [clone(r)] };
      }
      if (/UPDATE v3\.stock_change_requests SET status = 'rejected'/.test(q)) {
        const r = state.requests.find((x) => x.id === params[0]);
        if (!r) return { rows: [] };
        r.status = 'rejected'; r.decided_by_login = params[1]; r.decided_by_person_id = params[2];
        r.decision_note = params[3]; r.decided_at = new Date().toISOString();
        return { rows: [clone(r)] };
      }
      if (/FROM v3\.stock_change_requests q/.test(q)) {
        let rows = state.requests.map(clone);
        // filtros na ordem em que o service monta o WHERE
        if (/q\.status = \$1/.test(q)) rows = rows.filter((r) => r.status === params[0]);
        if (/q\.status IN \('approved','rejected'\)/.test(q)) rows = rows.filter((r) => r.status === 'approved' || r.status === 'rejected');
        if (/q\.product_id = \$1/.test(q)) rows = rows.filter((r) => r.product_id === params[0]);
        else if (/q\.product_id = \$2/.test(q)) rows = rows.filter((r) => r.product_id === params[1]);
        return { rows };
      }
      if (/SELECT product_id, direction, SUM\(qty\)/.test(q)) {
        const agg = new Map();
        for (const r of state.requests.filter((x) => x.status === 'pending')) {
          const k = r.product_id + '|' + r.direction;
          agg.set(k, (agg.get(k) || 0) + r.qty);
        }
        return { rows: [...agg.entries()].map(([k, qty]) => ({
          product_id: Number(k.split('|')[0]), direction: k.split('|')[1], qty })) };
      }
      if (q.startsWith('INSERT INTO v3.audit_log')) { state.audit.push({ action: params[2] }); return { rows: [] }; }
      throw new Error('query não mapeada no mock: ' + q.slice(0, 100));
    },
  };
  return api;
}

/** StockService falso: registra as chamadas e devolve um movimento. */
function fakeStock() {
  const calls = [];
  const mk = (name) => jest.fn(async (p) => {
    calls.push({ name, p });
    return { movement: { id: 900 + calls.length }, duplicate: false, applied: p.qty || p.found || 0 };
  });
  return { calls, pick: mk('pick'), storeIn: mk('storeIn'), count: mk('count'),
    adjust: mk('adjust'), resolveIssue: mk('resolveIssue') };
}

const svc = (db, stock) => new StockRequestService({ db, stock });

describe('StockRequestService — propor', () => {
  test('propor registra pending com quem propôs', async () => {
    const db = makeDb();
    const row = await svc(db, fakeStock()).propose({
      product_id: 10, kind: 'take', direction: 'out', qty: 3,
      reason: 'extra pro pedido 12-345', person_id: 5, login: 'Simone' });
    expect(row.status).toBe('pending');
    expect(row.qty).toBe(3);
    expect(row.proposed_by_login).toBe('Simone');
    expect(db.state.audit.map((a) => a.action)).toContain('stock_request.propose');
  });

  test('validações: kind/direction/qty', async () => {
    const s = svc(makeDb(), fakeStock());
    await expect(s.propose({ product_id: 1, kind: 'sei_la', direction: 'out', qty: 1 })).rejects.toThrow('kind inválido');
    await expect(s.propose({ product_id: 1, kind: 'take', direction: 'lado', qty: 1 })).rejects.toThrow('direction inválido');
    await expect(s.propose({ product_id: 1, kind: 'take', direction: 'out', qty: 0 })).rejects.toThrow('qty inválido');
    await expect(s.propose({ kind: 'take', direction: 'out', qty: 1 })).rejects.toThrow('product_id');
  });
});

describe('StockRequestService — aprovar', () => {
  test('take aprovado vira pick com allow_box e source_ref request:<id>', async () => {
    const db = makeDb(); const stock = fakeStock(); const s = svc(db, stock);
    const req = await s.propose({ product_id: 10, kind: 'take', direction: 'out', qty: 4, login: 'Simone' });
    const out = await s.approve({ id: req.id, login: 'Henrique', person_id: 7, note: 'ok' });
    expect(out.status).toBe('approved');
    expect(out.decided_by_login).toBe('Henrique');
    expect(out.applied_movement_id).toBeTruthy();
    expect(stock.pick).toHaveBeenCalledTimes(1);
    const p = stock.pick.mock.calls[0][0];
    expect(p.qty).toBe(4);
    expect(p.allow_box).toBe(true);
    expect(p.source).toBe('request');
    expect(p.source_ref).toBe('request:' + req.id);
    expect(db.state.audit.map((a) => a.action)).toContain('stock_request.approve');
  });

  test('aprovar duas vezes aplica UMA vez só (idempotente)', async () => {
    const db = makeDb(); const stock = fakeStock(); const s = svc(db, stock);
    const req = await s.propose({ product_id: 10, kind: 'take', direction: 'out', qty: 4 });
    const a = await s.approve({ id: req.id, login: 'Henrique' });
    const b = await s.approve({ id: req.id, login: 'Henrique' });
    expect(stock.pick).toHaveBeenCalledTimes(1);
    expect(a.status).toBe('approved');
    expect(b.status).toBe('approved');
    expect(b.id).toBe(a.id);
  });

  test('entrada aprovada vira storeIn (bin/caixa/a organizar)', async () => {
    const db = makeDb(); const stock = fakeStock(); const s = svc(db, stock);
    const req = await s.propose({ product_id: 10, kind: 'entrada', direction: 'in', qty: 80 });
    await s.approve({ id: req.id, login: 'Admin' });
    expect(stock.storeIn).toHaveBeenCalledTimes(1);
    const p = stock.storeIn.mock.calls[0][0];
    expect(p.qty).toBe(80);
    expect(p.bin_id).toBeNull();
    expect(p.box_id).toBeNull();      // sem local → a organizar
  });

  test('count aprovado vira count(found = qty) no bin', async () => {
    const db = makeDb(); const stock = fakeStock(); const s = svc(db, stock);
    const req = await s.propose({ product_id: 10, kind: 'count', direction: 'in', qty: 17, bin_id: 1 });
    await s.approve({ id: req.id, login: 'Admin' });
    expect(stock.count).toHaveBeenCalledTimes(1);
    expect(stock.count.mock.calls[0][0].found).toBe(17);
    expect(stock.count.mock.calls[0][0].bin_id).toBe(1);
  });

  test('issue_release com issue_id vira resolveIssue restocked', async () => {
    const db = makeDb(); const stock = fakeStock(); const s = svc(db, stock);
    const req = await s.propose({ product_id: 10, kind: 'issue_release', direction: 'in', qty: 2,
      issue_id: 44, bin_id: 1 });
    await s.approve({ id: req.id, login: 'Admin' });
    expect(stock.resolveIssue).toHaveBeenCalledTimes(1);
    const p = stock.resolveIssue.mock.calls[0][0];
    expect(p.issue_id).toBe(44);
    expect(p.action).toBe('restocked');
  });

  test('return_in sem issue_id cai em storeIn', async () => {
    const db = makeDb(); const stock = fakeStock(); const s = svc(db, stock);
    const req = await s.propose({ product_id: 10, kind: 'return_in', direction: 'in', qty: 6 });
    await s.approve({ id: req.id, login: 'Admin' });
    expect(stock.storeIn).toHaveBeenCalledTimes(1);
    expect(stock.resolveIssue).not.toHaveBeenCalled();
  });

  test('adjust direction out vira qty negativo', async () => {
    const db = makeDb(); const stock = fakeStock(); const s = svc(db, stock);
    const req = await s.propose({ product_id: 10, kind: 'adjust', direction: 'out', qty: 5,
      bin_id: 1, reason: 'quebrou no chão' });
    await s.approve({ id: req.id, login: 'Admin' });
    expect(stock.adjust.mock.calls[0][0].qty).toBe(-5);
    expect(stock.adjust.mock.calls[0][0].note).toMatch(/quebrou no chão/);
  });

  test('aprovar proposta inexistente rejeita', async () => {
    const s = svc(makeDb(), fakeStock());
    await expect(s.approve({ id: 999 })).rejects.toThrow('não existe');
  });
});

describe('StockRequestService — recusar', () => {
  test('recusar fecha sem chamar o StockService', async () => {
    const db = makeDb(); const stock = fakeStock(); const s = svc(db, stock);
    const req = await s.propose({ product_id: 10, kind: 'take', direction: 'out', qty: 4 });
    const out = await s.reject({ id: req.id, login: 'Henrique', note: 'não confere' });
    expect(out.status).toBe('rejected');
    expect(out.decision_note).toBe('não confere');
    expect(stock.pick).not.toHaveBeenCalled();
    expect(db.state.audit.map((a) => a.action)).toContain('stock_request.reject');
  });

  test('recusar já decidida devolve como está', async () => {
    const db = makeDb(); const stock = fakeStock(); const s = svc(db, stock);
    const req = await s.propose({ product_id: 10, kind: 'take', direction: 'out', qty: 4 });
    await s.approve({ id: req.id, login: 'Henrique' });
    const out = await s.reject({ id: req.id, login: 'Outro' });
    expect(out.status).toBe('approved');
    expect(stock.pick).toHaveBeenCalledTimes(1);
  });
});

describe('StockRequestService — leitura', () => {
  test('pendingByProduct soma out e in por produto, só pendentes', async () => {
    const db = makeDb(); const s = svc(db, fakeStock());
    await s.propose({ product_id: 10, kind: 'take', direction: 'out', qty: 3 });
    await s.propose({ product_id: 10, kind: 'take', direction: 'out', qty: 2 });
    await s.propose({ product_id: 10, kind: 'entrada', direction: 'in', qty: 50 });
    const decided = await s.propose({ product_id: 11, kind: 'take', direction: 'out', qty: 9 });
    await s.reject({ id: decided.id });
    const map = await s.pendingByProduct();
    expect(map[10]).toEqual({ out: 5, in: 50 });
    expect(map[11]).toBeUndefined();
  });

  test('list filtra por status', async () => {
    const db = makeDb(); const s = svc(db, fakeStock());
    const a = await s.propose({ product_id: 10, kind: 'take', direction: 'out', qty: 3 });
    await s.propose({ product_id: 10, kind: 'take', direction: 'out', qty: 4 });
    await s.reject({ id: a.id });
    const pend = await s.list({ status: 'pending' });
    expect(pend.length).toBe(1);
    expect(pend[0].qty).toBe(4);
    // 'decided' = histórico da página de Aprovações (approved OU rejected)
    const dec = await s.list({ status: 'decided' });
    expect(dec.length).toBe(1);
    expect(dec[0].status).toBe('rejected');
  });
});
