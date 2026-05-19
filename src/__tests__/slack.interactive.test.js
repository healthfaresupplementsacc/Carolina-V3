'use strict';
// FASE 1 P4: wizards build EventoCanônico → canonical dispatcher (no
// direct ISA-88/engine writes). Tests assert the event shape + that the
// single writer is the only path.
jest.mock('../db');
jest.mock('../dispatcher/canonical-dispatcher', () => ({
  safeDispatch: jest.fn().mockResolvedValue({ dispatched: true, upsert: 'create' }),
}));
jest.mock('../slack/home', () => ({ publishHome: jest.fn().mockResolvedValue() }));
jest.mock('../workflow/announce', () => ({
  adHocPending: jest.fn().mockResolvedValue(),
  note: jest.fn().mockResolvedValue(),
}));
jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    views: { open: jest.fn().mockResolvedValue({}), publish: jest.fn().mockResolvedValue({}) },
  })),
}));

const db = require('../db');
const canonical = require('../dispatcher/canonical-dispatcher');
const interactive = require('../slack/interactive');

beforeEach(() => { jest.clearAllMocks(); });

function viewSubmission(callbackId, meta, values, viewId = 'V123') {
  return {
    type: 'view_submission',
    user: { id: 'U1' },
    view: {
      id: viewId,
      callback_id: callbackId,
      private_metadata: JSON.stringify(meta || {}),
      state: { values },
    },
  };
}
const WHO = { who: { operator: { selected_option: { value: '5' } } } };
const lastEvents = () => canonical.safeDispatch.mock.calls.map((c) => c[0]);
const eventOfType = (t) => lastEvents().find((e) => e.type === t);

describe('view_submission → EventoCanônico → canonical dispatcher', () => {
  test('submit_break → break_start event (app_home source, operator from picker)', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_break', {}, {
      ...WHO, reason: { v: { value: 'almoço' } },
    }));
    const ev = eventOfType('break_start');
    expect(ev).toMatchObject({
      source_type: 'app_home', type: 'break_start', operator_id: 5,
    });
    expect(ev.source_id).toMatch(/^app_home:V123/);
    expect(ev.metadata.reason).toBe('almoço');
  });

  test('submit_end_break → break_end event', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_end_break', {}, { ...WHO }));
    expect(eventOfType('break_end')).toMatchObject({ type: 'break_end', operator_id: 5 });
  });

  test('F4 — optional note on a wizard → its own note event (distinct source_id)', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_break', {}, {
      ...WHO, reason: { v: { value: 'almoço' } },
      note: { v: { value: 'máquina fazendo barulho' } },
    }));
    const note = eventOfType('note');
    expect(note).toMatchObject({ type: 'note', operator_id: 5, raw_text: 'máquina fazendo barulho' });
    expect(note.source_id).toMatch(/:note$/);
    expect(note.source_id).not.toBe(eventOfType('break_start').source_id);
  });

  test('F4 — no note block → no note event', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_end_break', {}, { ...WHO }));
    expect(eventOfType('note')).toBeUndefined();
  });

  test('submit_note → single note event (no double-persist via F4)', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_note', {}, {
      ...WHO, text: { v: { value: 'nota principal' } },
    }));
    const notes = lastEvents().filter((e) => e.type === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0].raw_text).toBe('nota principal');
  });

  test('F5 — "Outro" with no description → response_action errors, NOTHING dispatched', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ name: 'Outro' }] });
    const r = await interactive.handleViewSubmission(viewSubmission('submit_adhoc', {}, {
      ...WHO, task: { v: { selected_option: { value: '8' } } },
      desc_outro: { v: { value: '' } },
    }));
    expect(r).toEqual({
      response_action: 'errors',
      errors: { desc_outro: expect.stringMatching(/obrigat/i) },
    });
    expect(canonical.safeDispatch).not.toHaveBeenCalled();
  });

  test('F5 — "Outro" + description → ad_hoc_start event with desc as task + admin alert', async () => {
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
    expect(r).toBeUndefined();
    expect(eventOfType('ad_hoc_start')).toMatchObject({
      type: 'ad_hoc_start', operator_id: 5, ad_hoc_task: 'troca de filtro da máquina 3',
    });
    expect(announce.adHocPending).toHaveBeenCalledWith(
      expect.objectContaining({ taskName: 'troca de filtro da máquina 3', operatorName: 'Ana' })
    );
  });

  test('F5 — a normal catalog task dispatches ad_hoc_start with that name', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ name: 'Limpeza' }] });
    const r = await interactive.handleViewSubmission(viewSubmission('submit_adhoc', {}, {
      ...WHO, task: { v: { selected_option: { value: '1' } } },
    }));
    expect(r).toBeUndefined();
    expect(eventOfType('ad_hoc_start')).toMatchObject({ ad_hoc_task: 'Limpeza', operator_id: 5 });
  });

  test('submit_join_phase → helping_start targeting the phase from metadata', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_join_phase', { phaseId: 99 }, { ...WHO }));
    expect(eventOfType('helping_start')).toMatchObject({
      type: 'helping_start', operator_id: 5, target_phase_id: 99,
    });
  });

  test('submit_close_phase → finish event with bottle count + target phase', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_close_phase', { phaseId: 50 }, {
      ...WHO, bottles: { v: { value: '480' } },
    }));
    const ev = eventOfType('finish');
    expect(ev).toMatchObject({ type: 'finish', operator_id: 5, target_phase_id: 50 });
    expect(ev.metadata.finalBottleCount).toBe(480);
  });

  test('submit_close_adhoc → ad_hoc_finish targeting the ad-hoc instance', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_close_adhoc', { adhocId: 77 }, { ...WHO }));
    expect(eventOfType('ad_hoc_finish')).toMatchObject({
      type: 'ad_hoc_finish', operator_id: 5, target_phase_id: 77,
    });
  });

  test('submit_start_batch → start event with workflow/phase NAMES + supplement + batch', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/FROM workflow_templates WHERE id/.test(sql)) return Promise.resolve({ rows: [{ name: 'Produção de Suplemento' }] });
      if (/FROM phase_templates WHERE workflow_template_id/.test(sql)) return Promise.resolve({ rows: [{ id: 10 }] });
      if (/FROM phase_templates WHERE id/.test(sql)) return Promise.resolve({ rows: [{ name: 'Mix' }] });
      return Promise.resolve({ rows: [] });
    });
    await interactive.handleInteraction(viewSubmission('submit_start_batch', {}, {
      ...WHO,
      wt: { v: { selected_option: { value: '1' } } },
      product: { supplement_select: { selected_option: { value: 'Green Tea' } } },
      batch: { v: { value: '0098' } },
    }));
    expect(eventOfType('start')).toMatchObject({
      type: 'start', operator_id: 5,
      workflow_template: 'Produção de Suplemento', phase_template: 'Mix',
      supplement: 'Green Tea', batch: '0098',
    });
  });

  test('W3 — chosen phase "wfId:ptId" overrides the workflow select', async () => {
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/FROM workflow_templates WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ name: params[0] === 2 ? 'Picking & Packing' : 'Produção de Suplemento' }] });
      }
      if (/FROM phase_templates WHERE id/.test(sql)) return Promise.resolve({ rows: [{ name: 'Imprimir ordens' }] });
      return Promise.resolve({ rows: [] });
    });
    await interactive.handleInteraction(viewSubmission('submit_start_batch', {}, {
      ...WHO,
      wt: { v: { selected_option: { value: '1' } } },
      phase: { v: { selected_option: { value: '2:7' } } },
      product: { supplement_select: { selected_option: { value: 'Berberine' } } },
      batch: { v: { value: '0119' } },
    }));
    expect(eventOfType('start')).toMatchObject({
      workflow_template: 'Picking & Packing', phase_template: 'Imprimir ordens',
    });
  });

  test('W4 — "Outro" workflow without name → response_action errors, nothing dispatched', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await interactive.handleViewSubmission(viewSubmission('submit_start_batch', {}, {
      ...WHO,
      wt: { v: { selected_option: { value: '__outro__' } } },
      outro_name: { v: { value: '' } },
    }));
    expect(r).toEqual({
      response_action: 'errors',
      errors: { outro_name: expect.stringMatching(/obrigat/i) },
    });
    expect(canonical.safeDispatch).not.toHaveBeenCalled();
  });

  test('W4 — "Outro" workflow + name creates pending template + dispatches start', async () => {
    const announce = require('../workflow/announce');
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT name FROM operators WHERE id/.test(sql)) return Promise.resolve({ rows: [{ name: 'Ana' }] });
      if (/INSERT INTO workflow_templates/.test(sql)) return Promise.resolve({ rows: [{ id: 99 }] });
      if (/FROM workflow_templates WHERE id/.test(sql)) return Promise.resolve({ rows: [{ name: 'Reembalagem especial' }] });
      if (/FROM phase_templates WHERE workflow_template_id/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const r = await interactive.handleViewSubmission(viewSubmission('submit_start_batch', {}, {
      ...WHO,
      wt: { v: { selected_option: { value: '__outro__' } } },
      outro_name: { v: { value: 'Reembalagem especial' } },
    }));
    expect(r).toBeUndefined();
    expect(eventOfType('start')).toMatchObject({ workflow_template: 'Reembalagem especial', operator_id: 5 });
    expect(announce.adHocPending).toHaveBeenCalledWith(
      expect.objectContaining({ taskName: expect.stringMatching(/workflow novo "Reembalagem especial"/) })
    );
  });

  test('submit_count → count event', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_count', {}, {
      ...WHO,
      supp: { supplement_select: { selected_option: { value: 'Rutin' } } },
      qty: { v: { value: '320' } },
    }));
    expect(eventOfType('count')).toMatchObject({
      type: 'count', operator_id: 5, supplement: 'Rutin',
    });
  });

  test('no operator selected → nothing dispatched', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_break', {}, {
      who: { operator: { selected_option: null } },
    }));
    expect(canonical.safeDispatch).not.toHaveBeenCalled();
  });

  test('republishes Home for the acting user', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const home = require('../slack/home');
    await interactive.handleInteraction(viewSubmission('submit_end_break', {}, { ...WHO }));
    expect(home.publishHome).toHaveBeenCalledWith('U1');
  });

  test('idempotency: same view.id ⇒ same source_id (Slack retry = upsert, not dup)', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await interactive.handleInteraction(viewSubmission('submit_end_break', {}, { ...WHO }, 'VSAME'));
    await interactive.handleInteraction(viewSubmission('submit_end_break', {}, { ...WHO }, 'VSAME'));
    const ids = lastEvents().filter((e) => e.type === 'break_end').map((e) => e.source_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });
});

describe('block_actions → open modal (unchanged)', () => {
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
