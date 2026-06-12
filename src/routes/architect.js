'use strict';
/**
 * HEALTHFARE V3 — Architect API (read-only). 11 endpoints.
 *
 * Auth: Authorization: Bearer <token>
 *   ARCHITECT_API_TOKEN  → scope 'architect' (tudo, sem rate-limit)
 *   OPERATOR_PAGE_TOKEN  → scope 'operator_page' (só [OP], rate-limit
 *                          60/min/IP, campos filtrados)
 *
 * Todas as chamadas são auditadas em v3.audit_log
 * (action='architect_api_access') — inclusive 401/403/429.
 *
 * ENDPOINTS (todos GET, JSON):
 *  ARCHITECT-ONLY:
 *   [A1] /api/v3/architect/snapshot?date=YYYY-MM-DD     estado do dia
 *   [A2] /api/v3/architect/audit?date=&limit=100        audit_log do dia
 *   [A3] /api/v3/architect/event/:id                    drill-down + audit trail
 *   [A4] /api/v3/architect/health                       worker/db/fila/latência
 *   [A5] /api/v3/architect/diagnostics/orphans          events↔messages órfãos 24h
 *   [A6] /api/v3/architect/diagnostics/queue            fila + pending_commands
 *   [A7] /api/v3/architect/diagnostics/llm_metrics      telemetria LLM 24h
 *  ARCHITECT + OPERATOR_PAGE:
 *   [OP1/A8]  /api/v3/architect/persons                 (op: só operators ativos)
 *   [OP2/A9]  /api/v3/architect/person/:id/today        (op: exige X-Operator-Id = :id)
 *   [OP3/A10] /api/v3/architect/open_events             (op: campos restritos)
 *   [OP4/A11] /api/v3/architect/supplements?q=          autocomplete top-20
 *
 * Exemplos curl:
 *   curl -H "Authorization: Bearer $ARCHITECT_API_TOKEN" \
 *     "https://<host>/api/v3/architect/health"
 *   curl -H "Authorization: Bearer $ARCHITECT_API_TOKEN" \
 *     "https://<host>/api/v3/architect/snapshot?date=2026-06-12"
 *   curl -H "Authorization: Bearer $OPERATOR_PAGE_TOKEN" -H "X-Operator-Id: 4" \
 *     "https://<host>/api/v3/architect/person/4/today"
 */
const express = require('express');
const { makeArchitectAuth, requireScope, makeRateLimiter } = require('../middleware/architect-auth');
const { makeArchitectAudit } = require('../middleware/architect-audit');
const q = require('../lib/architect-queries');

const BASE = '/api/v3/architect';

/**
 * @param {object} deps
 *   db              — pool pg (query)
 *   architectToken  — default process.env.ARCHITECT_API_TOKEN
 *   operatorToken   — default process.env.OPERATOR_PAGE_TOKEN
 *   rateLimit       — { limit, windowMs, now } opcional (teste)
 */
function createArchitectRouter(deps = {}) {
  const db = deps.db;
  const architectToken = deps.architectToken !== undefined ? deps.architectToken : process.env.ARCHITECT_API_TOKEN;
  const operatorToken = deps.operatorToken !== undefined ? deps.operatorToken : process.env.OPERATOR_PAGE_TOKEN;

  const router = express.Router();
  // ordem: audit (loga TUDO) → auth (401) → rate-limit (429 só operator_page)
  router.use(BASE, makeArchitectAudit({ db }));
  router.use(BASE, makeArchitectAuth({ architectToken, operatorToken }));
  router.use(BASE, makeRateLimiter(deps.rateLimit || {}));

  const onlyArchitect = requireScope('architect');
  const both = requireScope('architect', 'operator_page');

  // helper: handler async com tratamento de erro uniforme
  const h = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      console.error('[architect] erro em', req.path, '—', e.message);
      res.status(500).json({ error: 'internal', detail: e.message });
    }
  };

  // valida ?date= (400 se malformada); retorna null = hoje EDT
  const parseDate = (req, res) => {
    const d = q.validDateOrNull(req.query.date);
    if (d === undefined) {
      res.status(400).json({ error: 'bad_date', detail: 'use date=YYYY-MM-DD' });
      return undefined;
    }
    return d;
  };

  // ── ARCHITECT-ONLY ──────────────────────────────────────────
  router.get(`${BASE}/snapshot`, onlyArchitect, h(async (req, res) => {
    const date = parseDate(req, res);
    if (date === undefined) return;
    res.json(await q.snapshotDay(db, date));
  }));

  router.get(`${BASE}/audit`, onlyArchitect, h(async (req, res) => {
    const date = parseDate(req, res);
    if (date === undefined) return;
    res.json(await q.auditByDate(db, date, req.query.limit));
  }));

  router.get(`${BASE}/event/:id`, onlyArchitect, h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
    const detail = await q.eventDetail(db, id);
    if (!detail) return res.status(404).json({ error: 'event_not_found', id });
    res.json(detail);
  }));

  router.get(`${BASE}/health`, onlyArchitect, h(async (req, res) => {
    res.json(await q.health(db));
  }));

  router.get(`${BASE}/diagnostics/orphans`, onlyArchitect, h(async (req, res) => {
    res.json(await q.orphans(db));
  }));

  router.get(`${BASE}/diagnostics/queue`, onlyArchitect, h(async (req, res) => {
    res.json(await q.queueDiag(db));
  }));

  router.get(`${BASE}/diagnostics/llm_metrics`, onlyArchitect, h(async (req, res) => {
    res.json(await q.llmMetrics24h(db));
  }));

  // ── ARCHITECT + OPERATOR_PAGE ───────────────────────────────
  router.get(`${BASE}/persons`, both, h(async (req, res) => {
    res.json({ persons: await q.personsList(db, { scope: req.architectScope }) });
  }));

  router.get(`${BASE}/person/:id/today`, both, h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
    if (req.architectScope === 'operator_page') {
      // operador só vê as próprias tasks
      const opId = parseInt(req.headers['x-operator-id'], 10);
      if (!Number.isFinite(opId) || opId !== id) {
        return res.status(403).json({ error: 'operator_id_mismatch' });
      }
    }
    res.json({ person_id: id, events: await q.personToday(db, id) });
  }));

  router.get(`${BASE}/open_events`, both, h(async (req, res) => {
    res.json(await q.openEvents(db, { scope: req.architectScope }));
  }));

  router.get(`${BASE}/supplements`, both, h(async (req, res) => {
    res.json({ supplements: await q.supplementsSearch(db, req.query.q) });
  }));

  return router;
}

module.exports = { createArchitectRouter, BASE };
