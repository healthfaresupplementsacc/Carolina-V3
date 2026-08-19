'use strict';
/**
 * HEALTHFARE V3 — FILA DE IMPRESSÃO, API /api/v3/print-queue/* (S15.34, Bruno 08-19).
 *
 * Três clientes, três credenciais, uma fila:
 *   1. ADMIN pelo celular (/m/) — header `x-admin-pin`, RBAC view_stock/manage_stock.
 *      Pede a impressão, vê a fila, cancela o que pediu.
 *   2. ESTAÇÃO logada (kiosk /print ou /op) — Bearer OPERATOR_PAGE_TOKEN + a sessão
 *      em `X-Session-Token`. É quem toma e conclui.
 *   3. AGENTE do .28 — header `x-print-token` (o MESMO PRINT_EVENT_TOKEN do
 *      /api/print-event). Nenhum conceito de auth novo entrou no sistema.
 *
 * Por que não uma auth só: cada um desses já existe e já é o jeito daquele cliente
 * falar com a gente. Inventar uma quarta credencial pra fila seria mais um segredo
 * pra guardar, e o .28 não tem como digitar PIN.
 *
 * Escrita de estoque: NENHUMA. O único efeito colateral fora da fila é carimbar
 * label_printed_at nas caixas impressas (service.stampBoxes), que é o mesmo
 * carimbo do POST /api/v3/warehouse/locations/box/:id/label-printed.
 */

const express = require('express');
const { resolveLogin, hasFunction } = require('../data/auth');
const opAuth = require('../../lib/op-auth');
const { PrintQueueService, QueueError } = require('./service');

const BASE = '/api/v3/print-queue';

const err = (res, code, message, status) =>
  res.status(status || 400).json({ error: { code, message } });

/** QueueError → HTTP; qualquer outro erro → 500 com log. */
function sendError(res, e, where) {
  if (e instanceof QueueError) return err(res, e.code, e.message, e.status);
  console.error('[print-queue]', where, '-', e.message);
  return err(res, 'internal', e.message, 500);
}

/**
 * Identidade de quem chamou, em ordem de custo (o PIN é o mais comum e o mais
 * barato; a sessão do kiosk custa uma query; o token do .28 é comparação de env).
 *
 * @returns {Promise<null|{kind, name, is_admin, can_write, is_test, login_id}>}
 */
async function identify(db, req) {
  const h = req.headers || {};

  // 1) ADMIN por PIN (mesmo resolveLogin do data/auth — zero hashing duplicado)
  const pin = (req.query && req.query.pin) || h['x-admin-pin'];
  if (pin) {
    let login = null;
    if (db) { try { login = await resolveLogin(db, pin); } catch (_) { login = null; } }
    if (login) {
      const canRead = hasFunction(login, 'view_stock') || hasFunction(login, 'manage_stock');
      if (canRead) {
        return { kind: 'admin', name: login.name || 'admin', is_admin: true,
          can_write: hasFunction(login, 'manage_stock'), is_test: false,
          login_id: login.id || null };
      }
      return null;      // PIN vale, mas não é gente de estoque
    }
  }

  // 2) KIOSK: o token da PÁGINA prova que é a nossa estação; a sessão prova QUEM.
  const auth = String(h.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const pageToken = process.env.OPERATOR_PAGE_TOKEN || null;
  if (bearer && pageToken && bearer === pageToken) {
    const sessionToken = h['x-session-token'] || null;
    if (sessionToken && db) {
      let session = null;
      try { session = await opAuth.getSession(db, sessionToken); } catch (_) { session = null; }
      if (session) {
        return { kind: 'kiosk', name: session.display_name || 'estação', is_admin: false,
          can_write: true, is_test: !!session.is_sandbox, login_id: null };
      }
    }
  }

  // 3) AGENTE do .28 — mesmo segredo do /api/print-event (op.js:416)
  const printToken = h['x-print-token'];
  const expected = process.env.PRINT_EVENT_TOKEN || null;
  if (printToken && expected && printToken === expected) {
    return { kind: 'station', name: 'Estação .28', is_admin: false,
      can_write: true, is_test: false, login_id: null };
  }

  return null;
}

function createPrintQueueRouter(deps = {}) {
  const db = deps.db;
  const queue = deps.queue || new PrintQueueService({ db });
  const router = express.Router();

  router.use(BASE, express.json({ limit: '256kb' }));

  /**
   * Envolve um handler com a auth tripla + tradução de erro.
   * mode 'read' → qualquer identidade válida; 'write' → precisa de can_write.
   */
  function route(method, path, mode, handler) {
    router[method](BASE + path, async (req, res) => {
      let who = null;
      try {
        who = await identify(db, req);
      } catch (e) {
        return sendError(res, e, method.toUpperCase() + ' ' + path);
      }
      if (!who) {
        return err(res, 'unauthorized',
          'Credencial ausente ou inválida (PIN de admin, sessão da estação ou token de impressão).', 401);
      }
      if (mode === 'write' && !who.can_write) {
        return err(res, 'forbidden', 'Este login não pode mexer na fila de impressão.', 403);
      }
      try {
        await handler(req, res, who);
      } catch (e) {
        return sendError(res, e, method.toUpperCase() + ' ' + path);
      }
    });
  }

  const ok = (res, data) => res.json({ data });

  /** `by` = quem age. O corpo pode dizer (o .28 manda o nome da máquina), mas a
   *  identidade autenticada vence quando existe nome de gente. */
  const actorName = (req, who) => {
    const fromBody = req.body && req.body.by ? String(req.body.by).trim().slice(0, 120) : null;
    if (who.kind === 'station') return fromBody || who.name;
    return who.name || fromBody || 'desconhecido';
  };

  // ── LISTAR ──────────────────────────────────────────────────
  // Sem status → 'queued' (é o que a estação quer 99% das vezes).
  route('get', '', 'read', async (req, res, who) => {
    const jobs = await queue.list({
      status: req.query.status || 'queued',
      limit: req.query.limit,
      include_test: who.is_test,
    });
    ok(res, { jobs });
  });

  route('get', '/:id', 'read', async (req, res) => {
    const job = await queue.get(req.params.id);
    if (!job) return err(res, 'not_found', 'trabalho não existe: ' + req.params.id, 404);
    ok(res, { job });
  });

  // ── TRANSIÇÕES ──────────────────────────────────────────────
  route('post', '/:id/take', 'write', async (req, res, who) => {
    ok(res, { job: await queue.take(req.params.id, actorName(req, who)) });
  });

  route('post', '/:id/done', 'write', async (req, res, who) => {
    ok(res, { job: await queue.done(req.params.id, actorName(req, who)) });
  });

  route('post', '/:id/error', 'write', async (req, res, who) => {
    const note = (req.body && req.body.note) || null;
    ok(res, { job: await queue.fail(req.params.id, actorName(req, who), note) });
  });

  route('post', '/:id/cancel', 'write', async (req, res, who) => {
    ok(res, { job: await queue.cancel(req.params.id, actorName(req, who),
      { is_admin: who.is_admin }) });
  });

  console.log('[V3] Fila de impressão montada: ' + BASE + '/*');
  return router;
}

module.exports = { createPrintQueueRouter, identify, BASE };
