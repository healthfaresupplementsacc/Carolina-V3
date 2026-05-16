'use strict';
const sc = require('../ai/supplement-corrector');

describe('F8 — supplement corrector (fuzzy, no API)', () => {
  test('lev computes edit distance', () => {
    expect(sc.lev('vitamin', 'vitamim')).toBe(1);
    expect(sc.lev('', 'abc')).toBe(3);
    expect(sc.lev('abc', 'abc')).toBe(0);
  });

  test('norm strips accents/punct/case', () => {
    expect(sc.norm('Berberína!! 2500mg')).toBe('berberina 2500mg');
  });

  test('typo "Vitamim B1" → Vitamin B1 high', () => {
    const r = sc.fuzzyCorrect('S: Vitamim B1 0099');
    expect(r).toBeTruthy();
    expect(r.supplement).toBe('Vitamin B1');
    expect(r.confidence).toBe('high');
  });

  test('exact alias "berberina" → Berberine high', () => {
    const r = sc.fuzzyCorrect('F: berberina');
    expect(r.supplement).toBe('Berberine');
    expect(r.confidence).toBe('high');
  });

  test('mild typo "Graviolla" → Graviola (high or medium)', () => {
    const r = sc.fuzzyCorrect('comecei Graviolla 0124');
    expect(r).toBeTruthy();
    expect(r.supplement).toBe('Graviola');
    expect(['high', 'medium']).toContain(r.confidence);
  });

  test('pure noise → null', () => {
    expect(sc.fuzzyCorrect('S: F P N lote ordens')).toBeNull();
    expect(sc.fuzzyCorrect('xqzwk blargh')).toBeNull();
  });

  test('correctSupplement returns fuzzy high without API key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await sc.correctSupplement('S: Vitamim B1 0099');
    expect(r.supplement).toBe('Vitamin B1');
    expect(r.confidence).toBe('high');
    expect(r.via).toBe('fuzzy');
  });

  test('correctSupplement null when nothing close and no API', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await sc.correctSupplement('S: zzzqqq wak');
    expect(r).toBeNull();
  });
});
