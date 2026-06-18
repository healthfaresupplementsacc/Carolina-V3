'use strict';
/* REGRESSÃO do gap falso do Vitor: um break logado DENTRO de uma production_line
   (eventos sobrepostos) NÃO pode virar um gap gigante. computeGaps tem que MESCLAR
   intervalos sobrepostos — o gap real é só entre o ÚLTIMO fim e o próximo início. */
const { computeGaps } = require('../v3/data/timeline-repo');

const T = (hhmm) => Date.parse('2026-06-18T' + hhmm + ':00-04:00'); // EDT

describe('computeGaps — eventos sobrepostos (bug do gap do Vitor)', () => {
  test('break DENTRO da production_line → gap real = 13min (não 2h22m)', () => {
    // cenário REAL do Vitor: production 09:38–12:34, break 10:03–10:25 (dentro),
    // depois shipping 12:47–12:58. O único gap real é 12:34→12:47 (13min).
    const events = [
      { started_at: '2026-06-18T09:38:00-04:00', ended_at: '2026-06-18T12:34:00-04:00' }, // production_line
      { started_at: '2026-06-18T10:03:00-04:00', ended_at: '2026-06-18T10:25:00-04:00' }, // break (sobreposto)
      { started_at: '2026-06-18T12:47:00-04:00', ended_at: '2026-06-18T12:58:00-04:00' }, // shipping
    ];
    const nowMs = T('12:58'); // sem trailing
    const r = computeGaps(events, nowMs, nowMs);
    expect(r.idle_seconds).toBe(13 * 60);          // 12:34→12:47, NÃO 10:25→12:47
    expect(r.idle_seconds).not.toBe(142 * 60);     // o bug daria 2h22m (142min)
    expect(r.unreported_seconds).toBe(0);
  });

  test('eventos aninhados (break totalmente dentro) não criam gap nenhum', () => {
    const events = [
      { started_at: '2026-06-18T09:00:00-04:00', ended_at: '2026-06-18T12:00:00-04:00' }, // longo
      { started_at: '2026-06-18T10:00:00-04:00', ended_at: '2026-06-18T10:30:00-04:00' }, // aninhado
    ];
    const r = computeGaps(events, T('12:00'), T('12:00'));
    expect(r.idle_seconds).toBe(0);
  });

  test('gaps reais entre tasks não-sobrepostas continuam contando', () => {
    const events = [
      { started_at: '2026-06-18T09:00:00-04:00', ended_at: '2026-06-18T09:30:00-04:00' },
      { started_at: '2026-06-18T09:50:00-04:00', ended_at: '2026-06-18T10:00:00-04:00' }, // gap 20min antes
    ];
    const r = computeGaps(events, T('10:00'), T('10:00'));
    expect(r.idle_seconds).toBe(20 * 60);
  });
});
