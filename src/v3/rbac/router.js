'use strict';
/**
 * HEALTHFARE V3 — RBAC POR PESSOA — API /api/v3/rbac/* (Fase C, Bruno 09-10).
 *
 * "Ajusta no Usuários & Acessos e lá a gente define como quiser; uma seção
 * específica de controle de estoque; níveis diferentes; o sistema nunca chama
 * ninguém de manager, supervisor ou gestão."
 *
 * O que este router faz (e o data router NÃO cresce):
 *   GET  /me                → quem sou, funções efetivas, níveis de estoque
 *   GET  /login-functions   → (manage_users) cada login com as funções do perfil e
 *                             os ajustes por pessoa; + o catálogo das funções
 *   POST /login-function    → (manage_users) { login_id, function_key, state }
 *                             state: 'grant' (dá por cima do perfil) | 'revoke'
 *                             (tira) | 'inherit' (volta a seguir o perfil)
 *   GET  /inbox             → notificações pendentes DIRIGIDAS a mim (audience por
 *                             função ou por login) — o destino do clique vem em `link`
 *
 * CONTRATO: envelope { data } / { error:{ code, message } }, como o resto.
 * AUTH: makeAuthMiddleware (PIN → v3.app_logins). Login de emergência (id 0)
 * lê tudo mas não grava ajuste por pessoa (não tem conta).
 */
const express = require('express');
const { makeAuthMiddleware, hasFunction, stockLevelsOf } = require('../data/auth');

const BASE = '/api/v3/rbac';
const STATES = ['grant', 'revoke', 'inherit'];

function createRbacRouter(deps = {}) {
  const db = deps.db;
  const router = express.Router();
  router.use(BASE, express.json({ limit: '64kb' }));
  router.use(BASE, makeAuthMiddleware({ db }));

  const ok = (res, data) => res.json({ data });
  const err = (res, code, message, status) => res.status(status || 400).json({ error: { code, message } });
  const h = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
      const status = e && e.status ? e.status : 500;
      if (status === 500) console.error('[rbac]', req.method, req.path, '-', e.message);
      err(res, (e && e.code) || (status === 500 ? 'internal' : 'bad_request'), e.message, status);
    }
  };
  const bad = (msg) => { const e = new Error(msg); e.status = 400; return e; };
  async function audit(req, action, targetId, metadata) {
    try {
      await db.query(
        `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
         VALUES ('admin', NULL, $1, 'app_login', $2, $3::jsonb)`,
        [action, targetId || null, JSON.stringify({ ...(metadata || {}), login: req.login && req.login.name })]);
    } catch (_) { /* auditoria nunca derruba a operação */ }
  }

  router.get(BASE + '/me', h(async (req, res) => {
    const l = req.login || {};
    ok(res, { login: { id: l.id, name: l.name, role: l.role, functions: l.functions || [], overrides: l.overrides || null },
      stock_levels: stockLevelsOf(l) });
  }));

  router.get(BASE + '/login-functions', h(async (req, res) => {
    if (!hasFunction(req.login, 'manage_users')) return err(res, 'forbidden', 'Só quem gerencia usuários vê os ajustes por pessoa.', 403);
    const fns = (await db.query(`SELECT key, label, category FROM v3.app_functions ORDER BY category, key`)).rows;
    const logins = (await db.query(`
      SELECT l.id, l.name, l.active, r.key AS role, r.name AS role_name,
             COALESCE((SELECT array_agg(rf.function_key ORDER BY rf.function_key) FROM v3.role_functions rf WHERE rf.role_id = r.id), '{}') AS role_functions,
             COALESCE((SELECT json_object_agg(lf.function_key, lf.granted) FROM v3.login_functions lf WHERE lf.login_id = l.id), '{}'::json) AS overrides
        FROM v3.app_logins l JOIN v3.app_roles r ON r.id = l.role_id
       ORDER BY l.active DESC, l.name`)).rows;
    ok(res, { functions: fns, logins });
  }));

  router.post(BASE + '/login-function', h(async (req, res) => {
    if (!hasFunction(req.login, 'manage_users')) return err(res, 'forbidden', 'Só quem gerencia usuários muda função por pessoa.', 403);
    const b = req.body || {};
    const loginId = Number(b.login_id); const key = String(b.function_key || '').trim(); const state = String(b.state || '').trim();
    if (!loginId) throw bad('login_id obrigatório');
    if (!key) throw bad('function_key obrigatório');
    if (!STATES.includes(state)) throw bad('state inválido (grant, revoke ou inherit)');
    const fn = (await db.query('SELECT key FROM v3.app_functions WHERE key = $1', [key])).rows[0];
    if (!fn) throw bad('função não existe: ' + key);
    const target = (await db.query('SELECT id, name FROM v3.app_logins WHERE id = $1', [loginId])).rows[0];
    if (!target) throw bad('login não existe: ' + loginId);
    if (state === 'inherit') {
      await db.query('DELETE FROM v3.login_functions WHERE login_id = $1 AND function_key = $2', [loginId, key]);
    } else {
      await db.query(
        `INSERT INTO v3.login_functions (login_id, function_key, granted, updated_at, updated_by)
         VALUES ($1, $2, $3, NOW(), $4)
         ON CONFLICT (login_id, function_key) DO UPDATE SET granted = $3, updated_at = NOW(), updated_by = $4`,
        [loginId, key, state === 'grant', (req.login && req.login.name) || null]);
    }
    await audit(req, 'rbac.login_function', loginId, { function_key: key, state, target: target.name });
    ok(res, { ok: true, login_id: loginId, function_key: key, state });
  }));

  // Notificações pendentes dirigidas a mim: audience.functions ∩ minhas funções,
  // ou audience.login_ids contém meu id. Sem audience = de todo mundo (legado),
  // que continua no sino geral; aqui só o que tem destinatário.
  router.get(BASE + '/inbox', h(async (req, res) => {
    const l = req.login || {};
    const fns = l.functions || [];
    const all = fns.includes('*');
    const rows = (await db.query(`
      SELECT id, type, payload, status, link, audience, created_at
        FROM v3.notifications
       WHERE status = 'pending' AND audience IS NOT NULL
       ORDER BY created_at DESC LIMIT 200`)).rows;
    const mine = rows.filter((n) => {
      const a = n.audience || {};
      const byFn = Array.isArray(a.functions) && (all || a.functions.some((f) => fns.includes(f) || (f.startsWith('stock_') && fns.includes('manage_stock'))));
      const byId = Array.isArray(a.login_ids) && a.login_ids.includes(l.id);
      return byFn || byId;
    });
    ok(res, { count: mine.length, notifications: mine.slice(0, 50) });
  }));

  return router;
}

module.exports = { createRbacRouter, BASE };
