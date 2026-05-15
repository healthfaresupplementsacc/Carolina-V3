'use strict';
jest.mock('../db');
const db = require('../db');
const engine = require('../workflow/engine');

beforeEach(() => { jest.clearAllMocks(); });

describe('engine — ad-hoc primitives (Fase 3.2)', () => {
  test('findOrCreateAdHocTask matches case-insensitively', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [
      { id: 1, name: 'Limpeza', admin_approved: true },
    ]});
    const r = await engine.findOrCreateAdHocTask({ name: 'limpeza' });
    expect(r.id).toBe(1);
    expect(r.adminApproved).toBe(true);
    expect(r.created).toBe(false);
  });

  test('findOrCreateAdHocTask creates pending entry when name unknown', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, name, admin_approved FROM ad_hoc_tasks/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/INSERT INTO ad_hoc_tasks/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 99, name: 'limpando' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.findOrCreateAdHocTask({ name: 'limpando', createdByOperatorId: 5 });
    expect(r.id).toBe(99);
    expect(r.adminApproved).toBe(false);
    expect(r.created).toBe(true);
  });

  test('resolveReporteLink matches FO-NNNN to a workflow + Contagem phase', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/FROM workflow_instances/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 77 }] });
      }
      if (/FROM phase_instances pi\s+JOIN phase_templates pt/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 770 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.resolveReporteLink({
      text: 'Bia - Quantidade de Apple Cider adicionado no sistema FO-00614',
    });
    expect(r.matched).toBe(true);
    expect(r.workflowInstanceId).toBe(77);
    expect(r.phaseInstanceId).toBe(770);
  });

  test('resolveReporteLink returns matched=false when no FO code in text', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await engine.resolveReporteLink({ text: 'apenas conversa casual' });
    expect(r.matched).toBe(false);
  });

  test('resolveReporteLink returns matched=false when batch not found', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/FROM workflow_instances/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.resolveReporteLink({ text: 'Quantidade FO-99999' });
    expect(r.matched).toBe(false);
  });

  test('startAdHocTask of "Reporte no sistema" with FO-XXX links to Contagem phase', async () => {
    let insertedInstance = null;
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/FROM ad_hoc_tasks\s+WHERE LOWER\(name\)/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 6, name: 'Reporte no sistema', admin_approved: true }] });
      }
      if (/FROM workflow_instances/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 77 }] });
      }
      if (/FROM phase_instances pi\s+JOIN phase_templates pt/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 770 }] });
      }
      if (/INSERT INTO ad_hoc_task_instances/.test(sql)) {
        insertedInstance = params;
        return Promise.resolve({ rows: [{ id: 7700 }] });
      }
      if (/FROM operator_activity_log\s+WHERE operator_id = \$1 AND ended_at IS NULL/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/INSERT INTO operator_activity_log/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 8800 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.startAdHocTask({
      taskName: 'Reporte no sistema', operatorId: 5,
      text: 'Bia - Quantidade de Apple Cider adicionado no sistema FO-00614',
    });
    expect(r.adHocTaskInstanceId).toBe(7700);
    expect(r.linkedWorkflowInstanceId).toBe(77);
    expect(r.linkedPhaseInstanceId).toBe(770);
    expect(insertedInstance[4]).toBe(77);  // linked_workflow_instance_id
    expect(insertedInstance[5]).toBe(770); // linked_phase_instance_id
  });

  test('startAdHocTask with unknown name marks isPending=true', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/FROM ad_hoc_tasks\s+WHERE LOWER\(name\)/.test(sql)) return Promise.resolve({ rows: [] });
      if (/INSERT INTO ad_hoc_tasks/.test(sql)) return Promise.resolve({ rows: [{ id: 88, name: 'limpando' }] });
      if (/INSERT INTO ad_hoc_task_instances/.test(sql)) return Promise.resolve({ rows: [{ id: 1 }] });
      if (/FROM operator_activity_log\s+WHERE operator_id = \$1 AND ended_at IS NULL/.test(sql)) return Promise.resolve({ rows: [] });
      if (/INSERT INTO operator_activity_log/.test(sql)) return Promise.resolve({ rows: [{ id: 1 }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.startAdHocTask({ taskName: 'limpando', operatorId: 5 });
    expect(r.isPending).toBe(true);
    expect(r.isNewTaskInCatalog).toBe(true);
  });

  test('closeAdHocTask closes instance + oal rows + returns participants', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, status FROM ad_hoc_task_instances/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 7700, status: 'open' }] });
      }
      if (/UPDATE ad_hoc_task_instances\s+SET status = 'closed'/.test(sql)) return Promise.resolve({ rows: [] });
      if (/UPDATE operator_activity_log[\s\S]+RETURNING id, operator_id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 1, operator_id: 5 }] });
      }
      if (/SELECT DISTINCT oal.operator_id/.test(sql)) {
        return Promise.resolve({ rows: [{ operator_id: 5, name: 'Ana' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.closeAdHocTask({ adHocTaskInstanceId: 7700 });
    expect(r.alreadyClosed).toBe(false);
    expect(r.participants[0].name).toBe('Ana');
  });
});
