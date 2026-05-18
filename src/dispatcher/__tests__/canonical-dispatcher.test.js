'use strict';
jest.mock('../../db');
jest.mock('../../workflow/engine', () => ({
  findOrCreateWorkflowInstance: jest.fn(),
  startPhase: jest.fn(),
  closePhase: jest.fn(),
  joinPhase: jest.fn(),
  leaveCurrent: jest.fn(),
  startBreak: jest.fn(),
  endBreak: jest.fn(),
  startAdHocTask: jest.fn(),
  closeAdHocTask: jest.fn(),
  getCurrentActivity: jest.fn(),
}));
jest.mock('../../admin/audit', () => ({ auditAction: jest.fn().mockResolvedValue(1) }));
jest.mock('../../workflow/dispatcher', () => ({
  getTemplateContext: jest.fn(),
  resolveTemplate: jest.fn(),
  findOpenPhaseInstance: jest.fn(),
}));

const db = require('../../db');
const engine = require('../../workflow/engine');
const { auditAction } = require('../../admin/audit');
const wfDispatcher = require('../../workflow/dispatcher');
const { makeEvent } = require('../event-schema');
const dispatcher = require('../canonical-dispatcher');

const CTX = {
  wfByName: { 'Produção de Suplemento': 1, 'Picking & Packing': 2 },
  phaseByKey: {
    'Produção de Suplemento::Linha de Produção': 15,
    'Produção de Suplemento::Revisão': 14,
  },
};

// db.query router. `index` controls what getIndexRow returns.
function mockDb({ index = [], extra } = {}) {
  db.query = jest.fn((sql, params) => {
    if (/FROM dispatcher_index WHERE source_id/.test(sql)) {
      return Promise.resolve({ rows: index });
    }
    if (/INSERT INTO dispatcher_index/.test(sql)) return Promise.resolve({ rows: [] });
    if (/INSERT INTO operator_notes/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 555 }] });
    }
    if (/SELECT id, workflow_instance_id, status FROM phase_instances WHERE id/.test(sql)) {
      // echo the requested phase id so target_phase_id routing is testable
      return Promise.resolve({
        rows: [{ id: params[0], workflow_instance_id: 100, status: 'open' }],
      });
    }
    if (/SELECT workflow_instance_id, status FROM phase_instances/.test(sql)) {
      return Promise.resolve({ rows: [{ workflow_instance_id: 100, status: 'open' }] });
    }
    if (extra) {
      const r = extra(sql);
      if (r) return r;
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  wfDispatcher.getTemplateContext.mockResolvedValue(CTX);
  mockDb();
});

describe('canonical dispatcher — guards', () => {
  test('invalid event → dispatched:false reason invalid event', async () => {
    const r = await dispatcher.dispatch({ source_id: '', type: 'nope' });
    expect(r.dispatched).toBe(false);
    expect(r.reason).toBe('invalid event');
  });

  test('ambiguous operator (null) on start → needsDisambiguation, NOT guessed', async () => {
    const ev = makeEvent({
      source_id: '1779000000.0001', source_type: 'parser', type: 'start',
      operator_id: null, supplement: 'Rutin',
    });
    const r = await dispatcher.dispatch(ev);
    expect(r.dispatched).toBe(false);
    expect(r.needsDisambiguation).toBe(true);
    expect(engine.startPhase).not.toHaveBeenCalled();
  });
});

describe('canonical dispatcher — note never discarded', () => {
  test('note with null operator is STILL persisted + indexed', async () => {
    const ev = makeEvent({
      source_id: '1779000000.0002', source_type: 'parser', type: 'note',
      operator_id: null, raw_text: 'linha parada esperando label',
    });
    const r = await dispatcher.dispatch(ev);
    expect(r.dispatched).toBe(true);
    expect(r.upsert).toBe('create');
    expect(r.target_table).toBe('operator_notes');
    const insertedNote = db.query.mock.calls.find((c) =>
      /INSERT INTO operator_notes/.test(c[0])
    );
    expect(insertedNote).toBeTruthy();
    expect(auditAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'dispatcher.upsert' })
    );
  });
});

describe('canonical dispatcher — CREATE start', () => {
  test('new start → findOrCreate + startPhase + dispatcher_index + audit', async () => {
    engine.findOrCreateWorkflowInstance.mockResolvedValue({ workflowInstanceId: 100, created: true });
    engine.startPhase.mockResolvedValue({ phaseInstanceId: 200, oalId: 300, joined: false });
    const ev = makeEvent({
      source_id: '1779112687.0009', source_type: 'parser', type: 'start',
      operator_id: 3, supplement: 'Plant Sterols', batch: '0134',
      workflow_template: 'Produção de Suplemento', phase_template: 'Linha de Produção',
    });
    const r = await dispatcher.dispatch(ev);
    expect(r.dispatched).toBe(true);
    expect(r.upsert).toBe('create');
    expect(r.target_table).toBe('phase_instances');
    expect(r.target_id).toBe(200);
    expect(engine.startPhase).toHaveBeenCalledWith(
      expect.objectContaining({ workflowInstanceId: 100, phaseTemplateId: 15, operatorId: 3 })
    );
    const idxWrite = db.query.mock.calls.find((c) => /INSERT INTO dispatcher_index/.test(c[0]));
    expect(idxWrite).toBeTruthy();
    expect(idxWrite[1]).toEqual(['1779112687.0009', 'parser', 'phase_instances', 200]);
  });
});

describe('canonical dispatcher — L-06: same source_id = UPDATE not new row', () => {
  test('re-dispatch of an already-indexed start UPDATEs, never re-creates', async () => {
    mockDb({
      index: [{
        source_id: '1779112687.0009', source_type: 'parser',
        target_table: 'phase_instances', target_id: 200,
      }],
    });
    const ev = makeEvent({
      source_id: '1779112687.0009', source_type: 'parser', type: 'start',
      operator_id: 3, supplement: 'Plant Sterols', batch: '0134',
      workflow_template: 'Produção de Suplemento', phase_template: 'Linha de Produção',
    });
    const r = await dispatcher.dispatch(ev);
    expect(r.dispatched).toBe(true);
    expect(r.upsert).toBe('update');
    expect(r.target_table).toBe('phase_instances');
    // The engine create primitives must NOT run on a reprocess.
    expect(engine.startPhase).not.toHaveBeenCalled();
    expect(engine.findOrCreateWorkflowInstance).not.toHaveBeenCalled();
    // A real UPDATE of the existing phase_instance was issued.
    const upd = db.query.mock.calls.find((c) =>
      /UPDATE phase_instances/.test(c[0])
    );
    expect(upd).toBeTruthy();
    expect(auditAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'dispatcher.upsert',
        after: expect.objectContaining({ op: 'update' }),
      })
    );
  });

  test('L-08: edit reassigns operator on the SAME row (no duplicate)', async () => {
    mockDb({
      index: [{
        source_id: '1779112687.0009', source_type: 'parser',
        target_table: 'phase_instances', target_id: 200,
      }],
    });
    const ev = makeEvent({
      source_id: '1779112687.0009', source_type: 'parser', type: 'start',
      operator_id: 2, // was Vitor(3); edited "- Bruno" → Bruno Sarmento(2)
      supplement: 'Plant Sterols',
    });
    await dispatcher.dispatch(ev);
    const reassignPhase = db.query.mock.calls.find(
      (c) => /UPDATE phase_instances SET started_by_operator_id/.test(c[0]) && c[1][0] === 2
    );
    const reassignOal = db.query.mock.calls.find(
      (c) => /UPDATE operator_activity_log SET operator_id/.test(c[0]) && c[1][0] === 2
    );
    expect(reassignPhase).toBeTruthy();
    expect(reassignOal).toBeTruthy();
  });
});

describe('canonical dispatcher — finish closes the REFERENCED phase', () => {
  test('finish with target_phase_id closes THAT phase (not newest-open-matching)', async () => {
    engine.closePhase.mockResolvedValue({ alreadyClosed: false, participants: [] });
    const ev = makeEvent({
      source_id: '1779122749.1', source_type: 'parser', type: 'finish',
      operator_id: 1, target_phase_id: 539, // the Limpeza phase, explicitly
    });
    const r = await dispatcher.dispatch(ev);
    expect(r.dispatched).toBe(true);
    expect(r.kind).toBe('phase_close');
    expect(engine.closePhase).toHaveBeenCalledWith(
      expect.objectContaining({ phaseInstanceId: 539, closedByOperatorId: 1 })
    );
    // Did NOT fall back to the blind template search.
    expect(wfDispatcher.findOpenPhaseInstance).not.toHaveBeenCalled();
  });

  test('finish with no target and no open phase → dispatched:false', async () => {
    wfDispatcher.findOpenPhaseInstance.mockResolvedValue(null);
    const ev = makeEvent({
      source_id: '1779122749.2', source_type: 'parser', type: 'finish',
      operator_id: 1, workflow_template: 'Produção de Suplemento',
      phase_template: 'Linha de Produção', supplement: 'Unicorn',
    });
    const r = await dispatcher.dispatch(ev);
    expect(r.dispatched).toBe(false);
    expect(r.reason).toMatch(/no open phase/);
  });
});

describe('canonical dispatcher — count / break', () => {
  test('count → Reporte ad-hoc opened + immediately closed, indexed', async () => {
    engine.startAdHocTask.mockResolvedValue({ adHocTaskInstanceId: 999, oalId: 998 });
    engine.closeAdHocTask.mockResolvedValue({ alreadyClosed: false });
    const ev = makeEvent({
      source_id: '1779130000.1', source_type: 'parser', type: 'count',
      operator_id: 4, raw_text: 'Quantidade no sistema FO-00614',
    });
    const r = await dispatcher.dispatch(ev);
    expect(r.dispatched).toBe(true);
    expect(r.target_table).toBe('ad_hoc_task_instances');
    expect(engine.startAdHocTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskName: 'Reporte no sistema' })
    );
    expect(engine.closeAdHocTask).toHaveBeenCalled();
  });

  test('break_start → engine.startBreak, indexed to pauses', async () => {
    engine.startBreak.mockResolvedValue({ pauseId: 70, oalId: 71 });
    const ev = makeEvent({
      source_id: '1779128662.1', source_type: 'parser', type: 'break_start',
      operator_id: 2,
    });
    const r = await dispatcher.dispatch(ev);
    expect(r.dispatched).toBe(true);
    expect(r.target_table).toBe('pauses');
    expect(r.target_id).toBe(70);
    expect(engine.startBreak).toHaveBeenCalledWith(
      expect.objectContaining({ operatorId: 2 })
    );
  });
});

describe('canonical dispatcher — safeDispatch', () => {
  test('swallows thrown errors', async () => {
    db.query = jest.fn().mockRejectedValue(new Error('boom'));
    const r = await dispatcher.safeDispatch(
      makeEvent({ source_id: 'x', source_type: 'parser', type: 'note', raw_text: 'hi' })
    );
    expect(r.dispatched).toBe(false);
    expect(r.error).toMatch(/boom/);
  });
});
