'use strict';
/**
 * Testes do util de fuso NY do V4 (dashboard-v4/src/utils/ny-time.cjs).
 * Cobre os 2 bugs principais do E7-refine3:
 *   - parseYmdLocal retorna o dia da semana CERTO pro YYYY-MM-DD
 *     (antes new Date('2026-05-26') caía em UTC midnight → getDay = dia anterior em TZ-)
 *   - shiftNyDate avança/recua N dias preservando o YMD canônico NY
 */
const path = require('path');
const NY = require(path.join(__dirname, '..', '..',
  'dashboard-v4', 'src', 'utils', 'ny-time.cjs'));

describe('V4 ny-time — parseYmdLocal', () => {
  test('Ter 2026-05-26 vira Date com getDay=2 (Tuesday)', () => {
    const d = NY.parseYmdLocal('2026-05-26');
    expect(d).toBeInstanceOf(Date);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4);  // May (0-indexed)
    expect(d.getDate()).toBe(26);
    expect(d.getDay()).toBe(2);    // Tuesday — bug antes mostrava Monday (1) ou Sunday (0)
  });

  test('Seg 2026-05-25 vira Date com getDay=1 (Monday)', () => {
    const d = NY.parseYmdLocal('2026-05-25');
    expect(d.getDate()).toBe(25);
    expect(d.getDay()).toBe(1);    // Monday
  });

  test('Dom 2026-05-24 vira Date com getDay=0 (Sunday)', () => {
    expect(NY.parseYmdLocal('2026-05-24').getDay()).toBe(0);
  });

  test('Sáb 2026-12-26 vira Date com getDay=6 (Saturday)', () => {
    expect(NY.parseYmdLocal('2026-12-26').getDay()).toBe(6);
  });

  test('YMD inválido → null', () => {
    expect(NY.parseYmdLocal('lixo')).toBeNull();
    expect(NY.parseYmdLocal('2026/05/26')).toBeNull();
    expect(NY.parseYmdLocal('')).toBeNull();
    expect(NY.parseYmdLocal(null)).toBeNull();
    expect(NY.parseYmdLocal(undefined)).toBeNull();
  });

  test('ymdDayOfWeek wrapper devolve o getDay direto', () => {
    expect(NY.ymdDayOfWeek('2026-05-26')).toBe(2);
    expect(NY.ymdDayOfWeek('2026-05-25')).toBe(1);
    expect(NY.ymdDayOfWeek('lixo')).toBeNull();
  });
});

describe('V4 ny-time — shiftNyDate', () => {
  test('+1 dia', () => {
    expect(NY.shiftNyDate('2026-05-25', 1)).toBe('2026-05-26');
    expect(NY.shiftNyDate('2026-05-26', 1)).toBe('2026-05-27');
  });
  test('-1 dia', () => {
    expect(NY.shiftNyDate('2026-05-26', -1)).toBe('2026-05-25');
  });
  test('cross-month +N', () => {
    expect(NY.shiftNyDate('2026-05-31', 1)).toBe('2026-06-01');
    expect(NY.shiftNyDate('2026-05-30', 3)).toBe('2026-06-02');
  });
  test('cross-month -N', () => {
    expect(NY.shiftNyDate('2026-06-01', -1)).toBe('2026-05-31');
  });
  test('cross-year', () => {
    expect(NY.shiftNyDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(NY.shiftNyDate('2027-01-01', -1)).toBe('2026-12-31');
  });
  test('0 = idempotente', () => {
    expect(NY.shiftNyDate('2026-05-26', 0)).toBe('2026-05-26');
  });
  test('DST EDT→EST (1º domingo nov, 2026-11-01) e EST→EDT (2º domingo mar, 2027-03-08)', () => {
    // Atravessa DST não muda o YMD shift — Intl resolve corretamente
    expect(NY.shiftNyDate('2026-11-01', 1)).toBe('2026-11-02');
    expect(NY.shiftNyDate('2027-03-08', 1)).toBe('2027-03-09');
  });
  test('YMD inválido devolve input', () => {
    expect(NY.shiftNyDate('lixo', 1)).toBe('lixo');
  });
});

describe('V4 ny-time — nyToday + nyNowMinutes', () => {
  test('nyToday retorna YYYY-MM-DD formato', () => {
    expect(NY.nyToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  test('nyNowMinutes retorna número 0..1440 com fração de segundos', () => {
    const m = NY.nyNowMinutes();
    expect(typeof m).toBe('number');
    expect(m).toBeGreaterThanOrEqual(0);
    expect(m).toBeLessThan(1440);
  });
});

describe('V4 ny-time — TZ constant', () => {
  test("TZ = 'America/New_York'", () => {
    expect(NY.TZ).toBe('America/New_York');
  });
});
