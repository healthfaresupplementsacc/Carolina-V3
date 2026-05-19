'use strict';
// PARTE 4 — Carolina hourly activity auto-check: open phase/ad-hoc with
// no oal from the responsible operator for > 1h → asks the admin; admin
// answers sim/fechar/pausa → keep / close@lastoal / retro-break.
const af = require('../workflow/activity-freshness');
const at = require('../ai/admin-tools');
const fs = require('fs');
const path = require('path');

function memAppState(initial) {
  let store = Object.assign({}, initial);
  return {
    get: async (k, d) => (k in store ? store[k] : d),
    set: async (k, v) => { store[k] = v; },
    getTimeFormat: async () => '12h',
    _store: () => store,
  };
}
function staleRow(over) {
  return Object.assign({
    kind: 'phase', id: 5, name: 'Linha de Produção', product: 'Berberine',
    operator: 'Vitor', operator_id: 9, last_oal: '2026-05-16T18:00:00.000Z',
  }, over);
}

describe('PARTE 4 — detection SQL', () => {
  test('targets OPEN, started >1h, last oal NULL or >1h old', async () => {
    const sqls = [];
    const db = { query: (s) => { sqls.push(String(s)); return Promise.resolve({ rows: [] }); } };
    await af.findStale(db);
    const j = sqls.join('\n');
    expect(j).toMatch(/status = 'open' AND x\.ended_at IS NULL/);
    expect(j).toMatch(/x\.started_at < NOW\(\) - INTERVAL '8 hour'/);
    expect(j).toMatch(/lo\.last_oal IS NULL OR lo\.last_oal < NOW\(\) - INTERVAL '8 hour'/);
    expect(j).toMatch(/FROM phase_instances x/);
    expect(j).toMatch(/FROM ad_hoc_task_instances x/);
  });
});

describe('PARTE 4 — checkActivityFreshness asks the admin', () => {
  const baseDeps = () => {
    const posts = [];
    return {
      posts,
      db: { query: jest.fn((s) => {
        if (/FROM phase_instances x/.test(String(s))) return Promise.resolve({ rows: [{
          kind: 'phase', id: 5, name: 'Linha de Produção', product: 'Berberine',
          operator: 'Vitor', operator_id: 9, last_oal: '2026-05-16T18:00:00.000Z' }] });
        return Promise.resolve({ rows: [] });
      }) },
      appState: memAppState(),
      slack: { postToChannel: jest.fn((c, m) => { posts.push({ c, m }); return Promise.resolve('ts'); }) },
      auditAction: jest.fn().mockResolvedValue(),
      config: { slack: { managerChannelId: 'C0B36DR5MP1' } },
    };
  };

  test('stale phase → posts the question to the admin channel + persists pending', async () => {
    const d = baseDeps();
    const r = await af.checkActivityFreshness(d);
    expect(r.asked).toBe(1);
    expect(d.posts).toHaveLength(1);
    expect(d.posts[0].c).toBe('C0B36DR5MP1');
    expect(d.posts[0].m).toMatch(/Vitor tá em 'Linha de Produção · Berberine' há \+8h/);
    expect(d.posts[0].m).toMatch(/"sim".*"fechar".*"pausa"/s);
    expect(d.posts[0].m).toMatch(/sem resposta em 4h.*\[auto_close_12h\]/);
    const pending = JSON.parse((await d.appState.get(af.PENDING_KEY)));
    expect(pending.items[0]).toMatchObject({ kind: 'phase', id: 5, operator: 'Vitor' });
    expect(d.auditAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'activity_check.asked' }));
  });

  test('no stale (oal recent <1h) → no post, asked 0', async () => {
    const d = baseDeps();
    d.db.query = jest.fn(() => Promise.resolve({ rows: [] }));
    const r = await af.checkActivityFreshness(d);
    expect(r.asked).toBe(0);
    expect(d.posts).toHaveLength(0);
  });

  test('verified item is not re-asked until the 2h window passes', async () => {
    const d = baseDeps();
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    d.appState = memAppState({ [af.PENDING_KEY]: JSON.stringify({ items: [], verified: { 'phase:5': future } }) });
    const r = await af.checkActivityFreshness(d);
    expect(r.asked).toBe(0);
    expect(d.posts).toHaveLength(0);
  });
});

describe('PARTE 4 — admin answer resolves the check', () => {
  const withPending = () => memAppState({
    [af.PENDING_KEY]: JSON.stringify({ items: [staleRow()], verified: {} }),
  });

  test('"sim" → keep open, marked verified for 2h (no re-ask)', async () => {
    const appState = withPending();
    const r = await at.resolveActivityCheckTool({ answer: 'sim' }, { appState, auditAction: jest.fn() });
    expect(r).toMatchObject({ handled: true, action: 'keep' });
    const p = JSON.parse(await appState.get(af.PENDING_KEY));
    expect(p.items).toEqual([]);
    const until = new Date(p.verified['phase:5']).getTime();
    const hrs = (until - Date.now()) / 3600000;
    expect(hrs).toBeGreaterThan(1.9); expect(hrs).toBeLessThan(2.1);
  });

  test('"fechar" → closePhase with ended_at = last oal', async () => {
    const appState = withPending();
    const engine = { closePhase: jest.fn().mockResolvedValue({}), closeAdHocTask: jest.fn() };
    const r = await at.resolveActivityCheckTool({ answer: 'fechar agora' },
      { appState, engine, auditAction: jest.fn() });
    expect(r.action).toBe('close');
    expect(engine.closePhase).toHaveBeenCalledWith(
      expect.objectContaining({ phaseInstanceId: 5, when: '2026-05-16T18:00:00.000Z' }));
  });

  test('"pausa" → retro break: pause + oal break started_at = last oal', async () => {
    const appState = withPending();
    const sqls = [];
    const db = { query: jest.fn((s, p) => { sqls.push({ s: String(s), p }); return Promise.resolve({ rows: [{ id: 99 }] }); }) };
    const r = await at.resolveActivityCheckTool({ answer: 'pausa' }, { appState, db, auditAction: jest.fn() });
    expect(r.action).toBe('break');
    expect(sqls.some((x) => /INSERT INTO pauses/.test(x.s) && x.p[1] === '2026-05-16T18:00:00.000Z')).toBe(true);
    expect(sqls.some((x) => /INSERT INTO operator_activity_log/.test(x.s) && /activity_type[\s\S]*'break'/.test(x.s))).toBe(true);
  });

  test('unrecognized answer → not handled (asks again)', async () => {
    const r = await at.resolveActivityCheckTool({ answer: 'hmm sei lá' }, { appState: withPending(), auditAction: jest.fn() });
    expect(r.handled).toBe(false);
  });

  test('no pending → handled:false', async () => {
    const r = await af.resolveActivityCheck('keep', { appState: memAppState(), auditAction: jest.fn() });
    expect(r.handled).toBe(false);
  });
});

describe('TAREFA 3 — 8h detecção + 12h auto-close', () => {
  const iso = (hAgo) => new Date(Date.now() - hAgo * 3600 * 1000).toISOString();
  function deps({ pending, engine }) {
    const posts = [];
    const sqls = [];
    return {
      posts, sqls,
      db: { query: jest.fn((s) => {
        sqls.push(String(s));
        if (/FROM phase_instances x/.test(String(s))) return Promise.resolve({ rows: [{
          kind: 'phase', id: 5, name: 'Linha de Produção', product: 'Berberine',
          operator: 'Vitor', operator_id: 9, last_oal: '2026-05-16T18:00:00.000Z' }] });
        return Promise.resolve({ rows: [] });
      }) },
      appState: memAppState(pending ? { [af.PENDING_KEY]: JSON.stringify(pending) } : {}),
      slack: { postToChannel: jest.fn((c, m) => { posts.push({ c, m }); return Promise.resolve('ts'); }) },
      auditAction: jest.fn().mockResolvedValue(),
      config: { slack: { managerChannelId: 'C0B36DR5MP1' } },
      engine: engine || { closePhase: jest.fn().mockResolvedValue({}), closeAdHocTask: jest.fn().mockResolvedValue({}) },
    };
  }

  test('constantes: STALE_HOURS=8, AUTO_CLOSE_HOURS=12', () => {
    expect(af.STALE_HOURS).toBe(8);
    expect(af.AUTO_CLOSE_HOURS).toBe(12);
  });

  test('first_asked > 12h e ainda sem resposta → auto-close + nota + audit, NÃO re-pergunta', async () => {
    const d = deps({ pending: { items: [], verified: {}, firstAsked: { 'phase:5': iso(13) } } });
    const r = await af.checkActivityFreshness(d);
    expect(d.engine.closePhase).toHaveBeenCalledWith(expect.objectContaining({ phaseInstanceId: 5 }));
    expect(d.sqls.some((s) => /UPDATE phase_instances SET notes = COALESCE\(notes,''\) \|\| ' \[auto_close_12h\]'/.test(s))).toBe(true);
    expect(d.auditAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'activity_check.auto_close_12h' }));
    expect(r.autoClosed).toHaveLength(1);
    expect(r.asked).toBe(0);
    expect(d.posts).toHaveLength(0);
    const p = JSON.parse(await d.appState.get(af.PENDING_KEY));
    expect(p.firstAsked['phase:5']).toBeUndefined();
  });

  test('first_asked entre 8h e 12h → re-pergunta, NÃO fecha, mantém first_asked', async () => {
    const fa = iso(9);
    const d = deps({ pending: { items: [], verified: {}, firstAsked: { 'phase:5': fa } } });
    const r = await af.checkActivityFreshness(d);
    expect(d.engine.closePhase).not.toHaveBeenCalled();
    expect(r.asked).toBe(1);
    expect(d.posts).toHaveLength(1);
    const p = JSON.parse(await d.appState.get(af.PENDING_KEY));
    expect(p.firstAsked['phase:5']).toBe(fa); // clock NÃO reinicia
  });

  test('item novo (sem first_asked) → pergunta + carimba first_asked, não fecha', async () => {
    const d = deps({ pending: { items: [], verified: {}, firstAsked: {} } });
    const r = await af.checkActivityFreshness(d);
    expect(r.asked).toBe(1);
    expect(d.engine.closePhase).not.toHaveBeenCalled();
    const p = JSON.parse(await d.appState.get(af.PENDING_KEY));
    expect(typeof p.firstAsked['phase:5']).toBe('string');
  });

  test('resposta do admin ("sim") limpa o relógio de auto-close (first_asked)', async () => {
    const appState = memAppState({ [af.PENDING_KEY]: JSON.stringify({
      items: [staleRow()], verified: {}, firstAsked: { 'phase:5': iso(10) } }) });
    await at.resolveActivityCheckTool({ answer: 'sim' }, { appState, auditAction: jest.fn() });
    const p = JSON.parse(await appState.get(af.PENDING_KEY));
    expect(p.firstAsked['phase:5']).toBeUndefined();
  });
});

describe('PARTE 4 — wiring + tool + prompt', () => {
  test('resolve_activity_check is a registered channel tool', () => {
    expect(at.CHANNEL_TOOLS.has('resolve_activity_check')).toBe(true);
    expect(at.TOOL_DEFS.find((t) => t.name === 'resolve_activity_check')).toBeTruthy();
  });
  test('hourly cron wired in scheduler + index', () => {
    const sch = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
    expect(sch).toMatch(/cron\.schedule\('0 \* \* \* \*', \(\) => runActivityCheck\(\)/);
    expect(sch).toMatch(/checkActivityFreshness/);
    const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    expect(idx).toMatch(/startActivityCheckJob\(\)/);
  });
  test('prompt instructs ask + wait + repeat hourly + resolve mapping', () => {
    const dm = fs.readFileSync(path.join(__dirname, '..', 'slack', 'dm-handler.js'), 'utf8');
    expect(dm).toMatch(/ATIVIDADE PARADA/);
    expect(dm).toMatch(/NÃO aja sozinha/);
    expect(dm).toMatch(/resolve_activity_check/);
    expect(dm).toMatch(/action="keep"[\s\S]*action="close"[\s\S]*action="break"/);
  });
});
