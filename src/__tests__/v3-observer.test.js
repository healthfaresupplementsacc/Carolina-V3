'use strict';
// HEALTHFARE V3 — PARTE 2.8 — testes comportamentais do Observer (SHADOW).
const { Observer } = require('../v3/llm/Observer');
const MockProvider = require('../v3/llm/providers/MockProvider');

/** Fake DB — v3.messages + IDs de validação + vocab + audit + settings + legado. */
function makeFakeDb(o = {}) {
  const messages = o.messages || [];
  const persons = o.persons || [1, 6];
  const products = o.products || [5];
  const activityTypes = o.activityTypes || [10, 20];
  const broadcastTs = new Set(o.broadcastTs || []);
  const recentUser = o.recentUser || [];
  const window = o.window || null;
  const audit = [];
  const vocab = new Map();
  const find = (id) => messages.find((m) => m.id === id);

  return {
    messages, audit, vocab,
    query: jest.fn((sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^UPDATE v3\.messages SET llm_processed_at = NOW\(\), llm_result = \$2::jsonb, llm_provider_used = \$3/.test(s)) {
        const m = find(params[0]);
        if (m) { m.llm_processed_at = new Date(); m.llm_result = params[1]; m.llm_provider_used = params[2]; m.events_created = params[3]; m.events_updated = params[4]; m.processing_error = null; }
        return Promise.resolve({ rows: [] });
      }
      if (/^UPDATE v3\.messages SET llm_processed_at = NOW\(\), llm_result = \$2::jsonb, llm_provider_used = 'pre-filter'/.test(s)) {
        if (/id = ANY/.test(s)) {
          for (const id of params[0]) { const m = find(id); if (m && !m.llm_processed_at) { m.llm_processed_at = new Date(); m.llm_result = params[1]; } }
        } else {
          const m = find(params[0]);
          if (m) { m.llm_processed_at = new Date(); m.llm_result = params[1]; m.llm_provider_used = 'pre-filter'; }
        }
        return Promise.resolve({ rows: [] });
      }
      if (/^UPDATE v3\.messages SET processing_error/.test(s)) {
        const m = find(params[0]); if (m) m.processing_error = params[1];
        return Promise.resolve({ rows: [] });
      }
      if (/^INSERT INTO v3\.audit_log/.test(s)) { audit.push({ actor_type: 'llm_observer', action: params[0], target_id: params[1] }); return Promise.resolve({ rows: [] }); }
      if (/^INSERT INTO v3\.vocabulary/.test(s)) { vocab.set(params[0], (vocab.get(params[0]) || 0) + 1); return Promise.resolve({ rows: [] }); }
      if (/SELECT id FROM v3\.persons/.test(s)) return Promise.resolve({ rows: persons.map((id) => ({ id })) });
      if (/SELECT id FROM v3\.products/.test(s)) return Promise.resolve({ rows: products.map((id) => ({ id })) });
      if (/SELECT id FROM v3\.activity_types/.test(s)) return Promise.resolve({ rows: activityTypes.map((id) => ({ id })) });
      if (/FROM public\.admin_audit_log/.test(s)) return Promise.resolve({ rows: broadcastTs.has(params[0]) ? [{ x: 1 }] : [] });
      if (/SELECT id, slack_ts AS ts, slack_user_id, raw_text AS text FROM v3\.messages/.test(s)) return Promise.resolve({ rows: recentUser });
      if (/FROM v3\.settings WHERE key = 'operational_window'/.test(s)) return Promise.resolve({ rows: window ? [{ value: window }] : [] });
      // FIX A — claim no DB: UPDATE...RETURNING marca claimed_at e devolve só
      // o que reivindicou. Elegível: não-processada E (nunca reivindicada OU
      // claim expirado há >2min). Mutação síncrona = ticks sobrepostos não
      // pegam a mesma row.
      if (/^UPDATE v3\.messages SET claimed_at = NOW\(\)/.test(s)) {
        const nowMs = Date.now();
        const TWO_MIN = 2 * 60 * 1000;
        const elig = messages.filter((m) => !m.llm_processed_at
          && (!m.claimed_at || (nowMs - new Date(m.claimed_at).getTime()) > TWO_MIN));
        elig.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        const claimed = elig.slice(0, params[0] || 10); // LIMIT $1 = concurrency
        for (const m of claimed) m.claimed_at = new Date();
        return Promise.resolve({ rows: claimed });
      }
      return Promise.resolve({ rows: [] });
    }),
  };
}

let _eid = 0;
function mkServices(o = {}) {
  const provider = new MockProvider();
  if (o.llmResult) provider.setResult(o.llmResult);
  if (o.llmError) provider.setError(o.llmError);
  if (o.llmDelayMs) provider.setDelay(o.llmDelayMs);
  return {
    provider,
    personResolver: { resolve: jest.fn().mockResolvedValue(o.author || { person_id: 6, resolution_method: 'direct', confidence: 'high' }) },
    promptBuilder: { buildContext: jest.fn().mockResolvedValue({ systemPrompt: 's', userContent: 'u' }) },
    eventService: {
      upsert: jest.fn(async () => ({ id: ++_eid })),
      closeActivePersonEvent: jest.fn().mockResolvedValue([{ id: 999 }]),
      safetyAutoClose: jest.fn().mockResolvedValue([]),
    },
    batchService: { findOrCreateActive: jest.fn().mockResolvedValue({ id: 7 }) },
    productionCountService: { record: jest.fn().mockResolvedValue({ id: 9 }) },
    goalService: { record: jest.fn().mockResolvedValue({ id: 1 }) },
    slack: { addReaction: jest.fn(), postMessage: jest.fn(), sendDM: jest.fn() },
  };
}

/** Cria observer com a(s) mensagem(ns) já semeada(s) no db. */
function makeObserver(o = {}) {
  const dbOpts = Object.assign({}, o.dbOpts);
  const seed = o.messages || (o.message ? [o.message] : []);
  dbOpts.messages = [...seed, ...(dbOpts.messages || [])];
  const db = makeFakeDb(dbOpts);
  const svc = mkServices(o);
  const observer = new Observer(Object.assign({
    db, botUserId: 'U_BOT', mode: o.mode || 'shadow', now: o.now,
    concurrency: o.concurrency,
  }, svc));
  return Object.assign({ observer, db }, svc);
}

const msg = (over = {}) => Object.assign({
  id: 1, slack_ts: '100.1', slack_channel_id: 'C_PROD', slack_user_id: 'U_ANA',
  raw_text: 'comecei a formulação do plant', created_at: '2026-05-20T14:00:00.000Z',
}, over);

const OPEN = { actions: [{ type: 'open_event', person_id: 6, activity_type_id: 10, confidence: 'high' }], categorization: 'activity_start', confidence: 'high' };

describe('V3 §2.8 — pipeline normal', () => {
  test('mensagem normal → event criado', async () => {
    const m = msg();
    const { observer, eventService, db } = makeObserver({ llmResult: OPEN, message: m });
    const r = await observer.processMessage(m);
    expect(r.ok).toBe(true);
    expect(eventService.upsert).toHaveBeenCalledTimes(1);
    expect(m.llm_processed_at).toBeTruthy();
    expect(db.audit.some((a) => a.action === 'observer.processed')).toBe(true);
  });

  test('upsert recebe source_message_ts (idempotência via EventService)', async () => {
    const m = msg({ slack_ts: 'ABC.1' });
    const { observer, eventService } = makeObserver({ llmResult: OPEN, message: m });
    await observer.processMessage(m);
    expect(eventService.upsert.mock.calls[0][0].source_message_ts).toBe('ABC.1');
  });

  test('persiste com a confidence REAL do LLM (não força unconfirmed)', async () => {
    const m = msg();
    const { observer, eventService } = makeObserver({
      message: m,
      llmResult: { actions: [{ type: 'open_event', person_id: 6, activity_type_id: 10, confidence: 'low' }], confidence: 'low' },
    });
    await observer.processMessage(m);
    expect(eventService.upsert.mock.calls[0][0].confidence).toBe('low');
  });

  test('audit actor_type=llm_observer', async () => {
    const m = msg();
    const { observer, db } = makeObserver({ llmResult: OPEN, message: m });
    await observer.processMessage(m);
    expect(db.audit.length).toBeGreaterThan(0);
    expect(db.audit.every((a) => a.actor_type === 'llm_observer')).toBe(true);
  });
});

describe('V3 §2.8 — pre-filter routing', () => {
  test('bot_self (notificação automática) → skipped, sem event', async () => {
    const m = msg({ slack_user_id: 'U_BOT' });
    const { observer, eventService } = makeObserver({ llmResult: OPEN, message: m });
    const r = await observer.processMessage(m);
    expect(r.category).toBe('bot_self');
    expect(eventService.upsert).not.toHaveBeenCalled();
    expect(m.llm_provider_used).toBe('pre-filter');
  });

  test('bot_self com broadcast no admin_audit_log legado → admin_broadcast contexto', async () => {
    const m = msg({ slack_user_id: 'U_BOT', slack_ts: 'BC.1' });
    const { observer, eventService } = makeObserver({ llmResult: OPEN, message: m, dbOpts: { broadcastTs: ['BC.1'] } });
    const r = await observer.processMessage(m);
    expect(r.category).toBe('admin_broadcast');
    expect(eventService.upsert).not.toHaveBeenCalled();
    expect(JSON.parse(m.llm_result).category).toBe('admin_broadcast');
  });

  test('small_talk → skipped, sem event', async () => {
    const m = msg({ raw_text: 'ok' });
    const { observer, eventService } = makeObserver({ llmResult: OPEN, message: m });
    const r = await observer.processMessage(m);
    expect(r.category).toBe('small_talk');
    expect(eventService.upsert).not.toHaveBeenCalled();
  });

  test('burst → 1 chamada de LLM p/ as N msgs coalescidas', async () => {
    const recent = [
      { id: 2, ts: '100.1', slack_user_id: 'U_ANA', text: 'comecei a linha agora' },
      { id: 3, ts: '100.3', slack_user_id: 'U_ANA', text: 'parei pra mexer no mix' },
      { id: 4, ts: '100.5', slack_user_id: 'U_ANA', text: 'voltei pra linha de novo' },
      { id: 5, ts: '100.7', slack_user_id: 'U_ANA', text: 'mais um lote saindo' },
    ];
    const m = msg({ id: 1, slack_ts: '100.9', raw_text: 'terminei o lote enfim' });
    const others = recent.map((r) => ({ id: r.id }));
    const { observer, provider, db } = makeObserver({
      llmResult: OPEN, messages: [m, ...others], dbOpts: { recentUser: recent },
    });
    await observer.processMessage(m);
    expect(provider.calls).toHaveLength(1);
    expect(db.messages.find((x) => x.id === 2).llm_processed_at).toBeTruthy();
  });
});

describe('V3 §2.8 — admin_intervention', () => {
  test('autor admin → passa pelo LLM mas NÃO cria event', async () => {
    const m = msg();
    const { observer, eventService } = makeObserver({
      llmResult: OPEN, message: m,
      author: { person_id: 1, resolution_method: 'admin_intervention', confidence: 'high', is_admin_context: true },
    });
    const r = await observer.processMessage(m);
    expect(r.admin_context).toBe(true);
    expect(eventService.upsert).not.toHaveBeenCalled();
  });
});

describe('V3 §2.8 — janela operacional', () => {
  test('fora-de-hora processa e marca is_off_hours', async () => {
    const m = msg();
    const { observer } = makeObserver({
      llmResult: OPEN, message: m,
      dbOpts: { window: { start_hour: 8, end_hour: 19, weekdays: [1, 2, 3, 4, 5] } },
      now: () => new Date('2026-05-20T06:00:00.000Z'), // 02:00 ET — fora
    });
    const r = await observer.processMessage(m);
    expect(r.ok).toBe(true);
    expect(r.is_off_hours).toBe(true);
  });
});

describe('V3 §2.8 — validação da resposta do LLM', () => {
  test('person_id inexistente → processing_error, llm_processed_at NULL, retryable', async () => {
    const m = msg();
    const { observer } = makeObserver({
      message: m,
      llmResult: { actions: [{ type: 'open_event', person_id: 999, activity_type_id: 10 }], confidence: 'high' },
    });
    const r = await observer.processMessage(m);
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('validation');
    expect(r.retryable).toBe(true);
    expect(m.processing_error).toMatch(/person_id 999/);
    expect(m.llm_processed_at).toBeFalsy();
  });

  test('actions não-array → invalid_llm_response', async () => {
    const m = msg();
    const { observer } = makeObserver({ message: m });
    observer.provider = { classify: jest.fn().mockResolvedValue({ actions: 'nope' }) };
    const r = await observer.processMessage(m);
    expect(r.ok).toBe(false);
    expect(m.processing_error).toMatch(/invalid_llm_response/);
  });

  test('LLM lança (rate limit) → markError + retryable; llm_processed_at NULL → re-claim', async () => {
    const m = msg();
    const { observer } = makeObserver({ llmError: new Error('anthropic 529 overloaded'), message: m });
    const r = await observer.processMessage(m);
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('llm');
    expect(r.retryable).toBe(true);
    expect(m.processing_error).toMatch(/overloaded/);
    // llm_processed_at NULL → o claim expira em 2min e o worker re-tenta
    // (FIX A substituiu o backoff in-memory pela expiração do claim).
    expect(m.llm_processed_at).toBeFalsy();
  });
});

describe('V3 FIX A — claim no DB contra dupla-processamento', () => {
  test('ticks NÃO se sobrepõem — tick durante outro em andamento é no-op', async () => {
    const messages = [1, 2, 3].map((id) => msg({ id, slack_ts: 't.' + id }));
    // LLM lento: o 2º tick é disparado enquanto o 1º ainda processa.
    const { observer, provider } = makeObserver({ llmResult: OPEN, messages, llmDelayMs: 20, concurrency: 3 });
    const [r1, r2] = await Promise.all([observer.tick(), observer.tick()]);
    const ran = r1.length ? r1 : r2;       // um rodou o lote
    const skipped = r1.length ? r2 : r1;   // o outro caiu no guard _ticking
    expect(ran).toHaveLength(3);
    expect(skipped).toHaveLength(0);
    expect(provider.calls).toHaveLength(3); // zero duplicata
  });

  test('drenar a fila com ticks repetidos → cada mensagem classifica 1x', async () => {
    const messages = [1, 2, 3, 4, 5].map((id) => msg({ id, slack_ts: 't.' + id }));
    const { observer, provider, db } = makeObserver({ llmResult: OPEN, messages, concurrency: 2 });
    while (db.messages.some((m) => !m.llm_processed_at)) await observer.tick();
    expect(provider.calls).toHaveLength(5);
    expect(db.messages.every((m) => m.llm_processed_at && m.claimed_at)).toBe(true);
  });

  test('claim de no máximo `concurrency` mensagens por tick', async () => {
    const messages = [1, 2, 3, 4, 5].map((id) => msg({ id, slack_ts: 'c.' + id }));
    const { observer, db } = makeObserver({ llmResult: OPEN, messages, concurrency: 2 });
    const r = await observer.tick();
    expect(r).toHaveLength(2); // só `concurrency`, não as 5
    expect(db.messages.filter((m) => m.llm_processed_at)).toHaveLength(2);
  });

  test('mensagem com claim recente NÃO é re-reivindicada por outro tick', async () => {
    const m = msg({ id: 1, slack_ts: 'r.1', claimed_at: new Date() });
    const { observer, provider } = makeObserver({ llmResult: OPEN, messages: [m] });
    await observer.tick();
    expect(provider.calls).toHaveLength(0); // claim fresco → fora do lote
  });

  test('claim expirado (>2min) é re-reivindicado', async () => {
    const old = new Date(Date.now() - 3 * 60 * 1000); // 3min atrás
    const m = msg({ id: 1, slack_ts: 'e.1', claimed_at: old });
    const { observer, provider } = makeObserver({ llmResult: OPEN, messages: [m] });
    await observer.tick();
    expect(provider.calls).toHaveLength(1); // claim expirou → re-processa
  });
});

describe('V3 §2.8 — SHADOW MODE (zero efeito visível)', () => {
  test('shadow: nenhuma reaction, post ou DM no Slack', async () => {
    const m = msg();
    const { observer, slack } = makeObserver({
      message: m, llmResult: Object.assign({ react_emoji: 'white_check_mark' }, OPEN),
    });
    await observer.processMessage(m);
    expect(slack.addReaction).toHaveBeenCalledTimes(0);
    expect(slack.postMessage).toHaveBeenCalledTimes(0);
    expect(slack.sendDM).toHaveBeenCalledTimes(0);
  });

  test('mode=active: a reaction acontece (mesmo pipeline, pós-persist)', async () => {
    const m = msg();
    const { observer, slack } = makeObserver({
      message: m, mode: 'active', llmResult: Object.assign({ react_emoji: 'white_check_mark' }, OPEN),
    });
    await observer.processMessage(m);
    expect(slack.addReaction).toHaveBeenCalledWith('100.1', 'white_check_mark');
  });
});

describe('V3 §2.8 — contagens e vocabulário', () => {
  test('eod_count → ProductionCountService.record', async () => {
    const m = msg();
    const { observer, productionCountService } = makeObserver({
      message: m,
      llmResult: { actions: [{ type: 'eod_count', person_id: 6, product_id: 5, bottles: 684, confidence: 'high' }], confidence: 'high' },
    });
    await observer.processMessage(m);
    expect(productionCountService.record).toHaveBeenCalledTimes(1);
    expect(productionCountService.record.mock.calls[0][0].bottles).toBe(684);
  });

  test('partial_count → record com notes de parcial', async () => {
    const m = msg();
    const { observer, productionCountService } = makeObserver({
      message: m,
      llmResult: { actions: [{ type: 'partial_count', person_id: 6, product_id: 5, bottles: 300 }], confidence: 'medium' },
    });
    await observer.processMessage(m);
    expect(productionCountService.record.mock.calls[0][0].notes).toMatch(/partial/);
  });

  test('new_vocabulary_terms → upsert em v3.vocabulary', async () => {
    const m = msg();
    const { observer, db } = makeObserver({
      message: m, llmResult: Object.assign({ new_vocabulary_terms: ['fita'] }, OPEN),
    });
    await observer.processMessage(m);
    expect(db.vocab.get('fita')).toBe(1);
  });

  test('termo repetido → occurrence_count incrementa', async () => {
    const m1 = msg({ id: 1, slack_ts: 'x.1' });
    const m2 = msg({ id: 2, slack_ts: 'x.2' });
    const { observer, db } = makeObserver({
      messages: [m1, m2], llmResult: Object.assign({ new_vocabulary_terms: ['fita'] }, OPEN),
    });
    await observer.processMessage(m1);
    await observer.processMessage(m2);
    expect(db.vocab.get('fita')).toBe(2);
  });
});

describe('V3 Bloco 2 — set_goal (meta)', () => {
  test('action set_goal → goalService.record chamado (source channel)', async () => {
    const m = msg();
    const { observer, goalService } = makeObserver({
      message: m,
      llmResult: { categorization: 'goal_set', confidence: 'high', actions: [
        { type: 'set_goal', person_id: 6, product_id: 5, batch_number: 'BR-2026-0135', expected_quantity: 750 }] },
    });
    await observer.processMessage(m);
    expect(goalService.record).toHaveBeenCalledTimes(1);
    expect(goalService.record.mock.calls[0][0]).toMatchObject({
      product_id: 5, batch_number: 'BR-2026-0135', expected_quantity: 750, source: 'channel',
    });
  });

  test('set_goal vale mesmo com autor ADMIN — mas sem event de trabalho', async () => {
    const m = msg();
    const { observer, goalService, eventService } = makeObserver({
      message: m,
      author: { person_id: 1, resolution_method: 'admin_intervention', confidence: 'high', is_admin_context: true },
      llmResult: { categorization: 'goal_set', confidence: 'high', actions: [
        { type: 'set_goal', person_id: 1, product_id: 5, expected_quantity: 500 }] },
    });
    await observer.processMessage(m);
    expect(goalService.record).toHaveBeenCalledTimes(1);   // meta gravada
    expect(eventService.upsert).not.toHaveBeenCalled();     // admin não cria event
  });
});

describe('V3 §2.8 — worker loop', () => {
  test('ticks repetidos processam todas as não-processadas', async () => {
    const messages = [1, 2, 3, 4, 5].map((id) => msg({ id, slack_ts: 't.' + id }));
    const { observer, db } = makeObserver({ llmResult: OPEN, messages, concurrency: 2 });
    while (db.messages.some((m) => !m.llm_processed_at)) await observer.tick();
    expect(db.messages.every((m) => m.llm_processed_at)).toBe(true);
  });
});

describe('V3 §2.8 — Captura Aprimorada (Parte A)', () => {
  test('A2 — duas pessoas numa mensagem geram DOIS events (Vitor/linha + Ana/revisão)', async () => {
    // O caso real do dia 22: "Vitor assumindo a linha e a Ana indo para a
    // revisão". O LLM deve produzir 2 actions, uma por pessoa. O Observer
    // persiste as duas — cada upsert tem o person_id correto.
    const m = msg({ slack_ts: '99.1', raw_text: 'Vitor - assumindo a linha de producao e a Ana indo para a revisao' });
    const { observer, eventService } = makeObserver({
      message: m,
      // ativo: as 2 actions corretas que o LLM deveria emitir
      llmResult: {
        categorization: 'activity_start', confidence: 'high',
        actions: [
          { type: 'open_event', person_id: 4, activity_type_id: 10, confidence: 'high' }, // Vitor → linha
          { type: 'open_event', person_id: 6, activity_type_id: 20, confidence: 'high' }, // Ana → review
        ],
      },
      dbOpts: { persons: [4, 6], activityTypes: [10, 20] },
    });
    await observer.processMessage(m);
    expect(eventService.upsert).toHaveBeenCalledTimes(2);
    const calls = eventService.upsert.mock.calls.map((c) => c[0]);
    expect(calls.find((x) => x.person_id === 4)).toMatchObject({ person_id: 4, activity_type_id: 10 });
    expect(calls.find((x) => x.person_id === 6)).toMatchObject({ person_id: 6, activity_type_id: 20 });
  });

  test('A2 — open_event repassa quantity / quantity_unit ("142 ordens")', async () => {
    const m = msg({ slack_ts: '99.2', raw_text: 'S: impressao das ordens - 142' });
    const { observer, eventService } = makeObserver({
      message: m,
      llmResult: {
        categorization: 'activity_start', confidence: 'high',
        actions: [{
          type: 'open_event', person_id: 6, activity_type_id: 10,
          quantity: 142, quantity_unit: 'order', confidence: 'high',
        }],
      },
    });
    await observer.processMessage(m);
    expect(eventService.upsert.mock.calls[0][0]).toMatchObject({ quantity: 142, quantity_unit: 'order' });
  });

  test('A1 — close_event com activity_type_id é forwarded pro closeActivePersonEvent', async () => {
    // "F: encapsulação" — close nomeado fecha SÓ o event daquele tipo.
    // Quando activity_type_id é dado, kind=any (filtro forte é o type)
    // — antes era 'foreground', mas isso pulava events background.
    const m = msg({ slack_ts: '99.3', raw_text: 'F: encapsulação' });
    const { observer, eventService } = makeObserver({
      message: m,
      llmResult: {
        categorization: 'activity_end', confidence: 'high',
        actions: [{ type: 'close_event', person_id: 6, activity_type_id: 10, confidence: 'high' }],
      },
    });
    await observer.processMessage(m);
    expect(eventService.closeActivePersonEvent).toHaveBeenCalledTimes(1);
    const opts = eventService.closeActivePersonEvent.mock.calls[0][3];
    expect(opts).toMatchObject({ kind: 'any', activityTypeId: 10 });
  });

  test('A1 — break_end aciona closeActivePersonEvent com kind=meta', async () => {
    const m = msg({ slack_ts: '99.4', raw_text: 'voltei do almoço' });
    const { observer, eventService } = makeObserver({
      message: m,
      llmResult: {
        categorization: 'break_end', confidence: 'high',
        actions: [{ type: 'break_end', person_id: 6, confidence: 'high' }],
      },
    });
    await observer.processMessage(m);
    const opts = eventService.closeActivePersonEvent.mock.calls[0][3];
    expect(opts.kind).toBe('meta');
  });

  test('A1 — N>1 open_event na MESMA msg suffixa source_message_ts (bug 25/mai ev 145)', async () => {
    // Antes do fix: as 2 actions tinham mesmo source_message_ts → idempotência
    // sobrescrevia o 1º com o 2º. Agora cada uma vira event distinto.
    const m = msg({ slack_ts: '99.9', raw_text: 'S: Formulacao e Contagem/FNSKU (Vita B1 - 0148)' });
    const { observer, eventService } = makeObserver({
      message: m,
      llmResult: {
        categorization: 'activity_start', confidence: 'high',
        actions: [
          { type: 'open_event', person_id: 4, activity_type_id: 1, confidence: 'high' }, // formulação
          { type: 'open_event', person_id: 4, activity_type_id: 3, confidence: 'high' }, // marketplace_prep / contagem
        ],
      },
      dbOpts: { persons: [4], activityTypes: [1, 3] },
    });
    await observer.processMessage(m);
    expect(eventService.upsert).toHaveBeenCalledTimes(2);
    const ts1 = eventService.upsert.mock.calls[0][0].source_message_ts;
    const ts2 = eventService.upsert.mock.calls[1][0].source_message_ts;
    expect(ts1).not.toBe(ts2);                          // distintos
    expect(ts1).toBe('99.9#a0');
    expect(ts2).toBe('99.9#a1');
  });

  test('A1 — open_event ÚNICO mantém source_message_ts puro (retrocompat)', async () => {
    const m = msg({ slack_ts: '88.8' });
    const { observer, eventService } = makeObserver({ message: m, llmResult: OPEN });
    await observer.processMessage(m);
    expect(eventService.upsert).toHaveBeenCalledTimes(1);
    expect(eventService.upsert.mock.calls[0][0].source_message_ts).toBe('88.8');
  });

  test('A1 — close_event com activity_type_id usa kind=any (bug 25/mai close de bg)', async () => {
    // Antes: kind forçado a 'foreground' pulava encapsulação (background).
    // Agora: ao especificar activity_type_id, kind=any (filtro forte é o type).
    const m = msg({ slack_ts: '77.7', raw_text: 'F: encapsulação' });
    const { observer, eventService } = makeObserver({
      message: m,
      llmResult: {
        categorization: 'activity_end', confidence: 'high',
        actions: [{ type: 'close_event', person_id: 6, activity_type_id: 3, confidence: 'high' }],
      },
      dbOpts: { activityTypes: [3, 10, 20] },
    });
    await observer.processMessage(m);
    const opts = eventService.closeActivePersonEvent.mock.calls[0][3];
    expect(opts.kind).toBe('any');
    expect(opts.activityTypeId).toBe(3);
  });

  test('Aprendizado — uncertain do LLM é persistido no llm_result', async () => {
    const m = msg({ slack_ts: '66.6' });
    const { observer, db } = makeObserver({
      message: m,
      llmResult: Object.assign({}, OPEN, {
        uncertain: true,
        uncertainty_reason: 'duas tarefas paralelas ou sequenciais? não dá pra inferir',
      }),
    });
    await observer.processMessage(m);
    const result = JSON.parse(m.llm_result);
    expect(result.uncertain).toBe(true);
    expect(result.uncertainty_reason).toMatch(/duas tarefas paralelas/);
  });

  test('A7 — safetyAutoClose é chamado no 1º tick + rate-limited (5min)', async () => {
    const { observer, eventService } = makeObserver({ llmResult: OPEN });
    // 1º tick: chama uma vez (sem _lastSafetyAutoCloseMs ainda)
    await observer.tick();
    expect(eventService.safetyAutoClose).toHaveBeenCalledTimes(1);
    // 2º tick logo em seguida: NÃO chama de novo (cooldown 5min)
    await observer.tick();
    expect(eventService.safetyAutoClose).toHaveBeenCalledTimes(1);
    // forçar reset do cooldown → chama de novo
    observer._lastSafetyAutoCloseMs = Date.now() - 6 * 60 * 1000;
    await observer.tick();
    expect(eventService.safetyAutoClose).toHaveBeenCalledTimes(2);
  });
});

describe('V3 §2.8 — guard msg.no_event_created (bloco 29/mai-noite #36)', () => {
  const guardCalls = (db) => db.query.mock.calls.filter(([sql]) =>
    String(sql).replace(/\s+/g, ' ').includes("'msg.no_event_created'"));

  test('msg com prefixo S: que LLM emitiu actions=[] → guard dispara audit', async () => {
    const m = msg({ raw_text: 'S:fazendo 02 Akkermansia manualmente' });
    const { observer, db } = makeObserver({
      message: m,
      llmResult: { actions: [], categorization: 'activity_start', confidence: 'high' },
    });
    await observer.processMessage(m);
    expect(guardCalls(db).length).toBe(1);
  });

  test('msg com prefixo F: que LLM emitiu actions=[] → guard dispara', async () => {
    const m = msg({ raw_text: 'F: Finalizado Almoco' });
    const { observer, db } = makeObserver({
      message: m,
      llmResult: { actions: [], categorization: 'activity_end', confidence: 'high' },
    });
    await observer.processMessage(m);
    expect(guardCalls(db).length).toBe(1);
  });

  test('msg SEM prefixo S:/F: → guard NÃO dispara', async () => {
    const m = msg({ raw_text: 'feito 200 garrafas' });
    const { observer, db } = makeObserver({
      message: m,
      llmResult: { actions: [], categorization: 'note', confidence: 'high' },
    });
    await observer.processMessage(m);
    expect(guardCalls(db).length).toBe(0);
  });

  test('msg com S: que GEROU event → guard NÃO dispara', async () => {
    const m = msg({ raw_text: 'S: iniciando linha' });
    const { observer, db } = makeObserver({ message: m, llmResult: OPEN });
    await observer.processMessage(m);
    expect(guardCalls(db).length).toBe(0);
  });

  test('msg de admin com S: → guard NÃO dispara (admin context, actions skipadas é esperado)', async () => {
    const m = msg({ raw_text: 'S: começar isso' });
    const { observer, db } = makeObserver({
      message: m,
      author: { person_id: 1, resolution_method: 'admin_directive', is_admin_context: true, confidence: 'high' },
      llmResult: { actions: [{ type: 'open_event', person_id: 1, activity_type_id: 10, confidence: 'high' }], categorization: 'admin_intervention', confidence: 'high' },
    });
    await observer.processMessage(m);
    expect(guardCalls(db).length).toBe(0);
  });
});
