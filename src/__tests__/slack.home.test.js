'use strict';
jest.mock('../db');
const db = require('../db');
const home = require('../slack/home');

beforeEach(() => { jest.clearAllMocks(); });

describe('buildHomeView', () => {
  test('renders empty state cleanly', () => {
    const v = home.buildHomeView({ operators: [], workflows: [], phases: [], adhoc: [], breaks: [] });
    expect(v.type).toBe('home');
    const txt = JSON.stringify(v);
    // U4: header no longer prefixed with "Carolina — "
    expect(txt).toMatch(/🌿 HealthFare Production/);
    expect(txt).not.toMatch(/Carolina — HealthFare/);
    expect(txt).toMatch(/Nenhum batch ativo/);
    expect(txt).toMatch(/Ningu[ée]m em break/);
    // Primary action buttons present
    expect(txt).toMatch(/Iniciar batch/);
    expect(txt).toMatch(/Tarefa avulsa/);
  });

  test('renders active workflow with its open phases + overflow menu', () => {
    const v = home.buildHomeView({
      operators: [{ id: 1, name: 'Vitor' }],
      workflows: [{ id: 10, product_name: 'Green Tea', batch_number: '0098',
                    started_at: new Date(Date.now() - 3600000).toISOString(),
                    batch_change_approved: true, workflow_name: 'Produção de Suplemento' }],
      phases: [{ id: 50, workflow_instance_id: 10, phase_name: 'Encapsulação',
                 status: 'open', started_at: new Date(Date.now() - 600000).toISOString(),
                 starter_name: 'Bruno' }],
      adhoc: [], breaks: [],
    });
    const txt = JSON.stringify(v);
    expect(txt).toMatch(/Green Tea #0098/);
    expect(txt).toMatch(/Encapsulação/);
    expect(txt).toMatch(/Bruno/);
    expect(txt).toMatch(/join_phase:50/);
    expect(txt).toMatch(/close_phase:50/);
  });

  test('F1 — phase shows all participants (starter + joiners) not just starter', () => {
    const v = home.buildHomeView({
      operators: [{ id: 1, name: 'Vitor' }],
      workflows: [{ id: 10, product_name: 'Green Tea', batch_number: '0098',
                    started_at: new Date(Date.now() - 3600000).toISOString(),
                    batch_change_approved: true, workflow_name: 'Produção de Suplemento' }],
      phases: [{ id: 50, workflow_instance_id: 10, phase_name: 'Formulação',
                 status: 'open', started_at: new Date(Date.now() - 600000).toISOString(),
                 starter_name: 'Vitor', participants: 'Ana + Vitor' }],
      adhoc: [], breaks: [],
    });
    const txt = JSON.stringify(v);
    expect(txt).toMatch(/Ana \+ Vitor/);
  });

  test('F1 — falls back to starter_name when no participants string', () => {
    const v = home.buildHomeView({
      operators: [], workflows: [{ id: 10, product_name: 'X', batch_number: '1',
        started_at: new Date().toISOString(), batch_change_approved: true, workflow_name: 'W' }],
      phases: [{ id: 51, workflow_instance_id: 10, phase_name: 'Mix', status: 'open',
                 started_at: new Date().toISOString(), starter_name: 'Bruno', participants: null }],
      adhoc: [], breaks: [],
    });
    expect(JSON.stringify(v)).toMatch(/Bruno/);
  });

  test('flags batch change with hourglass', () => {
    const v = home.buildHomeView({
      operators: [], breaks: [], phases: [], adhoc: [],
      workflows: [{ id: 1, product_name: 'X', batch_number: '1', started_at: new Date().toISOString(),
                    batch_change_approved: false, workflow_name: 'W' }],
    });
    expect(JSON.stringify(v)).toMatch(/batch alterado/);
  });

  test('flags pending ad-hoc task', () => {
    const v = home.buildHomeView({
      operators: [], breaks: [], phases: [], workflows: [],
      adhoc: [{ id: 1, task_name: 'limpando', started_at: new Date().toISOString(),
                admin_approved: false, starter_name: 'Ana' }],
    });
    expect(JSON.stringify(v)).toMatch(/pendente de revis[ãa]o/);
  });

  test('lists operators on break with elapsed', () => {
    const v = home.buildHomeView({
      operators: [], workflows: [], phases: [], adhoc: [],
      breaks: [{ id: 1, operator_name: 'Ana', started_at: new Date(Date.now() - 720000).toISOString() }],
    });
    expect(JSON.stringify(v)).toMatch(/Ana \(\d+min\)/);
  });
});

describe('fetchHomeState', () => {
  test('queries operators, workflows, phases, adhoc, breaks', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const s = await home.fetchHomeState();
    expect(s).toEqual({ operators: [], workflows: [], phases: [], adhoc: [], breaks: [] });
    expect(db.query).toHaveBeenCalledTimes(5);
  });

  test('Bug 1 — phase/workflow/adhoc queries filter open AND ended_at IS NULL', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await home.fetchHomeState();
    const sqls = db.query.mock.calls.map((c) => c[0]);
    const wf = sqls.find((s) => /FROM workflow_instances wi/.test(s));
    const ph = sqls.find((s) => /FROM phase_instances pi/.test(s));
    const ah = sqls.find((s) => /FROM ad_hoc_task_instances ati/.test(s));
    expect(wf).toMatch(/wi\.status = 'active' AND wi\.ended_at IS NULL/);
    expect(ph).toMatch(/pi\.status = 'open' AND pi\.ended_at IS NULL/);
    expect(ah).toMatch(/ati\.status = 'open' AND ati\.ended_at IS NULL/);
  });

  test('Bug 2 — all Home list queries order by started_at DESC (newest first)', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await home.fetchHomeState();
    const sqls = db.query.mock.calls.map((c) => c[0]);
    const wf = sqls.find((s) => /FROM workflow_instances wi/.test(s));
    const ph = sqls.find((s) => /FROM phase_instances pi/.test(s));
    const ah = sqls.find((s) => /FROM ad_hoc_task_instances ati/.test(s));
    const br = sqls.find((s) => /activity_type = 'break'/.test(s));
    for (const q of [wf, ph, ah, br]) {
      expect(q).toMatch(/ORDER BY [a-z]+\.started_at DESC/);
      expect(q).not.toMatch(/started_at ASC/);
    }
  });
});
