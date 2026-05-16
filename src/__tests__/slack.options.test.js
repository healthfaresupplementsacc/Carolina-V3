'use strict';
/**
 * Bug B — supplement autocomplete (external_select Options Load URL).
 */
jest.mock('../db');
const db = require('../db');
const options = require('../slack/options');

beforeEach(() => { jest.clearAllMocks(); });

describe('matchSupplements (pure, against real parser catalog)', () => {
  test('1+ letter returns options', () => {
    const r = options.matchSupplements('v');
    expect(r.length).toBeGreaterThan(0);
    // Vitamin B1/B2 start with V
    expect(r.some((n) => /Vitamin/.test(n))).toBe(true);
  });

  test('"gree" fuzzy-matches Green Tea (prefix) AND Fenugreek (substring)', () => {
    const r = options.matchSupplements('gree');
    expect(r).toContain('Green Tea');     // canonical prefix
    expect(r).toContain('Fenugreek');     // "fenuGREEk" substring
    // prefix match should rank before substring
    expect(r.indexOf('Green Tea')).toBeLessThan(r.indexOf('Fenugreek'));
  });

  test('"b1" matches Vitamin B1 via alias', () => {
    const r = options.matchSupplements('b1');
    expect(r).toContain('Vitamin B1');
  });

  test('empty query returns up to 20 (catalog order when no usage data)', () => {
    const r = options.matchSupplements('');
    expect(r.length).toBeLessThanOrEqual(20);
    expect(r.length).toBeGreaterThan(0);
  });

  test('empty query prefers topUsed when provided', () => {
    const r = options.matchSupplements('', ['Berberine', 'Graviola']);
    expect(r[0]).toBe('Berberine');
    expect(r[1]).toBe('Graviola');
  });

  test('no match returns empty list (so only the create option shows)', () => {
    const r = options.matchSupplements('zzzqqq___nope');
    expect(r).toEqual([]);
  });
});

describe('toSlackOptions', () => {
  test('caps at <100 and appends a Criar novo option when value typed', () => {
    const many = Array.from({ length: 150 }, (_, i) => `S${i}`);
    const o = options.toSlackOptions(many, 'newthing');
    expect(o.length).toBeLessThanOrEqual(100);
    const last = o[o.length - 1];
    expect(last.value).toBe('__create__:newthing');
    expect(last.text.text).toMatch(/Criar novo: newthing/);
  });

  test('no Criar novo option when value blank', () => {
    const o = options.toSlackOptions(['Berberine'], '');
    expect(o.find((x) => x.value.startsWith('__create__'))).toBeUndefined();
  });
});

describe('buildOptionsResponse', () => {
  test('empty value → queries usage for top list', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ name: 'Berberine', total: 99 }] });
    const r = await options.buildOptionsResponse({ value: '' });
    expect(db.query).toHaveBeenCalled();
    expect(r.options[0].value).toBe('Berberine');
  });

  test('non-empty value → no usage query, returns matches + create', async () => {
    db.query = jest.fn();
    const r = await options.buildOptionsResponse({ value: 'green' });
    expect(db.query).not.toHaveBeenCalled();
    expect(r.options.some((o) => o.value === 'Green Tea')).toBe(true);
    expect(r.options.some((o) => o.value === '__create__:green')).toBe(true);
  });

  test('usage query failure falls back to catalog (no throw)', async () => {
    db.query = jest.fn().mockRejectedValue(new Error('db down'));
    const r = await options.buildOptionsResponse({ value: '' });
    expect(Array.isArray(r.options)).toBe(true);
    expect(r.options.length).toBeGreaterThan(0);
  });
});
