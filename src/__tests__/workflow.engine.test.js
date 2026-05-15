'use strict';
jest.mock('../db');
const db = require('../db');
const engine = require('../workflow/engine');

beforeEach(() => { jest.clearAllMocks(); });

describe('engine — checkPrereqs', () => {
  test('returns ok:true when no prereqs', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [
      { prerequisite_phase_ids: [], prerequisite_mode: 'all', soft_prereq: true },
    ]});
    const r = await engine.checkPrereqs(1, 10);
    expect(r.ok).toBe(true);
  });

  test('mode=all: blocks if any prereq missing (when soft=false)', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT prerequisite_phase_ids/.test(sql)) {
        return Promise.resolve({ rows: [{
          prerequisite_phase_ids: [3, 4], prerequisite_mode: 'all', soft_prereq: false,
        }]});
      }
      if (/SELECT pt.id, pt.name/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 3, name: 'Mix' }] }); // 4 missing
      }
      if (/SELECT name FROM phase_templates WHERE id = ANY/.test(sql)) {
        return Promise.resolve({ rows: [{ name: 'Encapsulação' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.checkPrereqs(1, 10);
    expect(r.ok).toBe(false);
    expect(r.block).toBe(true);
    expect(r.violatedPrereqs).toContain('Encapsulação');
  });

  test('mode=any: passes if at least one prereq closed', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT prerequisite_phase_ids/.test(sql)) {
        return Promise.resolve({ rows: [{
          prerequisite_phase_ids: [3, 4], prerequisite_mode: 'any', soft_prereq: true,
        }]});
      }
      if (/SELECT pt.id, pt.name/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 3, name: 'Encapsulação' }] }); // one done
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.checkPrereqs(1, 10);
    expect(r.ok).toBe(true);
  });

  test('mode=any with NONE closed: violates but does not block when soft', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT prerequisite_phase_ids/.test(sql)) {
        return Promise.resolve({ rows: [{
          prerequisite_phase_ids: [3, 4], prerequisite_mode: 'any', soft_prereq: true,
        }]});
      }
      if (/SELECT pt.id, pt.name/.test(sql)) {
        return Promise.resolve({ rows: [] }); // none closed
      }
      if (/SELECT name FROM phase_templates WHERE id = ANY/.test(sql)) {
        return Promise.resolve({ rows: [{ name: 'Encapsulação' }, { name: 'Tablet' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.checkPrereqs(1, 10);
    expect(r.ok).toBe(false);
    expect(r.block).toBe(false);
    expect(r.violatedPrereqs.length).toBe(2);
  });
});

describe('engine — startPhase', () => {
  test('creates phase_instance + closes previous oal + opens new oal as starter', async () => {
    const ops = [];
    db.query = jest.fn().mockImplementation((sql, params) => {
      ops.push({ sql: sql.slice(0, 60), params });
      if (/SELECT prerequisite_phase_ids/.test(sql)) {
        return Promise.resolve({ rows: [{ prerequisite_phase_ids: [], prerequisite_mode: 'all', soft_prereq: true }] });
      }
      if (/SELECT name FROM phase_templates WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ name: 'Formulação' }] });
      }
      if (/FROM phase_instances\s+WHERE workflow_instance_id = \$1 AND phase_template_id/.test(sql)) {
        return Promise.resolve({ rows: [] }); // no existing
      }
      if (/INSERT INTO phase_instances/.test(sql)) return Promise.resolve({ rows: [{ id: 500 }] });
      if (/FROM operator_activity_log\s+WHERE operator_id = \$1 AND ended_at IS NULL/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 100 }] });
      }
      if (/UPDATE operator_activity_log\s+SET ended_at/.test(sql)) return Promise.resolve({ rows: [] });
      if (/INSERT INTO operator_activity_log/.test(sql)) return Promise.resolve({ rows: [{ id: 200 }] });
      if (/UPDATE operator_activity_log SET left_for_id/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.startPhase({
      workflowInstanceId: 50, phaseTemplateId: 1, operatorId: 5,
    });
    expect(r.phaseInstanceId).toBe(500);
    expect(r.oalId).toBe(200);
    expect(r.joined).toBe(false);

    const insertOal = ops.find((o) => /INSERT INTO operator_activity_log/.test(o.sql));
    expect(insertOal.params[6]).toBe('starter'); // role
  });

  test('returns joined=true when phase_instance already open', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT prerequisite_phase_ids/.test(sql)) {
        return Promise.resolve({ rows: [{ prerequisite_phase_ids: [], prerequisite_mode: 'all', soft_prereq: true }] });
      }
      if (/SELECT name FROM phase_templates WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ name: 'X' }] });
      }
      if (/FROM phase_instances\s+WHERE workflow_instance_id = \$1 AND phase_template_id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 999 }] }); // already open
      }
      if (/FROM operator_activity_log\s+WHERE operator_id = \$1 AND ended_at IS NULL/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/INSERT INTO operator_activity_log/.test(sql)) return Promise.resolve({ rows: [{ id: 300 }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.startPhase({
      workflowInstanceId: 50, phaseTemplateId: 1, operatorId: 5,
    });
    expect(r.phaseInstanceId).toBe(999);
    expect(r.joined).toBe(true);
  });

  test('throws PREREQ_BLOCKED when blocking prereqs unmet (soft=false)', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT prerequisite_phase_ids/.test(sql)) {
        return Promise.resolve({ rows: [{ prerequisite_phase_ids: [3], prerequisite_mode: 'all', soft_prereq: false }] });
      }
      if (/SELECT pt.id, pt.name/.test(sql)) return Promise.resolve({ rows: [] }); // none closed
      if (/SELECT name FROM phase_templates WHERE id = ANY/.test(sql)) {
        return Promise.resolve({ rows: [{ name: 'Formulação' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    await expect(engine.startPhase({
      workflowInstanceId: 1, phaseTemplateId: 5, operatorId: 1,
    })).rejects.toMatchObject({ code: 'PREREQ_BLOCKED' });
  });

  test('returns prereqWarning when soft prereqs unmet (does NOT throw)', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT prerequisite_phase_ids/.test(sql)) {
        return Promise.resolve({ rows: [{ prerequisite_phase_ids: [3], prerequisite_mode: 'all', soft_prereq: true }] });
      }
      if (/SELECT pt.id, pt.name/.test(sql)) return Promise.resolve({ rows: [] });
      if (/SELECT name FROM phase_templates WHERE id = ANY/.test(sql)) {
        return Promise.resolve({ rows: [{ name: 'Formulação' }] });
      }
      if (/SELECT name FROM phase_templates WHERE id = \$1/.test(sql)) {
        return Promise.resolve({ rows: [{ name: 'Mix' }] });
      }
      if (/FROM phase_instances\s+WHERE workflow_instance_id/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/INSERT INTO phase_instances/.test(sql)) return Promise.resolve({ rows: [{ id: 1 }] });
      if (/FROM operator_activity_log\s+WHERE operator_id = \$1 AND ended_at IS NULL/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/INSERT INTO operator_activity_log/.test(sql)) return Promise.resolve({ rows: [{ id: 1 }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.startPhase({
      workflowInstanceId: 1, phaseTemplateId: 5, operatorId: 1,
    });
    expect(r.prereqWarning).toEqual(['Formulação']);
  });
});

describe('engine — joinPhase, leaveCurrent, closePhase', () => {
  test('joinPhase opens oal with role=joiner', async () => {
    let inserted = null;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/SELECT id, status FROM phase_instances/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 99, status: 'open' }] });
      }
      if (/FROM operator_activity_log\s+WHERE operator_id = \$1 AND ended_at IS NULL/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/INSERT INTO operator_activity_log/.test(sql)) {
        inserted = params;
        return Promise.resolve({ rows: [{ id: 250 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.joinPhase({ phaseInstanceId: 99, operatorId: 7 });
    expect(r.oalId).toBe(250);
    expect(inserted[6]).toBe('joiner');
  });

  test('joinPhase rejects when phase not open', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 99, status: 'closed' }] });
    await expect(engine.joinPhase({ phaseInstanceId: 99, operatorId: 7 }))
      .rejects.toThrow(/not open/);
  });

  test('leaveCurrent closes active row and opens idle', async () => {
    let openedIdle = false;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/FROM operator_activity_log\s+WHERE operator_id = \$1 AND ended_at IS NULL/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 400, activity_type: 'phase', started_at: '2026-05-15T10:00:00Z' }] });
      }
      if (/INSERT INTO operator_activity_log/.test(sql)) {
        if (params[1] === 'idle') openedIdle = true;
        return Promise.resolve({ rows: [{ id: 401 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.leaveCurrent({ operatorId: 5 });
    expect(r.previousOalId).toBe(400);
    expect(r.newOalId).toBe(401);
    expect(openedIdle).toBe(true);
  });

  test('closePhase closes phase + all active oal rows + returns participants', async () => {
    const ops = [];
    db.query = jest.fn().mockImplementation((sql, params) => {
      ops.push({ sql: sql.slice(0, 60), params });
      if (/SELECT id, status, started_at/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 500, status: 'open', started_at: '2026-05-15T10:00Z', workflow_instance_id: 50, phase_name: 'Encapsulação' }] });
      }
      if (/UPDATE phase_instances/.test(sql)) return Promise.resolve({ rows: [] });
      if (/UPDATE operator_activity_log[\s\S]+RETURNING id, operator_id/.test(sql)) {
        return Promise.resolve({ rows: [
          { id: 1001, operator_id: 5 }, { id: 1002, operator_id: 7 },
        ]});
      }
      if (/SELECT DISTINCT oal.operator_id/.test(sql)) {
        return Promise.resolve({ rows: [
          { operator_id: 5, name: 'Vitor' },
          { operator_id: 7, name: 'Ana' },
        ]});
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.closePhase({ phaseInstanceId: 500, finalBottleCount: 480 });
    expect(r.alreadyClosed).toBe(false);
    expect(r.workflowInstanceId).toBe(50);
    expect(r.phaseName).toBe('Encapsulação');
    expect(r.participants.map((p) => p.name).sort()).toEqual(['Ana', 'Vitor']);
    const upd = ops.find((o) => /UPDATE phase_instances/.test(o.sql));
    expect(upd.params[2]).toBe(480); // final_bottle_count
  });

  test('closePhase returns alreadyClosed=true when phase already closed', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 500, status: 'closed' }] });
    const r = await engine.closePhase({ phaseInstanceId: 500 });
    expect(r.alreadyClosed).toBe(true);
  });
});

describe('engine — findOrCreateWorkflowInstance', () => {
  test('returns existing active instance for same product+batch', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 77 }] });
    const r = await engine.findOrCreateWorkflowInstance({
      workflowTemplateId: 1, productName: 'Green Tea', batchNumber: '0098',
    });
    expect(r.workflowInstanceId).toBe(77);
    expect(r.created).toBe(false);
  });

  test('creates new when no match', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id FROM workflow_instances/.test(sql)) return Promise.resolve({ rows: [] });
      if (/INSERT INTO workflow_instances/.test(sql)) return Promise.resolve({ rows: [{ id: 88 }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.findOrCreateWorkflowInstance({
      workflowTemplateId: 1, productName: 'Green Tea', batchNumber: '0098',
    });
    expect(r.workflowInstanceId).toBe(88);
    expect(r.created).toBe(true);
  });
});
