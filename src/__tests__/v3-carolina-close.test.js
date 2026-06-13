'use strict';
/* Fase A (bloco zerar) — close_tasks / close_specific_event + confirmação rica. */
const { CommandHandler } = require('../v3/services/CommandHandler');

const resp = (rows) => ({ rows, rowCount: rows.length });
const PERSONS = [
  { id: 1, display_name: 'Bruno Camp', role: 'owner', slack_user_id: 'U_BRUNO_CAMP' },
  { id: 4, display_name: 'Vitor', role: 'operator', slack_user_id: 'U_VITOR' },
  { id: 6, display_name: 'Ana', role: 'operator', slack_user_id: 'U_ANA' },
];

function makeDb(openEvents = []) {
  const mem = { closed: [], audits: [], pendings: [] };
  return {
    mem,
    query: jest.fn(async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/FROM v3\.persons WHERE slack_user_id = \$1/.test(s)) {
        const p = PERSONS.find((x) => x.slack_user_id === params[0] && ['owner', 'manager'].includes(x.role));
        return resp(p ? [p] : []);
      }
      if (/SELECT e\.id, e\.person_id, p\.display_name, at\.slug, pb\.batch_number,.*min_aberto/s.test(s) || /min_aberto/.test(s)) {
        const ids = params[0] || [];
        return resp(openEvents.filter((e) => ids.includes(e.person_id)));
      }
      if (/UPDATE v3\.events SET ended_at = NOW\(\), closed_reason = 'admin_close_via_carolina'.*id = ANY/s.test(s)) {
        mem.closed.push(...(params[0] || []));
        return resp([]);
      }
      if (/UPDATE v3\.events SET ended_at = NOW\(\), closed_reason = 'admin_close_via_carolina'.*id = \$1 AND ended_at IS NULL/s.test(s)) {
        const ev = openEvents.find((e) => e.id === params[0]);
        if (!ev) return resp([]);
        mem.closed.push(params[0]);
        return resp([{ id: params[0] }]);
      }
      if (/SELECT ended_at, deleted_at FROM v3\.events WHERE id/.test(s)) {
        const ev = openEvents.find((e) => e.id === params[0]);
        return resp(ev ? [{ ended_at: null, deleted_at: null }] : []);
      }
      if (/INSERT INTO v3\.pending_commands/.test(s)) { mem.pendings.push({ type: params[4], payload: JSON.parse(params[5]) }); return resp([]); }
      if (/INSERT INTO v3\.audit_log/.test(s)) { mem.audits.push({ action: params[0] }); return resp([]); }
      return resp([]);
    }),
  };
}

function makeHandler(db, llmJson) {
  const calls = { posts: [], reactions: [] };
  return {
    calls,
    handler: new CommandHandler({
      db,
      provider: { classifyRaw: jest.fn(async () => ({ json_parsed: llmJson, cost_estimate_usd: 0 })) },
      eventService: { upsert: jest.fn(), correct: jest.fn(), softDelete: jest.fn() },
      slack: {
        postAs: jest.fn(async (o) => { calls.posts.push(o); return { ts: 'reply.' + (calls.posts.length) }; }),
        addReaction: jest.fn(async (o) => { calls.reactions.push(o); }),
      },
      productionChannelId: 'C_PROD', adminChannelId: 'C_ADMIN',
    }),
  };
}
const msg = (over = {}) => Object.assign({ id: 1, slack_ts: '100.1', slack_channel_id: 'C_ADMIN', slack_user_id: 'U_BRUNO_CAMP', raw_text: '<@U0B3EQLPEPL> fecha' }, over);

const OPEN = [
  { id: 311, person_id: 4, display_name: 'Vitor', slug: 'production_line', batch_number: 'BR-2026-0190', started_edt: '09:22 AM', min_aberto: 60 },
  { id: 315, person_id: 4, display_name: 'Vitor', slug: 'cleaning', batch_number: null, started_edt: '10:30 AM', min_aberto: 12 },
  { id: 320, person_id: 6, display_name: 'Ana', slug: 'review', batch_number: 'BR-2026-0195', started_edt: '10:00 AM', min_aberto: 42 },
];

describe('Fase A — close_tasks', () => {
  test('"fecha tasks do Vitor" → pending + confirmação LISTA as tasks', async () => {
    const db = makeDb(OPEN);
    const { handler, calls } = makeHandler(db, {
      command_type: 'close_tasks', params: { person_ids: [4] }, destructive: true, uncertain: false, explanation: 'fechar tasks Vitor',
    });
    const r = await handler.tryRoute(msg({ raw_text: '@Carolina Finaliza os tasks do vitor que estao ativos' }));
    expect(r.result).toBe('pending');
    expect(db.mem.pendings[0].type).toBe('close_tasks');
    const conf = calls.posts.find((p) => /Vou fechar/.test(p.text));
    expect(conf.text).toContain('production_line');
    expect(conf.text).toContain('cleaning');
    expect(conf.text).toContain('Reaja ✅');
  });

  test('confirmAndExecute → fecha as 2 tasks do Vitor + audit', async () => {
    const db = makeDb(OPEN);
    const { handler } = makeHandler(db, { command_type: 'close_tasks', params: { person_ids: [4] }, destructive: true, uncertain: false });
    await handler.tryRoute(msg());
    const r = await handler.confirmAndExecute({ carolinaMsgTs: 'reply.2', reactorSlackUserId: 'U_BRUNO_CAMP', reactorPersonId: 1, channel: 'C_ADMIN' });
    // pending lookup é via DB real no confirmAndExecute — aqui o fake não guarda; testamos o exec direto:
    const exec = await handler._execCloseTasks({ params: { person_ids: [4] } }, { id: 1 }, { id: 99 });
    expect(exec.event_ids.sort()).toEqual([311, 315]);
    expect(db.mem.closed).toEqual(expect.arrayContaining([311, 315]));
    expect(db.mem.audits.filter((a) => a.action === 'event.closed_via_carolina').length).toBeGreaterThanOrEqual(2);
  });

  test('2 pessoas (Vitor e Ana) → fecha tasks das duas', async () => {
    const db = makeDb(OPEN);
    const { handler } = makeHandler(db, {});
    const exec = await handler._execCloseTasks({ params: { person_ids: [4, 6] } }, { id: 1 }, { id: 99 });
    expect(exec.event_ids.sort()).toEqual([311, 315, 320]);
  });

  test('pessoa sem tasks abertas → mensagem clara, nada fechado', async () => {
    const db = makeDb([]);
    const { handler } = makeHandler(db, {});
    const exec = await handler._execCloseTasks({ params: { person_ids: [4] } }, { id: 1 }, { id: 99 });
    expect(exec.replyText).toMatch(/Nenhuma task aberta/);
    expect(db.mem.closed).toHaveLength(0);
  });

  test('sem pessoa identificada → pede esclarecimento', async () => {
    const db = makeDb(OPEN);
    const { handler } = makeHandler(db, {});
    const exec = await handler._execCloseTasks({ params: {} }, { id: 1 }, { id: 99 });
    expect(exec.replyText).toMatch(/Não identifiquei a pessoa/);
  });

  test('long_running NÃO entra (query filtra is_long_running=false)', async () => {
    const db = makeDb(OPEN);
    const { handler } = makeHandler(db, {});
    await handler._execCloseTasks({ params: { person_ids: [4] } }, { id: 1 }, { id: 99 });
    const q = db.query.mock.calls.find((c) => /min_aberto/.test(String(c[0])));
    expect(String(q[0])).toContain('is_long_running = false');
  });
});

describe('Fase A — close_specific_event', () => {
  test('fecha ev311 (aberto) + audit', async () => {
    const db = makeDb(OPEN);
    const { handler } = makeHandler(db, {});
    const exec = await handler._execCloseSpecificEvent({ target: { event_id: 311 } }, { id: 1 }, { id: 99 });
    expect(exec.event_id).toBe(311);
    expect(db.mem.closed).toContain(311);
  });
  test('event inexistente → aviso', async () => {
    const db = makeDb(OPEN);
    const { handler } = makeHandler(db, {});
    const exec = await handler._execCloseSpecificEvent({ target: { event_id: 999 } }, { id: 1 }, { id: 99 });
    expect(exec.replyText).toMatch(/não existe/);
  });
  test('sem event_id → aviso', async () => {
    const db = makeDb(OPEN);
    const { handler } = makeHandler(db, {});
    const exec = await handler._execCloseSpecificEvent({ target: null }, { id: 1 }, { id: 99 });
    expect(exec.replyText).toMatch(/Faltou o event_id/);
  });
});
