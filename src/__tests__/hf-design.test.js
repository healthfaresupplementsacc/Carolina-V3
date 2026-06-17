'use strict';
/* Fase 1 redesign — helpers do design system (puros). */
const D = require('../shared/hf-design');

describe('hf-design helpers', () => {
  test('phaseOfDay por hora', () => {
    expect(D.phaseOfDay(new Date(2026, 5, 16, 3))).toBe('madrugada');
    expect(D.phaseOfDay(new Date(2026, 5, 16, 9))).toBe('manhã');
    expect(D.phaseOfDay(new Date(2026, 5, 16, 14))).toBe('tarde');
    expect(D.phaseOfDay(new Date(2026, 5, 16, 20))).toBe('noite');
  });
  test('greeting casa com a fase', () => {
    expect(D.greeting('manhã')).toBe('Bom dia');
    expect(D.greeting('tarde')).toBe('Boa tarde');
    expect(D.greeting('noite')).toBe('Boa noite');
    expect(D.greeting(new Date(2026, 5, 16, 9))).toBe('Bom dia');
  });
  test('clockStr 24h zero-pad', () => {
    expect(D.clockStr(new Date(2026, 5, 16, 8, 5))).toBe('08:05');
    expect(D.clockStr(new Date(2026, 5, 16, 19, 32))).toBe('19:32');
  });
  test('dateStr pt-BR', () => {
    // 16 jun 2026 é uma terça
    expect(D.dateStr(new Date(2026, 5, 16))).toBe('terça-feira, 16 de junho');
  });
  test('initials', () => {
    expect(D.initials('Vitor')).toBe('VI');
    expect(D.initials('Bruno Sarmento')).toBe('BS');
    expect(D.initials('Ana Paula Silva')).toBe('AS');
    expect(D.initials('')).toBe('?');
  });
  test('statusDot cores', () => {
    expect(D.statusDot('busy')).toBe('#21a85b');
    expect(D.statusDot('lunch')).toBe('#d97712');
    expect(D.statusDot('free')).toBe('#8195ab');
  });
  test('ageBadge níveis e cores', () => {
    const now = new Date(2026, 5, 16, 12, 0);
    expect(D.ageBadge(new Date(2026, 5, 16, 11, 30), now).level).toBe('ok'); // 30min
    expect(D.ageBadge(new Date(2026, 5, 16, 9, 30), now)).toMatchObject({ level: 'warn', color: '#b35c00' }); // 2h30
    expect(D.ageBadge(new Date(2026, 5, 16, 7, 0), now)).toMatchObject({ level: 'over', color: '#b3261e' }); // 5h
    expect(D.ageBadge(new Date(2026, 5, 16, 11, 59, 30), now).text).toBe('agora');
    expect(D.ageBadge(new Date(2026, 5, 16, 10, 45), now).text).toBe('há 1h 15min');
  });
  test('accent determinístico e estável', () => {
    const a = D.operatorAccent('Vitor'); const b = D.operatorAccent('Vitor');
    expect(a).toBe(b); expect(D.ACCENTS).toContain(a);
    expect(D.productAccent('Berberine')).toMatch(/^#[0-9a-f]{6}$/);
  });
  test('ambientVars dentro de 0-1', () => {
    const v = D.ambientVars(new Date(2026, 5, 16, 13), 2);
    expect(Number(v['--day'])).toBeGreaterThan(0.9);
    expect(Number(v['--energy'])).toBeCloseTo(0.4, 1);
    const night = D.ambientVars(new Date(2026, 5, 16, 0), 0);
    expect(Number(night['--day'])).toBeLessThan(0.1);
    expect(Number(night['--energy'])).toBe(0);
  });
  test('floaters: count por densidade, bottles válidos', () => {
    expect(D.floaters(8)).toHaveLength(8);
    expect(D.floaters(14)).toHaveLength(14);
    expect(D.floaters(22).length).toBeLessThanOrEqual(22);
    var f = D.floaters(14);
    f.filter(function (x) { return x.k === 'b'; }).forEach(function (x) { expect(D.BOTTLE_FILES[x.b]).toBeTruthy(); });
    expect(f.some(function (x) { return x.k === 'b'; })).toBe(true); // tem bottle
    expect(f.some(function (x) { return x.k === 'c'; })).toBe(true); // tem cápsula
  });
  test('mantra cicla por idioma', () => {
    expect(D.mantra('pt', 0)).toBe('Cada lote conta.');
    expect(D.mantra('en', 0)).toBe('Every batch counts.');
    expect(typeof D.mantra('xx', 0)).toBe('string'); // fallback pt
  });
});
