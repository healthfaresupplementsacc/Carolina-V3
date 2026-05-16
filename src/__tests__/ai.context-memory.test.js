'use strict';
// BLOCO C bugfix — Carolina must use prior tool results (get_state) to
// resolve "fecha o que está aberto" without re-asking for an id.
jest.mock('../db');
const db = require('../db');
const at = require('../ai/admin-tools');
const dm = require('../slack/dm-handler');

beforeEach(() => { jest.clearAllMocks(); });

// True if any tool_result block in the transcript contains `substr`
// (the get_state JSON is a string inside the block, so a plain
// JSON.stringify of the whole array double-escapes the quotes).
function toolResultHas(messages, substr) {
  for (const m of messages || []) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === 'tool_result' && typeof b.content === 'string'
        && b.content.includes(substr)) return true;
    }
  }
  return false;
}

// ---- get_state now returns entity lists with ids ----
describe('get_state returns open entities (id + name), not just counts', () => {
  test('phases/adhoc/workflows lists present', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/count\(\*\)/.test(sql)) return Promise.resolve({ rows: [{ n: 1 }] });
      if (/FROM phase_instances WHERE status='open'/.test(sql)) return Promise.resolve({ rows: [{ id: 5, phase_name: 'Encapsulação' }] });
      if (/FROM ad_hoc_task_instances WHERE status='open'/.test(sql)) return Promise.resolve({ rows: [{ id: 9, task_name: 'Limpeza' }] });
      if (/FROM workflow_instances WHERE status='active'/.test(sql)) return Promise.resolve({ rows: [{ id: 2, product_name: 'Green Tea', batch_number: '0098' }] });
      return Promise.resolve({ rows: [] });
    });
    const s = await at.getState();
    expect(s.open_phases).toBe(1);
    expect(s.phases).toEqual([{ id: 5, phase_name: 'Encapsulação' }]);
    expect(s.adhoc[0].id).toBe(9);
    expect(s.workflows[0].product_name).toBe('Green Tea');
  });
});

// ---- trimHistory keeps tool pairs, cuts at real-user boundaries ----
describe('trimHistory', () => {
  const u = (t) => ({ role: 'user', content: t });
  const a = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }] });
  const aTool = () => ({ role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'get_state', input: {} }] });
  const uTool = () => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }] });

  test('keeps last N real exchanges, never splits a tool pair', () => {
    const h = [];
    for (let i = 0; i < 10; i++) { h.push(u('msg' + i), aTool(), uTool(), a('reply' + i)); }
    const t = dm.trimHistory(h, 3);
    // starts on a real (string) user message
    expect(t[0].role).toBe('user');
    expect(typeof t[0].content).toBe('string');
    // exactly 3 real-user turns kept
    expect(t.filter((m) => m.role === 'user' && typeof m.content === 'string')).toHaveLength(3);
    // every tool_use turn is followed by its tool_result
    t.forEach((m, i) => {
      if (m.role === 'assistant' && Array.isArray(m.content) && m.content[0] && m.content[0].type === 'tool_use') {
        expect(t[i + 1].content[0].type).toBe('tool_result');
      }
    });
  });

  test('short history is returned intact', () => {
    const h = [u('a'), a('b')];
    expect(dm.trimHistory(h, 6)).toEqual(h);
  });
});

// ---- loadManagerHistory freshness ----
describe('loadManagerHistory', () => {
  test('stale (>30min) → empty; fresh → trimmed messages', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ value: JSON.stringify({ ts: Date.now() - 40 * 60 * 1000, messages: [{ role: 'user', content: 'old' }] }) }] });
    expect(await dm.loadManagerHistory()).toEqual([]);
    db.query = jest.fn().mockResolvedValue({ rows: [{ value: JSON.stringify({ ts: Date.now(), messages: [{ role: 'user', content: 'fresh' }] }) }] });
    expect(await dm.loadManagerHistory()).toEqual([{ role: 'user', content: 'fresh' }]);
  });
  test('no row → empty', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    expect(await dm.loadManagerHistory()).toEqual([]);
  });
});

// ---- askClaude carries prior tool results into the next turn ----
describe('askClaude conversation memory', () => {
  test('prior get_state result is sent to the model on the next turn + history saved', async () => {
    const priorGetState = [
      { role: 'user', content: 'Bruno: qual estado das fases?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'g1', name: 'get_state', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'g1', content: JSON.stringify({ open_phases: 1, phases: [{ id: 5, phase_name: 'Encapsulação' }] }) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'tem 1 fase aberta' }] },
    ];
    const anthropic = { messages: { create: jest.fn().mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }) } };
    const saved = [];
    await dm.askClaude('fecha o que está aberto', 'Bruno', 'CTX', {
      anthropic, adminTools: { TOOL_DEFS: [], runTool: jest.fn() },
      history: priorGetState, saveHistory: async (m) => saved.push(m),
    });
    const sent = anthropic.messages.create.mock.calls[0][0].messages;
    expect(toolResultHas(sent, '"id":5')).toBe(true);      // prior get_state visible to the model
    expect(toolResultHas(sent, 'Encapsulação')).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0][saved[0].length - 1].role).toBe('assistant'); // transcript closed
  });
});

// ---- the 5 product-owner scenarios ----
// Two-turn flow: turn 1 = get_state (state crafted), turn 2 = the vague
// order. A "context-aware" fake Anthropic reads the get_state result
// from the messages it was given and applies the documented rule —
// proving the harness delivers the disambiguation data downstream.
function twoTurn(stateResult, order, claudeTurn2) {
  const realRun = async (name) => (name === 'get_state' ? stateResult : { ok: true });
  let hist = [];
  const save = async (m) => { hist = m; };
  const t1 = { messages: { create: jest.fn()
    .mockResolvedValueOnce({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'g', name: 'get_state', input: {} }] })
    .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: `vi ${stateResult.open_phases} fase(s)` }] }) } };
  const calls = [];
  const t2 = { messages: { create: jest.fn((req) => { calls.push(req); return Promise.resolve(claudeTurn2.shift()); }) } };
  const run2 = jest.fn(realRun);
  return (async () => {
    await dm.askClaude('qual estado das fases abertas?', 'Bruno', 'CTX',
      { anthropic: t1, adminTools: { TOOL_DEFS: [], runTool: jest.fn(realRun) }, history: [], saveHistory: save });
    const reply = await dm.askClaude(order, 'Bruno', 'CTX',
      { anthropic: t2, adminTools: { TOOL_DEFS: [], runTool: run2 }, history: hist, saveHistory: save });
    return { reply, run2, turn2Req: calls[0] };
  })();
}

describe('product-owner scenarios', () => {
  test('1 phase open + "fecha o aberto" → close_phase(id) called', async () => {
    const state = { open_phases: 1, phases: [{ id: 5, phase_name: 'Encapsulação' }], adhoc: [], workflows: [] };
    const { reply, run2, turn2Req } = await twoTurn(state, 'fecha o que está aberto', [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'c', name: 'close_phase', input: { phase_instance_id: 5 } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fechei a fase #5 (Encapsulação).' }] },
    ]);
    expect(toolResultHas(turn2Req.messages, '"id":5')).toBe(true); // memory delivered
    expect(run2).toHaveBeenCalledWith('close_phase', { phase_instance_id: 5 }, expect.any(Object));
    expect(reply).toMatch(/Fechei a fase #5/);
  });

  test('3 phases open + "fecha o aberto" → clarification, no close', async () => {
    const state = { open_phases: 3, phases: [{ id: 1, phase_name: 'A' }, { id: 2, phase_name: 'B' }, { id: 3, phase_name: 'C' }], adhoc: [], workflows: [] };
    const { reply, run2 } = await twoTurn(state, 'fecha o que está aberto', [
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Tem 3 fases abertas: #1 A, #2 B, #3 C. Qual?' }] },
    ]);
    expect(run2).not.toHaveBeenCalledWith('close_phase', expect.anything(), expect.anything());
    expect(reply).toMatch(/Qual\?/);
  });

  test('0 phases open + "fecha o aberto" → "não tem fase aberta"', async () => {
    const state = { open_phases: 0, phases: [], adhoc: [], workflows: [] };
    const { reply, run2 } = await twoTurn(state, 'fecha o que está aberto', [
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'não tem fase aberta agora' }] },
    ]);
    expect(run2).not.toHaveBeenCalledWith('close_phase', expect.anything(), expect.anything());
    expect(reply).toMatch(/não tem fase aberta/i);
  });

  test('1 phase + "fecha essa" → close_phase called', async () => {
    const state = { open_phases: 1, phases: [{ id: 7, phase_name: 'Revisão' }], adhoc: [], workflows: [] };
    const { run2, turn2Req } = await twoTurn(state, 'fecha essa', [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'c', name: 'close_phase', input: { phase_instance_id: 7 } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fechei a #7.' }] },
    ]);
    expect(toolResultHas(turn2Req.messages, '"id":7')).toBe(true);
    expect(run2).toHaveBeenCalledWith('close_phase', { phase_instance_id: 7 }, expect.any(Object));
  });

  test('1 phase + "encerra a fase que tá rolando" → close_phase called', async () => {
    const state = { open_phases: 1, phases: [{ id: 12, phase_name: 'Tablet' }], adhoc: [], workflows: [] };
    const { run2 } = await twoTurn(state, 'encerra a fase que tá rolando', [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'c', name: 'close_phase', input: { phase_instance_id: 12 } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Encerrei a #12.' }] },
    ]);
    expect(run2).toHaveBeenCalledWith('close_phase', { phase_instance_id: 12 }, expect.any(Object));
  });
});

describe('system prompt instructs reference resolution', () => {
  test('MEMÓRIA + RESOLUÇÃO DE REFERÊNCIA rules present', async () => {
    const anthropic = { messages: { create: jest.fn().mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }) } };
    await dm.askClaude('oi', 'Bruno', 'CTX', { anthropic, adminTools: { TOOL_DEFS: [], runTool: jest.fn() } });
    const sys = anthropic.messages.create.mock.calls[0][0].system[0].text;
    expect(sys).toMatch(/MEM[ÓO]RIA/);
    expect(sys).toMatch(/RESOLU[ÇC][ÃA]O DE REFER[ÊE]NCIA/);
    expect(sys).toMatch(/Exatamente 1/);
    expect(sys).toMatch(/V[áa]rias/);
    expect(sys).toMatch(/Zero/);
  });
});
