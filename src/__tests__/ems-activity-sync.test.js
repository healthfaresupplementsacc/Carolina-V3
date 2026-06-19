'use strict';
/* FASE 2 — EMS activity sync: extração (line+pipeline → atividades) + upsert/stale. */
const { EmsActivitySync } = require('../workers/ems-activity-sync');

const LINE = {
  equipment: [
    { id: 'eq1', name: 'NJP1200', equipment_type: 'capsule_machine', running: true, in_use_since: '2026-06-18T21:54:15Z',
      current_batch: { id: 'b1', batch_record_number: 'BR-2026-0223', status: 'encapsulating', target_qty_bottles: 700, actual_yield_bottles: null,
        formula: { formula_code: 'FRM-2026-0030', name: 'Folic Acid 1000mcg' }, product: { name: 'Folic Acid 1000mcg', image_url: 'https://img/x.jpg' } },
      operator: { name: 'Bruno Sarmento' } },
    { id: 'eq2', name: 'V-Blender', equipment_type: 'blender', running: false, in_use_since: null, current_batch: null, operator: null },
  ],
};
const PIPELINE = {
  formulation: [
    { id: 'b2', batch_record_number: 'BR-2026-0218', status: 'weighing', formula: { formula_code: 'FRM-0009', name: 'Plant Sterols' }, product: { name: 'Plant Sterols' }, operator: { name: 'Vitor' }, created_at: '2026-06-18T20:00:00Z' },
    { id: 'b3', batch_record_number: 'BR-2026-0299', status: 'weighing', operator: null, created_at: '2026-06-18T20:00:00Z' }, // sem operador → ignora
  ],
  production_line: [],
};

describe('EmsActivitySync.extract', () => {
  const w = new EmsActivitySync({});
  test('máquina RODANDO com batch vira atividade; parada é ignorada', () => {
    const acts = w.extract(LINE, { formulation: [], production_line: [] });
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ ems_key: 'eq1:b1', process_type: 'encapsulation', machine: 'NJP1200', batch_number: 'BR-2026-0223', employee_ems_name: 'Bruno Sarmento', target_bottles: 700, started_at: '2026-06-18T21:54:15Z' });
    expect(acts[0].supplement_name).toBe('Folic Acid 1000mcg');
  });
  test('pipeline: batch COM operador vira atividade; SEM operador é ignorado', () => {
    const acts = w.extract({ equipment: [] }, PIPELINE);
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ ems_key: 'b2:weighing', process_type: 'formulation', batch_number: 'BR-2026-0218', employee_ems_name: 'Vitor' });
  });
  test('EMS vazio → zero atividades (no-op, não quebra)', () => {
    expect(w.extract(null, null)).toEqual([]);
    expect(w.extract({ equipment: [] }, { formulation: [], production_line: [] })).toEqual([]);
  });
});

describe('EmsActivitySync._sync (upsert + stale)', () => {
  function makeDb() {
    const cache = []; const persons = [{ id: 7, display_name: 'Bruno Sarmento' }, { id: 4, display_name: 'Vitor' }];
    let seq = 1;
    return {
      cache,
      query: jest.fn(async (sql, params = []) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        if (/SELECT id, display_name FROM v3\.persons/.test(s)) return { rows: persons };
        if (/INSERT INTO v3\.ems_activity_cache/.test(s)) {
          const key = params[0]; const existing = cache.find((c) => c.ems_key === key);
          if (existing) { existing.stage = params[2]; existing.sync_status = 'active'; existing.ended_at = null; existing.last_synced_at = new Date(); }
          else cache.push({ id: seq++, ems_key: key, process_type: params[1], stage: params[2], machine: params[3], tracker_person_id: params[9], started_at: params[13], sync_status: 'active', ended_at: null, last_synced_at: new Date() });
          return { rows: [] };
        }
        if (/UPDATE v3\.ems_activity_cache SET sync_status = 'completed'/.test(s)) {
          const cutoff = new Date(params[0]);
          cache.filter((c) => c.sync_status === 'active' && c.last_synced_at < cutoff).forEach((c) => { c.sync_status = 'completed'; c.ended_at = new Date(); });
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
  }
  test('upsert mapeia operador→person; tick seguinte sem a atividade → completed', async () => {
    const db = makeDb();
    const w = new EmsActivitySync({ db });
    await w._sync(w.extract(LINE, { formulation: [], production_line: [] }));
    expect(db.cache).toHaveLength(1);
    expect(db.cache[0].tracker_person_id).toBe(7); // Bruno Sarmento mapeado
    expect(db.cache[0].sync_status).toBe('active');
    // próximo tick: atividade sumiu do EMS (máquina parou) → marca completed
    await new Promise((r) => setTimeout(r, 5));
    await w._sync([]);
    expect(db.cache[0].sync_status).toBe('completed');
    expect(db.cache[0].ended_at).toBeTruthy();
  });
});
