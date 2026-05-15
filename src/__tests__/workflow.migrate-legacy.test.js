'use strict';
jest.mock('../db');
const db = require('../db');
const m = require('../workflow/migrate-legacy');

const TPL_STATE = {
  wfByName: {
    'Produção de Suplemento': 1,
    'Picking & Packing': 2,
    'Envio FBA/Walmart/Tiktok/Ebay': 3,
  },
  phaseByKey: {
    'Produção de Suplemento::Formulação': 10,
    'Produção de Suplemento::Mix': 11,
    'Produção de Suplemento::Encapsulação': 12,
    'Produção de Suplemento::Tablet': 13,
    'Produção de Suplemento::Revisão': 14,
    'Produção de Suplemento::Linha de Produção': 15,
    'Produção de Suplemento::Contagem': 16,
    'Picking & Packing::Imprimir ordens': 20,
    'Picking & Packing::Empacotar': 21,
  },
  adhocByName: {
    limpeza: 100, manutenção: 101, treinamento: 102, reunião: 103,
    estoque: 104, 'reporte no sistema': 105, transformação: 106, outro: 107,
  },
  opByName: { Ana: 1, Bruno: 2, Vitor: 3, Simone: 4 },
};

beforeEach(() => { jest.clearAllMocks(); });

describe('migrate-legacy — tasks', () => {
  test('producao task → workflow_instance + Linha de Produção phase_instance', async () => {
    const inserts = [];
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/FROM tasks t[\s\S]+LIMIT/.test(sql)) {
        return Promise.resolve({ rows: [{
          id: 100, operator: 'Vitor', supplement_name: 'Green Tea', batch_number: '0098',
          task_type: 'producao', status: 'closed',
          started_at: '2026-05-15T10:00Z', ended_at: '2026-05-15T11:00Z',
          closed_by: 'Vitor', helpers: null, description: null,
          slack_start_ts: '170', slack_end_ts: '171', final_bottle_count: 480,
        }]});
      }
      if (/SELECT id FROM workflow_instances/.test(sql)) {
        return Promise.resolve({ rows: [] }); // no existing match
      }
      if (/INSERT INTO workflow_instances/.test(sql)) {
        inserts.push({ table: 'workflow_instances', params });
        return Promise.resolve({ rows: [{ id: 500 }] });
      }
      if (/INSERT INTO phase_instances/.test(sql)) {
        inserts.push({ table: 'phase_instances', params });
        return Promise.resolve({ rows: [{ id: 5000 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await m.migrateTasks(TPL_STATE);
    expect(r.phaseInstancesCreated).toBe(1);
    expect(r.workflowsCreated).toBe(1);

    const wfIns = inserts.find((i) => i.table === 'workflow_instances');
    expect(wfIns.params[0]).toBe(1); // wf template 'Produção de Suplemento'
    expect(wfIns.params[6]).toBe(100); // legacy_id

    const phIns = inserts.find((i) => i.table === 'phase_instances');
    expect(phIns.params[1]).toBe(15); // phase template 'Linha de Produção'
    expect(phIns.params[9]).toBe(480); // final_bottle_count
    expect(phIns.params[11]).toBe(100); // legacy_id
  });

  test('limpeza task → ad_hoc_task_instance (not phase)', async () => {
    let adHocIns = null;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/FROM tasks t[\s\S]+LIMIT/.test(sql)) {
        return Promise.resolve({ rows: [{
          id: 200, operator: 'Ana', task_type: 'limpeza', status: 'closed',
          started_at: '2026-05-15T17:00Z', ended_at: '2026-05-15T17:30Z',
          supplement_name: null, batch_number: null, closed_by: 'Ana',
          description: null, slack_start_ts: null, slack_end_ts: null,
          final_bottle_count: null, helpers: null,
        }]});
      }
      if (/INSERT INTO ad_hoc_task_instances/.test(sql)) {
        adHocIns = params;
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await m.migrateTasks(TPL_STATE);
    expect(r.adHocCreated).toBe(1);
    expect(adHocIns[0]).toBe(100); // ad_hoc_task_id = Limpeza
    expect(adHocIns[8]).toBe(200); // legacy_id
  });

  test('task already migrated is skipped (idempotency via NOT EXISTS)', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/FROM tasks t[\s\S]+NOT EXISTS/.test(sql)) {
        // SQL excludes already-migrated rows
        expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM phase_instances/);
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await m.migrateTasks(TPL_STATE);
    expect(r.phaseInstancesCreated).toBe(0);
  });

  test('reuses existing workflow_instance when supplement+batch match', async () => {
    let wfCreated = false;
    db.query = jest.fn().mockImplementation((sql) => {
      if (/FROM tasks t[\s\S]+LIMIT/.test(sql)) {
        return Promise.resolve({ rows: [{
          id: 300, operator: 'Vitor', supplement_name: 'Berberine', batch_number: '0119',
          task_type: 'revisao', status: 'closed',
          started_at: '2026-05-15T11:00Z', ended_at: '2026-05-15T11:30Z',
          closed_by: 'Vitor', description: null, helpers: null,
          slack_start_ts: null, slack_end_ts: null, final_bottle_count: null,
        }]});
      }
      if (/SELECT id FROM workflow_instances/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 777 }] }); // existing match
      }
      if (/INSERT INTO workflow_instances/.test(sql)) { wfCreated = true; return Promise.resolve({ rows: [{ id: 1 }] }); }
      if (/INSERT INTO phase_instances/.test(sql)) return Promise.resolve({ rows: [{ id: 1 }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await m.migrateTasks(TPL_STATE);
    expect(r.phaseInstancesCreated).toBe(1);
    expect(r.workflowsCreated).toBe(0); // didn't create — reused 777
    expect(wfCreated).toBe(false);
  });
});

describe('migrate-legacy — orders_sessions', () => {
  test('creates Picking & Packing workflow + Imprimir phase, pass_number from batch_label', async () => {
    let wfIns = null;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/FROM orders_sessions[\s\S]+LIMIT/.test(sql)) {
        return Promise.resolve({ rows: [{
          id: 9, operator: 'Simone', order_count: 188, batch_label: 'morning',
          started_at: '2026-05-13T09:00Z', ended_at: '2026-05-13T09:30Z',
          status: 'closed', slack_start_ts: '170', helpers: 'Ana',
        }]});
      }
      if (/INSERT INTO workflow_instances/.test(sql)) {
        wfIns = params;
        return Promise.resolve({ rows: [{ id: 900 }] });
      }
      if (/INSERT INTO phase_instances/.test(sql)) return Promise.resolve({ rows: [{ id: 1 }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await m.migrateOrdersSessions(TPL_STATE);
    expect(r.workflowsCreated).toBe(1);
    expect(r.phaseInstancesCreated).toBe(1);
    expect(wfIns[0]).toBe(2); // wf template 'Picking & Packing'
    expect(wfIns[1]).toBe(1); // pass_number=1 for morning
    expect(wfIns[7]).toBe(9); // legacy_id
  });
});

describe('migrate-legacy — pauses', () => {
  test('inserts operator_activity_log with activity_type=break and duration', async () => {
    let oalIns = null;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/FROM pauses[\s\S]+LIMIT/.test(sql)) {
        return Promise.resolve({ rows: [{
          id: 7, operator: 'Ana', reason: 'almoço',
          started_at: '2026-05-15T12:00Z', ended_at: '2026-05-15T13:00Z',
          ended_reason: 'manual_return',
        }]});
      }
      if (/INSERT INTO operator_activity_log/.test(sql)) {
        oalIns = params;
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await m.migratePauses(TPL_STATE);
    expect(r.oalCreated).toBe(1);
    expect(oalIns[0]).toBe(1); // operator_id Ana
    expect(oalIns[1]).toBe(7); // pause_id
  });

  test('skips pauses whose operator is unknown', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/FROM pauses[\s\S]+LIMIT/.test(sql)) {
        return Promise.resolve({ rows: [{
          id: 8, operator: 'Carolzinha', started_at: 'x', ended_at: 'y', reason: null,
        }]});
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await m.migratePauses(TPL_STATE);
    expect(r.oalCreated).toBe(0);
    expect(r.skipped).toBe(1);
  });
});
