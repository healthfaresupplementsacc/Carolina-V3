'use strict';
jest.mock('../db');
jest.mock('../workflow/engine', () => ({
  findOrCreateWorkflowInstance: jest.fn(),
  startPhase: jest.fn(),
  closePhase: jest.fn(),
  joinPhase: jest.fn(),
  startBreak: jest.fn(),
  endBreak: jest.fn(),
  startAdHocTask: jest.fn(),
  closeAdHocTask: jest.fn(),
}));

const db = require('../db');
const engine = require('../workflow/engine');
const dispatcher = require('../workflow/dispatcher');

function setupTemplateCtx() {
  db.query.mockImplementation((sql) => {
    if (/FROM operators WHERE LOWER\(name\)/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 1 }] });
    }
    if (/FROM workflow_templates/.test(sql)) {
      return Promise.resolve({ rows: [
        { id: 1, name: 'Produção de Suplemento' },
        { id: 2, name: 'Picking & Packing' },
        { id: 3, name: 'Envio FBA/Walmart/Tiktok/Ebay' },
      ]});
    }
    if (/FROM phase_templates pt\s+JOIN workflow_templates/.test(sql)) {
      return Promise.resolve({ rows: [
        { id: 15, phase_name: 'Linha de Produção', workflow_name: 'Produção de Suplemento' },
        { id: 14, phase_name: 'Revisão', workflow_name: 'Produção de Suplemento' },
        { id: 10, phase_name: 'Formulação', workflow_name: 'Produção de Suplemento' },
        { id: 12, phase_name: 'Encapsulação', workflow_name: 'Produção de Suplemento' },
        { id: 20, phase_name: 'Imprimir ordens', workflow_name: 'Picking & Packing' },
      ]});
    }
    if (/FROM phase_instances pi\s+JOIN workflow_instances/.test(sql)) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query = jest.fn();
});

describe('workflow dispatcher', () => {
  test('pause_start → engine.startBreak', async () => {
    setupTemplateCtx();
    engine.startBreak.mockResolvedValue({ pauseId: 30, oalId: 31 });
    const r = await dispatcher.dispatch(
      { type: 'pause_start', operator: 'Ana' },
      { ts: '1700000000.000', text: 'almoço' },
    );
    expect(r.dispatched).toBe(true);
    expect(r.kind).toBe('break_start');
    expect(engine.startBreak).toHaveBeenCalled();
  });

  test('pause_end → engine.endBreak', async () => {
    setupTemplateCtx();
    engine.endBreak.mockResolvedValue({ wasOnBreak: true });
    const r = await dispatcher.dispatch(
      { type: 'pause_end', operator: 'Ana' },
      { ts: '1700000100.000' },
    );
    expect(r.dispatched).toBe(true);
    expect(r.kind).toBe('break_end');
  });

  test('start producao → findOrCreate + startPhase Linha de Produção', async () => {
    setupTemplateCtx();
    engine.findOrCreateWorkflowInstance.mockResolvedValue({ workflowInstanceId: 100, created: true });
    engine.startPhase.mockResolvedValue({ phaseInstanceId: 200, oalId: 300, joined: false });
    const r = await dispatcher.dispatch(
      { type: 'start', operator: 'Vitor', supplement: 'Green Tea', batch: '0098', taskType: 'producao' },
      { ts: '1700000000.000' },
    );
    expect(r.dispatched).toBe(true);
    expect(r.kind).toBe('phase_start');
    expect(engine.findOrCreateWorkflowInstance).toHaveBeenCalledWith(expect.objectContaining({
      workflowTemplateId: 1, productName: 'Green Tea', batchNumber: '0098',
    }));
    expect(engine.startPhase).toHaveBeenCalledWith(expect.objectContaining({
      workflowInstanceId: 100, phaseTemplateId: 15,
    }));
  });

  test('finish → closePhase on found open phase', async () => {
    db.query.mockImplementation((sql) => {
      if (/FROM operators/.test(sql)) return Promise.resolve({ rows: [{ id: 3 }] });
      if (/FROM workflow_templates/.test(sql)) return Promise.resolve({ rows: [{ id: 1, name: 'Produção de Suplemento' }] });
      if (/FROM phase_templates pt\s+JOIN/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 15, phase_name: 'Linha de Produção', workflow_name: 'Produção de Suplemento' }] });
      }
      if (/FROM phase_instances pi\s+JOIN workflow_instances/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 200, workflow_instance_id: 100 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    engine.closePhase.mockResolvedValue({ alreadyClosed: false, participants: [] });
    const r = await dispatcher.dispatch(
      { type: 'finish', operator: 'Vitor', supplement: 'Green Tea' },
      { ts: '1700000300.000' },
    );
    expect(r.dispatched).toBe(true);
    expect(r.kind).toBe('phase_close');
    expect(engine.closePhase).toHaveBeenCalledWith(expect.objectContaining({
      phaseInstanceId: 200, closedByOperatorId: 3,
    }));
  });

  test('finish with no open phase → dispatched=false', async () => {
    setupTemplateCtx();
    const r = await dispatcher.dispatch(
      { type: 'finish', operator: 'Vitor', supplement: 'Unicorn' },
      { ts: '1700000300.000' },
    );
    expect(r.dispatched).toBe(false);
    expect(r.reason).toMatch(/no open phase/);
  });

  test('orders_start → Picking workflow + Imprimir phase', async () => {
    setupTemplateCtx();
    engine.findOrCreateWorkflowInstance.mockResolvedValue({ workflowInstanceId: 50, created: true });
    engine.startPhase.mockResolvedValue({ phaseInstanceId: 51, oalId: 52, joined: false });
    const r = await dispatcher.dispatch(
      { type: 'orders_start', operator: 'Simone', orderCount: 188 },
      { ts: '1700000000.000' },
    );
    expect(r.dispatched).toBe(true);
    expect(engine.findOrCreateWorkflowInstance).toHaveBeenCalledWith(expect.objectContaining({
      workflowTemplateId: 2, // Picking & Packing
    }));
    expect(engine.startPhase).toHaveBeenCalledWith(expect.objectContaining({
      phaseTemplateId: 20, // Imprimir ordens
    }));
  });

  test('count → startAdHocTask Reporte + immediately closeAdHocTask', async () => {
    setupTemplateCtx();
    engine.startAdHocTask.mockResolvedValue({ adHocTaskInstanceId: 999, oalId: 998 });
    engine.closeAdHocTask.mockResolvedValue({ alreadyClosed: false, participants: [] });
    const r = await dispatcher.dispatch(
      { type: 'count', operator: 'Vitor', supplement: 'Apple Cider Vinegar' },
      { ts: '1700000000.000', text: 'Bia - Quantidade de Apple Cider adicionado no sistema FO-00614' },
    );
    expect(r.dispatched).toBe(true);
    expect(r.kind).toBe('reporte');
    expect(engine.startAdHocTask).toHaveBeenCalledWith(expect.objectContaining({
      taskName: 'Reporte no sistema',
    }));
    expect(engine.closeAdHocTask).toHaveBeenCalledWith(expect.objectContaining({
      adHocTaskInstanceId: 999,
    }));
  });

  test('safeDispatch swallows errors', async () => {
    db.query = jest.fn().mockRejectedValue(new Error('boom'));
    const r = await dispatcher.safeDispatch({ type: 'pause_start', operator: 'Ana' }, {});
    expect(r.dispatched).toBe(false);
    expect(r.error).toMatch(/boom/);
  });

  test('unresolved operator → dispatched=false', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/FROM operators/.test(sql)) return Promise.resolve({ rows: [] }); // unknown name
      return Promise.resolve({ rows: [] });
    });
    const r = await dispatcher.dispatch(
      { type: 'start', operator: 'NobodyKnown', supplement: 'X' }, { ts: '1' }
    );
    expect(r.dispatched).toBe(false);
    expect(r.reason).toMatch(/operator/);
  });
});
