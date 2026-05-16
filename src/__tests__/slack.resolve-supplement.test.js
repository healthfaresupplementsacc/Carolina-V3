'use strict';
/**
 * B3 — typing a brand-new supplement creates it pending + asks admin,
 * with an AI suggestion (propose-then-confirm seed).
 */
const interactive = require('../slack/interactive');

describe('B3 — resolveSupplementValue create-new path', () => {
  function deps() {
    const calls = { db: [], announce: [], parser: [] };
    return {
      calls,
      db: { query: jest.fn((sql, p) => { calls.db.push({ sql, p }); return Promise.resolve({ rows: [] }); }) },
      parser: { addCustomSupplement: jest.fn((n) => calls.parser.push(n)) },
      announce: {
        toAdmin: jest.fn((m) => { calls.announce.push(m); return Promise.resolve(); }),
        adHocPending: jest.fn().mockResolvedValue(),
      },
      corrector: { correctSupplement: jest.fn().mockResolvedValue({ supplement: 'Vitamin B1', via: 'fuzzy', confidence: 'high' }) },
    };
  }

  test('existing selection passes through unchanged', async () => {
    const r = await interactive.resolveSupplementValue('Berberine', deps());
    expect(r).toEqual({ name: 'Berberine', isNew: false });
  });

  test('__create__ inserts catalog row + registers alias + admin msg w/ AI hint', async () => {
    const d = deps();
    const r = await interactive.resolveSupplementValue('__create__:Vitamim B1', d);
    expect(r).toEqual({ name: 'Vitamim B1', isNew: true });
    expect(d.db.query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO supplement_catalog/), ['Vitamim B1']
    );
    expect(d.parser.addCustomSupplement).toHaveBeenCalledWith('Vitamim B1', '');
    const adminMsg = d.calls.announce.join(' ');
    expect(adminMsg).toMatch(/Vitamim B1/);
    expect(adminMsg).toMatch(/Vitamin B1/);            // AI suggestion
    expect(adminMsg).toMatch(/\[a\] trocar/);          // propose options
  });

  test('AI hint omitted when corrector returns nothing', async () => {
    const d = deps();
    d.corrector.correctSupplement = jest.fn().mockResolvedValue(null);
    await interactive.resolveSupplementValue('__create__:Zzqqx', d);
    const adminMsg = d.calls.announce.join(' ');
    expect(adminMsg).toMatch(/Zzqqx/);
    expect(adminMsg).not.toMatch(/Acho que quis dizer/);
  });

  test('empty create value → null', async () => {
    const r = await interactive.resolveSupplementValue('__create__:   ', deps());
    expect(r).toEqual({ name: null, isNew: false });
  });
});
