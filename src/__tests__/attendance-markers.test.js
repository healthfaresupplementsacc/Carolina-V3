'use strict';
const { computeMarkers } = require('../v3/attendance-markers');

const P = (...isos) => isos.map((t) => ({ punch_time: t }));
const kinds = (r) => r.markers.map((m) => m.kind);
const typeOf = (r, kind) => (r.markers.find((m) => m.kind === kind) || {}).type;

describe('attendance markers', () => {
  test('4 batidas padrão: check-in, lunch out/in, check-out; almoço = maior break', () => {
    const r = computeMarkers(P('2026-07-23T12:00:00Z', '2026-07-23T17:00:00Z', '2026-07-23T17:45:00Z', '2026-07-23T21:00:00Z'), true, null);
    expect(kinds(r)).toEqual(['checkin', 'lunch_out', 'lunch_in', 'checkout']);
    expect(r.lunch.minutes).toBe(45);
  });

  test('dia ainda aberto (sem checkout): não emite check-out', () => {
    const r = computeMarkers(P('2026-07-23T12:00:00Z', '2026-07-23T17:00:00Z', '2026-07-23T17:45:00Z'), false, null);
    expect(kinds(r)).toContain('checkin');
    expect(kinds(r)).not.toContain('checkout');
  });

  test('almoço = o MAIOR break, não o primeiro', () => {
    // break1=15min, break2(almoço)=60min
    const r = computeMarkers(P(
      '2026-07-23T12:00:00Z',            // in
      '2026-07-23T14:00:00Z', '2026-07-23T14:15:00Z',  // break 15min
      '2026-07-23T16:00:00Z', '2026-07-23T17:00:00Z',  // break 60min (almoço)
      '2026-07-23T21:00:00Z'), true, null);
    // o segundo break é o lunch
    expect(r.breaks[0].type).toBe('unjustified');   // 15min separado, sem justif.
    expect(r.breaks[1].type).toBe('lunch');
    expect(r.breaks[1].minutes).toBe(60);
    expect(r.breaks[1].overtime_min).toBe(15);      // 60-45
  });

  test('break separado do almoço sem justificativa = unjustified; com justificativa = break', () => {
    const punches = P(
      '2026-07-23T12:00:00Z',
      '2026-07-23T16:00:00Z', '2026-07-23T16:45:00Z',  // almoço 45min
      '2026-07-23T18:00:00Z', '2026-07-23T18:30:00Z',  // break extra 30min
      '2026-07-23T21:00:00Z');
    const semJust = computeMarkers(punches, true, null);
    expect(semJust.breaks[1].type).toBe('unjustified');
    // agora com o break extra justificado (início às 18:00Z)
    const just = new Set([new Date('2026-07-23T18:00:00Z').getTime()]);
    const comJust = computeMarkers(punches, true, just);
    expect(comJust.breaks[1].type).toBe('break');
  });

  test('vários breaks pequenos somam até 45min = lunch; resto = break', () => {
    // 3 breaks de 15min (=45) + 1 de 20min. Nenhum >= 45 sozinho.
    const r = computeMarkers(P(
      '2026-07-23T12:00:00Z',
      '2026-07-23T13:00:00Z', '2026-07-23T13:15:00Z',
      '2026-07-23T14:00:00Z', '2026-07-23T14:15:00Z',
      '2026-07-23T15:00:00Z', '2026-07-23T15:15:00Z',
      '2026-07-23T16:00:00Z', '2026-07-23T16:20:00Z',
      '2026-07-23T21:00:00Z'), true, null);
    expect(r.breaks[0].type).toBe('lunch');
    expect(r.breaks[1].type).toBe('lunch');
    expect(r.breaks[2].type).toBe('lunch');
    expect(r.breaks[3].type).toBe('unjustified');   // passou dos 45min acumulados
  });

  test('sem batidas → vazio', () => {
    const r = computeMarkers([], false, null);
    expect(r.markers).toEqual([]);
  });
});
