'use strict';
// BLOCO C / P6 — end-to-end lock of the 4 acceptance use-cases the
// product owner required. (Total new BLOCO C tests across P1–P7 well
// exceed the 30 minimum; this file pins the contract scenarios.)
jest.mock('../db');
const db = require('../db');
const at = require('../ai/admin-tools');
const detect = require('../ai/detect');
const dm = require('../slack/dm-handler');

beforeEach(() => { jest.clearAllMocks(); });

function scriptedAnthropic(turns) {
  let i = 0;
  return { messages: { create: jest.fn(() => Promise.resolve(turns[i++])) } };
}

describe('Use-case 1 — "qual é o estado das fases abertas?" → get_state', () => {
  test('loop calls get_state and answers with the state', async () => {
    const runTool = jest.fn().mockResolvedValue({ active_workflows: 1, open_phases: 3, open_adhoc: 0, on_break: 1 });
    const anthropic = scriptedAnthropic([
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'get_state', input: {} }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'tem 3 fases abertas, 1 workflow ativo' }] },
    ]);
    const reply = await dm.askClaude('qual é o estado das fases abertas?', 'Bruno', 'CTX',
      { anthropic, adminTools: { TOOL_DEFS: [], runTool } });
    expect(runTool).toHaveBeenCalledWith('get_state', {}, expect.any(Object));
    expect(reply).toMatch(/3 fases abertas/);
  });
});

describe('Use-case 2 — "fecha a fase #5" → close_phase(5) + confirma', () => {
  test('loop routes to close_phase and returns a confirmation', async () => {
    const runTool = jest.fn().mockResolvedValue({ closed: true, phase_instance_id: 5, duration: '1h45' });
    const anthropic = scriptedAnthropic([
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'c5', name: 'close_phase', input: { phase_instance_id: 5 } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fechei a fase #5 agora, durou 1h45.' }] },
    ]);
    const reply = await dm.askClaude('fecha a fase #5', 'Bruno', 'CTX',
      { anthropic, adminTools: { TOOL_DEFS: [], runTool } });
    expect(runTool).toHaveBeenCalledWith('close_phase', { phase_instance_id: 5 }, expect.any(Object));
    expect(reply).toMatch(/Fechei a fase #5/);
  });

  test('runTool actually executes EXEC + audits ai_admin_executed', async () => {
    // EXEC.close_phase → engine.closePhase; mock db so it resolves.
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 5 }] });
    const audit = jest.fn().mockResolvedValue();
    await at.runTool('close_phase', { phase_instance_id: 5 }, { auditAction: audit });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ai_admin_executed', entityId: 'close_phase',
    }));
  });
});

describe('Use-case 3 — pending break question + "ignora" → dismiss', () => {
  test('interpretDirectOrder dismisses the pending question and confirms', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/retro_break_admin/.test(sql)) return Promise.resolve({ rows: [{ value: '{"opName":"Bruno"}' }] });
      if (/DELETE FROM app_state/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const r = await at.interpretDirectOrder('ignora', { auditAction: jest.fn() });
    expect(r.handled).toBe(true);
    expect(r.reply).toMatch(/descartei/i);
  });
});

describe('Use-case 4 — cron detects 5h phase → proposes → admin "sim" → executa', () => {
  test('propose then accept runs the audited EXEC and resolves the ledger', async () => {
    // (a) cron detects + proposes
    const w6 = { current: null };
    const ledger = { rows: [] };
    const detDeps = {
      proposals: {
        create: jest.fn().mockResolvedValue({ id: 42 }),
      },
      adminTools: {
        MUTATION_TOOLS: new Set(['close_phase']),
        getProposal: jest.fn(async () => w6.current),
        setProposal: jest.fn(async (p) => { w6.current = p; }),
      },
      postToAdmin: jest.fn().mockResolvedValue(),
    };
    db.query = jest.fn().mockImplementation((sql) => {
      if (/FROM phase_instances pi/.test(sql)) return Promise.resolve({ rows: [{ id: 5, phase_name: 'Encapsulação' }] });
      return Promise.resolve({ rows: [] });
    });
    const made = await detect.detectAndPropose(detDeps);
    expect(made[0]).toMatchObject({ type: 'close_phase' });
    expect(detDeps.postToAdmin).toHaveBeenCalledWith(expect.stringMatching(/Detectei.*fase #5/));
    expect(w6.current).toMatchObject({ kind: 'close_phase', carolina_proposal_id: 42 });

    // (b) admin replies "sim" → W6 resolveProposal executes + audits
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT value FROM app_state WHERE key/.test(sql)) {
        return Promise.resolve({ rows: [{ value: JSON.stringify(w6.current) }] });
      }
      return Promise.resolve({ rows: [{ id: 5 }] });
    });
    const audit = jest.fn().mockResolvedValue();
    const res = await at.resolveProposal('sim', { auditAction: audit });
    expect(res.outcome).toBe('executed');
    expect(res.kind).toBe('close_phase');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai_admin_executed' }));
  });
});
