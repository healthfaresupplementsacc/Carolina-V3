'use strict';
// HEALTHFARE V3 — PARTE 2.11 — integração ponta-a-ponta + casos reais.
//
// Item 4: webhook → v3.messages → Observer (pipeline real) → event →
//         events-shadow. Serviços REAIS, só o LLM é MockProvider.
// Item 5: casos reais do canal — valida que o pipeline PERSISTE certo
//         o que o LLM decide (encanamento), serviços mockados.
const MockProvider = require('../v3/llm/providers/MockProvider');
const { Observer } = require('../v3/llm/Observer');
const { PersonResolver } = require('../v3/services/PersonResolver');
const { PromptBuilder } = require('../v3/llm/prompt-builder');
const { EventService } = require('../v3/services/EventService');
const eventsV2 = require('../v3/slack/events-v2');
const adminRoutes = require('../v3/admin-v3/routes');
const { buildRepos } = require('../v3/data/router');

// ──────────────────────────────────────────────────────────────
// Fake DB in-memory razoavelmente completo (schema v3).
// ──────────────────────────────────────────────────────────────
function makeIntegrationDb() {
  const persons = [
    { id: 1, display_name: 'Bruno Camp', role: 'owner', slack_user_id: null, active: true, deleted_at: null },
    { id: 3, display_name: 'Henrique', role: 'manager', slack_user_id: null, active: true, deleted_at: null },
    { id: 6, display_name: 'Ana', role: 'operator', slack_user_id: null, active: true, deleted_at: null },
    { id: 7, display_name: 'Bruno Sarmento', role: 'operator', slack_user_id: null, active: true, deleted_at: null },
    { id: 8, display_name: 'Solo', role: 'operator', slack_user_id: 'U_SOLO', active: true, deleted_at: null },
  ];
  const activityTypes = [
    { id: 10, slug: 'formulation', display_name: 'Formulação', category: 'production_phase', requires_product: true },
    { id: 20, slug: 'break', display_name: 'Pausa', category: 'meta', requires_product: false },
  ];
  const products = [{ id: 5, canonical_name: 'Plant Sterols', aliases: ['Plant'] }];
  const messages = [];
  const events = [];
  const audit = [];
  const prefixLog = [];
  let nextMsgId = 1;
  let nextEvId = 1;
  const tsSet = new Set();

  function run(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

    // ── messages ──
    if (/^INSERT INTO v3\.messages/.test(s)) {
      if (!tsSet.has(params[0])) {
        tsSet.add(params[0]);
        messages.push({
          id: nextMsgId++, slack_ts: params[0], slack_channel_id: params[1],
          slack_user_id: params[2], raw_text: params[3], created_at: new Date(),
          person_id: null, llm_processed_at: null, llm_result: null, processing_error: null,
        });
      }
      return { rows: [] };
    }
    if (/^SELECT id, slack_ts AS ts, slack_user_id, raw_text AS text FROM v3\.messages/.test(s)) {
      return { rows: messages.filter((m) => m.slack_user_id === params[0])
        .map((m) => ({ id: m.id, ts: m.slack_ts, slack_user_id: m.slack_user_id, text: m.raw_text })) };
    }
    if (/FROM v3\.messages m LEFT JOIN v3\.persons/.test(s)) {
      return { rows: messages.filter((m) => m.slack_channel_id === params[0])
        .map((m) => ({ slack_ts: m.slack_ts, raw_text: m.raw_text, created_at: m.created_at, person_id: m.person_id, display_name: null })) };
    }
    if (/SELECT raw_text, created_at FROM v3\.messages WHERE person_id/.test(s)) {
      return { rows: messages.filter((m) => m.person_id === params[0]).map((m) => ({ raw_text: m.raw_text, created_at: m.created_at })) };
    }
    if (/^UPDATE v3\.messages SET llm_processed_at/.test(s)) {
      const m = messages.find((x) => x.id === params[0]);
      if (m) { m.llm_processed_at = new Date(); m.llm_result = params[1]; m.llm_provider_used = params[2]; }
      return { rows: [] };
    }
    if (/^UPDATE v3\.messages SET processing_error/.test(s)) {
      const m = messages.find((x) => x.id === params[0]);
      if (m) m.processing_error = params[1];
      return { rows: [] };
    }

    // ── persons / shared ──
    if (/FROM v3\.shared_accounts/.test(s) && !/shared_account_users/.test(s)) return { rows: [] };
    if (/FROM v3\.shared_account_users/.test(s)) return { rows: [] };
    if (/FROM v3\.persons WHERE deleted_at IS NULL/.test(s)) {
      return { rows: persons.map((p) => ({ id: p.id, display_name: p.display_name, role: p.role, slack_user_id: p.slack_user_id })) };
    }
    if (/FROM v3\.persons WHERE active = true/.test(s)) {
      return { rows: persons.map((p) => ({ id: p.id, display_name: p.display_name, role: p.role })) };
    }
    if (/^SELECT id FROM v3\.persons/.test(s)) return { rows: persons.map((p) => ({ id: p.id })) };

    // ── activity_types / products / batches ──
    if (/FROM v3\.activity_types WHERE active = true/.test(s)) return { rows: activityTypes };
    if (/^SELECT id FROM v3\.activity_types/.test(s)) return { rows: activityTypes.map((a) => ({ id: a.id })) };
    if (/SELECT category FROM v3\.activity_types/.test(s)) {
      const a = activityTypes.find((x) => x.id === params[0]);
      return { rows: a ? [{ category: a.category }] : [] };
    }
    if (/FROM v3\.products WHERE active = true/.test(s)) return { rows: products };
    if (/^SELECT id FROM v3\.products/.test(s)) return { rows: products.map((p) => ({ id: p.id })) };
    if (/FROM v3\.product_batches/.test(s)) return { rows: [] };

    // ── events (EventService) ──
    if (/^INSERT INTO v3\.events \(/.test(s)) {
      const cols = s.match(/\(([^)]+)\)/)[1].split(',').map((x) => x.trim());
      const row = { id: nextEvId++, created_at: new Date(), updated_at: new Date(), deleted_at: null, deleted_by: null };
      cols.forEach((c, i) => { row[c] = params[i]; });
      events.push(row);
      return { rows: [{ ...row }] };
    }
    if (/^UPDATE v3\.events SET /.test(s)) {
      const setPart = s.match(/SET ([\s\S]+) WHERE id = \$1/)[1];
      const row = events.find((e) => e.id === params[0]);
      if (!row) return { rows: [] };
      for (const a of setPart.split(',').map((x) => x.trim())) {
        if (a.startsWith('updated_at')) continue;
        const mm = a.match(/^(\w+) = \$(\d+)$/);
        if (mm) row[mm[1]] = params[Number(mm[2]) - 1];
      }
      return { rows: [{ ...row }] };
    }
    if (/^SELECT \* FROM v3\.events WHERE source_message_ts/.test(s)) {
      return { rows: events.filter((e) => e.source_message_ts === params[0] && e.deleted_at == null).slice(0, 1) };
    }
    if (/^SELECT \* FROM v3\.events WHERE id = \$1/.test(s)) {
      const e = events.find((x) => x.id === params[0]);
      return { rows: e ? [{ ...e }] : [] };
    }
    if (/^SELECT \* FROM v3\.events WHERE person_id/.test(s)) {
      return { rows: events.filter((e) => e.person_id === params[0] && e.ended_at == null && e.deleted_at == null) };
    }
    if (/FROM v3\.events WHERE ended_at IS NULL/.test(s)) {
      return { rows: events.filter((e) => e.ended_at == null && e.deleted_at == null)
        .map((e) => ({ person_id: e.person_id, activity_type_id: e.activity_type_id, started_at: e.started_at, phase_label: e.phase_label })) };
    }
    if (/FROM v3\.events e LEFT JOIN v3\.persons/.test(s)) { // TimelineRepo.eventsByDay
      return { rows: events.filter((e) => e.deleted_at == null).map((e) => {
        const at = activityTypes.find((a) => a.id === e.activity_type_id) || {};
        const p = persons.find((pp) => pp.id === e.person_id) || {};
        return {
          id: e.id, person_id: e.person_id, activity_type_id: e.activity_type_id,
          product_batch_id: e.product_batch_id, started_at: e.started_at, ended_at: e.ended_at,
          confidence: e.confidence, cowork_with: e.cowork_with, phase_label: e.phase_label,
          description: e.description, source_message_ts: e.source_message_ts,
          person_name: p.display_name, person_role: p.role,
          activity_slug: at.slug, activity_name: at.display_name, activity_category: at.category,
        };
      }) };
    }

    // ── outros ──
    if (/FROM v3\.llm_corrections/.test(s)) return { rows: [] };
    if (/FROM v3\.vocabulary/.test(s)) return { rows: [] };
    if (/FROM v3\.person_language_profile/.test(s)) return { rows: [] };
    if (/FROM v3\.settings WHERE key = 'operational_window'/.test(s)) {
      return { rows: [{ value: { start_hour: 0, end_hour: 24, weekdays: [0, 1, 2, 3, 4, 5, 6] } }] };
    }
    if (/^INSERT INTO v3\.prefix_resolution_log/.test(s)) { prefixLog.push(params); return { rows: [] }; }
    if (/^INSERT INTO v3\.audit_log/.test(s)) { audit.push({ actor_type: params[0], action: params[2] }); return { rows: [] }; }
    if (/^INSERT INTO v3\.vocabulary/.test(s)) { return { rows: [] }; }
    return { rows: [] };
  }

  const db = {
    messages, events, audit, prefixLog, persons,
    query: jest.fn((sql, p) => Promise.resolve(run(sql, p))),
  };
  db.connect = () => Promise.resolve({ query: db.query, release: () => {} });
  return db;
}

// ──────────────────────────────────────────────────────────────
// Item 4 — ponta-a-ponta
// ──────────────────────────────────────────────────────────────
describe('V3 §2.11 — integração ponta-a-ponta (webhook → worker → event)', () => {
  test('mensagem entra pelo webhook, worker processa, event criado e visível em events-shadow', async () => {
    const db = makeIntegrationDb();

    // 1) webhook insere a mensagem
    const wh = await eventsV2.handleEvent({
      type: 'event_callback',
      event: { type: 'message', channel: 'C_PROD', ts: '900.1', user: 'U_SOLO', text: 'comecei a formulação' },
    }, { db, productionChannelId: 'C_PROD' });
    expect(wh.action).toBe('inserted');
    expect(db.messages).toHaveLength(1);

    // 2) pipeline real (só o LLM é mock)
    const provider = new MockProvider();
    provider.setResult({
      interpretation: 'Solo abriu formulação',
      categorization: 'activity_start',
      confidence: 'high',
      actions: [{ type: 'open_event', person_id: 8, activity_type_id: 10, confidence: 'high' }],
    });
    const observer = new Observer({
      db,
      provider,
      personResolver: new PersonResolver({ db, provider }),
      promptBuilder: new PromptBuilder({ db }),
      eventService: new EventService({ db }),
      batchService: { findOrCreateActive: jest.fn() },
      productionCountService: { record: jest.fn() },
      botUserId: 'U_BOT',
      mode: 'shadow',
    });
    const r = await observer.processMessage(db.messages[0]);

    // 3) event criado de verdade
    expect(r.ok).toBe(true);
    expect(db.events).toHaveLength(1);
    expect(db.events[0].person_id).toBe(8);
    expect(db.events[0].activity_type_id).toBe(10);
    expect(db.events[0].source_message_ts).toBe('900.1'); // idempotência
    expect(db.messages[0].llm_processed_at).toBeTruthy();

    // 4) aparece no endpoint de inspeção
    const shadow = await adminRoutes.handleEventsShadow(
      { query: { pin: '510510' }, headers: {} }, { db, repos: buildRepos(db) });
    expect(shadow.status).toBe(200);
    expect(shadow.body).toContain('Solo');
    expect(shadow.body).toContain('Formulação');

    // 5) PersonResolver registrou a resolução
    expect(db.prefixLog.length).toBeGreaterThan(0);
    // 6) SHADOW: o pipeline rodou sem nenhum efeito no Slack (sem slack dep)
    expect(r.events).toEqual([db.events[0].id]);
  });

  test('re-processar a mesma mensagem NÃO duplica o event (idempotência)', async () => {
    const db = makeIntegrationDb();
    db.messages.push({
      id: 1, slack_ts: '901.1', slack_channel_id: 'C_PROD', slack_user_id: 'U_SOLO',
      raw_text: 'formulação', created_at: new Date(), person_id: null, llm_processed_at: null,
    });
    const provider = new MockProvider();
    provider.setResult({
      categorization: 'activity_start', confidence: 'high',
      actions: [{ type: 'open_event', person_id: 8, activity_type_id: 10, confidence: 'high' }],
    });
    const mk = () => new Observer({
      db, provider,
      personResolver: new PersonResolver({ db, provider }),
      promptBuilder: new PromptBuilder({ db }),
      eventService: new EventService({ db }),
      batchService: { findOrCreateActive: jest.fn() },
      productionCountService: { record: jest.fn() },
      botUserId: 'U_BOT', mode: 'shadow',
    });
    await mk().processMessage(db.messages[0]);
    db.messages[0].llm_processed_at = null; // simula re-processamento (edição)
    await mk().processMessage(db.messages[0]);
    expect(db.events).toHaveLength(1); // upsert por source_message_ts não duplicou
  });
});

// ──────────────────────────────────────────────────────────────
// Item 5 — casos reais do canal (encanamento; serviços mockados)
// ──────────────────────────────────────────────────────────────
let _eid = 0;
function caseHarness({ author, llmResult }) {
  const db = {
    query: jest.fn((sql) => {
      const s = String(sql).replace(/\s+/g, ' ');
      // validação de IDs por tabela (os casos usam person 3/4/6/7,
      // product 5, activity_type 10/20/21)
      if (/SELECT id FROM v3\.persons/.test(s)) return Promise.resolve({ rows: [1, 3, 4, 6, 7].map((id) => ({ id })) });
      if (/SELECT id FROM v3\.products/.test(s)) return Promise.resolve({ rows: [{ id: 5 }] });
      if (/SELECT id FROM v3\.activity_types/.test(s)) return Promise.resolve({ rows: [10, 20, 21].map((id) => ({ id })) });
      return Promise.resolve({ rows: [] });
    }),
  };
  const provider = new MockProvider();
  provider.setResult(llmResult);
  const eventService = {
    upsert: jest.fn(async () => ({ id: ++_eid })),
    closeActivePersonEvent: jest.fn().mockResolvedValue([{ id: 99 }]),
  };
  const batchService = { findOrCreateActive: jest.fn().mockResolvedValue({ id: 77 }) };
  const productionCountService = { record: jest.fn().mockResolvedValue({ id: 9 }) };
  const observer = new Observer({
    db, provider,
    personResolver: { resolve: jest.fn().mockResolvedValue(author) },
    promptBuilder: { buildContext: jest.fn().mockResolvedValue({ systemPrompt: 's', userContent: 'u' }) },
    eventService, batchService, productionCountService,
    botUserId: 'U_BOT', mode: 'shadow',
  });
  return { observer, eventService, batchService, productionCountService };
}
const m = (text, slack_user_id = 'U08JC85HMNE') => ({
  id: 1, slack_ts: '1.1', slack_channel_id: 'C_PROD', slack_user_id,
  raw_text: text, created_at: '2026-05-20T14:00:00.000Z',
});

describe('V3 §2.11 — casos reais do canal (encanamento)', () => {
  test('"Vitor HealthFare: Bruno- linha" → event pro Bruno Sarmento (cross-account)', async () => {
    const { observer, eventService } = caseHarness({
      author: { person_id: 7, resolution_method: 'llm_identified', confidence: 'high' }, // Bruno Sarmento
      llmResult: { categorization: 'activity_start', confidence: 'high',
        actions: [{ type: 'open_event', person_id: 7, activity_type_id: 10, confidence: 'high' }] },
    });
    await observer.processMessage(m('Bruno- linha de producao'));
    expect(eventService.upsert).toHaveBeenCalledTimes(1);
    expect(eventService.upsert.mock.calls[0][0].person_id).toBe(7); // Bruno Sarmento, NÃO Vitor
  });

  test('"Ana- N; indo revisar, Simone fica na linha" → handoff (fecha Ana, abre Simone)', async () => {
    const { observer, eventService } = caseHarness({
      author: { person_id: 6, resolution_method: 'llm_identified', confidence: 'high' },
      llmResult: { categorization: 'activity_end', confidence: 'high', actions: [
        { type: 'close_event', person_id: 6, confidence: 'high' },
        { type: 'open_event', person_id: 4, activity_type_id: 10, confidence: 'medium' },
      ] },
    });
    await observer.processMessage(m('Ana- N; indo revisar e a Simone vai ficar na linha'));
    expect(eventService.closeActivePersonEvent).toHaveBeenCalledTimes(1); // fecha Ana
    expect(eventService.upsert).toHaveBeenCalledTimes(1);                 // abre Simone
  });

  test('"Ana- F; pausa para o almoco" → fecha trabalho + abre break', async () => {
    const { observer, eventService } = caseHarness({
      author: { person_id: 6, resolution_method: 'llm_identified', confidence: 'high' },
      llmResult: { categorization: 'break_start', confidence: 'high', actions: [
        { type: 'close_event', person_id: 6, confidence: 'high' },
        { type: 'break_start', person_id: 6, activity_type_id: 21, confidence: 'high' },
      ] },
    });
    await observer.processMessage(m('Ana- F; revisao... pausa para o almoco'));
    expect(eventService.closeActivePersonEvent).toHaveBeenCalledTimes(1);
    expect(eventService.upsert).toHaveBeenCalledTimes(1); // o break
  });

  test('"Ana- voltei do almoco" → fecha o break (kind meta)', async () => {
    const { observer, eventService } = caseHarness({
      author: { person_id: 6, resolution_method: 'llm_identified', confidence: 'high' },
      llmResult: { categorization: 'break_end', confidence: 'high',
        actions: [{ type: 'break_end', person_id: 6, confidence: 'high' }] },
    });
    await observer.processMessage(m('Ana- voltei do almoco'));
    expect(eventService.closeActivePersonEvent).toHaveBeenCalledTimes(1);
    expect(eventService.closeActivePersonEvent.mock.calls[0][3].kind).toBe('meta');
  });

  test('Thassio "Ana, da pra usar a silica?" → admin_intervention, SEM event', async () => {
    const { observer, eventService } = caseHarness({
      author: { person_id: 3, resolution_method: 'admin_intervention', confidence: 'high', is_admin_context: true },
      llmResult: { categorization: 'admin_intervention', confidence: 'high', actions: [] },
    });
    const r = await observer.processMessage(m('Ana, da pra usar hoje a silica?'));
    expect(r.admin_context).toBe(true);
    expect(eventService.upsert).not.toHaveBeenCalled();
  });

  test('"S-Vitamin B2-0151 Bruno" → event Bruno Sarmento, produto+lote → BatchService', async () => {
    const { observer, eventService, batchService } = caseHarness({
      author: { person_id: 7, resolution_method: 'llm_identified', confidence: 'high' },
      llmResult: { categorization: 'activity_start', confidence: 'high', actions: [{
        type: 'open_event', person_id: 7, activity_type_id: 10, product_id: 5,
        batch_number: '0151', confidence: 'high',
      }] },
    });
    await observer.processMessage(m('S-Vitamin B2-0151 (Para capsulas) Bruno'));
    expect(batchService.findOrCreateActive).toHaveBeenCalledWith(5, '0151', expect.anything(), expect.anything());
    expect(eventService.upsert.mock.calls[0][0].person_id).toBe(7);
    expect(eventService.upsert.mock.calls[0][0].product_batch_id).toBe(77);
  });
});
