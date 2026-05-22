'use strict';
// HEALTHFARE V3 — Bloco 3 — testes de DeadlineService + CatalogService.
const { DeadlineService } = require('../v3/services/DeadlineService');
const { CatalogService } = require('../v3/services/CatalogService');

function makeFakeDb(seed = {}) {
  let nextId = 1;
  const deadlines = [];
  const activityTypes = (seed.activityTypes || []).map((a) => ({ ...a }));
  const audit = [];

  function run(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

    if (/^INSERT INTO v3\.deadlines/.test(s)) {
      const row = {
        id: nextId++, flow: params[0], label: params[1], kind: params[2],
        time_of_day: params[3], weekdays: params[4], due_date: params[5],
        active: params[6], notes: params[7], created_at: new Date(), updated_at: new Date(),
      };
      deadlines.push(row);
      return { rows: [{ ...row }] };
    }
    if (/^UPDATE v3\.deadlines SET /.test(s)) {
      const setPart = s.match(/SET ([\s\S]+) WHERE id = \$1/)[1];
      const row = deadlines.find((d) => d.id === params[0]);
      if (!row) return { rows: [] };
      for (const a of setPart.split(',').map((x) => x.trim())) {
        if (a.startsWith('updated_at')) continue;
        const m = a.match(/^(\w+) = \$(\d+)$/);
        if (m) row[m[1]] = params[Number(m[2]) - 1];
      }
      return { rows: [{ ...row }] };
    }
    if (/^SELECT \* FROM v3\.deadlines WHERE id = \$1/.test(s)) {
      const r = deadlines.find((d) => d.id === params[0]);
      return { rows: r ? [{ ...r }] : [] };
    }
    if (/^DELETE FROM v3\.deadlines WHERE id = \$1/.test(s)) {
      const i = deadlines.findIndex((d) => d.id === params[0]);
      if (i >= 0) deadlines.splice(i, 1);
      return { rows: [] };
    }
    if (/^SELECT \* FROM v3\.activity_types WHERE id = \$1/.test(s)) {
      const r = activityTypes.find((a) => a.id === params[0]);
      return { rows: r ? [{ ...r }] : [] };
    }
    if (/^UPDATE v3\.activity_types SET /.test(s)) {
      const setPart = s.match(/SET ([\s\S]+) WHERE id = \$1/)[1];
      const row = activityTypes.find((a) => a.id === params[0]);
      if (!row) return { rows: [] };
      for (const a of setPart.split(',').map((x) => x.trim())) {
        const m = a.match(/^(\w+) = \$(\d+)$/);
        if (m) row[m[1]] = params[Number(m[2]) - 1];
      }
      return { rows: [{ ...row }] };
    }
    if (/^INSERT INTO v3\.audit_log/.test(s)) {
      audit.push({ action: params[2], target_type: params[3], target_id: params[4] });
      return { rows: [] };
    }
    return { rows: [] };
  }

  const db = { deadlines, activityTypes, audit, query: jest.fn((sql, p) => Promise.resolve(run(sql, p))) };
  db.connect = () => Promise.resolve({ query: db.query, release: () => {} });
  return db;
}

describe('V3 Bloco 3 — DeadlineService', () => {
  test('create grava deadline e audita', async () => {
    const db = makeFakeDb();
    const d = await new DeadlineService({ db }).create(
      { flow: 'pnp', label: 'Corte correio', kind: 'recurring', time_of_day: '13:00' }, 1);
    expect(d.id).toBeDefined();
    expect(d.label).toBe('Corte correio');
    expect(db.audit.map((a) => a.action)).toContain('deadline.created');
  });

  test('create exige label', async () => {
    await expect(new DeadlineService({ db: makeFakeDb() }).create({ flow: 'pnp' }, 1))
      .rejects.toThrow(/label obrigatório/);
  });

  test('update edita campo permitido; rejeita campo inválido', async () => {
    const db = makeFakeDb();
    const s = new DeadlineService({ db });
    const d = await s.create({ label: 'X', time_of_day: '13:00' }, 1);
    const after = await s.update(d.id, { time_of_day: '14:00' }, 1);
    expect(after.time_of_day).toBe('14:00');
    await expect(s.update(d.id, { id: 99 }, 1)).rejects.toThrow(/não-editável/);
  });

  test('remove apaga a deadline (config — não é "nada se perde")', async () => {
    const db = makeFakeDb();
    const s = new DeadlineService({ db });
    const d = await s.create({ label: 'X' }, 1);
    await s.remove(d.id, 1);
    expect(db.deadlines).toHaveLength(0);
    expect(db.audit.map((a) => a.action)).toContain('deadline.removed');
  });
});

describe('V3 Bloco 3 — CatalogService', () => {
  test('updateActivityType reordena fase e audita', async () => {
    const db = makeFakeDb({ activityTypes: [
      { id: 5, slug: 'production_line', display_name: 'Linha', flow: 'production', phase_order: 5 }] });
    const after = await new CatalogService({ db }).updateActivityType(5, { phase_order: 4 }, 1);
    expect(after.phase_order).toBe(4);
    expect(db.audit.map((a) => a.action)).toContain('activity_type.updated');
  });

  test('updateActivityType rejeita campo não-editável e id inexistente', async () => {
    const db = makeFakeDb({ activityTypes: [{ id: 5, slug: 'x', display_name: 'X' }] });
    const s = new CatalogService({ db });
    await expect(s.updateActivityType(5, { slug: 'novo' }, 1)).rejects.toThrow(/não-editável/);
    await expect(s.updateActivityType(999, { phase_order: 1 }, 1)).rejects.toThrow(/não existe/);
  });
});
