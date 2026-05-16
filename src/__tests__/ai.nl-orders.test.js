'use strict';
// BLOCO C / P2 — natural-language direct-order interpretation + ambiguity.
jest.mock('../db');
const db = require('../db');
const at = require('../ai/admin-tools');
const dm = require('../slack/dm-handler');

beforeEach(() => { jest.clearAllMocks(); });

describe('P2 — detectDismissIntent', () => {
  test.each([
    ['ignora', true], ['ignore isso', true], ['esquece', true], ['esqueça', true],
    ['deixa pra lá', true], ['deixa pra la', true], ['deixa quieto', true],
    ['para com isso', true], ['cancela essa', true], ['descarta', true],
    ['não precisa', true], ['deleta a pergunta', true],
    ['fecha a fase #5', false], ['sim', false], ['mostra timeline da Ana', false],
    ['', false], ['parabéns', false], ['paralelo', false],
  ])('%s → %s', (txt, exp) => {
    expect(at.detectDismissIntent(txt)).toBe(exp);
  });
});

describe('P2 — pendingSummary / pendingContextLine', () => {
  test('nothing pending', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const ps = await at.pendingSummary();
    expect(ps.hasAny).toBe(false);
    expect(await at.pendingContextLine()).toMatch(/nenhuma pergunta/);
  });

  test('retro break pending is summarised', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/retro_break_admin/.test(sql)) return Promise.resolve({ rows: [{ value: '{}' }] });
      return Promise.resolve({ rows: [] });
    });
    const ps = await at.pendingSummary();
    expect(ps.hasAny).toBe(true);
    expect(ps.parts.join()).toMatch(/break retroativo/);
    expect(await at.pendingContextLine()).toMatch(/PEND[ÊE]NCIAS/);
  });

  test('W6 proposal pending is summarised', async () => {
    db.query = jest.fn().mockImplementation((sql, p) => {
      if (/SELECT value FROM app_state WHERE key = \$1/.test(sql) && p && p[0] === 'ai_proposal') {
        return Promise.resolve({ rows: [{ value: JSON.stringify({ kind: 'close_phase' }) }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const ps = await at.pendingSummary();
    expect(ps.parts.join()).toMatch(/close_phase/);
  });
});

describe('P2 — interpretDirectOrder', () => {
  test('dismiss intent + something pending → handled, dismisses', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/retro_break_admin/.test(sql)) return Promise.resolve({ rows: [{ value: '{}' }] });
      if (/DELETE FROM app_state/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const r = await at.interpretDirectOrder('ignora', { auditAction: jest.fn() });
    expect(r.handled).toBe(true);
    expect(r.reply).toMatch(/descartei/i);
  });

  test('dismiss intent but nothing pending → not handled (falls to LLM)', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    expect(await at.interpretDirectOrder('ignora', {})).toEqual({ handled: false });
  });

  test('non-dismiss text → not handled', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    expect(await at.interpretDirectOrder('fecha a fase #5', {})).toEqual({ handled: false });
  });
});

describe('P2 — ambiguity routing lives in the system prompt', () => {
  test('askClaude system prompt instructs ambiguity → ask, not act', async () => {
    const anthropic = { messages: { create: jest.fn().mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }) } };
    await dm.askClaude('fecha essa', 'Bruno', '=== CTX ===', { anthropic, adminTools: { TOOL_DEFS: [], runTool: jest.fn() } });
    const sys = anthropic.messages.create.mock.calls[0][0].system[0].text;
    expect(sys).toMatch(/AMB[ÍI]GUA/);
    expect(sys).toMatch(/pergunta qual/i);
    expect(sys).toMatch(/confirma o que fez/i);
  });
});
