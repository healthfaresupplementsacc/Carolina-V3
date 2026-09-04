'use strict';
/**
 * veeqo-order-sync — GUARD do deducted_at (Fase 0 do MASTER-SYNC-PLAN, conflito 3).
 *
 * O bug provado pelo DEDUCT: em modo live o carimbo era gravado incondicional,
 * mesmo com pick applied=0 (armazém vazio) — e como o pick parcial CONSOME o
 * (source, source_ref), a linha nunca seria re-deduzida: sub-dedução silenciosa
 * permanente. As duas restrições inegociáveis do guard:
 *   1. NUNCA loop infinito (deixar NULL e re-tentar aplicaria 0 pra sempre);
 *   2. NUNCA furo silencioso.
 * Forma escolhida: carimba SEMPRE + error_note 'deducao parcial: X de Y'
 * + audit_log 'deduct_shortfall' + contador no retorno do tick; o resumo
 * diário sai no digest do stock-drift-alert.
 */
const { VeeqoOrderSync } = require('../workers/veeqo-order-sync');

const ORDER = {
  id: 500, number: 'HF100', channel: { name: 'eBay' },
  created_at: '2026-09-04T14:00:00Z', shipped_at: '2026-09-04T15:00:00Z',
  line_items: [{ id: 9, quantity: 2, sellable: { sku_code: 'HF-X-C2' } }],
};

function makeDb(state) {
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      state.queries.push({ q, params });
      if (/FROM v3\.product_skus/.test(q)) {
        return { rows: [{ sku: 'HF-X-C2', product_id: 7, units_per_pack: 2 }] };
      }
      if (/INSERT INTO v3\.pnp_order_lines/.test(q)) {
        // RETURNING * — devolve a linha como o banco a conhece AGORA
        return { rows: [{ id: 1, deducted_at: state.lineDeductedAt || null }] };
      }
      if (/UPDATE v3\.pnp_order_lines SET deducted_at/.test(q)) {
        state.stamps.push({ q, params });
        state.lineDeductedAt = new Date();   // o banco de verdade fica carimbado
        return { rows: [] };
      }
      if (/INSERT INTO v3\.audit_log/.test(q)) {
        state.audits.push({ q, meta: JSON.parse(params[params.length - 1]) });
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function boot({ deductMode = 'live', pickResult } = {}) {
  const state = { queries: [], stamps: [], audits: [], lineDeductedAt: null };
  const veeqo = {
    configured: () => true,
    getOrdersPage: jest.fn(async ({ status, page }) =>
      (status === 'shipped' && page === 1) ? [ORDER] : []),
  };
  const stock = { pick: jest.fn(async () => pickResult) };
  const worker = new VeeqoOrderSync({
    db: makeDb(state), veeqo, stock, enabled: true, deductMode,
  });
  return { state, worker, stock };
}

describe('guard do deducted_at (modo live)', () => {
  test('aplicou tudo: carimba limpo, sem error_note, sem audit, contador 0', async () => {
    const { state, worker, stock } = boot({
      pickResult: { movement: { id: 1, qty: -4 }, applied: 4, duplicate: false } });
    const out = await worker.tick();
    expect(stock.pick).toHaveBeenCalledTimes(1);
    expect(stock.pick.mock.calls[0][0]).toMatchObject({
      product_id: 7, qty: 4, source: 'veeqo_ship', source_ref: '500:9', allow_box: true });
    expect(state.stamps.length).toBe(1);
    expect(state.stamps[0].q).not.toContain('error_note');
    expect(state.audits.length).toBe(0);
    expect(out.deduct_shortfalls).toBe(0);
  });

  test('aplicou PARCIAL: carimba (sem loop) + error_note + audit deduct_shortfall + contador', async () => {
    const { state, worker } = boot({
      pickResult: { movement: { id: 1, qty: -1 }, applied: 1, duplicate: false } });
    const out = await worker.tick();
    expect(state.stamps.length).toBe(1);
    expect(state.stamps[0].q).toContain('error_note');
    expect(state.stamps[0].params[1]).toBe('deducao parcial: 1 de 4');
    expect(state.audits.length).toBe(1);
    expect(state.audits[0].q).toContain('deduct_shortfall');
    expect(state.audits[0].meta).toMatchObject({
      product_id: 7, sku: 'HF-X-C2', wanted: 4, applied: 1, missing: 3 });
    expect(state.audits[0].meta.ny_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(out.deduct_shortfalls).toBe(1);
  });

  test('aplicou ZERO (armazem vazio): mesmo tratamento, "0 de 4"', async () => {
    const { state, worker } = boot({
      pickResult: { movement: { id: 1, qty: 0 }, applied: 0, duplicate: false } });
    const out = await worker.tick();
    expect(state.stamps.length).toBe(1);
    expect(state.stamps[0].params[1]).toBe('deducao parcial: 0 de 4');
    expect(state.audits.length).toBe(1);
    expect(out.deduct_shortfalls).toBe(1);
  });

  test('SEM loop: no tick seguinte a linha carimbada nao e re-deduzida nem re-carimbada', async () => {
    const { state, worker, stock } = boot({
      pickResult: { movement: { id: 1, qty: 0 }, applied: 0, duplicate: false } });
    await worker.tick();
    const out2 = await worker.tick();     // linha volta do banco COM deducted_at
    expect(stock.pick).toHaveBeenCalledTimes(1);
    expect(state.stamps.length).toBe(1);
    expect(state.audits.length).toBe(1);
    expect(out2.deduct_shortfalls).toBe(0);
  });

  test('duplicate (crash entre pick e carimbo): recupera o applied real do movimento', async () => {
    // pick anterior aplicou os 4 (movement.qty=-4) mas o processo caiu antes do
    // carimbo; o retry volta duplicate + applied:0 — NAO e furo, e recuperacao
    const { state, worker } = boot({
      pickResult: { movement: { id: 1, qty: -4 }, applied: 0, duplicate: true } });
    const out = await worker.tick();
    expect(state.stamps.length).toBe(1);
    expect(state.stamps[0].q).not.toContain('error_note');
    expect(state.audits.length).toBe(0);
    expect(out.deduct_shortfalls).toBe(0);
  });

  test('duplicate de um pick que foi parcial: o furo original vira error_note agora', async () => {
    const { state, worker } = boot({
      pickResult: { movement: { id: 1, qty: -1 }, applied: 0, duplicate: true } });
    const out = await worker.tick();
    expect(state.stamps[0].params[1]).toBe('deducao parcial: 1 de 4');
    expect(out.deduct_shortfalls).toBe(1);
  });
});

describe('modo dry intocado', () => {
  test('dry: nenhum pick, nenhum carimbo, nenhum audit', async () => {
    const { state, worker, stock } = boot({ deductMode: 'dry',
      pickResult: { movement: { id: 1, qty: -4 }, applied: 4 } });
    const out = await worker.tick();
    expect(stock.pick).not.toHaveBeenCalled();
    expect(state.stamps.length).toBe(0);
    expect(state.audits.length).toBe(0);
    expect(out.deduct_shortfalls).toBe(0);
    expect(out.shipped).toBe(1);          // a linha continua espelhada normal
  });
});

describe('quem escreve quantidade continua sendo so o StockService', () => {
  test('o worker nunca toca stock_bins/boxes/unplaced/movements direto', async () => {
    const { state, worker } = boot({
      pickResult: { movement: { id: 1, qty: 0 }, applied: 0, duplicate: false } });
    await worker.tick();
    const touches = state.queries.filter((x) =>
      /stock_bins|stock_boxes|stock_unplaced|stock_movements/i.test(x.q));
    expect(touches).toEqual([]);
  });
});
