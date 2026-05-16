'use strict';
// BLOCO B / C5 — message variations module.
jest.mock('../db');

describe('message-variations', () => {
  let db, mv;
  beforeEach(() => {
    jest.resetModules();
    jest.mock('../db');
    db = require('../db');
    mv = require('../message-variations');
  });

  test('render substitutes known placeholders, leaves unknown', () => {
    expect(mv.render('oi {nome}, no {supp}', { nome: 'Ana', supp: 'Green Tea' }))
      .toBe('oi Ana, no Green Tea');
    expect(mv.render('faltou {qqcoisa}', {})).toBe('faltou {qqcoisa}');
  });

  test('resolveTemplates returns DB rows when present', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ template: 'A {nome}' }, { template: 'B' }] });
    expect(await mv.resolveTemplates('voltei')).toEqual(['A {nome}', 'B']);
  });

  test('resolveTemplates falls back to code defaults when table empty', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const t = await mv.resolveTemplates('greeting');
    expect(t.length).toBe(5);
    expect(t).toEqual(expect.arrayContaining([expect.stringMatching(/Bom dia/)]));
  });

  test('resolveTemplates falls back when the DB throws', async () => {
    db.query = jest.fn().mockRejectedValue(new Error('db down'));
    const t = await mv.resolveTemplates('note');
    expect(t.length).toBe(20);
  });

  test('resolveTemplates returns [] for unknown type', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    expect(await mv.resolveTemplates('nope')).toEqual([]);
  });

  test('pick renders a template with vars', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ template: '{nome}, voltou?' }] });
    expect(await mv.pick('voltei', { nome: 'Bruno' })).toBe('Bruno, voltou?');
  });

  test('pick returns empty string for unknown type', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    expect(await mv.pick('bogus', {})).toBe('');
  });

  test('seedDefaults inserts when a type is empty, skips when populated', async () => {
    const inserts = [];
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/SELECT COUNT/.test(sql)) {
        // greeting already populated, everything else empty
        return Promise.resolve({ rows: [{ n: params[0] === 'greeting' ? 5 : 0 }] });
      }
      if (/INSERT INTO message_variations/.test(sql)) { inserts.push(params[0]); return Promise.resolve({ rows: [] }); }
      return Promise.resolve({ rows: [] });
    });
    await mv.seedDefaults();
    expect(inserts).not.toContain('greeting');          // skipped (populated)
    expect(inserts).toContain('note');                  // seeded
    expect(inserts).toContain('conflict');
    expect(inserts.filter((t) => t === 'note').length).toBe(20);
  });

  test('create computes next position and inserts', async () => {
    db.query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ pos: 7 }] })
      .mockResolvedValueOnce({ rows: [{ id: 99, type: 'note', template: 'x', position: 7, active: true }] });
    const row = await mv.create('note', 'x');
    expect(row.id).toBe(99);
    expect(db.query.mock.calls[1][1]).toEqual(['note', 'x', 7]);
  });

  test('update builds a partial SET and remove deletes by id', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 5, template: 'y', active: false, position: 0 }] });
    await mv.update(5, { template: 'y', active: false });
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE message_variations SET/);
    expect(sql).toMatch(/template = \$1/);
    expect(sql).toMatch(/active = \$2/);
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await mv.remove(5);
    expect(db.query).toHaveBeenCalledWith('DELETE FROM message_variations WHERE id = $1', [5]);
  });

  test('listTypes exposes the 5 editable sets with labels', () => {
    const types = mv.listTypes().map((t) => t.type).sort();
    expect(types).toEqual(['break_time_retry', 'conflict', 'greeting', 'note', 'voltei']);
    const conflict = mv.listTypes().find((t) => t.type === 'conflict');
    expect(conflict.placeholders).toEqual(['nome', 'parceiro', 'supp']);
    expect(conflict.default_count).toBe(10);
  });
});
