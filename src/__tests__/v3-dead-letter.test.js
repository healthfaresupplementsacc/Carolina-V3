'use strict';
/* Fase A — dead-letter de retry: tests do Observer (_markError/_deadLetter/claim)
   + diagnostics/queue estendido. */
const { Observer } = require('../v3/llm/Observer');
const q = require('../lib/architect-queries');

const resp = (rows) => ({ rows, rowCount: rows.length });

function makeDb() {
  const mem = { updates: [], audits: [], notifications: [], deadLettered: new Set(), claimSql: null };
  return {
    mem,
    query: jest.fn(async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/UPDATE v3\.messages SET claimed_at = NOW\(\)/.test(s)) { mem.claimSql = s; return resp([]); }
      if (/UPDATE v3\.messages SET processing_error = \$2, last_error = \$2/.test(s)) {
        mem.updates.push({ id: params[0], err: params[1] });
        return resp([]);
      }
      if (/UPDATE v3\.messages SET dead_lettered_at = NOW\(\)/.test(s)) {
        if (mem.deadLettered.has(params[0])) return resp([]); // já DL → rowCount 0
        mem.deadLettered.add(params[0]);
        return resp([{ id: params[0] }]);
      }
      if (/INSERT INTO v3\.audit_log/.test(s)) {
        // actor_type E action podem ser literais no SQL — simula o CHECK ampliado
        const m = /VALUES \('([^']+)', NULL, '([^']+)'/.exec(s) || /VALUES \('([^']+)'/.exec(s);
        const ALLOWED = ['admin', 'llm_observer', 'llm_assistant', 'system', 'app_home', 'operator_page', 'admin_via_slack', 'dedupe_worker'];
        if (m && !ALLOWED.includes(m[1])) return Promise.reject(new Error('viola CHECK actor_type: ' + m[1]));
        mem.audits.push({ actor: m && m[1], action: (m && m[2]) || params[1] || params[0], target: params[0] });
        return resp([]);
      }
      if (/INSERT INTO v3\.notifications/.test(s)) {
        mem.notifications.push(JSON.parse(params[0]));
        return resp([]);
      }
      return resp([]);
    }),
  };
}

function makeObserver(db, slack) {
  return new Observer({
    db,
    provider: { classify: jest.fn() },
    personResolver: { resolve: jest.fn() },
    promptBuilder: { build: jest.fn() },
    eventService: { safetyAutoClose: jest.fn() },
    batchService: {}, productionCountService: {},
    botUserId: 'U_BOT', mode: 'shadow',
    slack: slack || null,
    enableWorkerAlerts: false,
  });
}

const msg = (attempts, over = {}) => ({
  id: 42, slack_ts: '1781.42', raw_text: 'S: msg problematica de teste',
  processing_attempts: attempts, ...over,
});

describe('Fase A — dead-letter no Observer', () => {
  test('falha com attempts=1 → registra last_error, NÃO dead-letter', async () => {
    const db = makeDb();
    const o = makeObserver(db);
    await o._markError(msg(1), new Error('llm_error: boom'));
    expect(db.mem.updates[0].err).toContain('boom');
    expect(db.mem.deadLettered.size).toBe(0);
    expect(db.mem.notifications).toHaveLength(0);
  });

  test('falha com attempts=3 → dead-letter + audit llm_observer + notification + Carolina avisa', async () => {
    const db = makeDb();
    const slack = { postAs: jest.fn(async () => ({ ts: 'x' })) };
    const o = makeObserver(db, slack);
    await o._markError(msg(3), new Error('invalid_llm_response: garbage'));
    expect(db.mem.deadLettered.has(42)).toBe(true);
    const audit = db.mem.audits.find((a) => a.action === 'message_dead_lettered');
    expect(audit).toBeTruthy();
    expect(audit.actor).toBe('llm_observer'); // passa no CHECK (não 'observer')
    expect(db.mem.notifications[0]).toMatchObject({ message_id: 42, attempts: 3 });
    const post = slack.postAs.mock.calls[0][0];
    expect(post.sender).toEqual({ name: 'Carolina' });
    expect(post.thread_ts).toBeNull();
    expect(post.text).toContain('dead-letter');
    expect(post.text).toContain('1781.42');
  });

  test('attempts=5 (corrida): segunda chamada não duplica notification', async () => {
    const db = makeDb();
    const o = makeObserver(db);
    await o._markError(msg(3), new Error('x'));
    await o._markError(msg(4), new Error('x'));   // já dead-lettered → rowCount 0 → early return
    expect(db.mem.notifications).toHaveLength(1);
  });

  test('claim SQL exclui dead_lettered e incrementa attempts', async () => {
    const db = makeDb();
    const o = makeObserver(db);
    await o.tick();
    expect(db.mem.claimSql).toContain('dead_lettered_at IS NULL');
    expect(db.mem.claimSql).toContain('processing_attempts = COALESCE(processing_attempts, 0) + 1');
    expect(db.mem.claimSql).toContain('last_attempt_at = NOW()');
  });

  test('_finalize limpa last_error no sucesso', async () => {
    const db = makeDb();
    let finalizeSql = null;
    db.query.mockImplementation(async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (/SET llm_processed_at = NOW\(\)/.test(s) && /llm_result/.test(s)) finalizeSql = s;
      return resp([]);
    });
    const o = makeObserver(db);
    await o._finalize(msg(2), { actions: [], provider_used: 'gemini' }, [], [], { isOffHours: false, adminCtx: false, coalesced: 1 });
    expect(finalizeSql).toContain('last_error = NULL');
  });
});

describe('Fase A — diagnostics/queue estendido', () => {
  test('retorna campos de dead-letter', async () => {
    const db = {
      query: jest.fn(async (sql) => {
        const s = String(sql).replace(/\s+/g, ' ');
        if (/MIN\(created_at\) AS oldest/.test(s)) return resp([{ n: 1, oldest: new Date().toISOString() }]);
        if (/dead_lettered_at > NOW\(\)/.test(s)) return resp([{ id: 9, slack_ts: '1.2', text: 'x', last_error: 'boom', dead_lettered_at_edt: '…' }]);
        if (/processing_attempts >= 2/.test(s)) return resp([{ id: 10, processing_attempts: 2 }]);
        if (/AVG\(processing_attempts\)/.test(s)) return resp([{ avg: '1.05' }]);
        if (/pending_commands/.test(s)) return resp([{ n: 0 }]);
        if (/processing_error IS NOT NULL/.test(s)) return resp([{ n: 0 }]);
        if (/MAX\(llm_processed_at\)/.test(s)) return resp([{ ts: null }]);
        return resp([]);
      }),
    };
    const r = await q.queueDiag(db);
    expect(r.dead_lettered_count_24h).toBe(1);
    expect(r.dead_lettered_last_24h[0].id).toBe(9);
    expect(r.msgs_at_risk[0].id).toBe(10);
    expect(r.avg_attempts_per_msg_today).toBe('1.05');
    // pending exclui dead-lettered (filtro na query)
    const pendingSql = db.query.mock.calls.map((c2) => String(c2[0]).replace(/\s+/g, ' ')).find((s) => /MIN\(created_at\) AS oldest/.test(s));
    expect(pendingSql).toContain('dead_lettered_at IS NULL');
  });
});
