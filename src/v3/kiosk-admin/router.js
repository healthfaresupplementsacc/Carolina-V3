'use strict';
/**
 * HEALTHFARE V3 — OPERADORES NO PAINEL — /api/v3/kiosk-admin/* (Bruno 09-11).
 *
 *  "Na página de admin eu deveria conseguir ver o PIN de todos (se esquecerem eu falo).
 *   No sandbox eu deveria poder 'logar como' pra ver o que aparece pra eles e achar bugs.
 *   O sandbox precisa de um PIN falso: digito 9999, um monte de números e um 0, e funciona.
 *   Em Usuários & Acessos eu vejo todos os operadores, os PINs, e edito o que cada um vê."
 *
 *  PIN LEGÍVEL: v3.persons.pin_plain (migration 092), gravado junto do hash toda vez que
 *  um PIN é definido por aqui. Só sai por GET /operators, que exige `manage_users` (ou
 *  admin) e grava audit 'operators.pins_viewed' a cada leitura. Login continua pelo hash.
 *
 *  PIN FALSO (qualquer operador, não só o sandbox): o kiosk manda o que a pessoa digitou;
 *  se vier "DDDD + números + 0" (5+ dígitos terminando em 0), o middleware aqui, montado
 *  ANTES do op.js, reduz aos 4 primeiros. Quem olha por cima do ombro vê 12 dígitos e não
 *  sabe quais valem. Nunca enfraquece: ainda precisa saber os 4 certos.
 *
 *  LOGAR COMO: POST /operators/:id/impersonate abre uma sessão de kiosk pra pessoa com
 *  `impersonated_by = <login do admin>` e devolve a URL /op/?as=<token>. O kiosk troca o
 *  token pelos dados em GET /session/:token (só página). Tudo que for feito ali é REAL,
 *  em nome da pessoa — o audit diz quem abriu.
 *
 *  O QUE CADA UM VÊ NO KIOSK: v3.persons.kiosk_prefs.hidden_groups (chaves dos grupos do
 *  catálogo); o /api/v3/kiosk/order devolve e o kiosk esconde. Dashboard = app_logins
 *  (já existe, seção por pessoa da Fase C); aqui só o vínculo pra mostrar na mesma tabela.
 */
const express = require('express');
const opAuth = require('../../lib/op-auth');
const { makeAuthMiddleware, hasFunction } = require('../data/auth');

const BASE = '/api/v3/kiosk-admin';
const FAKE_PIN_RE = /^(\d{4})\d*0$/;

/** Reduz "DDDD…0" aos 4 dígitos. Fora do padrão devolve o que veio. */
function normalizeTypedPin(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = FAKE_PIN_RE.exec(s);
  return m ? m[1] : s;
}
function extractBearer(req) { const h = String(req.headers.authorization || ''); return h.startsWith('Bearer ') ? h.slice(7) : null; }

function createKioskAdminRouter(deps = {}) {
  const db = deps.db;
  const operatorToken = deps.operatorToken !== undefined ? deps.operatorToken : process.env.OPERATOR_PAGE_TOKEN;
  const router = express.Router();
  const ok = (res, data) => res.json({ data });
  const err = (res, code, message, status) => res.status(status || 400).json({ error: { code, message } });

  // ── PIN FALSO: reescreve o corpo do login do kiosk antes do op.js ler ──
  router.post('/api/v3/op/auth/login', express.json({ limit: '4kb' }), (req, _res, next) => {
    if (req.body && req.body.pin != null) { const n = normalizeTypedPin(req.body.pin); if (n !== String(req.body.pin)) req.body.pin = n; }
    next();
  });

  router.use(BASE, express.json({ limit: '32kb' }));

  // ── kiosk: troca o token do "logar como" pelos dados da sessão ──
  router.get(BASE + '/session/:token', async (req, res) => {
    try {
      const t = extractBearer(req);
      if (!operatorToken || t !== operatorToken) return err(res, 'invalid_page_token', 'página inválida', 401);
      const s = await opAuth.getSession(db, req.params.token);
      if (!s) return err(res, 'invalid_session', 'sessão inválida ou expirada', 401);
      const imp = (await db.query('SELECT impersonated_by FROM v3.operator_sessions WHERE id = $1', [s.session_id])).rows[0];
      if (!imp || !imp.impersonated_by) return err(res, 'not_impersonation', 'essa sessão não foi aberta pelo painel', 403);
      ok(res, { session_token: req.params.token, impersonated_by: imp.impersonated_by,
        person: { id: s.person_id, display_name: s.display_name, role: s.role, count_exempt: !!s.count_exempt, is_sandbox: !!s.is_sandbox },
        auto_logoff_seconds: s.auto_logoff_seconds || 30 });
    } catch (e) { console.error('[kiosk-admin]', e.message); err(res, 'internal', e.message, 500); }
  });

  // ── painel (PIN do dashboard + manage_users) ──
  const gate = (req, res, next) => { if (!hasFunction(req.login, 'manage_users')) return err(res, 'forbidden', 'Só quem gerencia usuários vê e muda operadores.', 403); next(); };
  router.use(BASE + '/operators', makeAuthMiddleware({ db }), gate);
  async function audit(req, action, targetId, meta) {
    try { await db.query(`INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata) VALUES ('admin', NULL, $1, 'person', $2, $3::jsonb)`, [action, targetId || null, JSON.stringify({ ...(meta || {}), login: req.login && req.login.name })]); } catch (_) { /* nunca derruba */ }
  }

  router.get(BASE + '/operators', async (req, res) => {
    try {
      const rows = (await db.query(`
        SELECT p.id, p.display_name, p.role, p.active, p.is_sandbox, p.count_exempt, p.auto_logoff_seconds, p.pin_plain,
               (p.pin_hash IS NOT NULL) AS has_pin, p.kiosk_prefs,
               l.id AS login_id, l.name AS login_name, r.key AS login_role, l.active AS login_active,
               (SELECT MAX(s.last_activity_at) FROM v3.operator_sessions s WHERE s.person_id = p.id) AS last_kiosk_at
          FROM v3.persons p
          LEFT JOIN v3.app_logins l ON l.person_id = p.id AND l.active
          LEFT JOIN v3.app_roles r ON r.id = l.role_id
         WHERE p.deleted_at IS NULL
         ORDER BY p.active DESC, (p.role = 'operator') DESC, p.display_name`)).rows;
      await audit(req, 'operators.pins_viewed', null, { count: rows.filter((x) => x.pin_plain).length });
      ok(res, { operators: rows.map((x) => ({ ...x, pin: x.pin_plain, pin_plain: undefined, pin_unknown: !!x.has_pin && !x.pin_plain })) });
    } catch (e) { console.error('[kiosk-admin]', e.message); err(res, 'internal', e.message, 500); }
  });

  router.post(BASE + '/operators/:id/pin', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10); const pin = String((req.body || {}).pin || '').trim();
      if (!id) return err(res, 'bad_id', 'id inválido');
      if (!/^\d{4}$/.test(pin)) return err(res, 'bad_pin_format', 'PIN tem 4 dígitos');
      const dup = (await db.query('SELECT id, display_name FROM v3.persons WHERE active AND deleted_at IS NULL AND id <> $1 AND pin_plain = $2', [id, pin])).rows[0];
      if (dup) return err(res, 'pin_taken', 'Esse PIN já é de ' + dup.display_name, 409);
      const h = opAuth.hashPin(pin);
      const r = await db.query('UPDATE v3.persons SET pin_hash = $2, pin_salt = $3, pin_plain = $4, updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id, display_name', [id, h.pin_hash || h.hash, h.pin_salt || h.salt, pin]);
      if (!r.rows[0]) return err(res, 'not_found', 'pessoa não encontrada', 404);
      await audit(req, 'operators.pin_set', id, { person: r.rows[0].display_name });
      ok(res, { id, pin });
    } catch (e) { console.error('[kiosk-admin]', e.message); err(res, 'internal', e.message, 500); }
  });

  router.post(BASE + '/operators/:id/kiosk-prefs', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10); if (!id) return err(res, 'bad_id', 'id inválido');
      const b = req.body || {}; const hidden = Array.isArray(b.hidden_groups) ? b.hidden_groups.map(String).filter((x) => /^[a-z_]{1,32}$/.test(x)) : [];
      const r = await db.query(`UPDATE v3.persons SET kiosk_prefs = COALESCE(kiosk_prefs, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id, kiosk_prefs`, [id, JSON.stringify({ hidden_groups: hidden })]);
      if (!r.rows[0]) return err(res, 'not_found', 'pessoa não encontrada', 404);
      await audit(req, 'operators.kiosk_prefs', id, { hidden_groups: hidden });
      ok(res, { id, kiosk_prefs: r.rows[0].kiosk_prefs });
    } catch (e) { console.error('[kiosk-admin]', e.message); err(res, 'internal', e.message, 500); }
  });

  router.post(BASE + '/operators/:id/impersonate', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10); if (!id) return err(res, 'bad_id', 'id inválido');
      const p = (await db.query("SELECT id, display_name FROM v3.persons WHERE id = $1 AND active AND deleted_at IS NULL AND role = 'operator'", [id])).rows[0];
      if (!p) return err(res, 'not_found', 'operador não encontrado (ou inativo)', 404);
      const s = await opAuth.createSession(db, { personId: p.id, ip: req.ip || 'painel', userAgent: 'impersonate:' + ((req.login && req.login.name) || 'admin') });
      const token = s && (s.session_token || s.token);
      await db.query('UPDATE v3.operator_sessions SET impersonated_by = $2 WHERE session_token = $1', [token, (req.login && req.login.name) || 'admin']);
      await audit(req, 'operators.impersonate', p.id, { person: p.display_name });
      ok(res, { id: p.id, person: p.display_name, token, url: '/op/?as=' + encodeURIComponent(token) });
    } catch (e) { console.error('[kiosk-admin]', e.message); err(res, 'internal', e.message, 500); }
  });

  return router;
}

module.exports = { createKioskAdminRouter, normalizeTypedPin, BASE };
