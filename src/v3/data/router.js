'use strict';
/**
 * HEALTHFARE V3 — Bloco 0 / Etapa 2 — API de dados JSON.
 *
 * GET /api/v3/data/* — contrato ESTÁVEL e VERSIONADO (v3) entre o
 * cérebro e qualquer cliente (dashboard, BI, sistema externo). O
 * cérebro não conhece os clientes; isto é a única porta de leitura.
 *
 * - Retorna JSON puro, nunca HTML.
 * - Envelope { meta:{version,tz,date?,generated_at}, data }.
 * - Auth na borda (middleware único, ver auth.js).
 * - Os repos (src/v3/data/*) devolvem só `data`; o envelope é montado
 *   AQUI — assim os handlers HTML reusam os mesmos repos sem envelope.
 *
 * ADITIVO: rotas novas. Não toca nada existente (HTML, shadow, worker).
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
const { toNyIso, TZ } = require('./ny-date');
const { makeAuthMiddleware } = require('./auth');

const API_VERSION = 'v3';

/** Instancia os repos de leitura sobre um pool/cliente pg. */
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
  };
}

/** Envelope padrão da API. `data` = payload do repo. */
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

/**
 * Cada endpoint: handler async (req, repos) → { data, meta? }.
 * O router enrola em envelope() e responde JSON. Exportado pra teste.
 */
const ENDPOINTS = [
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
];

/**
 * Router Express da API de dados. Montar com app.use('/', router)
 * — igual ao admin-v3. deps.db = pool pg; deps.repos injetável (teste).
 */
function createDataRouter(deps = {}) {
  const express = require('express');
  const router = express.Router();
  const repos = deps.repos || buildRepos(deps.db);

  // auth na borda — protege TODO o /api/v3/data/*
  router.use('/api/v3/data', makeAuthMiddleware(deps));

  for (const ep of ENDPOINTS) {
    router.get(ep.path, async (req, res) => {
      try {
        const out = await ep.handler(req, repos);
        res.json(envelope(out.data, out.meta));
      } catch (e) {
        console.error('[v3-data] erro em', ep.path, '-', e.message);
        res.status(500).json({ error: { code: 'internal', message: e.message } });
      }
    });
  }

  console.log('[V3] API de dados montada: GET /api/v3/data/* (' + ENDPOINTS.length + ' endpoints)');
  return router;
}

module.exports = { createDataRouter, buildRepos, envelope, ENDPOINTS, API_VERSION };
