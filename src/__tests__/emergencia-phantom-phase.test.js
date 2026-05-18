'use strict';
// EMERGÊNCIA L-01/L-02/L-04/L-05 — a generic 'start' with no real phase
// signal (no phase hint, generic taskType 'producao', no supplement)
// must NOT mint a phantom "Linha de Produção" workflow/phase. These are
// BEHAVIOURAL tests: they drive the real dispatch() and assert which
// engine calls happen.
jest.mock('../db');
jest.mock('../workflow/engine', () => ({
  findOrCreateWorkflowInstance: jest.fn().mockResolvedValue({ workflowInstanceId: 9 }),
  startPhase: jest.fn().mockResolvedValue({ phaseInstanceId: 1, oalId: 2, prereqWarning: [] }),
  closePhase: jest.fn(), joinPhase: jest.fn(),
  startBreak: jest.fn(), endBreak: jest.fn(),
  startAdHocTask: jest.fn().mockResolvedValue({ adHocTaskInstanceId: 77, oalId: 78 }),
  closeAdHocTask: jest.fn(),
  getCurrentActivity: jest.fn(),
}));
const db = require('../db');
const engine = require('../workflow/engine');
const dispatcher = require('../workflow/dispatcher');

function ctx({ openPhase = null } = {}) {
  db.query.mockImplementation((sql) => {
    if (/FROM operators WHERE LOWER\(name\)/.test(sql)) return Promise.resolve({ rows: [{ id: 4 }] });
    if (/FROM workflow_templates/.test(sql)) return Promise.resolve({ rows: [
      { id: 1, name: 'Produção de Suplemento' }, { id: 2, name: 'Picking & Packing' }] });
    if (/FROM phase_templates pt\s+JOIN workflow_templates/.test(sql)) return Promise.resolve({ rows: [
      { id: 15, phase_name: 'Linha de Produção', workflow_name: 'Produção de Suplemento' },
      { id: 12, phase_name: 'Encapsulação', workflow_name: 'Produção de Suplemento' },
      { id: 20, phase_name: 'Imprimir ordens', workflow_name: 'Picking & Packing' }] });
    if (/FROM phase_instances pi\s+JOIN workflow_instances/.test(sql)) return Promise.resolve({ rows: openPhase ? [openPhase] : [] });
    return Promise.resolve({ rows: [] });
  });
}
beforeEach(() => { jest.clearAllMocks(); });

describe('EMERGÊNCIA — phantom "Linha de Produção" is no longer minted', () => {
  test('generic start, no supplement, operator ALREADY active → NO phase, NO adhoc (Simone-on-P&P case)', async () => {
    ctx();
    engine.getCurrentActivity.mockResolvedValue({ id: 99, activity_type: 'phase', phase_name: 'Imprimir ordens' });
    const r = await dispatcher.dispatch(
      { type: 'start', operator: 'Simone', taskType: 'producao' }, { ts: '1', text: 'voltei pra linha' });
    expect(r.dispatched).toBe(false);
    expect(r.reason).toMatch(/fase fantasma evitada/);
    expect(engine.findOrCreateWorkflowInstance).not.toHaveBeenCalled();
    expect(engine.startPhase).not.toHaveBeenCalled();
    expect(engine.startAdHocTask).not.toHaveBeenCalled();
  });

  test('generic start, no supplement, operator NOT active → ad-hoc "Outro" with note, NOT a phase', async () => {
    ctx();
    engine.getCurrentActivity.mockResolvedValue(null);
    const r = await dispatcher.dispatch(
      { type: 'start', operator: 'Vitor', taskType: 'producao' },
      { ts: '2', text: 'tô mexendo numas coisas aqui' });
    expect(r.dispatched).toBe(true);
    expect(r.kind).toBe('adhoc_outro_no_context');
    expect(engine.startAdHocTask).toHaveBeenCalledWith(expect.objectContaining({
      taskName: 'Outro', operatorId: 4, text: 'tô mexendo numas coisas aqui',
    }));
    expect(engine.startPhase).not.toHaveBeenCalled();
    expect(engine.findOrCreateWorkflowInstance).not.toHaveBeenCalled();
  });

  test('REAL production start WITH supplement → phase IS created (not blocked)', async () => {
    ctx();
    const r = await dispatcher.dispatch(
      { type: 'start', operator: 'Ana', taskType: 'producao', supplement: 'Rutin', batch: '0140' },
      { ts: '3', text: 'S: Rutin 0140' });
    expect(r.dispatched).toBe(true);
    expect(r.kind).toBe('phase_start');
    expect(engine.startPhase).toHaveBeenCalledWith(expect.objectContaining({ phaseTemplateId: 15 }));
    expect(engine.getCurrentActivity).not.toHaveBeenCalled(); // guard not even reached
  });

  test('explicit phase hint → that phase IS created (not blocked)', async () => {
    ctx();
    const r = await dispatcher.dispatch(
      { type: 'start', operator: 'Ana', taskType: 'producao', _phaseHint: 'Encapsulação' },
      { ts: '4', text: 'S: Encapsulação Green Tea' });
    expect(r.dispatched).toBe(true);
    expect(r.kind).toBe('phase_start');
    expect(engine.startPhase).toHaveBeenCalledWith(expect.objectContaining({ phaseTemplateId: 12 }));
  });

  test('orders_start is unaffected (explicit P&P, never the fallback)', async () => {
    ctx();
    const r = await dispatcher.dispatch(
      { type: 'orders_start', operator: 'Simone', orderCount: 500 }, { ts: '5', text: '500 ordens' });
    expect(r.dispatched).toBe(true);
    expect(r.kind).toBe('phase_start');
    expect(engine.startPhase).toHaveBeenCalledWith(expect.objectContaining({ phaseTemplateId: 20 }));
  });
});
