'use strict';
/**
 * LABEL PRINTING AUTOCLOSE (Bruno 09-12): "Impressão de Labels" nunca mais fica aberta 732 h.
 */
const { decide, endAtFor, LabelPrintingAutoclose } = require('../workers/label-printing-autoclose');

const T = (s) => new Date(s);
describe('decide', () => {
  test('imprimiu há 10 min → deixa aberta mesmo velha', () => {
    expect(decide({ started_at: '2026-09-11T10:00:00Z', last_print_at: '2026-09-12T13:50:00Z' }, T('2026-09-12T14:00:00Z'))).toBeNull();
  });
  test('aberta há 30 dias sem sinal → stale', () => {
    expect(decide({ started_at: '2026-08-13T02:11:00Z' }, T('2026-09-12T14:00:00Z'))).toBe('auto_label_stale');
  });
  test('Sandbox aberta há 40 min → stale; há 10 min → fica', () => {
    expect(decide({ started_at: '2026-09-12T13:20:00Z', is_sandbox: true }, T('2026-09-12T14:00:00Z'))).toBe('auto_label_stale');
    expect(decide({ started_at: '2026-09-12T13:50:00Z', is_sandbox: true }, T('2026-09-12T14:00:00Z'))).toBeNull();
  });
  test('começou 15:00 NY, agora 21:00 NY (01:00Z do dia seguinte), 6 h de idade → fim de expediente', () => {
    expect(decide({ started_at: '2026-09-12T19:00:00Z', last_heartbeat_at: '2026-09-12T22:30:00Z' }, T('2026-09-13T01:00:00Z'))).toBe('auto_label_eod');
  });
  test('começou 15:00 NY, agora 18:00 NY, 3 h → fica (dia normal)', () => {
    expect(decide({ started_at: '2026-09-12T19:00:00Z' }, T('2026-09-12T22:00:00Z'))).toBeNull();
  });
});
describe('endAtFor', () => {
  test('fecha no último sinal real, nunca em "agora"; sem sinal, 1 min depois do início', () => {
    expect(endAtFor({ started_at: '2026-08-13T02:11:00Z', last_print_at: '2026-09-11T14:16:24Z' }).toISOString()).toBe('2026-09-11T14:16:24.000Z');
    expect(endAtFor({ started_at: '2026-08-13T02:11:00Z' }).toISOString()).toBe('2026-08-13T02:12:00.000Z');
  });
});
describe('tick', () => {
  test('fecha só o que a regra manda e audita', async () => {
    const closed = []; const audits = [];
    const db = { async query(sql, params) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      if (q.startsWith('SELECT e.id, e.person_id')) return { rows: [
        { id: 1, person: 'Sandbox', is_sandbox: true, started_at: '2026-08-13T02:11:00Z', last_print_at: '2026-09-11T14:16:24Z', last_heartbeat_at: null },
        { id: 2, person: 'Vitor', is_sandbox: false, started_at: '2026-09-12T14:57:00Z', last_print_at: null, last_heartbeat_at: '2026-09-12T15:10:00Z' }] };
      if (q.startsWith('UPDATE v3.events SET ended_at')) { closed.push(params); return { rows: [] }; }
      if (q.startsWith('INSERT INTO v3.audit_log')) { audits.push(params[0]); return { rows: [] }; }
      return { rows: [] }; } };
    const w = new LabelPrintingAutoclose({ db, now: () => T('2026-09-12T15:20:00Z'), log: () => {} });
    const r = await w.tick();
    expect(r).toEqual({ open: 2, closed: 1 });
    expect(closed[0][0]).toBe(1); expect(closed[0][1]).toBe('2026-09-11T14:16:24.000Z'); expect(closed[0][2]).toBe('auto_label_stale');
    expect(audits).toEqual([1]);
  });
});
