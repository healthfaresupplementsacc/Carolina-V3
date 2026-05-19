'use strict';
// FASE 1 P5 — Carolina's ISA-88 instance-lifecycle mutation (close_phase)
// goes through the SINGLE canonical writer, idempotent by
// source_id = tool_call_id, audited ai_admin_executed + dispatcher.upsert.
jest.mock('../db');
jest.mock('../dispatcher/canonical-dispatcher', () => ({
  safeDispatch: jest.fn().mockResolvedValue({ dispatched: true, upsert: 'create', target_table: 'phase_instances', target_id: 5 }),
}));

const db = require('../db');
const canonical = require('../dispatcher/canonical-dispatcher');
const at = require('../ai/admin-tools');

beforeEach(() => {
  jest.clearAllMocks();
  db.query = jest.fn().mockResolvedValue({ rows: [] });
});

describe('P5 — close_phase → canonical dispatcher (EventoCanônico)', () => {
  test('builds a carolina_tool finish event keyed by tool_call_id, no direct engine write', async () => {
    const audit = jest.fn().mockResolvedValue();
    await at.runTool(
      'close_phase',
      { phase_instance_id: 42, bottle_count: 480 },
      { auditAction: audit, toolCallId: 'toolu_ABC123' }
    );
    expect(canonical.safeDispatch).toHaveBeenCalledTimes(1);
    const ev = canonical.safeDispatch.mock.calls[0][0];
    expect(ev).toMatchObject({
      source_type: 'carolina_tool',
      source_id: 'carolina_tool:toolu_ABC123',
      type: 'finish',
      target_phase_id: 42,
    });
    expect(ev.metadata.finalBottleCount).toBe(480);
  });

  test('pairs ai_admin_executed audit with the dispatcher result (spec 5.1)', async () => {
    const audit = jest.fn().mockResolvedValue();
    await at.runTool('close_phase', { phase_instance_id: 7 }, { auditAction: audit, toolCallId: 't1' });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ai_admin_executed',
        entityId: 'close_phase',
        before: expect.objectContaining({ source_id: 'carolina_tool:t1' }),
      })
    );
  });

  test('admin close (no operator) is NOT treated as ambiguous (carolina_tool exception)', async () => {
    // Re-require the REAL dispatcher to prove the guard exception.
    jest.resetModules();
    jest.dontMock('../dispatcher/canonical-dispatcher');
    jest.doMock('../db');
    jest.doMock('../workflow/engine', () => ({
      closePhase: jest.fn().mockResolvedValue({ alreadyClosed: false, participants: [] }),
    }));
    jest.doMock('../admin/audit', () => ({ auditAction: jest.fn().mockResolvedValue(1) }));
    jest.doMock('../workflow/dispatcher', () => ({
      getTemplateContext: jest.fn().mockResolvedValue({ wfByName: {}, phaseByKey: {} }),
      resolveTemplate: jest.fn(),
      findOpenPhaseInstance: jest.fn(),
    }));
    const realDb = require('../db');
    realDb.query = jest.fn((sql, params) => {
      if (/FROM dispatcher_index/.test(sql)) return Promise.resolve({ rows: [] });
      if (/SELECT id, workflow_instance_id, status FROM phase_instances WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: params[0], workflow_instance_id: 9, status: 'open' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const realDisp = require('../dispatcher/canonical-dispatcher');
    const realEngine = require('../workflow/engine');
    const { makeEvent } = require('../dispatcher/event-schema');
    const r = await realDisp.dispatch(makeEvent({
      source_id: 'carolina_tool:tX', source_type: 'carolina_tool',
      type: 'finish', operator_id: null, target_phase_id: 42,
    }));
    expect(r.dispatched).toBe(true);
    expect(r.needsDisambiguation).toBeUndefined();
    expect(realEngine.closePhase).toHaveBeenCalledWith(
      expect.objectContaining({ phaseInstanceId: 42, closedByOperatorId: null })
    );
    jest.resetModules();
  });
});

describe('P5 — non-instance mutation tools are NOT routed through the dispatcher', () => {
  test('approve_adhoc still uses the audited EXEC path (catalog op, not EventoCanônico)', async () => {
    const audit = jest.fn().mockResolvedValue();
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 9 }] });
    await at.runTool('approve_adhoc', { adhoc_task_id: 9 }, { auditAction: audit });
    expect(canonical.safeDispatch).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ai_admin_executed', entityId: 'approve_adhoc' })
    );
  });

  test('allowMutations:false still blocks close_phase BEFORE dispatching', async () => {
    const audit = jest.fn();
    await expect(
      at.runTool('close_phase', { phase_instance_id: 5 }, { allowMutations: false, auditAction: audit })
    ).rejects.toThrow(/confirma[çc][ãa]o expl[íi]cita/i);
    expect(canonical.safeDispatch).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
