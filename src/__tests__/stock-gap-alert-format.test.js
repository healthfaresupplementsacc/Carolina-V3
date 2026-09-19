'use strict';
/** Bruno 09-14: aviso de estoque do P&P tem que ser curto: título + "Produto: tem X, precisa de Y". */
const { StockGapAlert } = require('../workers/stock-gap-alert');

test('formato curto, o que falta primeiro, sem seções', () => {
  const w = new StockGapAlert({ db: { query: async () => ({ rows: [] }) }, enabled: false });
  const txt = w._format({ items: [
    { product: 'Urolithin A', needed: 7, stock: 4, severity: 'warning', advice: 'blá' },
    { product: 'Melatonin', needed: 3, stock: 5, severity: 'warning', advice: 'blá' },
    { product: 'Hyaluronic Acid', needed: 8, stock: 0, severity: 'critical', advice: 'ZERADO e sem nada em produção.' }] }, 'Status do estoque pro P&P');
  expect(txt.split('\n')).toEqual([
    '*Status do estoque pro P&P*',
    'Hyaluronic Acid: tem 0, precisa de 8',
    'Urolithin A: tem 4, precisa de 7',
    'Melatonin: tem 5, precisa de 3',
  ]);
  expect(txt).not.toMatch(/RESOLVER|resolver|ZERADO|red_circle/);
});
