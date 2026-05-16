'use strict';
// BLOCO C bugfix — use-case 3: retro-break question must NOT intercept
// every admin message; dismiss keywords (vocative-tolerant) must work;
// other orders coexist with a pending question.
jest.mock('../db');
const db = require('../db');
const at = require('../ai/admin-tools');
const btr = require('../workflow/break-time-reply');
const dm = require('../slack/dm-handler');

beforeEach(() => { jest.clearAllMocks(); });

describe('bugfix — every required dismiss keyword (bare + vocative)', () => {
  const KW = [
    'ignora', 'ignore', 'fecha', 'fecha essa', 'fecha isso', 'encerra',
    'esquece', 'esquece isso', 'deleta', 'deleta a pergunta',
    'para com isso', 'para', 'cancela', 'cancela essa', 'deixa', 'deixa pra lá',
  ];
  test.each(KW)('"%s" → dismiss intent', (kw) => {
    expect(at.detectDismissIntent(kw)).toBe(true);
  });
  test.each(KW)('"Carolina, %s" (vocative) → dismiss intent', (kw) => {
    expect(at.detectDismissIntent('Carolina, ' + kw)).toBe(true);
  });
  test.each(['ó Carol, ignora', 'Carolina ignora isso', 'carol fecha essa', 'ei carolina, esquece'])(
    'natural phrasing "%s" → dismiss', (s) => { expect(at.detectDismissIntent(s)).toBe(true); });
});

describe('bugfix — real orders / questions are NOT dismiss', () => {
  test.each([
    'fecha a fase #5', 'Carolina, fecha a fase #5', 'renomeia tarefa #10 pra Limpeza',
    'qual é o estado das fases abertas agora?', 'Carolina, qual é o estado das fases agora?',
    'mostra timeline da Ana hoje', 'sim', 'parabéns', 'paralelo', 'aprova essa tarefa',
  ])('"%s" → NOT dismiss', (s) => { expect(at.detectDismissIntent(s)).toBe(false); });
});

describe('bugfix — looksLikeTimeReply gates the retro-break handler', () => {
  test.each(['14:30', '14h30', '1430', '14h', '2pm', 'às 9:05', '08:00'])(
    'time "%s" → true', (s) => { expect(btr.looksLikeTimeReply(s)).toBe(true); });
  test.each([
    'fecha a fase #5', 'Carolina, qual é o estado das fases agora?', 'ignora',
    'fecha essa', 'esquece', 'renomeia #10 pra X', '5',
  ])('non-time "%s" → false', (s) => { expect(btr.looksLikeTimeReply(s)).toBe(false); });
});

describe('bugfix — interpretDirectOrder with a pending retro-break question', () => {
  function retroPending() {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/retro_break_admin/.test(sql) && /SELECT/.test(sql)) return Promise.resolve({ rows: [{ value: '{"opName":"Bruno"}' }] });
      if (/DELETE FROM app_state/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
  }

  test.each(['ignora', 'fecha essa', 'esquece', 'deleta', 'para com isso', 'cancela', 'deixa', 'Carolina, fecha essa'])(
    '"%s" → dismisses the pending break question', async (s) => {
      retroPending();
      const r = await at.interpretDirectOrder(s, { auditAction: jest.fn() });
      expect(r.handled).toBe(true);
      expect(r.reply).toMatch(/descartei/i);
    });

  test('"qual é o estado das fases?" with pending → NOT handled (falls to loop)', async () => {
    retroPending();
    const r = await at.interpretDirectOrder('qual é o estado das fases agora?', {});
    expect(r).toEqual({ handled: false });
  });

  test('"fecha a fase #5" with pending → NOT a dismiss (real order falls to loop)', async () => {
    retroPending();
    const r = await at.interpretDirectOrder('fecha a fase #5', {});
    expect(r).toEqual({ handled: false });
  });

  test('dismiss keyword but NOTHING pending → not handled', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    expect(await at.interpretDirectOrder('ignora', {})).toEqual({ handled: false });
  });
});

describe('bugfix — coexistence: loop runs + reminds about the pending question', () => {
  test('askClaude system prompt carries the COEXISTÊNCIA reminder rule', async () => {
    const anthropic = { messages: { create: jest.fn().mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }) } };
    await dm.askClaude('qual o estado?', 'Bruno', 'CTX\n\nPENDÊNCIAS: pergunta de horário de break retroativo.',
      { anthropic, adminTools: { TOOL_DEFS: [], runTool: jest.fn() } });
    const sys = anthropic.messages.create.mock.calls[0][0].system[0].text;
    expect(sys).toMatch(/COEXIST[ÊE]NCIA/);
    expect(sys).toMatch(/lembrando da pend[êe]ncia/i);
    expect(sys).toMatch(/dismiss_pending_question/);
    expect(sys).toMatch(/update_break_retroactive/);
    // the pending context was passed into the prompt
    expect(sys).toMatch(/PEND[ÊE]NCIAS: pergunta de hor[áa]rio de break/);
  });
});
