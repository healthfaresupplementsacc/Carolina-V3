'use strict';
/**
 * HEALTHFARE V3 — API de dados JSON /api/v3/data/*
 *
 * Contrato ESTÁVEL e VERSIONADO (v3) entre o cérebro e os clientes
 * (dashboard, BI, sistema externo). JSON puro, nunca HTML.
 * Envelope { meta:{version,tz,date?,generated_at}, data }.
 * Auth na borda (auth.js). Os repos devolvem só `data`.
 *
 * Bloco 0: leitura. Bloco 2: 1ª escrita (POST /goals). Bloco 3:
 * o set completo de escrita (PATCH/DELETE) — "admin controla tudo",
 * sempre via os services porta-única, auditado.
 */

const { TimelineRepo } = require('./timeline-repo');
const { CountsRepo } = require('./counts-repo');
const { BatchesRepo } = require('./batches-repo');
const { MessagesRepo } = require('./messages-repo');
const { MetricsRepo } = require('./metrics-repo');
const { HealthRepo } = require('./health-repo');
const { VocabularyRepo } = require('./vocabulary-repo');
const { CatalogRepo } = require('./catalog-repo');
const { HistoryRepo } = require('./history-repo');
const { GoalsRepo } = require('./goals-repo');
const { FlowViewsRepo } = require('./flow-views-repo');
const { DeadlinesRepo } = require('./deadlines-repo');
const { SenderProfilesRepo } = require('./sender-profiles-repo');
const { GoalService } = require('../services/GoalService');
const { EventService } = require('../services/EventService');
const { BatchService } = require('../services/BatchService');
const { ProductionCountService } = require('../services/ProductionCountService');
const { DeadlineService } = require('../services/DeadlineService');
const { CatalogService } = require('../services/CatalogService');
const { SenderService } = require('../services/SenderService');
const { toNyIso, TZ, resolveDate } = require('./ny-date');
const { makeAuthMiddleware } = require('./auth');

const API_VERSION = 'v3';

/** Repos de leitura sobre um pool/cliente pg. */
function buildRepos(db) {
  return {
    timeline: new TimelineRepo({ db }),
    counts: new CountsRepo({ db }),
    batches: new BatchesRepo({ db }),
    messages: new MessagesRepo({ db }),
    metrics: new MetricsRepo({ db }),
    health: new HealthRepo({ db }),
    vocabulary: new VocabularyRepo({ db }),
    catalog: new CatalogRepo({ db }),
    history: new HistoryRepo({ db }),
    goals: new GoalsRepo({ db }),
    flowViews: new FlowViewsRepo({ db }),
    deadlines: new DeadlinesRepo({ db }),
    senderProfiles: new SenderProfilesRepo({ db }),
  };
}

/** Services porta-única (escrita), sobre um pool/cliente pg. */
function buildServices(db) {
  return {
    goal: new GoalService({ db }),
    event: new EventService({ db }),
    batch: new BatchService({ db }),
    count: new ProductionCountService({ db }),
    deadline: new DeadlineService({ db }),
    catalog: new CatalogService({ db }),
    sender: new SenderService({ db }),
    senderProfile: new SenderProfilesRepo({ db }), // share repo for CRUD writes too
  };
}

/** Envelope padrão da API. `data` = payload do repo/service. */
function envelope(data, metaExtra) {
  return {
    meta: Object.assign(
      { version: API_VERSION, tz: TZ, generated_at: toNyIso(new Date()) },
      metaExtra || {}),
    data,
  };
}

const intParam = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};
const body = (req) => (req && req.body) || {};

/**
 * Cada endpoint: { method?, path, handler async (req, repos, services) }
 * → { data, meta? }. Exportado pra teste.
 */
const ENDPOINTS = [
  // ── LEITURA ───────────────────────────────────────────────
  { path: '/api/v3/data/timeline',
    handler: async (req, r) => {
      const d = await r.timeline.eventsByDay(req.query.date);
      return { data: d, meta: { date: d.date } };
    } },
  { path: '/api/v3/data/person/:id/timeline',
    handler: async (req, r) => {
      const d = await r.timeline.eventsByPersonDay(intParam(req.params.id), req.query.date);
      return { data: d, meta: { date: d.date } };
    } },
  { path: '/api/v3/data/counts',
    handler: async (req, r) => {
      const d = await r.counts.countsByDay(req.query.date);
      return { data: d, meta: { date: d.date } };
    } },
  { path: '/api/v3/data/batches',
    handler: async (req, r) => ({ data: await r.batches.activeBatches() }) },
  { path: '/api/v3/data/batches/:id',
    handler: async (req, r) => ({ data: await r.batches.batchSummary(intParam(req.params.id)) }) },
  { path: '/api/v3/data/messages',
    handler: async (req, r) => {
      const d = await r.messages.messagesByDay(req.query.date, { limit: req.query.limit });
      return { data: d, meta: { date: d.date } };
    } },
  { path: '/api/v3/data/messages/:id',
    handler: async (req, r) => ({ data: await r.messages.messageById(intParam(req.params.id)) }) },
  // Ciclo de aprendizado base — lista as msgs que o LLM marcou como
  // incertas, OU com confidence low/unconfirmed, OU com processing_error.
  // Futura tela "Cérebro" usa isso.
  { path: '/api/v3/data/uncertain-cases',
    handler: async (req, r) => ({
      data: await r.messages.uncertainCases({
        limit: req.query.limit, since_days: req.query.since_days,
      }),
    }) },
  { path: '/api/v3/data/metrics',
    handler: async (req, r) => {
      const d = await r.metrics.metricsByDay(req.query.date);
      return { data: d, meta: { date: d.date } };
    } },
  { path: '/api/v3/data/health',
    handler: async (req, r) => ({ data: await r.health.workerHealth() }) },
  { path: '/api/v3/data/vocabulary',
    handler: async (req, r) => ({ data: await r.vocabulary.pending() }) },
  { path: '/api/v3/data/flows',
    handler: async (req, r) => ({ data: await r.catalog.flows() }) },
  { path: '/api/v3/data/catalog/persons',
    handler: async (req, r) => ({ data: await r.catalog.persons() }) },
  { path: '/api/v3/data/catalog/products',
    handler: async (req, r) => ({ data: await r.catalog.products() }) },
  { path: '/api/v3/data/catalog/activity-types',
    handler: async (req, r) => ({ data: await r.catalog.activityTypes() }) },
  { path: '/api/v3/data/person/:id/history',
    handler: async (req, r) => ({
      data: await r.history.personHistory(intParam(req.params.id),
        { from: req.query.from, to: req.query.to }),
    }) },
  { path: '/api/v3/data/product/:id/history',
    handler: async (req, r) => ({
      data: await r.history.productHistory(intParam(req.params.id),
        { from: req.query.from, to: req.query.to }),
    }) },
  { path: '/api/v3/data/goals',
    handler: async (req, r) => {
      const g = await r.goals.goalsByDay(req.query.date);
      return { data: g, meta: { date: g.date } };
    } },
  // Bloco 3 — visões por fluxo
  { path: '/api/v3/data/production',
    handler: async (req, r) => {
      const d = await r.flowViews.productionByDay(req.query.date);
      return { data: d, meta: { date: d.date } };
    } },
  { path: '/api/v3/data/pp',
    handler: async (req, r) => {
      const d = await r.flowViews.pnpByDay(req.query.date);
      return { data: d, meta: { date: d.date } };
    } },
  { path: '/api/v3/data/support',
    handler: async (req, r) => {
      const d = await r.flowViews.supportByDay(req.query.date);
      return { data: d, meta: { date: d.date } };
    } },
  // taxa de revisão (cápsulas/seg + frascos/min) + média de tempo de revisão
  // por produto e geral. Histórico (?range=7d|30d|90d|180d, default 30d).
  { path: '/api/v3/data/review-rate',
    handler: async (req, r) => ({
      data: await r.flowViews.reviewRate({ range: req.query.range, product_id: req.query.product_id }),
    }) },
  { path: '/api/v3/data/deadlines',
    handler: async (req, r) => ({ data: await r.deadlines.list() }) },
  // sender profiles + manual post (porta de saída admin)
  { path: '/api/v3/data/sender-profiles',
    handler: async (req, r) => ({ data: await r.senderProfiles.list() }) },
  { path: '/api/v3/data/sent-history',
    handler: async (req, r, s) => ({ data: await s.sender.recentPosts(req.query.limit) }) },

  // ── ESCRITA (Bloco 3 — admin controla tudo, auditado) ─────
  // metas
  { method: 'post', path: '/api/v3/data/goals',
    handler: async (req, r, s) => {
      const b = body(req);
      return { data: await s.goal.record({
        product_id: b.product_id || null, batch_number: b.batch_number || null,
        expected_quantity: b.expected_quantity, unit: b.unit || 'bottle',
        destinations: b.destinations || null, production_date: resolveDate(b.production_date),
        source: 'dashboard', created_by_person_id: b.created_by_person_id || null,
        confidence: b.confidence || 'high', actor_type: 'admin',
      }) };
    } },
  { method: 'patch', path: '/api/v3/data/goals/:id',
    handler: async (req, r, s) => {
      const b = body(req);
      return { data: await s.goal.correct(intParam(req.params.id), b.changes || {}, b.by_person_id, b.note) };
    } },
  { method: 'delete', path: '/api/v3/data/goals/:id',
    handler: async (req, r, s) => ({
      data: await s.goal.softDelete(intParam(req.params.id), body(req).by_person_id, body(req).reason),
    }) },
  // events — CREATE (B.6: admin cria event direto pela UI; ex.: o
  // caso Bruno Sarmento/formulação que faltou no dia 22 e o LLM
  // nunca abriu). source_message_ts=NULL é a marca de criação manual
  // (idempotência por ts não aplicável). actor_type='admin' no audit.
  { method: 'post', path: '/api/v3/data/events',
    handler: async (req, r, s) => {
      const b = body(req);
      if (!b.person_id) throw new Error('person_id obrigatório');
      if (!b.started_at) throw new Error('started_at obrigatório');
      return { data: await s.event.upsert({
        person_id: b.person_id,
        activity_type_id: b.activity_type_id || null,
        product_batch_id: b.product_batch_id || null,
        started_at: b.started_at,
        ended_at: b.ended_at || null,
        phase_label: b.phase_label || null,
        description: b.description || null,
        confidence: b.confidence || 'high',
        cowork_with: b.cowork_with || [],
        quantity: b.quantity != null ? b.quantity : null,
        quantity_unit: b.quantity_unit || null,
        source_message_ts: null,
        actor_type: 'admin',
        actor_person_id: b.by_person_id || null,
      }) };
    } },
  // events
  { method: 'patch', path: '/api/v3/data/events/:id',
    handler: async (req, r, s) => {
      const b = body(req);
      return { data: await s.event.correct(intParam(req.params.id), b.changes || {}, b.by_person_id, b.note) };
    } },
  { method: 'delete', path: '/api/v3/data/events/:id',
    handler: async (req, r, s) => ({
      data: await s.event.softDelete(intParam(req.params.id), body(req).by_person_id, body(req).reason),
    }) },
  { method: 'post', path: '/api/v3/data/events/:id/restore',
    handler: async (req, r, s) => ({
      data: await s.event.restore(intParam(req.params.id), body(req).by_person_id),
    }) },
  { method: 'post', path: '/api/v3/data/events/merge',
    handler: async (req, r, s) => ({
      data: await s.event.mergeEvents(body(req).event_ids || [], body(req).by_person_id),
    }) },
  { method: 'post', path: '/api/v3/data/events/:id/split',
    handler: async (req, r, s) => ({
      data: await s.event.splitEvent(intParam(req.params.id), body(req).split_at, body(req).by_person_id),
    }) },
  // contagens
  { method: 'patch', path: '/api/v3/data/counts/:id',
    handler: async (req, r, s) => {
      const b = body(req);
      return { data: await s.count.supersede(intParam(req.params.id), b.new_bottles, b.by_person_id, b.note) };
    } },
  { method: 'delete', path: '/api/v3/data/counts/:id',
    handler: async (req, r, s) => ({
      data: await s.count.softDelete(intParam(req.params.id), body(req).by_person_id, body(req).reason),
    }) },
  { method: 'post', path: '/api/v3/data/counts/:id/confirm',
    handler: async (req, r, s) => {
      const b = body(req);
      const id = intParam(req.params.id);
      // decision: 'duplicate' → some da soma (softDelete) | 'additional' → entra (limpa flag)
      if (b.decision === 'duplicate') {
        return { data: await s.count.softDelete(id, b.by_person_id, 'duplicata confirmada pelo admin') };
      }
      if (b.decision === 'additional') {
        return { data: await s.count.confirmNotDuplicate(id, b.by_person_id) };
      }
      throw new Error('confirm: decision inválido (duplicate|additional)');
    } },
  // lotes — resolve produto+nº lote → batch_id (cria se não existir).
  // Usado pelo drawer de edição quando o admin escolhe produto + lote
  // pra anexar ao event. batch_number opcional → '(sem lote)' como
  // placeholder, permitindo eventos com produto mas sem nº de lote
  // (ex.: "Bruno mencionou Potassium" sem informar o lote).
  { method: 'post', path: '/api/v3/data/batches/resolve',
    handler: async (req, r, s) => {
      const b = body(req);
      const productId = parseInt(b.product_id, 10);
      if (!Number.isFinite(productId)) throw new Error('product_id obrigatório');
      const batchNum = (b.batch_number == null || String(b.batch_number).trim() === '')
        ? '(sem lote)'
        : String(b.batch_number).trim();
      const startedAt = b.started_at || new Date().toISOString();
      const batch = await s.batch.findOrCreateActive(productId, batchNum, startedAt,
        { actorType: 'admin' });
      return { data: {
        batch_id: batch.id,
        product_id: batch.product_id,
        batch_number: batch.batch_number,
        status: batch.status,
        started_at: batch.started_at,
      } };
    } },
  // lotes
  { method: 'patch', path: '/api/v3/data/batches/:id',
    handler: async (req, r, s) => {
      const b = body(req);
      return { data: await s.batch.closeBatch(intParam(req.params.id), b.finished_at || null,
        b.status, { actorType: 'admin', actorPersonId: b.by_person_id }) };
    } },
  // fases (activity_types)
  { method: 'patch', path: '/api/v3/data/catalog/activity-types/:id',
    handler: async (req, r, s) => {
      const b = body(req);
      return { data: await s.catalog.updateActivityType(intParam(req.params.id), b.changes || {}, b.by_person_id) };
    } },
  // sender profiles (CRUD)
  { method: 'post', path: '/api/v3/data/sender-profiles',
    handler: async (req, r, s) => ({ data: await s.senderProfile.create(body(req)) }) },
  { method: 'patch', path: '/api/v3/data/sender-profiles/:id',
    handler: async (req, r, s) => ({ data: await s.senderProfile.update(intParam(req.params.id), body(req)) }) },
  { method: 'delete', path: '/api/v3/data/sender-profiles/:id',
    handler: async (req, r, s) => ({ data: await s.senderProfile.softDelete(intParam(req.params.id)) }) },
  { method: 'post', path: '/api/v3/data/sender-profiles/:id/set-default',
    handler: async (req, r, s) => ({ data: await s.senderProfile.setDefault(intParam(req.params.id)) }) },
  // porta de saída MANUAL — postar como persona.
  // PIN obrigatório; audit em manual_post.sent.
  { method: 'post', path: '/api/v3/data/send',
    handler: async (req, r, s) => {
      const b = body(req);
      if (!b.sender_name) throw new Error('sender_name obrigatório');
      if (!b.channel) throw new Error('channel obrigatório');
      if (!b.text && !b.image) throw new Error('text ou image obrigatório');
      const out = await s.sender.send({
        channel: b.channel,
        text: b.text || null,
        sender: { name: b.sender_name, icon: b.sender_icon || null },
        image: b.image || null,
        thread_ts: b.thread_ts || null,
        actorType: 'admin',
      });
      return { data: out };
    } },
  // porta de saída MANUAL — reagir a msg (emoji).
  { method: 'post', path: '/api/v3/data/react',
    handler: async (req, r, s) => {
      const b = body(req);
      if (!b.channel) throw new Error('channel obrigatório');
      if (!b.ts) throw new Error('ts obrigatório');
      if (!b.emoji) throw new Error('emoji obrigatório');
      const out = await s.sender.react({
        channel: b.channel, ts: b.ts, emoji: b.emoji, actorType: 'admin',
      });
      return { data: out };
    } },
  // deadlines
  { method: 'post', path: '/api/v3/data/deadlines',
    handler: async (req, r, s) => ({ data: await s.deadline.create(body(req), body(req).by_person_id) }) },
  { method: 'patch', path: '/api/v3/data/deadlines/:id',
    handler: async (req, r, s) => {
      const b = body(req);
      return { data: await s.deadline.update(intParam(req.params.id), b.changes || {}, b.by_person_id) };
    } },
  { method: 'delete', path: '/api/v3/data/deadlines/:id',
    handler: async (req, r, s) => ({
      data: await s.deadline.remove(intParam(req.params.id), body(req).by_person_id),
    }) },
];

/**
 * Snapshot completo do dia, JSON puro. AUTH POR TOKEN (query ?token=...)
 * — independente do PIN. Pensado pro Claude (claude.ai) auditar o V3
 * via fetch read-only.
 *
 * Quando V3_SNAPSHOT_TOKEN não está setada no env → 503 (feature desligada).
 * Token inválido → 401. Match → JSON com timeline + cards + open events +
 * uncertain cases + worker health.
 */
async function buildSnapshot(dateInput, repos) {
  const date = resolveDate(dateInput);
  const [timeline, production, pp, support, goals, counts, deadlines, metrics, health, uncertain, autoClosed]
    = await Promise.all([
      repos.timeline.eventsByDay(date),
      repos.flowViews.productionByDay(date),
      repos.flowViews.pnpByDay(date),
      repos.flowViews.supportByDay(date),
      repos.goals.goalsByDay(date),
      repos.counts.countsByDay(date),
      repos.deadlines.list(),
      repos.metrics.metricsByDay(date),
      repos.health.workerHealth(),
      repos.messages.uncertainCases({ since_days: 3, limit: 50 }),
      // E7-cérebro #4 — events auto-fechados HOJE (NY) viram notificações.
      // Tolerante a falta do método (fallback {events:[]}) pra não quebrar
      // testes que mockam repos parcialmente.
      repos.health.autoClosedEvents
        ? repos.health.autoClosedEvents(date)
        : Promise.resolve({ events: [] }),
    ]);

  const openEvents = [];
  for (const p of (timeline.people || [])) {
    for (const e of (p.events || [])) {
      if (!e.ended_at) {
        openEvents.push({
          event_id: e.event_id, person_id: p.person_id, person: p.display_name,
          activity: e.activity, flow: e.flow,
          started_at: e.started_at, source_message_ts: e.source_message_ts,
        });
      }
    }
  }

  const batchById = {};
  for (const l of (production.lotes || [])) {
    if (l.batch_id != null) batchById[l.batch_id] = {
      batch_number: l.batch_number, product: l.product,
    };
  }

  const dupCount = (goals.goals || [])
    .reduce((s, g) => s + ((g.duplicatas_suspeitas || []).length), 0);
  const invalidCount = (production.lotes || []).reduce((s, l) => s + (l.invalid_event_count || 0), 0)
    + (pp.invalid_event_count || 0);
  const downtimeCount = (support.occurrences || []).filter((o) => o.is_downtime).length;

  return {
    date,
    timeline,
    cards: {
      production: production.lotes,
      pp: {
        total_seconds: pp.total_seconds,
        orders: pp.orders, seconds_per_order: pp.seconds_per_order,
        sub_steps: pp.sub_steps, quantities: pp.quantities, people: pp.people,
      },
      support: support.occurrences,
      goals: goals.goals,
      counts: {
        total: (counts.counts || []).length,
        totals_by_product: counts.totals_by_product || {},
        rows: counts.counts || [],
      },
      deadlines: deadlines.deadlines,
      atencao: {
        duplicatas_count: dupCount,
        invalid_events: invalidCount,
        downtime_events: downtimeCount,
        open_events_count: openEvents.length,
        // E7-cérebro #4 — lista de auto-fechados de hoje pra render no card
        // de notificações (ev X de pessoa Y fechado às 21:00 sem F manual).
        auto_closed_events: autoClosed.events || [],
        auto_closed_count: (autoClosed.events || []).length,
      },
    },
    open_events: openEvents,
    uncertain_cases: uncertain.cases,
    batch_by_id: batchById,
    worker_health: health,
    metrics_summary: {
      msgs_processed: metrics.total_processed,
      errors: metrics.errors,
      cost_usd: metrics.cost_estimate_usd,
      by_confidence: metrics.by_confidence,
    },
  };
}

/**
 * Router Express da API de dados. Montar com app.use('/', router).
 * deps.db = pool pg; deps.repos / deps.services injetáveis (teste).
 */
function createDataRouter(deps = {}) {
  const express = require('express');
  const router = express.Router();
  const repos = deps.repos || buildRepos(deps.db);
  const services = deps.services || buildServices(deps.db);

  // Snapshot — registrada ANTES do middleware PIN: usa token próprio
  // (env V3_SNAPSHOT_TOKEN) na query. Read-only puro; sem write.
  //
  // E7-refine3: adiciona Cache-Control: no-store. O endpoint sempre retorna
  // a data pedida (verificado: buildSnapshot('2026-05-26') → date='2026-05-26'),
  // mas sem esse header navegadores e proxies podiam manter resp velha em
  // cache — Bruno relatou ver date=2026-05-25 num refresh de URL que ele
  // tinha aberto antes. Agora qualquer GET re-busca limpo.
  router.get('/api/v3/data/snapshot', async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const expected = deps.snapshotToken || process.env.V3_SNAPSHOT_TOKEN || null;
    if (!expected) {
      return res.status(503).json({ error: { code: 'disabled',
        message: 'snapshot desligado (V3_SNAPSHOT_TOKEN não setada).' } });
    }
    if (req.query.token !== expected) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'token inválido.' } });
    }
    try {
      const data = await buildSnapshot(req.query.date, repos);
      res.json(envelope(data, { date: data.date, snapshot: true }));
    } catch (e) {
      console.error('[v3-data] snapshot:', e.message);
      const code = /obrigatóri|inválid/.test(e.message) ? 400 : 500;
      res.status(code).json({ error: { code: code === 400 ? 'bad_request' : 'internal', message: e.message } });
    }
  });

  // auth na borda — protege TODO o /api/v3/data/* (exceto o snapshot acima)
  router.use('/api/v3/data', makeAuthMiddleware(deps));

  for (const ep of ENDPOINTS) {
    const method = ep.method || 'get';
    router[method](ep.path, async (req, res) => {
      try {
        const out = await ep.handler(req, repos, services);
        res.json(envelope(out.data, out.meta));
      } catch (e) {
        console.error('[v3-data]', method.toUpperCase(), ep.path, '-', e.message);
        const notFound = /não existe/.test(e.message);
        const bad = /obrigatóri|inválid|não-(corrigível|editável)|precisa de/.test(e.message);
        const code = notFound ? 404 : (bad ? 400 : 500);
        res.status(code).json({
          error: {
            code: notFound ? 'not_found' : (bad ? 'bad_request' : 'internal'),
            message: e.message,
          },
        });
      }
    });
  }

  console.log('[V3] API de dados montada: /api/v3/data/* (' + ENDPOINTS.length + ' endpoints)');
  return router;
}

module.exports = { createDataRouter, buildRepos, buildServices, envelope, ENDPOINTS, API_VERSION, buildSnapshot };
