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
    expect(txt).toMatch(/Carolina — HealthFare Production/);
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
});
