'use strict';
/**
 * Entrega 3 Fase 1.5: confirm the seed produces the exact templates
 * approved by Bruno — 3 workflows, 13 phase_templates (7 + 4 + 2),
 * 8 ad_hoc_tasks, and the Revisão prereq uses mode='any'.
 */

jest.mock('../db');
const db = require('../db');
const { seedTemplates } = require('../workflow/seed');

// Stateful mock so the 2nd-pass prereq update can resolve phase ids by name.
function buildMock() {
  const state = {
    workflows: new Map(),  // name → id
    phases: new Map(),     // `${wfId}::${name}` → { id, prereqJson }
    adhocs: new Map(),     // name → true
    nextId: 1,
    calls: [],
  };
  db.query = jest.fn().mockImplementation((sql, params) => {
    state.calls.push({ sql, params });
    if (/INSERT INTO workflow_templates/.test(sql)) {
      const name = params[0];
      if (!state.workflows.has(name)) state.workflows.set(name, state.nextId++);
      return Promise.resolve({ rows: [{ id: state.workflows.get(name), inserted: true }] });
    }
    if (/SELECT id FROM phase_templates WHERE workflow_template_id = \$1 AND name = \$2/.test(sql)) {
      const key = `${params[0]}::${params[1]}`;
      const r = state.phases.get(key);
      return Promise.resolve({ rows: r ? [{ id: r.id }] : [] });
    }
    if (/INSERT INTO phase_templates/.test(sql)) {
      const wfId = params[0], name = params[1];
      const id = state.nextId++;
      state.phases.set(`${wfId}::${name}`, { id, prereqJson: '[]', mode: params[6] });
      return Promise.resolve({ rows: [{ id }] });
    }
    if (/UPDATE phase_templates\s+SET prerequisite_phase_ids/.test(sql)) {
      const wfId = params[1], name = params[2];
      const ph = state.phases.get(`${wfId}::${name}`);
      if (ph) ph.prereqJson = params[0];
      return Promise.resolve({ rows: [] });
    }
    if (/UPDATE phase_templates SET/.test(sql)) return Promise.resolve({ rows: [] });
    if (/INSERT INTO ad_hoc_tasks/.test(sql)) {
      state.adhocs.set(params[0], true);
      return Promise.resolve({ rows: [{ inserted: true }] });
    }
    return Promise.resolve({ rows: [] });
  });
  return state;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('Entrega 3 Fase 1.5 — seed templates', () => {
  test('seeds exactly 3 workflow_templates with the approved names', async () => {
    const s = buildMock();
    const r = await seedTemplates();
    expect(r.workflowsInserted).toBe(3);
    expect([...s.workflows.keys()].sort()).toEqual([
      'Envio FBA/Walmart/Tiktok/Ebay',
      'Picking & Packing',
      'Produção de Suplemento',
    ]);
  });

  test('Produção de Suplemento has 7 phases including Mix as required and Encapsulação/Tablet parallel', async () => {
    const s = buildMock();
    await seedTemplates();
    const wfId = s.workflows.get('Produção de Suplemento');
    expect(wfId).toBeDefined();
    const phaseNames = [...s.phases.keys()]
      .filter((k) => k.startsWith(wfId + '::'))
      .map((k) => k.split('::')[1]).sort();
    expect(phaseNames).toEqual([
      'Contagem', 'Encapsulação', 'Formulação', 'Linha de Produção',
      'Mix', 'Revisão', 'Tablet',
    ]);

    // Verify Mix is required and Encapsulação/Tablet share parallel_group
    const insertCalls = s.calls.filter((c) => /INSERT INTO phase_templates/.test(c.sql) && c.params[0] === wfId);
    const mix = insertCalls.find((c) => c.params[1] === 'Mix');
    expect(mix.params[3]).toBe(true); // is_required
    const enc = insertCalls.find((c) => c.params[1] === 'Encapsulação');
    const tab = insertCalls.find((c) => c.params[1] === 'Tablet');
    expect(enc.params[5]).toBe('cap_or_tab');
    expect(tab.params[5]).toBe('cap_or_tab');
    expect(enc.params[3]).toBe(false);
    expect(tab.params[3]).toBe(false);
  });

  test('Revisão uses prerequisite_mode="any" on [Encapsulação, Tablet]', async () => {
    const s = buildMock();
    await seedTemplates();
    const wfId = s.workflows.get('Produção de Suplemento');
    const rev = s.calls.find((c) =>
      /INSERT INTO phase_templates/.test(c.sql) &&
      c.params[0] === wfId && c.params[1] === 'Revisão'
    );
    expect(rev.params[6]).toBe('any'); // prerequisite_mode

    // After the second pass, prereqJson should list the two phase ids
    const phaseKey = `${wfId}::Revisão`;
    const phase = s.phases.get(phaseKey);
    const ids = JSON.parse(phase.prereqJson);
    expect(ids.length).toBe(2);
    const encId = s.phases.get(`${wfId}::Encapsulação`).id;
    const tabId = s.phases.get(`${wfId}::Tablet`).id;
    expect(ids.sort()).toEqual([encId, tabId].sort());
  });

  test('Picking & Packing has 4 phases all soft-prereq', async () => {
    const s = buildMock();
    await seedTemplates();
    const wfId = s.workflows.get('Picking & Packing');
    const phases = [...s.phases.keys()]
      .filter((k) => k.startsWith(wfId + '::'))
      .map((k) => k.split('::')[1]).sort();
    expect(phases).toEqual([
      'Colar label no envelope', 'Empacotar',
      'Imprimir ordens', 'Separar bottles',
    ]);
    // All phase inserts should have soft_prereq=true (param index 7)
    const inserts = s.calls.filter((c) =>
      /INSERT INTO phase_templates/.test(c.sql) && c.params[0] === wfId
    );
    expect(inserts.length).toBe(4);
    for (const c of inserts) expect(c.params[7]).toBe(true);
  });

  test('Envio FBA/Walmart/Tiktok/Ebay has 2 phases', async () => {
    const s = buildMock();
    await seedTemplates();
    const wfId = s.workflows.get('Envio FBA/Walmart/Tiktok/Ebay');
    const phases = [...s.phases.keys()]
      .filter((k) => k.startsWith(wfId + '::')).length;
    expect(phases).toBe(2);
  });

  test('seeds exactly 8 ad_hoc_tasks all admin_approved=true', async () => {
    const s = buildMock();
    const r = await seedTemplates();
    expect(r.adHocInserted).toBe(8);
    const names = [...s.adhocs.keys()].sort();
    expect(names).toEqual([
      'Estoque', 'Limpeza', 'Manutenção', 'Outro',
      'Reporte no sistema', 'Reunião', 'Transformação', 'Treinamento',
    ]);
    // Every insert passed (name, desc, TRUE, TRUE)? Check first
    const ahInserts = s.calls.filter((c) => /INSERT INTO ad_hoc_tasks/.test(c.sql));
    for (const c of ahInserts) {
      expect(c.params.length).toBe(2); // name, description (TRUE/TRUE are literals)
      expect(/TRUE,\s*TRUE/i.test(c.sql)).toBe(true);
    }
  });

  test('re-running seed is idempotent (upsert path)', async () => {
    const s = buildMock();
    await seedTemplates();
    const callsAfter1 = s.calls.length;
    await seedTemplates(); // 2nd run — should hit the SELECT/UPDATE path for phases
    const callsAfter2 = s.calls.length;
    expect(callsAfter2).toBeGreaterThan(callsAfter1);
    // Same phase count (no duplicates created)
    const wfId = s.workflows.get('Produção de Suplemento');
    const dup = [...s.phases.keys()].filter((k) => k.startsWith(wfId + '::')).length;
    expect(dup).toBe(7);
  });
});
