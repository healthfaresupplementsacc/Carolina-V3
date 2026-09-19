'use strict';
/**
 * HISTÓRICO DA VEEQO → nosso livro (Bruno 09-16).
 *  1. decide(): só edição manual, só nosso armazém, só SKU base, só depois da carga, nunca a nossa própria.
 *  2. mapReason(): Return → devolução usável; Damaged → dano; contagem/achado → contagem.
 *  3. ingest(): espelha tudo (menos ruído de kit/pedido), aplica via StockService.adjust com nota completa, idempotente.
 */
const { decide, mapReason, actorOf, mirrorRow, isBase, VeeqoHistorySync } = require('../v3/services/veeqo-history-sync');

const BASE = { action: 'edited_by_user', warehouse_id: 108841, product_id: 70, is_base: true, actor: 'Henrique Monteiro', quantity: 29, increased: true, created_at: '2026-09-16T19:25:09Z', reason: 'Return', notes: null };

test('decide: devolução do Henrique depois da carga → aplica +29 como devolução usável', () => {
  expect(decide(BASE)).toEqual({ apply: true, delta: 29, reason_code: 'devolucao_usavel' });
});
test('decide: recusa o que não deve virar movimento', () => {
  expect(decide({ ...BASE, created_at: '2026-09-13T01:01:00Z' }).skip).toBe('before_baseline');
  expect(decide({ ...BASE, actor: 'Production Line System' }).skip).toBe('our_own_edit');
  expect(decide({ ...BASE, action: 'order_allocated' }).skip).toBe('not_manual_edit');
  expect(decide({ ...BASE, warehouse_id: 1 }).skip).toBe('other_warehouse');
  expect(decide({ ...BASE, is_base: false }).skip).toBe('not_base_sku');
  expect(decide({ ...BASE, product_id: null }).skip).toBe('sku_not_ours');
  expect(decide({ ...BASE, increased: false, quantity: 3, reason: 'Damaged' })).toEqual({ apply: true, delta: -3, reason_code: 'dano' });
});
test('mapReason', () => {
  expect(mapReason('Return', true)).toBe('devolucao_usavel');
  expect(mapReason('Item found', true)).toBe('contagem');
  expect(mapReason('Other', false, 'Inventory count 09/12/2026')).toBe('contagem');
  expect(mapReason('Damaged', false)).toBe('dano');
  expect(mapReason(null, true)).toBe('contagem');
  expect(mapReason('Other', true, 'BR-2026-0204')).toBe('producao');
  expect(mapReason('Other', false, 'Tiktok Order - 2 Units')).toBe('venda');
  expect(mapReason('Other', true, 'Return Amz 15/09')).toBe('devolucao_usavel');
  expect(mapReason('Other', false, 'Removed for order - 1')).toBe('venda');
});
test('actorOf + mirrorRow + isBase', () => {
  const e = { id: 9795478712, increased: true, quantity: 29, stock_level: 30, created_at: '2026-09-16T19:25:09.641Z', reason: 'Return', notes: null,
    action: { name: 'edited_by_user', summary: 'Edited by <b>Henrique Monteiro</b>' }, stock_entry: { sellable_id: 697347272, warehouse_id: 108841 }, sellable: { id: 697347272, type: 'ProductVariant', sku_code: 'HF-UROL-1000' } };
  expect(actorOf(e)).toBe('Henrique Monteiro');
  const info = { sku: 'HF-UROL-1000', product_id: 70, units_per_pack: 1, veeqo_type: 'variant' };
  expect(mirrorRow(e, info)).toMatchObject({ id: 9795478712, sku: 'HF-UROL-1000', product_id: 70, warehouse_id: 108841, actor: 'Henrique Monteiro', quantity: 29, increased: true, stock_level: 30, reason: 'Return' });
  expect(isBase(info, 'ProductVariant')).toBe(true);
  expect(isBase({ ...info, sku: 'HF-UROL-1000-C2', units_per_pack: 2, veeqo_type: 'kit' }, 'Kit')).toBe(false);
  expect(isBase({ ...info, sku: 'HF-UROL-1000-WFS' }, 'ProductVariant')).toBe(false);
});
test('ingest: espelha, ignora ruído de kit/pedido, aplica com nota completa e marca a linha', async () => {
  const inserted = []; const adjusts = []; const updates = [];
  const db = { async query(sql, params) {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    if (q.startsWith('INSERT INTO v3.veeqo_stock_history')) { inserted.push(params); return { rows: params[0] === 2 ? [] : [{ id: params[0] }] }; }
    if (q.startsWith('SELECT id FROM v3.stock_boxes')) return { rows: [{ id: 40 }] };
    if (q.startsWith('UPDATE v3.veeqo_stock_history')) { updates.push(params); return { rows: [] }; }
    return { rows: [] }; } };
  const stock = { async adjust(p) { adjusts.push(p); return { movement: { id: 555 }, applied: p.qty, duplicate: false }; } };
  const s = new VeeqoHistorySync({ db, stock, log: () => {} });
  const skuMap = new Map([['HF-UROL-1000', { sku: 'HF-UROL-1000', product_id: 70, units_per_pack: 1, veeqo_type: 'variant' }]]);
  const mk = (id, over) => ({ id, increased: true, quantity: 29, stock_level: 30, created_at: '2026-09-16T19:25:09Z', reason: 'Return', notes: 'cliente devolveu lacrado',
    action: { name: 'edited_by_user', summary: 'Edited by Henrique Monteiro' }, stock_entry: { sellable_id: 697347272, warehouse_id: 108841 }, sellable: { id: 697347272, type: 'ProductVariant', sku_code: 'HF-UROL-1000' }, ...over });
  const r = await s.ingest([
    mk(1),
    mk(2),                                                                       // já espelhada (ON CONFLICT) → duplicate
    mk(3, { action: { name: 'kit_content_stock_changed', summary: 'x' } }),        // ruído
    mk(4, { action: { name: 'order_allocated', summary: 'Order 1 allocated' } }), // pedido: já tem dono
    mk(5, { created_at: '2026-09-01T00:00:00Z' }),                               // antes da carga: só registro
  ], skuMap);
  expect(r).toMatchObject({ seen: 5, mirrored: 2, applied: 1, duplicate: 1, skipped: 1 });
  expect(adjusts).toHaveLength(1);
  expect(adjusts[0]).toMatchObject({ product_id: 70, qty: 29, box_id: 40, source: 'veeqo_history', source_ref: 'veeqo_hist:1', reason_code: 'devolucao_usavel', actor_name: 'Veeqo · Henrique Monteiro', ref_type: 'veeqo_history', ref_id: 1 });
  expect(adjusts[0].note).toBe('[Veeqo] Henrique Monteiro · Return · cliente devolveu lacrado · nível na Veeqo depois: 30');
  expect(updates[0]).toEqual([1, 'applied', 555, 29]);
  expect(inserted.find((p) => p[0] === 5)[15]).toBe('skipped');
});
