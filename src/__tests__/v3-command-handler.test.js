'use strict';
/* HEALTHFARE V3 — testes do CommandHandler (bloco 30/mai noite).
   Cobertura: detecção, parsing LLM, exec não-destrutivo, pending pra
   destrutivo, confirmação ✅, validações de admin, expiração TTL. */

const { CommandHandler } = require('../v3/services/CommandHandler');

const PERSONS = [
  { id: 1, display_name: 'Bruno Camp', role: 'owner', slack_user_id: 'U_BRUNO_CAMP' },
  { id: 2, display_name: 'Thassio', role: 'owner', slack_user_id: 'U_THASSIO' },
  { id: 3, display_name: 'Henrique', role: 'manager', slack_user_id: 'U_HENRIQUE' },
  { id: 4, display_name: 'Vitor', role: 'operator', slack_user_id: 'U_VITOR' },
  { id: 5, display_name: 'Simone', role: 'operator', slack_user_id: 'U_SIMONE' },
];

function makeFakeDb(opts = {}) {
  const audit = [];
  const pendings = [];
  const events = opts.events || [{ id: 999, person_id: 4, deleted_at: null, description: 'old desc' }];
  const eventsFound = new Map(events.map((e) => [e.id, e]));
  let pendingNextId = 1;
  return {
    audit, pendings, eventsFound,
    query: jest.fn(async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      // Persons by slack
      if (/FROM v3\.persons WHERE slack_user_id = \$1/.test(s)) {
        const p = PERSONS.find((x) => x.slack_user_id === params[0]
          && ['owner', 'manager'].includes(x.role));
        return { rows: p ? [p] : [] };
      }
      if (/FROM v3\.persons.*role IN/.test(s) && /slack_user_id = \$1/.test(s)) {
        const p = PERSONS.find((x) => x.slack_user_id === params[0]);
        if (p && ['owner', 'manager'].includes(p.role)) return { rows: [p] };
        return { rows: [] };
      }
      // activity_types
      if (/FROM v3\.activity_types WHERE slug = \$1/.test(s)) {
        const slugs = { lunch: 20, machine_downtime: 27, production_line: 5, cleaning: 10 };
        const id = slugs[params[0]];
        return { rows: id ? [{ id }] : [] };
      }
      // pending_commands INSERT
      if (/INSERT INTO v3\.pending_commands/.test(s)) {
        const [carolinaTs, adminTs, adminPersonId, adminSlack, cmdType, payloadJson, expiresAt] = params;
        pendings.push({
          id: pendingNextId++, carolina_msg_ts: carolinaTs, admin_msg_ts: adminTs,
          admin_person_id: adminPersonId, admin_slack_user_id: adminSlack,
          command_type: cmdType,
          command_payload: typeof payloadJson === 'string' ? JSON.parse(payloadJson) : payloadJson,
          expires_at: expiresAt, status: 'pending', created_at: new Date(),
        });
        return { rows: [] };
      }
      // pending_commands SELECT
      if (/SELECT \* FROM v3\.pending_commands WHERE carolina_msg_ts/.test(s)) {
        const found = pendings.find((c) => c.carolina_msg_ts === params[0] && c.status === 'pending');
        return { rows: found ? [found] : [] };
      }
      // pending_commands UPDATE status
      if (/UPDATE v3\.pending_commands/.test(s)) {
        // marcadores simples — atualiza pelo id em params[0]
        if (/SET status='expired'/.test(s) && /expires_at < NOW\(\)/.test(s)) {
          const expired = pendings.filter((c) => c.status === 'pending'
            && new Date(c.expires_at).getTime() < Date.now());
          for (const e of expired) e.status = 'expired';
          return { rows: expired.map((e) => ({ id: e.id, carolina_msg_ts: e.carolina_msg_ts })), rowCount: expired.length };
        }
        if (/SET status='cancelled'/.test(s)) {
          const found = pendings.find((c) => c.carolina_msg_ts === params[0]
            && c.status === 'pending' && c.admin_person_id === params[1]);
          if (found) { found.status = 'cancelled'; return { rows: [{ id: found.id }], rowCount: 1 }; }
          return { rows: [], rowCount: 0 };
        }
        if (/SET status='executed'/.test(s)) {
          const found = pendings.find((c) => c.id === params[0]);
          if (found) {
            found.status = 'executed';
            found.executed_at = new Date();
            found.result = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
          }
          return { rows: [] };
        }
        return { rows: [] };
      }
      // audit_log INSERT — simula o CHECK constraint audit_log_actor_type_check
      // (actor_type é literal no SQL). Pega regressão se voltar p/ 'admin_via_slack'.
      if (/INSERT INTO v3\.audit_log/.test(s)) {
        const ALLOWED_ACTOR = ['admin', 'llm_observer', 'llm_assistant', 'system', 'app_home'];
        const mActor = /VALUES \('([^']+)'/.exec(s);
        if (mActor && !ALLOWED_ACTOR.includes(mActor[1])) {
          return Promise.reject(new Error('new row for relation "audit_log" violates check constraint "audit_log_actor_type_check"'));
        }
        audit.push({ actor_type: mActor && mActor[1], action: params[0], target_id: params[1],
          metadata: typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2] });
        return { rows: [] };
      }
      // events SELECT (idempotência check) — simplificado
      if (/SELECT id FROM v3\.events WHERE person_id = \$1.*activity_type_id = \$2/.test(s)) {
        return { rows: [] };
      }
      if (/SELECT id, deleted_at FROM v3\.events WHERE id/.test(s)) {
        const ev = eventsFound.get(params[0]);
        return { rows: ev ? [ev] : [] };
      }
      if (/SELECT description FROM v3\.events WHERE id/.test(s)) {
        const ev = eventsFound.get(params[0]);
        return { rows: ev ? [{ description: ev.description }] : [] };
      }
      if (/SELECT id FROM v3\.events WHERE activity_type_id/.test(s)) {
        return { rows: [] }; // sem dup pra downtime
      }
      if (/FROM v3\.events.*ABS.*ABS/.test(s)) {
        // idempotência downtime
        return { rows: [] };
      }
      if (/FROM v3\.events e.*person_id.*production/.test(s)) {
        // auto-detect cowork (pessoas em produção no intervalo)
        return { rows: [{ person_id: 4, display_name: 'Vitor', role: 'operator' },
          { person_id: 6, display_name: 'Ana', role: 'operator' }] };
      }
      // ── cowork-join do admin (Bruno 07-10): _joinOpenCowork ──
      // âncora = trabalho ABERTO do colega. Sem opts.coworkAnchor → [] (cai no create normal).
      if (/FROM v3\.events e JOIN v3\.activity_types at.*person_id = ANY/.test(s)) {
        return { rows: opts.coworkAnchor ? [opts.coworkAnchor] : [] };
      }
      // fim da última task do joiner (pra preencher o buraco). Default null → começa no aviso.
      if (/SELECT MAX\(ended_at\) AS last_end FROM v3\.events/.test(s)) {
        return { rows: [{ last_end: opts.lastEnd || null }] };
      }
      if (/UPDATE v3\.events SET cowork_group_id = gen_random_uuid\(\)/.test(s)) {
        return { rows: [{ cowork_group_id: opts.newGid || 'gid-new' }] };
      }
      if (/SELECT id FROM v3\.events WHERE cowork_group_id = \$1 AND person_id = \$2/.test(s)) {
        return { rows: [] }; // joiner ainda não está no grupo
      }
      if (/SELECT DISTINCT person_id FROM v3\.events WHERE cowork_group_id/.test(s)) {
        return { rows: opts.coworkAnchor ? [{ person_id: opts.coworkAnchor.person_id }] : [] };
      }
      if (/INSERT INTO v3\.events .*cowork_group_id\) VALUES.*RETURNING id/.test(s)) {
        events.push({ id: opts.joinEventId || 2044, insertParams: params });
        return { rows: [{ id: opts.joinEventId || 2044 }] };
      }
      if (/UPDATE v3\.events SET cowork_with = array_append/.test(s)) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

function makeProvider(jsonOut) {
  return {
    classifyRaw: jest.fn(async () => ({ json_parsed: jsonOut, cost_estimate_usd: 0.001 })),
  };
}

function makeSlackMock() {
  const calls = { posts: [], reactions: [] };
  return {
    calls,
    // Espelha a assinatura REAL do sender.postAs: exige sender.name (objeto),
    // NÃO sender_name plano. Se alguém passar o shape errado, lança igual ao
    // real — assim o test pega o bug em vez de mascará-lo (drift mock↔realidade).
    postAs: jest.fn(async ({ channel, text, thread_ts, sender }) => {
      if (!sender || !sender.name) throw new Error('sender.name obrigatório');
      // Decisão Bruno (01/jun): reply SEMPRE top-level. Mock rejeita thread_ts
      // não-null pra pegar regressão se alguém voltar a responder em thread.
      if (thread_ts != null) throw new Error('reply deve ser top-level (thread_ts=null), recebeu: ' + thread_ts);
      const ts = 'reply.' + (calls.posts.length + 1);
      calls.posts.push({ channel, text, thread_ts, sender_name: sender.name, ts });
      return { ts };
    }),
    addReaction: jest.fn(async ({ channel, ts, emoji }) => {
      calls.reactions.push({ channel, ts, emoji });
    }),
  };
}

function makeEventService(opts = {}) {
  return {
    upsert: jest.fn(async (p) => ({ id: opts.upsertId || 1001, ...p })),
    correct: jest.fn(async (id, fields, byPerson, note, actor) => ({ id, ...fields })),
    softDelete: jest.fn(async (id, byPerson, reason, actor) => ({ id, deleted_at: new Date() })),
    markLongRunning: jest.fn(async (id, flag) => ({ id, is_long_running: flag })),
  };
}

function makeHandler(extra = {}) {
  const db = makeFakeDb(extra.dbOpts);
  const slack = makeSlackMock();
  const eventService = makeEventService(extra.eventServiceOpts);
  const provider = makeProvider(extra.llmJson || {});
  const h = new CommandHandler({
    db, provider, eventService,
    slack: { postAs: slack.postAs, addReaction: slack.addReaction },
    productionChannelId: 'C_PROD',
    adminChannelId: 'C_ADMIN',
    now: extra.now,
  });
  return { handler: h, db, slack, eventService, provider };
}

const msg = (over = {}) => Object.assign({
  id: 100, slack_ts: '1000.1', slack_channel_id: 'C_PROD',
  slack_user_id: 'U_BRUNO_CAMP',
  raw_text: '<@U0B3EQLPEPL> anota lunch da Simone às 13:01 PM',
}, over);

// ─── detecção ─────────────────────────────────────────────

describe('CommandHandler — detecção de mention', () => {
  test('hasMention pega <@U0B3EQLPEPL> + texto livre', () => {
    expect(CommandHandler.hasMention('<@U0B3EQLPEPL> oi')).toBe(true);
    expect(CommandHandler.hasMention('@Carolina apaga ev280')).toBe(true);
    expect(CommandHandler.hasMention('@carolina algo')).toBe(true);
    expect(CommandHandler.hasMention('S: linha de producao')).toBe(false);
    expect(CommandHandler.hasMention('')).toBe(false);
    expect(CommandHandler.hasMention(null)).toBe(false);
  });

  test('tryRoute sem mention → matched=false', async () => {
    const { handler } = makeHandler();
    const r = await handler.tryRoute(msg({ raw_text: 'S: linha de producao' }));
    expect(r.matched).toBe(false);
  });

  test('tryRoute canal errado → matched=false', async () => {
    const { handler } = makeHandler();
    const r = await handler.tryRoute(msg({ slack_channel_id: 'C_OUTRO' }));
    expect(r.matched).toBe(false);
  });

  test('tryRoute no admin-orin com mention + admin → matched=true (Frente 1)', async () => {
    const llmJson = { command_type: 'unknown', destructive: false, uncertain: false, explanation: '...' };
    const { handler } = makeHandler({ llmJson });
    const r = await handler.tryRoute(msg({ slack_channel_id: 'C_ADMIN' }));
    expect(r.matched).toBe(true);
  });

  test('tryRoute operador (Vitor) com mention → rejected + audit', async () => {
    const { handler, db } = makeHandler();
    const r = await handler.tryRoute(msg({ slack_user_id: 'U_VITOR' }));
    expect(r.matched).toBe(true);
    expect(r.handled).toBe(false);
    expect(r.reason).toBe('not_admin');
    expect(db.audit.some((a) => a.action === 'admin_command_rejected_not_admin')).toBe(true);
  });
});

// ─── não-destrutivo ───────────────────────────────────────

describe('CommandHandler — não-destrutivo (executa direto)', () => {
  test('create_event lunch da Simone → executa + reply + audit', async () => {
    const llmJson = {
      command_type: 'create_event',
      target: null,
      params: { person_id: 5, slug: 'lunch', started_at: '2026-05-31T17:01:00Z', ended_at: null,
        description: 'Almoço Simone retroativo' },
      destructive: false, uncertain: false,
      explanation: 'criar lunch da Simone 1:01 PM',
    };
    const { handler, db, slack, eventService } = makeHandler({ llmJson });
    const r = await handler.tryRoute(msg());
    expect(r.matched).toBe(true);
    expect(r.handled).toBe(true);
    expect(r.result).toBe('executed');
    expect(eventService.upsert).toHaveBeenCalledTimes(1);
    expect(slack.calls.reactions[0].emoji).toBe('white_check_mark');  // react ✓
    expect(slack.calls.posts[0].text).toMatch(/✅|Criado ev/);          // reply
    expect(db.audit.some((a) => a.action === 'admin_command_executed')).toBe(true);
  });

  test('Frente 1 — comando no admin-orin: react ✓ e reply vão pro admin-orin', async () => {
    const llmJson = {
      command_type: 'create_event', target: null,
      params: { person_id: 5, slug: 'lunch', started_at: '2026-05-31T17:01:00Z' },
      destructive: false, uncertain: false, explanation: 'criar lunch',
    };
    const { handler, slack } = makeHandler({ llmJson });
    await handler.tryRoute(msg({ slack_channel_id: 'C_ADMIN' }));
    expect(slack.calls.reactions[0].channel).toBe('C_ADMIN');  // ✓ no canal de origem
    expect(slack.calls.posts[0].channel).toBe('C_ADMIN');      // reply no canal de origem
  });

  test('Frente 1 — comando no produção: react ✓ e reply vão pro produção (regressão)', async () => {
    const llmJson = {
      command_type: 'create_event', target: null,
      params: { person_id: 5, slug: 'lunch', started_at: '2026-05-31T17:01:00Z' },
      destructive: false, uncertain: false, explanation: 'criar lunch',
    };
    const { handler, slack } = makeHandler({ llmJson });
    await handler.tryRoute(msg({ slack_channel_id: 'C_PROD' }));
    expect(slack.calls.reactions[0].channel).toBe('C_PROD');
    expect(slack.calls.posts[0].channel).toBe('C_PROD');
  });

  test('Frente 1 — reply usa sender.name=Carolina + audit grava com actor_type=admin', async () => {
    const llmJson = {
      command_type: 'create_event', target: null,
      params: { person_id: 5, slug: 'lunch', started_at: '2026-05-31T17:01:00Z' },
      destructive: false, uncertain: false, explanation: 'criar lunch',
    };
    const { handler, db, slack } = makeHandler({ llmJson });
    await handler.tryRoute(msg());
    // reply postado (mock só aceita sender.name — se _reply passar sender_name plano, lança)
    expect(slack.calls.posts.length).toBeGreaterThan(0);
    expect(slack.calls.posts[0].sender_name).toBe('Carolina');
    // audit gravado com actor_type permitido (FIX 3 — 'admin', não 'admin_via_slack')
    const exec = db.audit.find((a) => a.action === 'admin_command_executed');
    expect(exec).toBeTruthy();
    expect(exec.actor_type).toBe('admin');
  });

  test('Frente 1 — reply de query_status é TOP-LEVEL (thread_ts=null)', async () => {
    const llmJson = {
      command_type: 'query_status',
      params: { question: 'quem está na linha', scope: 'current_production' },
      destructive: false, uncertain: false,
    };
    const { handler, slack } = makeHandler({ llmJson });
    await handler.tryRoute(msg());
    expect(slack.calls.posts.length).toBeGreaterThan(0);
    expect(slack.calls.posts[0].thread_ts).toBeNull();
  });

  test('Frente 1 — reply de comando destrutivo (pending) é TOP-LEVEL (thread_ts=null)', async () => {
    const llmJson = {
      command_type: 'delete_event', target: { event_id: 999 },
      destructive: true, uncertain: false, explanation: 'soft-delete ev999',
    };
    const { handler, slack, db } = makeHandler({ llmJson });
    const r = await handler.tryRoute(msg({ raw_text: '@Carolina apaga ev999' }));
    expect(r.result).toBe('pending');
    expect(db.pendings).toHaveLength(1);
    expect(slack.calls.posts[0].thread_ts).toBeNull();  // pedido de confirmação top-level
  });

  test('create_downtime — auto-detect cowork via people em produção', async () => {
    const llmJson = {
      command_type: 'create_downtime',
      params: { started_at: '2026-05-29T20:18:00Z', ended_at: '2026-05-29T20:52:00Z' },
      destructive: false, uncertain: false,
      explanation: 'criar machine_downtime',
    };
    const { handler, eventService } = makeHandler({ llmJson });
    await handler.tryRoute(msg({ raw_text: '<@U0B3EQLPEPL> maquinario 4:18-4:52' }));
    expect(eventService.upsert).toHaveBeenCalledTimes(1);
    // primeiro op da linha (Vitor=4) virou person; outros (Ana=6) viraram cowork
    expect(eventService.upsert.mock.calls[0][0].person_id).toBe(4);
    expect(eventService.upsert.mock.calls[0][0].cowork_with).toEqual([6]);
  });

  test('set_workday_plan — admin avisa horário do dia extra → grava plano em settings', async () => {
    const llmJson = {
      command_type: 'set_workday_plan', target: null,
      params: { date: null, end_time: '18:00' },
      destructive: false, uncertain: false,
    };
    const { handler, db } = makeHandler({ llmJson });
    const r = await handler.tryRoute(msg({ raw_text: '<@U0B3EQLPEPL> hoje trabalham até 18h' }));
    expect(r.result).toBe('executed');
    const call = db.query.mock.calls.find(([sql, params]) => /INSERT INTO v3\.settings/.test(String(sql)) && params && params[0] === 'workday_plan');
    expect(call).toBeTruthy();
    expect(JSON.parse(call[1][1]).end).toBe('18:00');
  });

  test('query_status — read-only, sem write, sem react ✓', async () => {
    // Ainda reage ✓ no admin msg (acknowledgment); só não cria event.
    const llmJson = {
      command_type: 'query_status',
      params: { question: 'como tá o Potassium', scope: 'current_production' },
      destructive: false, uncertain: false,
    };
    const { handler, eventService, slack } = makeHandler({ llmJson });
    const r = await handler.tryRoute(msg({ raw_text: '@Carolina como tá o Potassium?' }));
    expect(r.result).toBe('executed');
    expect(eventService.upsert).not.toHaveBeenCalled();
    expect(slack.calls.posts.length).toBeGreaterThan(0);  // posta resposta
  });
});

// ─── cowork join + start "agora" (Bruno 07-10) ────────────

describe('CommandHandler — cowork join + start "agora" (Bruno 07-10)', () => {
  test('"X na limpeza junto com Y" → ENTRA no trabalho aberto do Y (join), sem evento solto', async () => {
    const llmJson = {
      command_type: 'create_event', target: null,
      params: { person_id: 4, slug: 'cleaning', cowork_with: [7], started_at: null,
        description: 'Vitor entrou na limpeza com Bruno Sarmento (cowork)' },
      destructive: false, uncertain: false,
    };
    const anchor = { id: 2038, person_id: 7, activity_type_id: 10, product_batch_id: null, cowork_group_id: null };
    const { handler, db, eventService } = makeHandler({
      llmJson, dbOpts: { coworkAnchor: anchor, joinEventId: 2044 },
    });
    await handler.tryRoute(msg({ raw_text: '<@U0B3EQLPEPL> Vitor está na limpeza junto com Bruno Sarmento' }));
    // NÃO cria evento solto via upsert — junta no grupo do Bruno
    expect(eventService.upsert).not.toHaveBeenCalled();
    const insertCall = db.query.mock.calls.find(([sql]) =>
      /INSERT INTO v3\.events .*cowork_group_id\) VALUES.*RETURNING id/.test(String(sql).replace(/\s+/g, ' ')));
    expect(insertCall).toBeTruthy();
    const params = insertCall[1]; // [joinerId, activity_type_id, product_batch_id, startIso, others, gid]
    expect(params[0]).toBe(4);            // Vitor entra
    expect(params[1]).toBe(10);           // cleaning (herda do âncora do Bruno)
    expect(params[4]).toEqual([7]);       // cowork_with = Bruno Sarmento
    expect(params[3]).toBe(new Date(1000.1 * 1000).toISOString()); // start = hora da msg, NÃO 9am
  });

  test('aviso TARDE → preenche o buraco: start = fim da última task do joiner (não a hora do aviso)', async () => {
    const llmJson = {
      command_type: 'create_event', target: null,
      params: { person_id: 4, slug: 'cleaning', cowork_with: [7], started_at: null },
      destructive: false, uncertain: false,
    };
    // Bruno (âncora) limpando desde 16:10; Vitor terminou a última task 17:01:45.
    const anchor = { id: 2038, person_id: 7, activity_type_id: 10, product_batch_id: null,
      cowork_group_id: null, started_at: '2026-07-10T20:10:31Z' };
    const { handler, db, eventService } = makeHandler({
      llmJson, dbOpts: { coworkAnchor: anchor, joinEventId: 2044, lastEnd: '2026-07-10T21:01:45Z' },
    });
    // aviso às 18:17 (slack_ts) — mas o Vitor entrou quando ficou livre (17:01:45)
    await handler.tryRoute(msg({ slack_ts: (Date.parse('2026-07-10T22:17:38Z') / 1000).toString(),
      raw_text: '<@U0B3EQLPEPL> Vitor está na limpeza junto com Bruno Sarmento' }));
    expect(eventService.upsert).not.toHaveBeenCalled();
    const insertCall = db.query.mock.calls.find(([sql]) =>
      /INSERT INTO v3\.events .*cowork_group_id\) VALUES.*RETURNING id/.test(String(sql).replace(/\s+/g, ' ')));
    // start = fim da última task do Vitor (preenche o buraco), NÃO a hora do aviso
    expect(insertCall[1][3]).toBe('2026-07-10T21:01:45.000Z');
  });

  test('colega SEM trabalho aberto → cai no create normal (não trava), começando agora', async () => {
    const llmJson = {
      command_type: 'create_event', target: null,
      params: { person_id: 4, slug: 'cleaning', cowork_with: [7], started_at: null },
      destructive: false, uncertain: false,
    };
    const { handler, eventService } = makeHandler({ llmJson }); // sem coworkAnchor → âncora vazio
    await handler.tryRoute(msg({ raw_text: '<@U0B3EQLPEPL> Vitor está na limpeza junto com Bruno Sarmento' }));
    expect(eventService.upsert).toHaveBeenCalledTimes(1);
    expect(eventService.upsert.mock.calls[0][0].started_at).toBe(new Date(1000.1 * 1000).toISOString());
  });

  test('sem horário na msg → started_at = hora da msg, NÃO o chute da LLM (9am fantasma)', async () => {
    const llmJson = {
      command_type: 'create_event', target: null,
      params: { person_id: 4, slug: 'production_line', started_at: '2026-07-10T13:00:00Z' }, // 9am chutado
      destructive: false, uncertain: false,
    };
    const { handler, eventService } = makeHandler({ llmJson });
    await handler.tryRoute(msg({ raw_text: '<@U0B3EQLPEPL> Vitor entrou na linha de produção' })); // SEM hora
    expect(eventService.upsert).toHaveBeenCalledTimes(1);
    const started = eventService.upsert.mock.calls[0][0].started_at;
    expect(started).toBe(new Date(1000.1 * 1000).toISOString()); // hora da msg
    expect(started).not.toBe('2026-07-10T13:00:00Z');            // ignorou o chute
  });

  test('COM horário explícito na msg → respeita o started_at da LLM (retroativo real)', async () => {
    const llmJson = {
      command_type: 'create_event', target: null,
      params: { person_id: 5, slug: 'lunch', started_at: '2026-05-31T17:01:00Z' },
      destructive: false, uncertain: false,
    };
    const { handler, eventService } = makeHandler({ llmJson });
    await handler.tryRoute(msg({ raw_text: '<@U0B3EQLPEPL> anota lunch da Simone às 1:01pm' }));
    expect(eventService.upsert.mock.calls[0][0].started_at).toBe('2026-05-31T17:01:00Z');
  });
});

// ─── destrutivo (pending) ─────────────────────────────────

describe('CommandHandler — destrutivo (pending até ✅)', () => {
  test('delete_event → pending_commands criado + reply pede ✅', async () => {
    const llmJson = {
      command_type: 'delete_event', target: { event_id: 999 },
      params: { reason: 'admin Slack' },
      destructive: true, uncertain: false,
      explanation: 'soft-delete ev999',
    };
    const { handler, db, slack, eventService } = makeHandler({ llmJson });
    const r = await handler.tryRoute(msg({ raw_text: '@Carolina apaga ev999' }));
    expect(r.result).toBe('pending');
    expect(db.pendings).toHaveLength(1);
    expect(db.pendings[0].command_type).toBe('delete_event');
    expect(slack.calls.posts[0].text).toMatch(/Reaja ✅/);
    expect(eventService.softDelete).not.toHaveBeenCalled();  // ainda não
  });

  test('confirmAndExecute pelo MESMO admin → executa softDelete', async () => {
    const llmJson = {
      command_type: 'delete_event', target: { event_id: 999 },
      destructive: true, uncertain: false, explanation: 'soft-delete ev999',
    };
    const { handler, db, eventService } = makeHandler({ llmJson });
    await handler.tryRoute(msg());          // cria pending
    const pending = db.pendings[0];
    const r = await handler.confirmAndExecute({
      carolinaMsgTs: pending.carolina_msg_ts,
      reactorSlackUserId: 'U_BRUNO_CAMP',
      reactorPersonId: 1,    // mesmo admin
    });
    expect(r.result).toBe('executed');
    expect(eventService.softDelete).toHaveBeenCalledTimes(1);
    expect(eventService.softDelete.mock.calls[0][0]).toBe(999);
    expect(pending.status).toBe('executed');
  });

  test('confirmAndExecute por OUTRO admin → rejeitado', async () => {
    const llmJson = {
      command_type: 'delete_event', target: { event_id: 999 },
      destructive: true, uncertain: false, explanation: 'soft-delete',
    };
    const { handler, db, eventService } = makeHandler({ llmJson });
    await handler.tryRoute(msg());
    const pending = db.pendings[0];
    const r = await handler.confirmAndExecute({
      carolinaMsgTs: pending.carolina_msg_ts,
      reactorSlackUserId: 'U_THASSIO',
      reactorPersonId: 2,    // OUTRO admin
    });
    expect(r.handled).toBe(false);
    expect(r.reason).toBe('wrong_admin');
    expect(eventService.softDelete).not.toHaveBeenCalled();
    expect(pending.status).toBe('pending');     // ainda pendente
  });
});

// ─── expiração TTL ────────────────────────────────────────

describe('CommandHandler — expiração TTL', () => {
  test('expireOldPending marca status=expired pra pending com expires_at < now', async () => {
    const fakeNow = new Date('2026-05-31T15:00:00Z');
    const { handler, db, slack } = makeHandler({
      now: () => fakeNow,
      llmJson: { command_type: 'delete_event', target: { event_id: 999 },
        destructive: true, uncertain: false, explanation: '...' },
    });
    await handler.tryRoute(msg());
    expect(db.pendings[0].status).toBe('pending');
    expect(db.pendings[0].expires_at).toBeInstanceOf(Date);
    // simula passagem de 15min — manualmente seta expires_at no passado
    db.pendings[0].expires_at = new Date(fakeNow.getTime() - 60 * 1000);
    const n = await handler.expireOldPending();
    expect(n).toBe(1);
    expect(db.pendings[0].status).toBe('expired');
    expect(slack.calls.posts.some((p) => /expirou/.test(p.text))).toBe(true);
  });

  test('confirmAndExecute em comando expirado → rejeitado', async () => {
    const fakeNow = new Date('2026-05-31T15:00:00Z');
    const { handler, db, eventService } = makeHandler({
      now: () => fakeNow,
      llmJson: { command_type: 'delete_event', target: { event_id: 999 },
        destructive: true, uncertain: false, explanation: '...' },
    });
    await handler.tryRoute(msg());
    // expira manualmente
    db.pendings[0].expires_at = new Date(fakeNow.getTime() - 60 * 1000);
    const r = await handler.confirmAndExecute({
      carolinaMsgTs: db.pendings[0].carolina_msg_ts,
      reactorSlackUserId: 'U_BRUNO_CAMP', reactorPersonId: 1,
    });
    expect(r.handled).toBe(false);
    expect(r.reason).toBe('expired');
    expect(eventService.softDelete).not.toHaveBeenCalled();
  });
});

// ─── uncertain ────────────────────────────────────────────

describe('CommandHandler — uncertain pede confirmação', () => {
  test('llm uncertain=true em comando não-destrutivo → pending (não executa direto)', async () => {
    const llmJson = {
      command_type: 'create_event',
      params: { person_id: 5, slug: 'lunch', started_at: '2026-05-31T17:00:00Z' },
      destructive: false, uncertain: true,
      explanation: 'criar lunch (mas LLM não tem certeza sobre o horário exato)',
    };
    const { handler, db, eventService } = makeHandler({ llmJson });
    const r = await handler.tryRoute(msg());
    expect(r.result).toBe('pending');
    expect(eventService.upsert).not.toHaveBeenCalled();
    expect(db.pendings).toHaveLength(1);
  });
});

// ─── unknown ──────────────────────────────────────────────

describe('CommandHandler — unknown', () => {
  test('command_type=unknown → reply educativo, sem write, sem pending', async () => {
    const llmJson = {
      command_type: 'unknown',
      destructive: false, uncertain: false,
      explanation: 'não entendi',
    };
    const { handler, db, eventService, slack } = makeHandler({ llmJson });
    const r = await handler.tryRoute(msg({ raw_text: '@Carolina lalalala?' }));
    expect(r.result).toBe('unknown');
    expect(eventService.upsert).not.toHaveBeenCalled();
    expect(db.pendings).toHaveLength(0);
    expect(slack.calls.posts[0].text).toMatch(/Não entendi/);
  });
});
