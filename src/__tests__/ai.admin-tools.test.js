'use strict';
jest.mock('../db');
const db = require('../db');
const at = require('../ai/admin-tools');

beforeEach(() => { jest.clearAllMocks(); });

describe('W6 — parseConfirmation', () => {
  test.each([
    ['sim', 'yes'], ['pode', 'yes'], ['confirma', 'yes'], ['ok', 'yes'], ['blz', 'yes'],
    ['não', 'no'], ['nao', 'no'], ['cancela', 'no'], ['deixa', 'no'],
    ['na verdade muda pra X', 'adjust'], ['', 'adjust'], ['hmm sei la', 'adjust'],
  ])('%s → %s', (inp, exp) => { expect(at.parseConfirmation(inp)).toBe(exp); });
});

describe('W6 — propose builds message + stores one proposal', () => {
  test('propose(close_phase) stores + returns Carolina message', async () => {
    const calls = [];
    db.query = jest.fn((sql, p) => { calls.push({ sql, p }); return Promise.resolve({ rows: [] }); });
    const msg = await at.propose('close_phase', { phase_instance_id: 42, hours: 5 });
    expect(msg).toMatch(/🤖/);
    expect(msg).toMatch(/#42/);
    expect(calls.some((c) => /INSERT INTO app_state/.test(c.sql) && c.p[0] === 'ai_proposal')).toBe(true);
  });

  test('unknown kind rejected', async () => {
    await expect(at.propose('nuke_everything', {})).rejects.toThrow(/desconhecida/);
  });
});

describe('W6 — resolveProposal', () => {
  function withPending(kind, args) {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT value FROM app_state WHERE key/.test(sql)) {
        return Promise.resolve({ rows: [{ value: JSON.stringify({ kind, args }) }] });
      }
      return Promise.resolve({ rows: [{ id: 1 }] });
    });
  }

  test('no pending → handled:false', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    expect(await at.resolveProposal('sim')).toEqual({ handled: false });
  });

  test('"não" cancels + clears', async () => {
    withPending('approve_adhoc', { adhoc_task_id: 9 });
    const r = await at.resolveProposal('não', { auditAction: jest.fn() });
    expect(r.outcome).toBe('cancelled');
  });

  test('"sim" executes + audits ai_admin_executed', async () => {
    withPending('approve_adhoc', { adhoc_task_id: 9 });
    const audit = jest.fn().mockResolvedValue();
    const r = await at.resolveProposal('sim, pode', { auditAction: audit });
    expect(r.outcome).toBe('executed');
    expect(r.kind).toBe('approve_adhoc');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ai_admin_executed', source: 'slack_admin',
    }));
  });

  test('adjust keeps proposal + returns adjustment', async () => {
    withPending('rename', { entity_type: 'ad_hoc_task', id: 3, new_name: 'X' });
    const r = await at.resolveProposal('na verdade renomeia pra Limpeza Linha');
    expect(r.outcome).toBe('adjust');
    expect(r.adjustment).toMatch(/Limpeza Linha/);
    expect(r.proposal.kind).toBe('rename');
  });

  test('executor error → outcome error, proposal cleared', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT value FROM app_state WHERE key/.test(sql)) {
        return Promise.resolve({ rows: [{ value: JSON.stringify({ kind: 'rename', args: { entity_type: 'bogus', id: 1, new_name: 'x' } }) }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await at.resolveProposal('sim', { auditAction: jest.fn() });
    expect(r.outcome).toBe('error');
  });
});

describe('W6 — read tools', () => {
  test('getState aggregates counts', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ n: 3 }] });
    const s = await at.getState();
    expect(s).toEqual({ active_workflows: 3, open_phases: 3, open_adhoc: 3, on_break: 3 });
  });
  test('suggestClaudeCodePrompt formats a prompt', () => {
    const p = at.suggestClaudeCodePrompt('o parser ignora X');
    expect(p).toMatch(/Cole no Claude Code/);
    expect(p).toMatch(/o parser ignora X/);
    expect(p).toMatch(/npm test verde/);
  });
});
