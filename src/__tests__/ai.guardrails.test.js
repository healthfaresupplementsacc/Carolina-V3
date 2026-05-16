'use strict';
// BLOCO C / P5 — mutation guardrails + audit + persona intact.
jest.mock('../db');
const db = require('../db');
const at = require('../ai/admin-tools');
const dm = require('../slack/dm-handler');

beforeEach(() => { jest.clearAllMocks(); });

describe('P5 — mutation only with explicit confirmation', () => {
  test('mutation with allowMutations:false is rejected (no EXEC, no audit)', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 1 }] });
    const audit = jest.fn();
    await expect(
      at.runTool('close_phase', { phase_instance_id: 5 }, { allowMutations: false, auditAction: audit })
    ).rejects.toThrow(/confirma[çc][ãa]o expl[íi]cita/i);
    expect(audit).not.toHaveBeenCalled();
  });

  test('mutation in the admin loop (default) executes + audits triggered_by', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 1 }] });
    const audit = jest.fn().mockResolvedValue();
    await at.runTool('approve_adhoc', { adhoc_task_id: 9 }, { auditAction: audit });
    const payload = audit.mock.calls[0][0];
    expect(payload.action).toBe('ai_admin_executed');
    expect(payload.before.triggered_by).toBe('slack_admin_order');
  });

  test('triggeredBy override is recorded', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ id: 1 }] });
    const audit = jest.fn().mockResolvedValue();
    await at.runTool('approve_adhoc', { adhoc_task_id: 1 }, { auditAction: audit, triggeredBy: 'cron_confirmed' });
    expect(audit.mock.calls[0][0].before.triggered_by).toBe('cron_confirmed');
  });

  test('read tools run freely even with allowMutations:false, never audited', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ n: 1 }] });
    const audit = jest.fn();
    const r = await at.runTool('get_state', {}, { allowMutations: false, auditAction: audit });
    expect(r.open_phases).toBe(1);
    expect(audit).not.toHaveBeenCalled();
  });

  test('dismiss audit carries triggered_by', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const audit = jest.fn().mockResolvedValue();
    await at.runTool('dismiss_pending_question', {}, { auditAction: audit });
    expect(audit.mock.calls[0][0].before.triggered_by).toBe('slack_admin_order');
  });
});

describe('P5 — persona guardrails intact', () => {
  test('admin loop uses the ADMIN persona scope (C0B36DR5MP1)', async () => {
    const anthropic = { messages: { create: jest.fn().mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }) } };
    await dm.askClaude('oi', 'Bruno', '=== CTX ===', { anthropic, adminTools: { TOOL_DEFS: [], runTool: jest.fn() } });
    const sys = anthropic.messages.create.mock.calls[0][0].system[0].text;
    expect(sys).toMatch(/C0B36DR5MP1/);                 // ADMIN_RULES present
    expect(sys).toMatch(/admitir que é IA|pode ser técnica/i);
  });

  test('PROD persona still locks AI-denial (C7 guardrail unchanged)', () => {
    const { buildPersona } = require('../ai/persona');
    const prod = buildPersona('prod', 'HealthFare Production');
    expect(prod).toMatch(/NUNCA admita ser AI/);
    expect(prod).toMatch(/para de zoeira/);
  });
});
