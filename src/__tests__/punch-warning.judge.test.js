'use strict';
/* Caso Vitor 10-03 (Bruno 10-04): o aviso das 9:40 acusou "faltou saida do dia"
 * com o NGTeco mostrando saida 16:32:29 e o proprio att_state com checkout
 * 16:32. Dois furos: (1) o ev 5204 fechado pelo EMS as 19:11 virou "fim real"
 * do dia; (2) batida de saida antes das 17:00 nao valia como saida.
 * Estes testes reproduzem o dia inteiro dele com os dados reais. */
const { judgeMissing } = require('../workers/punch-warning');

const NY = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return Date.UTC(2026, 9, 3, h + 4, m, 0); }; // 10-03 EDT = UTC-4
const nyMinutesOf = (d) => { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d); const g = (t) => +p.find((x) => x.type === t).value; return (g('hour') % 24) * 60 + g('minute'); };

const VITOR = { punches: [NY('08:15'), NY('12:35'), NY('13:19'), NY('16:32')], firstStart: NY('08:22'), lunch: { o: NY('12:35'), i: NY('13:19') } };

describe('judgeMissing — caso Vitor 10-03', () => {
  test('com o fim real HUMANO (15:58) a saida 16:32 e saida: NADA falta', () => {
    expect(judgeMissing({ ...VITOR, lastRealEnd: NY('15:58'), checkoutAt: null, nyMinutesOf })).toEqual([]);
  });
  test('mesmo com o fim fantasma do EMS (19:11), o checkout registrado pelo sistema (16:32) impede a acusacao', () => {
    expect(judgeMissing({ ...VITOR, lastRealEnd: NY('19:11'), checkoutAt: NY('16:32'), nyMinutesOf })).toEqual([]);
  });
  test('o bug antigo: fim fantasma 19:11 + sem checkout do sistema => acusava saida (documenta por que o EMS saiu do "fim real")', () => {
    const f = judgeMissing({ ...VITOR, lastRealEnd: NY('19:11'), checkoutAt: null, nyMinutesOf });
    expect(f.map((x) => x.d)).toEqual(['saida do dia']);
  });
  test('saida de verdade esquecida: ultima batida 13:19 (volta do almoco), fim humano 17:40, sem checkout => acusa', () => {
    const f = judgeMissing({ punches: [NY('08:15'), NY('12:35'), NY('13:19')], firstStart: NY('08:22'), lunch: VITOR.lunch, lastRealEnd: NY('17:40'), checkoutAt: null, nyMinutesOf });
    expect(f.map((x) => x.d)).toEqual(['saida do dia']);
  });
  test('sem fim humano mensuravel (so fechamentos automaticos) nao julga saida', () => {
    expect(judgeMissing({ punches: [NY('08:15'), NY('12:35'), NY('13:19')], firstStart: NY('08:22'), lunch: VITOR.lunch, lastRealEnd: null, checkoutAt: null, nyMinutesOf })).toEqual([]);
  });
  test('entrada da manha sem batida ate 60min depois da 1a tarefa => acusa entrada', () => {
    const f = judgeMissing({ punches: [NY('12:35'), NY('13:19'), NY('17:05')], firstStart: NY('08:22'), lunch: VITOR.lunch, lastRealEnd: NY('16:50'), checkoutAt: null, nyMinutesOf });
    expect(f.map((x) => x.d)).toEqual(['entrada da manha']);
  });
});
