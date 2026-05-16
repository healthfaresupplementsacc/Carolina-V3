'use strict';
// BLOCO C / P3 — autonomous detection.
jest.mock('../db');
const db = require('../db');
const detect = require('../ai/detect');

beforeEach(() => { jest.clearAllMocks(); });

describe('P3 — individual detectors map DB rows → candidates', () => {
  test('phasesStale → close_phase proposal', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 5, phase_name: 'Encapsulação', started_at: 'x' }] });
    const c = await detect.phasesStale();
    expect(c[0]).toMatchObject({
      proposalType: 'close_phase', targetEntityId: 5,
      proposedAction: { tool: 'close_phase', input: { phase_instance_id: 5 } },
    });
    expect(c[0].summary).toMatch(/#5/);
  });

  test('adhocPending → approve_adhoc proposal', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 7, name: 'limpando' }] });
    const c = await detect.adhocPending();
    expect(c[0].proposalType).toBe('approve_adhoc');
    expect(c[0].proposedAction.input).toEqual({ adhoc_task_id: 7 });
  });

  test('supplementsPending → approve_supplement proposal', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ canonical_name: 'Berberine' }] });
    const c = await detect.supplementsPending();
    expect(c[0].proposalType).toBe('approve_supplement');
    expect(c[0].proposedAction.input).toEqual({ name: 'Berberine' });
  });

  test('duplicateBatches → merge_tasks proposal', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ product_name: 'Green Tea', batch_number: '0098', ids: [10, 11] }] });
    const c = await detect.duplicateBatches();
    expect(c[0].proposalType).toBe('merge_tasks');
    expect(c[0].proposedAction.input).toEqual({ task_ids: [10, 11] });
  });

  test('workflowsNoBatch → alert-only ask_batch', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 3, product_name: 'Mullein' }] });
    const c = await detect.workflowsNoBatch();
    expect(c[0].proposalType).toBe('ask_batch');
    expect(c[0].alertOnly).toBe(true);
  });

  test('a failing detector query yields [] (defensive)', async () => {
    db.query = jest.fn().mockRejectedValue(new Error('no such column'));
    expect(await detect.phasesStale()).toEqual([]);
    expect(await detect.operatorsIdle()).toEqual([]);
  });
});

describe('P3 — buildProposeText', () => {
  test('executable proposal asks sim/não with the tool', () => {
    const t = detect.buildProposeText({ summary: 'fase #5 parada', proposedAction: { tool: 'close_phase' } });
    expect(t).toMatch(/🤖/);
    expect(t).toMatch(/close_phase/);
    expect(t).toMatch(/"sim"/);
    expect(t).toMatch(/"não"/);
  });
  test('alert-only proposal omits tool', () => {
    const t = detect.buildProposeText({ summary: 'Ana parada', alertOnly: true, proposedAction: {} });
    expect(t).toMatch(/Detectei/);
    expect(t).not.toMatch(/Proposta:/);
  });
});

describe('P3 — detectAndPropose orchestration', () => {
  function fakeDeps(over = {}) {
    return {
      proposals: { create: jest.fn().mockResolvedValue({ id: 1 }) },
      adminTools: {
        MUTATION_TOOLS: new Set(['close_phase', 'approve_adhoc', 'merge_tasks']),
        getProposal: jest.fn().mockResolvedValue(null),
        setProposal: jest.fn().mockResolvedValue(),
      },
      postToAdmin: jest.fn().mockResolvedValue(),
      isTypeEnabled: jest.fn().mockResolvedValue(true),
      ...over,
    };
  }

  test('a stale phase → create + W6 mirror + admin post', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/FROM phase_instances pi/.test(sql)) return Promise.resolve({ rows: [{ id: 5, phase_name: 'Enc' }] });
      return Promise.resolve({ rows: [] });
    });
    const deps = fakeDeps();
    const made = await detect.detectAndPropose(deps);
    expect(deps.proposals.create).toHaveBeenCalledWith(expect.objectContaining({ proposalType: 'close_phase', source: 'cron' }));
    expect(deps.adminTools.setProposal).toHaveBeenCalledWith(expect.objectContaining({ kind: 'close_phase', carolina_proposal_id: 1 }));
    expect(deps.postToAdmin).toHaveBeenCalledWith(expect.stringMatching(/Detectei.*fase #5/));
    expect(made).toHaveLength(1);
  });

  test('deduped proposal is not re-posted', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/FROM phase_instances pi/.test(sql)) return Promise.resolve({ rows: [{ id: 5 }] });
      return Promise.resolve({ rows: [] });
    });
    const deps = fakeDeps({ proposals: { create: jest.fn().mockResolvedValue({ id: 1, _deduped: true }) } });
    const made = await detect.detectAndPropose(deps);
    expect(deps.postToAdmin).not.toHaveBeenCalled();
    expect(made).toHaveLength(0);
  });

  test('isTypeEnabled=false gates the proposal (P7 hook)', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/FROM phase_instances pi/.test(sql)) return Promise.resolve({ rows: [{ id: 5 }] });
      return Promise.resolve({ rows: [] });
    });
    const deps = fakeDeps({ isTypeEnabled: jest.fn().mockResolvedValue(false) });
    await detect.detectAndPropose(deps);
    expect(deps.proposals.create).not.toHaveBeenCalled();
  });

  test('does not clobber an existing W6 proposal', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/FROM phase_instances pi/.test(sql)) return Promise.resolve({ rows: [{ id: 5 }] });
      return Promise.resolve({ rows: [] });
    });
    const deps = fakeDeps();
    deps.adminTools.getProposal = jest.fn().mockResolvedValue({ kind: 'rename' });
    await detect.detectAndPropose(deps);
    expect(deps.adminTools.setProposal).not.toHaveBeenCalled();
    expect(deps.postToAdmin).toHaveBeenCalled(); // still announces
  });
});
