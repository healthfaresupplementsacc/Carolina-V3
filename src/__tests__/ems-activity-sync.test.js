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
  test('pipeline OBJETO-por-stage (shape real EMS) é achatado, não ignorado', () => {
    // EMS real: formulation/production_line são objetos {stage:[...]}, não arrays.
    const pipelineObj = {
      formulation: {
        encapsulating: [{ id: 'b9', batch_record_number: 'BR-2026-0301', status: 'encapsulating', product: { name: 'Magnesium' }, operator: { name: 'Vitor' }, created_at: '2026-06-18T20:00:00Z' }],
        weighing: [{ id: 'b10', batch_record_number: 'BR-2026-0302', operator: null }], // sem operador → ignora
      },
      production_line: { yield_review: [{ id: 'b11', batch_record_number: 'BR-2026-0303', status: 'yield_review', product: { name: 'Zinc' }, operator: { name: 'Bruno Sarmento' }, created_at: '2026-06-18T20:00:00Z' }] },
    };
    const acts = w.extract({ equipment: [] }, pipelineObj);
    expect(acts).toHaveLength(2);
    expect(acts.map((a) => a.batch_number).sort()).toEqual(['BR-2026-0301', 'BR-2026-0303']);
    expect(acts.find((a) => a.batch_number === 'BR-2026-0301').process_type).toBe('encapsulation');
    expect(acts.find((a) => a.batch_number === 'BR-2026-0303').process_type).toBe('production_line');
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
        if (/SELECT id FROM v3\.persons WHERE ems_user_id/.test(s)) return { rows: [] }; // sem UUID nestes mocks
        if (/FROM v3\.persons WHERE active = true/.test(s)) return { rows: persons };
        if (/UPDATE v3\.persons SET ems_user_id/.test(s)) return { rows: [] }; // backfill UUID
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
  test('UUID (ems_user_id) mapeia direto, sem depender do nome', async () => {
    const db = { query: jest.fn(async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/SELECT id FROM v3\.persons WHERE ems_user_id/.test(s)) return { rows: [{ id: 99 }] };
      return { rows: [] };
    }) };
    const w = new EmsActivitySync({ db });
    expect(await w._resolvePersonId('Nome Qualquer', 'uuid-abc')).toBe(99); // casou por UUID
  });

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

describe('EmsActivitySync._syncCleaning (ITEM 3 — limpeza)', () => {
  test('espelha last_cleaning das máquinas em ems_cleaning_log (idempotente)', async () => {
    const ups = [];
    const db = { query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/SELECT id, display_name.*FROM v3\.persons/.test(s) || /FROM v3\.persons WHERE active/.test(s)) return { rows: [{ id: 4, display_name: 'Vitor Leite' }] };
      if (/INSERT INTO v3\.ems_cleaning_log/.test(s)) { ups.push({ log: params[0], machine: params[1], by: params[5], pid: params[6] }); return { rows: [] }; }
      return { rows: [] };
    } };
    const w = new EmsActivitySync({ db });
    const line = { equipment: [
      { name: 'NJP1200', equipment_type: 'capsule_machine', last_cleaning: { log_number: 'CL-1', cleaning_type: 'full_changeover', cleaned_by: 'Vitor Leite', cleaned_at: '2026-06-20T16:15:00Z', status: 'passed' } },
      { name: 'Scale #01', equipment_type: 'scale', last_cleaning: null }, // sem limpeza → ignora
    ] };
    const n = await w._syncCleaning(line);
    expect(n).toBe(1);
    expect(ups[0]).toMatchObject({ log: 'CL-1', machine: 'NJP1200', by: 'Vitor Leite', pid: 4 });
  });
});

describe('EmsActivitySync._autoCheckin (gate de início recente)', () => {
  function makeDb(opts = {}) {
    const events = []; const cacheAuto = opts.cacheAuto || {}; let seq = 700;
    return {
      events,
      query: jest.fn(async (sql, params = []) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        if (/SELECT auto_event_id FROM v3\.ems_activity_cache WHERE ems_key/.test(s)) return { rows: [{ auto_event_id: cacheAuto[params[0]] || null }] };
        if (/FROM v3\.product_batches WHERE batch_number/.test(s)) return { rows: [{ id: 55 }] };
        if (/SELECT 1 FROM v3\.events WHERE person_id/.test(s)) return { rows: opts.openEvent ? [{ x: 1 }] : [], rowCount: opts.openEvent ? 1 : 0 };
        if (/FROM v3\.activity_types WHERE slug/.test(s)) return { rows: [{ id: 30 }] };
        if (/INSERT INTO v3\.events/.test(s)) { const id = seq++; events.push({ id, person: params[0], activity: params[1], batch: params[2], started_at: params[3], source: 'ems_auto' }); return { rows: [{ id }] }; }
        return { rows: [] };
      }),
    };
  }
  const recent = () => new Date(Date.now() - 5 * 60000).toISOString();  // 5 min atrás
  const old = () => new Date(Date.now() - 90 * 60000).toISOString();    // 90 min atrás
  const act = (over) => Object.assign({ ems_key: 'k1', stage: 'encapsulating', batch_number: 'BR-2026-0223', machine: 'NJP1200', tracker_person_id: 7, stage_started_at: recent() }, over);

  test('início RECENTE + mapeado + sem event aberto → cria task ems_auto com started_at do stage', async () => {
    const db = makeDb(); const w = new EmsActivitySync({ db, autoCheckin: true });
    const a = act();
    const n = await w._autoCheckin([a]);
    expect(n).toBe(1);
    expect(db.events[0]).toMatchObject({ person: 7, source: 'ems_auto' });
    // started_at agora é um Date (não string crua) ≈ ao início do stage
    expect(new Date(db.events[0].started_at).getTime()).toBe(new Date(a.stage_started_at).getTime());
  });
  test('início no FUTURO (EMS corrompido) → NÃO cria event futuro; clampa started_at pra ~agora', async () => {
    const db = makeDb(); const w = new EmsActivitySync({ db, autoCheckin: true });
    const future = new Date(Date.now() + 4 * 3600000).toISOString(); // +4h (caso real batch 0234)
    const n = await w._autoCheckin([act({ stage_started_at: future })]);
    expect(n).toBe(1);
    const startMs = new Date(db.events[0].started_at).getTime();
    expect(startMs).toBeLessThanOrEqual(Date.now() + 2000);   // nunca no futuro
    expect(startMs).toBeGreaterThan(Date.now() - 60000);      // ~agora (detecção), não +4h
  });
  test('início VELHO (fora da janela) → NÃO cria (não back-fill de assignment)', async () => {
    const db = makeDb(); const w = new EmsActivitySync({ db, autoCheckin: true });
    expect(await w._autoCheckin([act({ stage_started_at: old() })])).toBe(0);
  });
  test('sem operador mapeado → NÃO cria', async () => {
    const db = makeDb(); const w = new EmsActivitySync({ db, autoCheckin: true });
    expect(await w._autoCheckin([act({ tracker_person_id: null })])).toBe(0);
  });
  test('já tem event aberto pro lote → NÃO duplica', async () => {
    const db = makeDb({ openEvent: true }); const w = new EmsActivitySync({ db, autoCheckin: true });
    expect(await w._autoCheckin([act()])).toBe(0);
  });
  test('já criou auto_event pra essa atividade → NÃO recria', async () => {
    const db = makeDb({ cacheAuto: { k1: 999 } }); const w = new EmsActivitySync({ db, autoCheckin: true });
    expect(await w._autoCheckin([act()])).toBe(0);
  });
  test('kill-switch OFF → não cria nada', async () => {
    const db = makeDb(); const w = new EmsActivitySync({ db, autoCheckin: false });
    expect(await w._autoCheckin([act()])).toBe(0);
  });
});

describe('EmsActivitySync._syncProductCatalog (Bruno 06-26: produtos novos do EMS entram sozinhos)', () => {
  test('importa só os produtos do EMS que NÃO existem no v3.products', async () => {
    const inserted = [];
    const db = { query: jest.fn(async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/SELECT 1 FROM v3\.products WHERE canonical_name ILIKE/.test(s)) {
        // "Melatonin" já existe; "Urolithin A" não
        return { rows: /Melatonin/i.test(params[0]) ? [{ '1': 1 }] : [], rowCount: /Melatonin/i.test(params[0]) ? 1 : 0 };
      }
      if (/INSERT INTO v3\.products/.test(s)) { inserted.push(params[0]); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }) };
    const ems = { products: async () => [
      { name: 'Melatonin', internal_sku: 'HF-MEL' },
      { name: 'Urolithin A', internal_sku: 'HF-UROL-1000', amazon_sku: 'X', walmart_sku: 'Y' },
    ] };
    const w = new EmsActivitySync({ db, ems });
    const added = await w._syncProductCatalog();
    expect(added).toBe(1);                 // só Urolithin A
    expect(inserted).toEqual(['Urolithin A']);
  });
});
