'use strict';
/* Horário das câmeras (Bruno 07-10): ON 07:00–20:30 seg–sáb, domingo OFF o dia
   todo, America/New_York (DST-aware). Datas em UTC → convertidas pro fuso NY. */
const { isCamerasOn, nyClock } = require('../cameras-schedule');
const at = (iso) => new Date(iso);

describe('cameras-schedule — horário de supervisão (NY)', () => {
  // Julho 2026 = EDT (UTC-4). Jul 6 = segunda, Jul 4 = sábado, Jul 5 = domingo.
  test('segunda meio-dia → LIGADO', () => {
    expect(isCamerasOn(at('2026-07-06T16:00:00Z'))).toBe(true); // 12:00 NY
  });
  test('liga exatamente 07:00', () => {
    expect(isCamerasOn(at('2026-07-06T10:59:00Z'))).toBe(false); // 06:59 NY
    expect(isCamerasOn(at('2026-07-06T11:00:00Z'))).toBe(true);  // 07:00 NY
  });
  test('desliga exatamente 20:30', () => {
    expect(isCamerasOn(at('2026-07-07T00:29:00Z'))).toBe(true);  // 20:29 NY seg
    expect(isCamerasOn(at('2026-07-07T00:30:00Z'))).toBe(false); // 20:30 NY seg
  });
  test('madrugada e noite → DESLIGADO', () => {
    expect(isCamerasOn(at('2026-07-06T06:00:00Z'))).toBe(false); // 02:00 NY
    expect(isCamerasOn(at('2026-07-07T03:00:00Z'))).toBe(false); // 23:00 NY seg
  });
  test('DOMINGO o dia todo → DESLIGADO', () => {
    expect(isCamerasOn(at('2026-07-05T16:00:00Z'))).toBe(false); // 12:00 NY dom
    expect(isCamerasOn(at('2026-07-05T15:00:00Z'))).toBe(false); // 11:00 NY dom (dentro do horário útil, mas domingo)
    expect(nyClock(at('2026-07-05T16:00:00Z')).weekday).toBe('Sunday');
  });
  test('SÁBADO desligado por padrão (serviço extra é sob demanda no cameras.js)', () => {
    expect(isCamerasOn(at('2026-07-04T16:00:00Z'))).toBe(false); // 12:00 NY sáb
    expect(nyClock(at('2026-07-04T16:00:00Z')).weekday).toBe('Saturday');
  });
  test('DST: inverno (EST, UTC-5) respeita o fuso', () => {
    // Jan 5 2026 = segunda. 07:00 EST = 12:00 UTC.
    expect(isCamerasOn(at('2026-01-05T11:59:00Z'))).toBe(false); // 06:59 EST
    expect(isCamerasOn(at('2026-01-05T12:00:00Z'))).toBe(true);  // 07:00 EST
    expect(isCamerasOn(at('2026-01-05T17:00:00Z'))).toBe(true);  // 12:00 EST
  });
});
