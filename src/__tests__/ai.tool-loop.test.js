'use strict';
// BLOCO C / P1 — agentic tool-use loop + new direct tools.
jest.mock('../db');
const db = require('../db');
const at = require('../ai/admin-tools');
const dm = require('../slack/dm-handler');

beforeEach(() => { jest.clearAllMocks(); });

// ---- admin-tools.runTool ----
describe('P1 — runTool dispatch', () => {
  test('read tool get_state runs freely, no audit', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ n: 2 }] });
    const audit = jest.fn();
    const r = await at.runTool('get_state', {}, { auditAction: audit });
    expect(r).toEqual(expect.objectContaining({ active_workflows: 2, open_phases: 2, open_adhoc: 2, on_break: 2 }));
    expect(audit).not.toHaveBeenCalled();
  });

  test('mutation tool executes EXEC + audits ai_admin_executed', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 1 }] });
    const audit = jest.fn().mockResolvedValue();
    const r = await at.runTool('approve_adhoc', { adhoc_task_id: 9 }, { auditAction: audit });
    expect(r).toEqual({ approved: true });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ai_admin_executed', entityType: 'ai_admin', entityId: 'approve_adhoc',
    }));
  });

  test('dismiss_pending_question clears retro+W6 and audits', async () => {
    const deleted = [];
    db.query = jest.fn().mockImplementation((sql, p) => {
      if (/SELECT value FROM app_state WHERE key = 'retro_break_admin'/.test(sql)) {
        return Promise.resolve({ rows: [{ value: '{}' }] });
      }
      if (/SELECT value FROM app_state WHERE key = \$1/.test(sql) && p && p[0] === 'ai_proposal') {
        return Promise.resolve({ rows: [{ value: JSON.stringify({ kind: 'close_phase' }) }] });
      }
      if (/DELETE FROM app_state/.test(sql)) { deleted.push(p ? p[0] : 'retro'); return Promise.resolve({ rows: [] }); }
      return Promise.resolve({ rows: [] });
    });
    const audit = jest.fn().mockResolvedValue();
    const r = await at.runTool('dismiss_pending_question', { question_id: 'x' }, { auditAction: audit });
    expect(r.dismissed).toEqual(expect.arrayContaining(['retro_break_admin']));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ai_admin_executed', entityId: 'dismiss_pending_question',
    }));
  });

  test('update_break_retroactive delegates to handleAdminRetroReply + audits', async () => {
    // No retro_break_admin pending → handleAdminRetroReply returns
    // {handled:false}; the tool still audits the attempt.
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const audit = jest.fn().mockResolvedValue();
    const r = await at.runTool('update_break_retroactive', { time: '14:30' }, { auditAction: audit });
    expect(r.handled).toBe(false);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ai_admin_executed', entityId: 'update_break_retroactive',
    }));
  });

  test('unknown tool rejected', async () => {
    await expect(at.runTool('frobnicate', {}, {})).rejects.toThrow(/desconhecida/);
  });
});

// ---- dm-handler.askClaude loop ----
function fakeAnthropic(scripted) {
  let i = 0;
  return { messages: { create: jest.fn().mockImplementation(() => Promise.resolve(scripted[i++])) } };
}
const ctx = '=== CTX ===';

describe('P1 — askClaude agentic loop', () => {
  test('plain answer (no tools) returns text', async () => {
    const anthropic = fakeAnthropic([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'tem 2 fases abertas, tudo no ritmo' }] },
    ]);
    const reply = await dm.askClaude('como tá?', 'Bruno', ctx, { anthropic, adminTools: { TOOL_DEFS: [], runTool: jest.fn() } });
    expect(reply).toMatch(/2 fases abertas/);
  });

  test('tool_use → runTool → final answer', async () => {
    const runTool = jest.fn().mockResolvedValue({ active_workflows: 1, open_phases: 3 });
    const anthropic = fakeAnthropic([
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'get_state', input: {} }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '3 fases abertas agora' }] },
    ]);
    const reply = await dm.askClaude('estado das fases?', 'Thassio', ctx, {
      anthropic, adminTools: { TOOL_DEFS: [], runTool },
    });
    expect(runTool).toHaveBeenCalledWith('get_state', {}, expect.any(Object));
    expect(reply).toBe('3 fases abertas agora');
    expect(anthropic.messages.create).toHaveBeenCalledTimes(2);
  });

  test('tool error is fed back, not thrown', async () => {
    const runTool = jest.fn().mockRejectedValue(new Error('boom'));
    const anthropic = fakeAnthropic([
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'close_phase', input: { phase_instance_id: 5 } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'deu ruim, não fechei' }] },
    ]);
    const reply = await dm.askClaude('fecha a 5', 'Bruno', ctx, { anthropic, adminTools: { TOOL_DEFS: [], runTool } });
    expect(reply).toMatch(/deu ruim/);
    const secondCall = anthropic.messages.create.mock.calls[1][0];
    const toolResult = secondCall.messages.find((m) => Array.isArray(m.content) && m.content[0] && m.content[0].type === 'tool_result');
    expect(toolResult.content[0].is_error).toBe(true);
  });

  test('iteration cap prevents infinite tool loop', async () => {
    const always = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'get_state', input: {} }, { type: 'text', text: 'pensando...' }] };
    const anthropic = { messages: { create: jest.fn().mockResolvedValue(always) } };
    const reply = await dm.askClaude('loop', 'Bruno', ctx, { anthropic, adminTools: { TOOL_DEFS: [], runTool: jest.fn().mockResolvedValue({}) } });
    expect(anthropic.messages.create).toHaveBeenCalledTimes(4); // MAX_ITERS
    expect(reply).toBe('pensando...');
  });

  test('system prompt is a cached block + tools passed', async () => {
    const anthropic = fakeAnthropic([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }]);
    await dm.askClaude('oi', 'Bruno', ctx, { anthropic, adminTools: { TOOL_DEFS: [{ name: 'get_state' }], runTool: jest.fn() } });
    const call = anthropic.messages.create.mock.calls[0][0];
    expect(Array.isArray(call.system)).toBe(true);
    expect(call.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(call.tools).toEqual([{ name: 'get_state' }]);
  });
});
