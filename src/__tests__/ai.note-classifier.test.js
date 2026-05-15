'use strict';
const classifier = require('../ai/note-classifier');

describe('heuristicClassify', () => {
  test('greetings → casual_chat', () => {
    expect(classifier.heuristicClassify('bom dia pessoal').intent).toBe('casual_chat');
    expect(classifier.heuristicClassify('valeu, obrigado!').intent).toBe('casual_chat');
  });
  test('problem words → needs_action', () => {
    expect(classifier.heuristicClassify('a máquina parou de novo').intent).toBe('needs_action');
    expect(classifier.heuristicClassify('acabou o material do potassium').intent).toBe('needs_action');
  });
  test('substantive text → note', () => {
    expect(classifier.heuristicClassify('deixei o lote separado na prateleira 3 pra revisar amanha').intent).toBe('note');
  });
  test('short/ambiguous → unknown_but_relevant', () => {
    expect(classifier.heuristicClassify('ok').intent).toBe('unknown_but_relevant');
  });
});

describe('classify (no API key → heuristic)', () => {
  const OLD = process.env.ANTHROPIC_API_KEY;
  beforeAll(() => { delete process.env.ANTHROPIC_API_KEY; });
  afterAll(() => { if (OLD) process.env.ANTHROPIC_API_KEY = OLD; });

  test('uses heuristic source when no key', async () => {
    const r = await classifier.classify('bom dia');
    expect(r.source).toBe('heuristic');
    expect(r.intent).toBe('casual_chat');
  });
});

describe('classifyAndAct', () => {
  const OLD = process.env.ANTHROPIC_API_KEY;
  beforeAll(() => { delete process.env.ANTHROPIC_API_KEY; });
  afterAll(() => { if (OLD) process.env.ANTHROPIC_API_KEY = OLD; });

  function deps() {
    const calls = { db: [], slack: [] };
    return {
      calls,
      db: { query: jest.fn((sql, p) => { calls.db.push({ sql, p }); return Promise.resolve({ rows: [] }); }) },
      slackClient: { postToChannel: jest.fn((ch, t) => { calls.slack.push({ ch, t }); return Promise.resolve('ts'); }) },
      config: { slack: { managerChannelId: 'C0B36DR5MP1' } },
    };
  }

  test('casual_chat → ignored, no DB/slack', async () => {
    const d = deps();
    const r = await classifier.classifyAndAct({ operator: 'Ana', raw: 'bom dia' }, { text: 'bom dia' }, d);
    expect(r.action).toBe('ignored');
    expect(d.calls.slack.length).toBe(0);
  });

  test('note (substantive) → noted, updates oal', async () => {
    const d = deps();
    const r = await classifier.classifyAndAct(
      { operator: 'Ana' },
      { text: 'deixei o lote do berberine separado pra revisar amanha de manha na mesa 3' },
      d
    );
    expect(r.action).toBe('noted');
    expect(d.calls.db.length).toBe(1);
    expect(d.calls.db[0].sql).toMatch(/UPDATE operator_activity_log/);
  });

  test('needs_action → admin chat alert (manager channel)', async () => {
    const d = deps();
    const r = await classifier.classifyAndAct(
      { operator: 'Bruno' }, { text: 'a maquina de tablet quebrou e parou tudo' }, d
    );
    expect(r.action).toBe('admin_alerted');
    expect(d.calls.slack.length).toBe(1);
    expect(d.calls.slack[0].ch).toBe('C0B36DR5MP1');
    expect(d.calls.slack[0].t).toMatch(/n[ãa]o reconhecida/);
  });

  test('admin alert never targets production channel', async () => {
    const d = deps();
    await classifier.classifyAndAct({ operator: 'X' }, { text: 'ok' }, d); // low conf
    for (const c of d.calls.slack) expect(c.ch).toBe('C0B36DR5MP1');
  });
});
