'use strict';
/**
 * MODO SIMPLES — POST /api/v3/warehouse/simple/set (Fase 1, mutirão da carga).
 *  1. quantidade ABSOLUTA por escopo (shelf|box|unplaced): delta vs sistema,
 *     SÓ verbos do StockService (subir: storeIn+place; descer: count/adjust)
 *  2. locais nascem aqui: prateleira via bin_code, caixa com número BX
 *     alocado pelo MESMO alocador da aprovação
 *  3. 2+ locais do mesmo tipo → 409 multi_location (o simples não chuta)
 *  4. idempotente por client_ref (source_ref 'simpleset:<uuid>')
 *  5. escopo unplaced conserta a célula "A organizar" que nunca salvava
 *     (branch unplaced do adjust, StockService REAL testado aqui)
 *  6. contrato B: _buildRow ganha home_bin/main_box, overview ganha
 *     simple_progress
 * DB/StockService mockados no módulo; StockService REAL com mini-DB nos testes
 * do verbo; Express de verdade nos testes de rota. PINs FICTÍCIOS.
 */
const express = require('express');
const { createSimpleSet, simpleProgress, SCOPES } = require('../v3/warehouse/simple-set');
const { StockService } = require('../v3/services/StockService');
const { createWarehouseRouter } = require('../v3/warehouse/router');

const REF = '3f1c2a34-9d2b-4e64-8a11-0c9d6b7e5f10';
const REF2 = '9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const CTX = { person_id: 7, login: 'Henrique' };

// ── fixtures do módulo: estado em memória + verbos que atualizam o estado ──

function makeState(over = {}) {
  return { bins: [], boxes: [], unplaced: 0, veeqo: null, refs: new Set(),
    nextId: 1, ...over };
}

function makeDb(state) {
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      if (/FROM v3\.stock_bins WHERE product_id/.test(q)) {
        return { rows: state.bins.filter((b) => b.product_id === params[0] && b.active !== false) };
      }
      if (/FROM v3\.stock_boxes WHERE product_id/.test(q)) {
        return { rows: state.boxes.filter((x) => x.product_id === params[0] && x.status !== 'empty') };
      }
      if (/FROM v3\.stock_unplaced WHERE product_id/.test(q)) {
        return { rows: state.unplaced > 0 ? [{ qty: state.unplaced }] : [] };
      }
      if (/box_number ~ /.test(q)) {   // alocador BX (mesma query da aprovação)
        const nums = state.boxes.map((b) => b.box_number)
          .filter((n) => /^BX-[0-9]+$/.test(n))
          .sort((a, b) => Number(b.slice(3)) - Number(a.slice(3)));
        return { rows: nums.length ? [{ box_number: nums[0] }] : [] };
      }
      return { rows: [] };
    },
  };
}

function makeLocations(state) {
  return {
    upsertBin: jest.fn(async (p) => {
      const existing = state.bins.find((b) => b.bin_code === p.bin_code);
      if (existing) return { ...existing };
      const bin = { id: state.nextId++, bin_code: p.bin_code, product_id: p.product_id, qty: 0, active: true };
      state.bins.push(bin);
      return { ...bin };
    }),
    upsertBox: jest.fn(async (p) => {
      const box = { id: state.nextId++, box_number: p.box_number, product_id: p.product_id,
        box_type_id: p.box_type_id || null, qty: 0, status: 'in_storage' };
      state.boxes.push(box);
      return { ...box };
    }),
  };
}

/** Verbos mockados que APLICAM no estado (pra idempotência de verdade). */
function makeStock(state) {
  const dedupe = (ref) => {
    if (ref && state.refs.has(ref)) return true;
    if (ref) state.refs.add(ref);
    return false;
  };
  return {
    storeIn: jest.fn(async (p) => {
      if (dedupe(p.source_ref)) return { movement: { id: 1 }, duplicate: true, applied: 0 };
      state.unplaced += p.qty;
      return { movement: { id: 900 }, duplicate: false, applied: p.qty };
    }),
    place: jest.fn(async (p) => {
      if (dedupe(p.source_ref)) return { movement: { id: 1 }, duplicate: true, applied: 0 };
      const applied = Math.min(state.unplaced, p.qty);
      state.unplaced -= applied;
      const dest = p.bin_id ? state.bins.find((b) => b.id === p.bin_id)
        : state.boxes.find((x) => x.id === p.box_id);
      if (dest) dest.qty += applied;
      return { movement: { id: 901 }, duplicate: false, applied };
    }),
    count: jest.fn(async (p) => {
      if (dedupe(p.source_ref)) return { movement: { id: 1 }, duplicate: true, applied: 0 };
      const dest = p.bin_id ? state.bins.find((b) => b.id === p.bin_id)
        : state.boxes.find((x) => x.id === p.box_id);
      const expected = dest ? dest.qty : 0;
      if (dest) dest.qty = p.found;
      return { movement: { id: 902 }, duplicate: false, applied: p.found - expected };
    }),
    adjust: jest.fn(async (p) => {
      if (dedupe(p.source_ref)) return { movement: { id: 1 }, duplicate: true, applied: 0 };
      const before = state.unplaced;
      state.unplaced = Math.max(0, before + p.qty);
      return { movement: { id: 903 }, duplicate: false, applied: state.unplaced - before };
    }),
  };
}

function makeDeps(state) {
  const db = makeDb(state);
  const stock = makeStock(state);
  const locations = makeLocations(state);
  const rowsWithVeeqo = jest.fn(async (pid) => {
    const shelf = state.bins.reduce((n, b) => n + b.qty, 0);
    const box = state.boxes.reduce((n, x) => n + x.qty, 0);
    const total = shelf + box + state.unplaced;
    return [{ product_id: pid || 10, shelf_qty: shelf, box_qty: box,
      unplaced_qty: state.unplaced, total, veeqo_total: state.veeqo }];
  });
  return { db, stock, locations, rowsWithVeeqo,
    simple: createSimpleSet({ db, stock, locations, rowsWithVeeqo }) };
}

// ── validação ──────────────────────────────────────────────

describe('simple/set — validação', () => {
  test.each([
    [{}, /product_id/],
    [{ product_id: 10 }, /scope/],
    [{ product_id: 10, scope: 'palete' }, /scope/],
    [{ product_id: 10, scope: 'shelf' }, /qty/],
    [{ product_id: 10, scope: 'shelf', qty: -1 }, /qty/],
    [{ product_id: 10, scope: 'shelf', qty: 3.5 }, /qty/],
    [{ product_id: 10, scope: 'shelf', qty: 20001 }, /qty/],
    [{ product_id: 10, scope: 'shelf', qty: 5 }, /client_ref/],
    [{ product_id: 10, scope: 'shelf', qty: 5, client_ref: 'abc' }, /client_ref/],
  ])('corpo ruim %# → erro em PT-BR, nada escrito', async (body, re) => {
    const { simple, stock } = makeDeps(makeState());
    await expect(simple.set(body, CTX)).rejects.toThrow(re);
    expect(stock.storeIn).not.toHaveBeenCalled();
    expect(stock.count).not.toHaveBeenCalled();
    expect(stock.adjust).not.toHaveBeenCalled();
  });

  test('os 3 escopos do contrato', () => {
    expect(SCOPES).toEqual(['shelf', 'box', 'unplaced']);
  });
});

// ── shelf: do zero absoluto até descer por contagem ────────

describe('simple/set — prateleira', () => {
  test('do zero COM bin_code: cria a prateleira + storeIn + place nela', async () => {
    const state = makeState({ veeqo: 23 });
    const { simple, stock, locations } = makeDeps(state);
    const out = await simple.set({ product_id: 10, scope: 'shelf', qty: 23,
      bin_code: 'a03b2', client_ref: REF }, CTX);
    expect(locations.upsertBin).toHaveBeenCalledWith({ bin_code: 'A03B2', product_id: 10 });
    const si = stock.storeIn.mock.calls[0][0];
    expect(si).toMatchObject({ product_id: 10, qty: 23, person_id: 7,
      actor_type: 'admin', source: 'warehouse_simple', source_ref: 'simpleset:' + REF });
    expect(si.note).toContain('prateleira contada 23');
    expect(stock.place.mock.calls[0][0]).toMatchObject({
      qty: 23, bin_id: state.bins[0].id, source_ref: 'simpleset:' + REF + ':place' });
    expect(out.applied).toBe(23);
    expect(out.summary).toMatchObject({ product_id: 10, shelf_qty: 23, total: 23,
      veeqo_total: 23, delta_veeqo: 0, match: true,
      home_bin: { id: state.bins[0].id, bin_code: 'A03B2' }, main_box: null });
  });

  test('do zero SEM bin_code: erro claro pedindo o código', async () => {
    const { simple, stock } = makeDeps(makeState());
    await expect(simple.set({ product_id: 10, scope: 'shelf', qty: 23,
      client_ref: REF }, CTX)).rejects.toThrow(/bin_code obrigatório/);
    expect(stock.storeIn).not.toHaveBeenCalled();
  });

  test('bin_code de prateleira de OUTRO produto → erro, nada escrito', async () => {
    const state = makeState({ bins: [{ id: 4, bin_code: 'A01A1', product_id: 99, qty: 5, active: true }] });
    const { simple, stock } = makeDeps(state);
    await expect(simple.set({ product_id: 10, scope: 'shelf', qty: 23,
      bin_code: 'A01A1', client_ref: REF }, CTX)).rejects.toThrow(/já pertence a outro produto/);
    expect(stock.storeIn).not.toHaveBeenCalled();
  });

  test('descer usa count(found = alvo), o verbo ABSOLUTO', async () => {
    const state = makeState({ bins: [{ id: 4, bin_code: 'A03', product_id: 10, qty: 30, active: true }] });
    const { simple, stock } = makeDeps(state);
    const out = await simple.set({ product_id: 10, scope: 'shelf', qty: 23, client_ref: REF }, CTX);
    expect(stock.count).toHaveBeenCalledTimes(1);
    expect(stock.count.mock.calls[0][0]).toMatchObject({
      bin_id: 4, found: 23, source: 'warehouse_simple', source_ref: 'simpleset:' + REF });
    expect(stock.storeIn).not.toHaveBeenCalled();
    expect(out.applied).toBe(-7);
    expect(out.summary.shelf_qty).toBe(23);
  });

  test('qty igual ao sistema: nenhum verbo, resposta fresca mesmo assim', async () => {
    const state = makeState({ bins: [{ id: 4, bin_code: 'A03', product_id: 10, qty: 23, active: true }], veeqo: 25 });
    const { simple, stock } = makeDeps(state);
    const out = await simple.set({ product_id: 10, scope: 'shelf', qty: 23, client_ref: REF }, CTX);
    expect(stock.storeIn).not.toHaveBeenCalled();
    expect(stock.count).not.toHaveBeenCalled();
    expect(out.applied).toBe(0);
    expect(out.summary).toMatchObject({ total: 23, veeqo_total: 25, delta_veeqo: -2, match: false });
  });

  test('2+ prateleiras → 409 multi_location apontando o Modo completo', async () => {
    const state = makeState({ bins: [
      { id: 4, bin_code: 'A03', product_id: 10, qty: 10, active: true },
      { id: 5, bin_code: 'B01', product_id: 10, qty: 5, active: true }] });
    const { simple, stock } = makeDeps(state);
    const err = await simple.set({ product_id: 10, scope: 'shelf', qty: 23, client_ref: REF }, CTX)
      .then(() => null, (e) => e);
    expect(err.code).toBe('multi_location');
    expect(err.status).toBe(409);
    expect(err.message).toContain('A03, B01');
    expect(err.message).toContain('Modo completo');
    expect(stock.storeIn).not.toHaveBeenCalled();
    expect(stock.count).not.toHaveBeenCalled();
  });
});

// ── caixa: número BX automático ────────────────────────────

describe('simple/set — caixa', () => {
  test('sem caixa: aloca BX-0001 e faz storeIn + place nela', async () => {
    const state = makeState();
    const { simple, stock, locations } = makeDeps(state);
    const out = await simple.set({ product_id: 10, scope: 'box', qty: 88,
      box_type_id: 3, client_ref: REF }, CTX);
    expect(locations.upsertBox).toHaveBeenCalledWith({
      box_number: 'BX-0001', product_id: 10, box_type_id: 3 });
    expect(stock.place.mock.calls[0][0]).toMatchObject({
      qty: 88, box_id: state.boxes[0].id, source_ref: 'simpleset:' + REF + ':place' });
    expect(out.summary).toMatchObject({ box_qty: 88, total: 88,
      main_box: { id: state.boxes[0].id, box_number: 'BX-0001', box_type_id: 3 } });
  });

  test('número segue o maior BX existente (mesmo alocador da aprovação)', async () => {
    const state = makeState({ boxes: [
      { id: 1, box_number: 'BX-0451', product_id: 99, qty: 4, status: 'in_storage', box_type_id: null }] });
    const { simple, locations } = makeDeps(state);
    await simple.set({ product_id: 10, scope: 'box', qty: 12, client_ref: REF }, CTX);
    expect(locations.upsertBox.mock.calls[0][0].box_number).toBe('BX-0452');
  });

  test('descer caixa usa count(found = alvo) na caixa', async () => {
    const state = makeState({ boxes: [
      { id: 6, box_number: 'BX-0002', product_id: 10, qty: 100, status: 'in_storage', box_type_id: null }] });
    const { simple, stock } = makeDeps(state);
    const out = await simple.set({ product_id: 10, scope: 'box', qty: 88, client_ref: REF }, CTX);
    expect(stock.count.mock.calls[0][0]).toMatchObject({ box_id: 6, found: 88 });
    expect(out.summary.box_qty).toBe(88);
  });

  test('2+ caixas → 409 multi_location', async () => {
    const state = makeState({ boxes: [
      { id: 6, box_number: 'BX-0001', product_id: 10, qty: 50, status: 'in_storage', box_type_id: null },
      { id: 7, box_number: 'BX-0002', product_id: 10, qty: 50, status: 'in_storage', box_type_id: null }] });
    const { simple } = makeDeps(state);
    const err = await simple.set({ product_id: 10, scope: 'box', qty: 88, client_ref: REF }, CTX)
      .then(() => null, (e) => e);
    expect(err.code).toBe('multi_location');
    expect(err.status).toBe(409);
  });
});

// ── a organizar: a célula que nunca salvava ────────────────

describe('simple/set — a organizar (fix do nunca-salva)', () => {
  test('subir: storeIn sem bin nem caixa (cai no bucket)', async () => {
    const state = makeState({ unplaced: 10 });
    const { simple, stock } = makeDeps(state);
    const out = await simple.set({ product_id: 10, scope: 'unplaced', qty: 35, client_ref: REF }, CTX);
    const p = stock.storeIn.mock.calls[0][0];
    expect(p).toMatchObject({ product_id: 10, qty: 25, source_ref: 'simpleset:' + REF });
    expect(p.bin_id).toBeUndefined();
    expect(p.box_id).toBeUndefined();
    expect(stock.place).not.toHaveBeenCalled();
    expect(out.summary.unplaced_qty).toBe(35);
  });

  test('descer: adjust com o branch unplaced (não existia verbo pra isso)', async () => {
    const state = makeState({ unplaced: 35 });
    const { simple, stock } = makeDeps(state);
    const out = await simple.set({ product_id: 10, scope: 'unplaced', qty: 20, client_ref: REF }, CTX);
    expect(stock.adjust.mock.calls[0][0]).toMatchObject({
      product_id: 10, qty: -15, unplaced: true, source_ref: 'simpleset:' + REF });
    expect(out.applied).toBe(-15);
    expect(out.summary.unplaced_qty).toBe(20);
  });

  test('zerar o bucket funciona (qty 0 é válido)', async () => {
    const state = makeState({ unplaced: 8 });
    const { simple } = makeDeps(state);
    const out = await simple.set({ product_id: 10, scope: 'unplaced', qty: 0, client_ref: REF }, CTX);
    expect(out.summary.unplaced_qty).toBe(0);
  });
});

// ── idempotência ───────────────────────────────────────────

describe('simple/set — idempotência por client_ref', () => {
  test('mesmo client_ref duas vezes = aplicado UMA vez (retry recalcula delta 0)', async () => {
    const state = makeState({ veeqo: 23 });
    const { simple, stock } = makeDeps(state);
    const a = await simple.set({ product_id: 10, scope: 'shelf', qty: 23,
      bin_code: 'A03', client_ref: REF }, CTX);
    const b = await simple.set({ product_id: 10, scope: 'shelf', qty: 23,
      bin_code: 'A03', client_ref: REF }, CTX);
    expect(a.applied).toBe(23);
    expect(b.applied).toBe(0);               // já batia: nenhum verbo de novo
    expect(stock.storeIn).toHaveBeenCalledTimes(1);
    expect(b.summary.total).toBe(23);        // e não 46
  });

  test('mundo mudou no meio: o ON CONFLICT do StockService recusa o mesmo ref', async () => {
    const state = makeState();
    const { simple, stock } = makeDeps(state);
    await simple.set({ product_id: 10, scope: 'unplaced', qty: 30, client_ref: REF }, CTX);
    state.unplaced = 12;                     // alguém mexeu por fora
    const out = await simple.set({ product_id: 10, scope: 'unplaced', qty: 30, client_ref: REF }, CTX);
    expect(stock.storeIn).toHaveBeenCalledTimes(2);
    expect(out.applied).toBe(0);             // dedupe do verbo segurou
    expect(out.duplicate).toBe(true);
    expect(state.unplaced).toBe(12);
  });

  test('client_ref DIFERENTE aplica de novo (é outra contagem)', async () => {
    const state = makeState();
    const { simple } = makeDeps(state);
    await simple.set({ product_id: 10, scope: 'unplaced', qty: 30, client_ref: REF }, CTX);
    const out = await simple.set({ product_id: 10, scope: 'unplaced', qty: 45, client_ref: REF2 }, CTX);
    expect(out.applied).toBe(15);
    expect(state.unplaced).toBe(45);
  });
});

// ── simple_progress (contrato B) ───────────────────────────

describe('simpleProgress — o placar do mutirão', () => {
  test('conta produtos, quantos batem e as garrafas dos dois lados', () => {
    const rows = [
      { total: 111, veeqo_total: 111 },      // bate
      { total: 20, veeqo_total: 25 },        // não bate
      { total: 0, veeqo_total: 0 },          // bate (zerado dos dois lados)
      { total: 7, veeqo_total: null },       // sem Veeqo: não conta em matching/veeqo
    ];
    expect(simpleProgress(rows)).toEqual({
      products: 4, matching: 2, bottles_counted: 138, veeqo_bottles: 136 });
  });

  test('vazio: tudo zero', () => {
    expect(simpleProgress([])).toEqual({
      products: 0, matching: 0, bottles_counted: 0, veeqo_bottles: 0 });
  });
});

// ── StockService REAL: os dois retoques que o modo simples precisou ──

function miniDb() {
  const state = { movements: [], unplaced: new Map(), bins: new Map(),
    boxes: new Map(), audit: [], nextId: 1 };
  const db = {
    state,
    async connect() { return db; },
    release() {},
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK') return {};
      if (q.startsWith('SELECT * FROM v3.stock_movements WHERE source')) {
        const f = state.movements.find((m) => m.source === params[0] && m.source_ref === params[1]);
        return { rows: f ? [{ ...f }] : [] };
      }
      if (q.startsWith('INSERT INTO v3.stock_movements')) {
        const [kind, product_id, qty, bin_id, box_id, , source, source_ref] = params;
        if (source_ref && state.movements.some((m) => m.source === source && m.source_ref === source_ref)) {
          return { rows: [] };                       // ON CONFLICT DO NOTHING
        }
        const row = { id: state.nextId++, kind, product_id, qty, bin_id, box_id,
          source, source_ref, note: params[9] };
        state.movements.push(row);
        return { rows: [{ ...row }] };
      }
      if (/FROM v3\.stock_unplaced WHERE product_id/.test(q)) {
        const qty = state.unplaced.get(params[0]);
        return { rows: qty != null ? [{ product_id: params[0], qty }] : [] };
      }
      if (q.startsWith('INSERT INTO v3.stock_unplaced')) {
        state.unplaced.set(params[0], params[1]); return {};
      }
      if (/SELECT \* FROM v3\.stock_bins WHERE id/.test(q)) {
        const b = state.bins.get(params[0]); return { rows: b ? [{ ...b }] : [] };
      }
      if (q.startsWith('UPDATE v3.stock_bins SET qty')) {
        const b = state.bins.get(params[0]); if (b) b.qty = params[1]; return {};
      }
      if (q.startsWith('INSERT INTO v3.audit_log')) { state.audit.push(params[2]); return {}; }
      return { rows: [] };
    },
  };
  return db;
}

describe('StockService.adjust — branch unplaced (célula "A organizar")', () => {
  test('sem bin/caixa e sem unplaced: erro CLARO em PT-BR (era o 400 cru do hub)', async () => {
    const svc = new StockService({ db: miniDb() });
    await expect(svc.adjust({ product_id: 10, qty: -3, note: 'contagem' }))
      .rejects.toThrow(/precisa de uma prateleira ou caixa.*Modo simples/);
  });

  test('unplaced:true desce o bucket, floor em 0, movimento adjust sem local', async () => {
    const db = miniDb();
    db.state.unplaced.set(10, 5);
    const svc = new StockService({ db });
    const out = await svc.adjust({ product_id: 10, qty: -3, unplaced: true,
      note: 'contagem do mutirão', source: 'warehouse_simple', source_ref: 'simpleset:x1' });
    expect(out.applied).toBe(-3);
    expect(db.state.unplaced.get(10)).toBe(2);
    const m = db.state.movements[0];
    expect(m.kind).toBe('adjust');
    expect(m.bin_id).toBeNull();
    expect(m.box_id).toBeNull();
    // floor: descer mais do que tem para em 0
    await svc.adjust({ product_id: 10, qty: -99, unplaced: true, note: 'zera' });
    expect(db.state.unplaced.get(10)).toBe(0);
  });

  test('idempotente: mesmo source_ref não aplica duas vezes', async () => {
    const db = miniDb();
    db.state.unplaced.set(10, 8);
    const svc = new StockService({ db });
    await svc.adjust({ product_id: 10, qty: -3, unplaced: true, note: 'n',
      source: 'warehouse_simple', source_ref: 'simpleset:dup' });
    const again = await svc.adjust({ product_id: 10, qty: -3, unplaced: true, note: 'n',
      source: 'warehouse_simple', source_ref: 'simpleset:dup' });
    expect(again.duplicate).toBe(true);
    expect(again.applied).toBe(0);
    expect(db.state.unplaced.get(10)).toBe(5);   // e não 2
  });
});

describe('StockService.count — carrega o source_ref (idempotência do modo simples)', () => {
  test('count grava o source_ref no movimento e recusa a repetição', async () => {
    const db = miniDb();
    db.state.bins.set(4, { id: 4, product_id: 10, bin_code: 'A03', qty: 30 });
    const svc = new StockService({ db });
    const out = await svc.count({ bin_id: 4, found: 23,
      source: 'warehouse_simple', source_ref: 'simpleset:c1' });
    expect(out.applied).toBe(-7);
    expect(db.state.movements[0].source_ref).toBe('simpleset:c1');
    expect(db.state.bins.get(4).qty).toBe(23);
    db.state.bins.get(4).qty = 30;               // alguém repôs no meio
    const again = await svc.count({ bin_id: 4, found: 23,
      source: 'warehouse_simple', source_ref: 'simpleset:c1' });
    expect(again.duplicate).toBe(true);
    expect(db.state.bins.get(4).qty).toBe(30);   // dedupe segurou o segundo set
  });
});

// ── rota de verdade: auth, envelope, audit, overview ───────

const ADMIN_PIN = '111111';    // fictício: manage_stock
const VIEWER_PIN = '222222';   // fictício: só view_stock

function makeRouterDb(state) {
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      if (/FROM v3\.app_logins l/.test(q)) {
        const map = {
          [ADMIN_PIN]: { id: 1, name: 'Henrique', role: 'manager', rank: 50, functions: ['view_stock', 'manage_stock'] },
          [VIEWER_PIN]: { id: 2, name: 'Visitante', role: 'viewer', rank: 20, functions: ['view_stock'] },
        };
        const l = map[params[0]];
        return { rows: l ? [l] : [] };
      }
      if (q.startsWith('INSERT INTO v3.audit_log')) { state.audit.push({ action: params[1], meta: params[4] }); return { rows: [] }; }
      if (/COUNT\(\*\)::int AS count/.test(q) && /stock_change_requests/.test(q)) {
        return { rows: [{ count: 0, oldest_age_min: null }] };
      }
      if (/FROM v3\.stock_bins WHERE product_id/.test(q)) {
        return { rows: state.bins.filter((b) => b.product_id === params[0] && b.active !== false) };
      }
      if (/FROM v3\.stock_boxes WHERE product_id/.test(q)) {
        return { rows: state.boxes.filter((x) => x.product_id === params[0] && x.status === 'in_storage') };
      }
      if (/FROM v3\.stock_unplaced WHERE product_id/.test(q)) {
        return { rows: state.unplaced > 0 ? [{ qty: state.unplaced }] : [] };
      }
      if (q.startsWith('INSERT INTO v3.stock_bins')) {
        const bin = { id: 77, bin_code: params[0], shelf_code: params[1], area: params[2],
          product_id: params[3], qty: 0, active: true };
        state.bins.push(bin); return { rows: [bin] };
      }
      if (q.startsWith('INSERT INTO v3.stock_boxes')) {
        const box = { id: 88, box_number: params[0], area: params[1], product_id: params[2],
          box_type_id: params[3] || null, qty: 0, status: 'in_storage' };
        state.boxes.push(box); return { rows: [box] };
      }
      return { rows: [] };
    },
  };
}

function routerRow(over = {}) {
  return {
    product_id: 10, name: 'Berberine', nickname: 'BERB', bottle_color: 'black',
    base_sku: 'HF-BERB', skus: [], children: [],
    shelf_qty: 0, box_qty: 0, unplaced_qty: 0, total: 0,
    reserved: 0, pending_out: 0, pending_in: 0, available: 0, separated: 0,
    min_units: null, days_of_stock: null, veeqo: null, veeqo_match: 'unknown',
    status: ['out'], bins: [], boxes: [], home_bin: null, main_box: null,
    ...over,
  };
}

describe('POST /api/v3/warehouse/simple/set — a rota', () => {
  let server, base, state, stock;

  async function boot(rows, physical) {
    if (server) await new Promise((r) => server.close(r));
    state = { audit: [], bins: [], boxes: [], unplaced: 0 };
    stock = {
      overview: jest.fn(async (o) => rows.map((r) => JSON.parse(JSON.stringify(r)))),
      storeIn: jest.fn(async (p) => ({ movement: { id: 1 }, duplicate: false, applied: p.qty })),
      place: jest.fn(async (p) => ({ movement: { id: 2 }, duplicate: false, applied: p.qty })),
      count: jest.fn(async (p) => ({ movement: { id: 3 }, duplicate: false, applied: 0 })),
      adjust: jest.fn(async (p) => ({ movement: { id: 4 }, duplicate: false, applied: p.qty })),
    };
    const { createVeeqoCache } = require('../v3/warehouse/veeqo-cache');
    const veeqoCache = createVeeqoCache({ veeqo: { listSellables: async () => ([
      { sku: 'HF-BERB', type: 'variant', wh: { physical, allocated: 0, available: physical } }]) } });
    await veeqoCache.warm();
    const app = express();
    app.use('/', createWarehouseRouter({ db: makeRouterDb(state), stock,
      requests: { list: async () => [] }, veeqoCache }));
    server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
    base = `http://127.0.0.1:${server.address().port}`;
  }

  afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

  async function call(method, path, body, pin) {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(pin ? { 'x-admin-pin': pin } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let j = null; try { j = await r.json(); } catch (_) { j = null; }
    return { status: r.status, body: j };
  }

  test('view_stock não escreve: 403', async () => {
    await boot([routerRow()], 23);
    const r = await call('POST', '/api/v3/warehouse/simple/set',
      { product_id: 10, scope: 'shelf', qty: 23, bin_code: 'A03', client_ref: REF }, VIEWER_PIN);
    expect(r.status).toBe(403);
    expect(stock.storeIn).not.toHaveBeenCalled();
  });

  test('contrato A: {data:{...}} com números, check da Veeqo e locais; audit gravado', async () => {
    await boot([routerRow({ shelf_qty: 23, total: 23 })], 23);
    const r = await call('POST', '/api/v3/warehouse/simple/set',
      { product_id: 10, scope: 'shelf', qty: 23, bin_code: 'A03', client_ref: REF }, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      product_id: 10, veeqo_total: 23, shelf_qty: 23, box_qty: 0, unplaced_qty: 0,
      total: 23, delta_veeqo: 0, match: true,
      home_bin: { id: 77, bin_code: 'A03' }, main_box: null });
    expect(state.audit.some((a) => a.action === 'warehouse.simple_set')).toBe(true);
  });

  test('2 prateleiras → 409 {error:{code:multi_location}} no envelope padrão', async () => {
    await boot([routerRow()], 23);
    state.bins.push(
      { id: 1, bin_code: 'A03', product_id: 10, qty: 10, active: true },
      { id: 2, bin_code: 'B01', product_id: 10, qty: 5, active: true });
    const r = await call('POST', '/api/v3/warehouse/simple/set',
      { product_id: 10, scope: 'shelf', qty: 23, client_ref: REF }, ADMIN_PIN);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('multi_location');
    expect(r.body.error.message).toContain('Modo completo');
  });

  test('validação vira 400 bad_request com a mensagem em PT-BR', async () => {
    await boot([routerRow()], 23);
    const r = await call('POST', '/api/v3/warehouse/simple/set',
      { product_id: 10, scope: 'shelf', qty: 23, bin_code: 'A03' }, ADMIN_PIN);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('bad_request');
    expect(r.body.error.message).toMatch(/client_ref/);
  });

  test('overview ganha simple_progress (contrato B)', async () => {
    await boot([routerRow({ shelf_qty: 23, total: 23 })], 23);
    const r = await call('GET', '/api/v3/warehouse/overview', undefined, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data.simple_progress).toEqual({
      products: 1, matching: 1, bottles_counted: 23, veeqo_bottles: 23 });
  });
});
