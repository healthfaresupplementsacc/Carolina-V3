'use strict';
/* Paridade das batidas do relógio (Bruno 08-01, caso Vitor):
   uma batida À NOITE (>=17:00 NY) é SAÍDA do dia, NUNCA volta de almoço.
   Vitor bateu 11:38 (in), 15:06 (volta almoço), 18:36 (SAÍDA) — o sistema
   achava que 18:36 era "voltou do almoço" e floodava "está sem função" com
   ele já em casa. Este teste trava a regra pra nunca mais regredir. */

const CHECKOUT_MIN = 17 * 60;             // 17:00 NY
const LUNCH_WIN = { from: 10 * 60, to: 15 * 60 + 30 };
const TZ = 'America/New_York';
const nyMin = (t) => {
  const s = new Date(t).toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = s.split(':').map(Number); return h * 60 + m;
};

// réplica pura da classificação em attendance-sync._syncPerson (loop de paridade).
// openLunchAt: fn(punchIndex)->bool (o /op tinha almoço aberto quando essa batida caiu?)
function classify(punches, openLunchAt = () => false) {
  let state = 'out', checkinAt = null, checkoutAt = null, breakStart = null, lastInAt = null;
  punches.forEach((p, idx) => {
    const t = new Date(p); const mins = nyMin(t); const evening = mins >= CHECKOUT_MIN;
    if (state === 'out' && !checkinAt) { state = 'in'; checkinAt = t; lastInAt = t; }
    else if (state === 'in') {
      const ol = openLunchAt(idx);
      if (!evening && (ol || (mins >= LUNCH_WIN.from && mins <= LUNCH_WIN.to))) { state = 'break'; breakStart = t; }
      else { state = 'out'; checkoutAt = t; }
    } else {
      if (evening) { state = 'out'; checkoutAt = t; }
      else { state = 'in'; lastInAt = t; breakStart = null; if (checkoutAt) checkoutAt = null; }
    }
  });
  return { state, checkinAt, checkoutAt, lastInAt };
}

// horários NY como ISO UTC (verão = UTC-4)
const ny = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); const u = h + 4; return `2026-08-01T${String(u).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`; };

describe('paridade de batidas — saída à noite (Bruno 08-01, Vitor)', () => {
  test('CASO VITOR: 11:38 in, 15:06 volta-almoço, 18:36 SAÍDA → state=out, checkout=18:36', () => {
    const r = classify([ny('11:38'), ny('15:06'), ny('18:36')], (i) => i === 1); // 2ª batida tinha almoço aberto
    expect(r.state).toBe('out');
    expect(nyMin(r.checkoutAt)).toBe(18 * 60 + 36);
  });

  test('batida noturna estando "in" (sem almoço) = SAÍDA, não almoço: 09:00 in, 18:00 out', () => {
    const r = classify([ny('09:00'), ny('18:00')]);
    expect(r.state).toBe('out');
    expect(nyMin(r.checkoutAt)).toBe(18 * 60);
  });

  test('almoço normal continua funcionando: 08:00 in, 12:00 lunch-out, 12:45 lunch-in, 17:30 out', () => {
    const r = classify([ny('08:00'), ny('12:00'), ny('12:45'), ny('17:30')]);
    expect(r.state).toBe('out');
    expect(nyMin(r.checkoutAt)).toBe(17 * 60 + 30);
  });

  test('só entrada e almoço (ainda trabalhando de tarde): 08:00 in, 12:00 out, 12:40 in → state=in', () => {
    const r = classify([ny('08:00'), ny('12:00'), ny('12:40')]);
    expect(r.state).toBe('in');
    expect(r.checkoutAt).toBeNull();
  });
});
