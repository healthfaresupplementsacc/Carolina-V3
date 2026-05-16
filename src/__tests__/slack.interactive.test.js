'use strict';
jest.mock('../db');
jest.mock('../workflow/engine', () => ({
  startBreak: jest.fn().mockResolvedValue({}),
  endBreak: jest.fn().mockResolvedValue({}),
  joinPhase: jest.fn().mockResolvedValue({}),
  closePhase: jest.fn().mockResolvedValue({}),
  closeAdHocTask: jest.fn().mockResolvedValue({}),
  startAdHocTask: jest.fn().mockResolvedValue({}),
  findOrCreateWorkflowInstance: jest.fn().mockResolvedValue({ workflowInstanceId: 1 }),
  startPhase: jest.fn().mockResolvedValue({}),
  addNote: jest.fn().mockResolvedValue({ noteId: 1 }),
}));
jest.mock('../slack/home', () => ({ publishHome: jest.fn().mockResolvedValue() }));
jest.mock('../workflow/announce', () => ({
  adHocPending: jest.fn().mockResolvedValue(),
  note: jest.fn().mockResolvedValue(),
}));

// Avoid real WebClient
jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    views: { open: jest.fn().mockResolvedValue({}), publish: jest.fn().mockResolvedValue({}) },
  })),
}));

const db = require('../db');
const engine = require('../workflow/engine');
const interactive = require('../slack/interactive');

beforeEach(() => { jest.clearAllMocks(); });

function viewSubmission(callbackId, meta, values) {
  return {
    type: 'view_submission',
    user: { id: 'U1' },
    view: {
      callback_id: callbackId,
      private_metadata: JSON.stringify(meta || {}),
      state: { values },
    },
  };
}

const WHO = { who: { operator: { selected_option: { value: '5' } } } };

describe('view_submission → engine', () => {
  test('submit_break calls engine.startBreak with operatorId', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_break', {}, {
      ...WHO, reason: { v: { value: 'almoço' } },
    }));
    expect(engine.startBreak).toHaveBeenCalledWith(expect.objectContaining({ operatorId: 5, reason: 'almoço' }));
  });

  test('submit_end_break calls engine.endBreak', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_end_break', {}, { ...WHO }));
    expect(engine.endBreak).toHaveBeenCalledWith(expect.objectContaining({ operatorId: 5 }));
  });

  test('F4 — optional note on a wizard is persisted via engine.addNote', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_break', {}, {
      ...WHO, reason: { v: { value: 'almoço' } },
      note: { v: { value: 'máquina fazendo barulho' } },
    }));
    expect(engine.startBreak).toHaveBeenCalled();
    expect(engine.addNote).toHaveBeenCalledWith({ operatorId: 5, text: 'máquina fazendo barulho' });
  });

  test('F4 — no note block → engine.addNote NOT called', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_end_break', {}, { ...WHO }));
    expect(engine.addNote).not.toHaveBeenCalled();
  });

  test('F4 — submit_note path does not double-persist via F4 block', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_note', {}, {
      ...WHO, text: { v: { value: 'nota principal' } },
    }));
    expect(engine.addNote).toHaveBeenCalledTimes(1);
    expect(engine.addNote).toHaveBeenCalledWith({ operatorId: 5, text: 'nota principal' });
  });

  test('F5 — "Outro" with no description returns response_action errors', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ name: 'Outro' }] });
    const r = await interactive.handleViewSubmission(viewSubmission('submit_adhoc', {}, {
      ...WHO, task: { v: { selected_option: { value: '8' } } },
      desc_outro: { v: { value: '' } },
    }));
    expect(r).toEqual({
      response_action: 'errors',
      errors: { desc_outro: expect.stringMatching(/obrigat/i) },
    });
    expect(engine.startAdHocTask).not.toHaveBeenCalled();
  });

  test('F5 — "Outro" + description starts task with desc + alerts admin', async () => {
    const announce = require('../workflow/announce');
    db.query = jest.fn().mockImplementation((sql) => {
      if (/FROM ad_hoc_tasks WHERE id/.test(sql)) return Promise.resolve({ rows: [{ name: 'Outro' }] });
      if (/FROM operators WHERE id/.test(sql)) return Promise.resolve({ rows: [{ name: 'Ana' }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await interactive.handleViewSubmission(viewSubmission('submit_adhoc', {}, {
      ...WHO, task: { v: { selected_option: { value: '8' } } },
      desc_outro: { v: { value: 'troca de filtro da máquina 3' } },
    }));
    expect(r).toBeUndefined(); // no error → modal closes
    expect(engine.startAdHocTask).toHaveBeenCalledWith(expect.objectContaining({
      taskName: 'troca de filtro da máquina 3', operatorId: 5,
    }));
    expect(announce.adHocPending).toHaveBeenCalledWith(
      expect.objectContaining({ taskName: 'troca de filtro da máquina 3', operatorName: 'Ana' })
    );
  });

  test('F5 — a normal catalog task submits without description', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ name: 'Limpeza' }] });
    const r = await interactive.handleViewSubmission(viewSubmission('submit_adhoc', {}, {
      ...WHO, task: { v: { selected_option: { value: '1' } } },
    }));
    expect(r).toBeUndefined();
    expect(engine.startAdHocTask).toHaveBeenCalledWith(expect.objectContaining({
      taskName: 'Limpeza', operatorId: 5,
    }));
  });

  test('submit_join_phase passes phaseId from private_metadata', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_join_phase', { phaseId: 99 }, { ...WHO }));
    expect(engine.joinPhase).toHaveBeenCalledWith({ phaseInstanceId: 99, operatorId: 5 });
  });

  test('submit_close_phase parses bottle count', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_close_phase', { phaseId: 50 }, {
      ...WHO, bottles: { v: { value: '480' } },
    }));
    expect(engine.closePhase).toHaveBeenCalledWith(expect.objectContaining({
      phaseInstanceId: 50, finalBottleCount: 480, closedByOperatorId: 5,
    }));
  });

  test('submit_start_batch creates workflow + opens first phase', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/FROM phase_templates WHERE workflow_template_id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 10 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    await interactive.handleInteraction(viewSubmission('submit_start_batch', {}, {
      ...WHO,
      wt: { v: { selected_option: { value: '1' } } },
      product: { supplement_select: { selected_option: { value: 'Green Tea' } } },
      batch: { v: { value: '0098' } },
    }));
    expect(engine.findOrCreateWorkflowInstance).toHaveBeenCalledWith(expect.objectContaining({
      workflowTemplateId: 1, productName: 'Green Tea', batchNumber: '0098',
    }));
    expect(engine.startPhase).toHaveBeenCalledWith(expect.objectContaining({ phaseTemplateId: 10 }));
  });

  test('W3 — chosen phase ("wfId:ptId") overrides workflow + opens that phase', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_start_batch', {}, {
      ...WHO,
      wt: { v: { selected_option: { value: '1' } } },           // workflow 1 picked
      phase: { v: { selected_option: { value: '2:7' } } },      // but phase from workflow 2, pt 7
      product: { supplement_select: { selected_option: { value: 'Berberine' } } },
      batch: { v: { value: '0119' } },
    }));
    expect(engine.findOrCreateWorkflowInstance).toHaveBeenCalledWith(expect.objectContaining({
      workflowTemplateId: 2, // phase's workflow wins
    }));
    expect(engine.startPhase).toHaveBeenCalledWith(expect.objectContaining({ phaseTemplateId: 7 }));
  });

  test('no operator selected → engine not called', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_break', {}, {
      who: { operator: { selected_option: null } },
    }));
    expect(engine.startBreak).not.toHaveBeenCalled();
  });

  test('republishes Home for the acting user', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const home = require('../slack/home');
    await interactive.handleInteraction(viewSubmission('submit_end_break', {}, { ...WHO }));
    expect(home.publishHome).toHaveBeenCalledWith('U1');
  });
});

describe('block_actions → open modal', () => {
  test('start_break opens a modal with operator picker', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 1, name: 'Ana' }] });
    const { WebClient } = require('@slack/web-api');
    await interactive.handleInteraction({
      type: 'block_actions', trigger_id: 'T1',
      actions: [{ action_id: 'start_break' }],
      user: { id: 'U1' },
    });
    const inst = WebClient.mock.results[WebClient.mock.results.length - 1].value;
    expect(inst.views.open).toHaveBeenCalled();
    const arg = JSON.parse(inst.views.open.mock.calls[0][0].view);
    expect(arg.callback_id).toBe('submit_break');
    expect(JSON.stringify(arg)).toMatch(/Quem é você/);
  });
});
