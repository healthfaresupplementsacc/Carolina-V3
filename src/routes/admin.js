'use strict';
/**
 * HEALTHFARE V3 — Admin Panel API (/api/admin/*). Fases B+C do bloco noturno.
 *
 * NOVO path — NÃO toca o dashboard V4 admin existente (R8).
 *
 * Auth: ADMIN_PASSWORD (env) → POST /api/admin/auth/login → token HMAC
 * stateless (8h) em cookie HttpOnly `hf_admin` (a UI usa cookie; clients
 * podem mandar Authorization: Bearer <token>). Rate-limit 3 tentativas/5min/IP.
 *
 * Operators:
 *   GET  /api/admin/operators                      lista + sessões/último event
 *   POST /api/admin/operators/:id/pin              {pin} re-hash scrypt
 *   PUT  /api/admin/operators/:id/auto-logoff      {seconds|null}
 *   PUT  /api/admin/operators/:id/count-exempt     {exempt}
 *   PUT  /api/admin/operators/:id/active           {active} (false força logout)
 *   POST /api/admin/operators/:id/force-logout
 *   GET  /api/admin/operators/:id/sessions         últimas 30d
 *   GET  /api/admin/operators/:id/events           últimos 7d (read-only)
 *
 * Notifications (Fase C):
 *   GET  /api/admin/notifications?status=&type=&limit=&offset=
 *   POST /api/admin/notifications/:id/accept|reject|edit
 */
const express = require('express');
const crypto = require('crypto');
const opAuth = require('../lib/op-auth');

const SESSION_HOURS = 8;
const LOGIN_LIMIT = 3;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const EDT = 'America/New_York';

function signToken(password, expMs) {
  const mac = crypto.createHmac('sha256', String(password)).update('hf-admin:' + expMs).digest('hex');
  return expMs + '.' + mac;
}
function verifyToken(password, token, nowMs) {
  if (!password || !token) return false;
  const [expStr, mac] = String(token).split('.');
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < nowMs) return false;
  const expect = crypto.createHmac('sha256', String(password)).update('hf-admin:' + exp).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(mac || '', 'hex'), Buffer.from(expect, 'hex')); }
  catch (_) { return false; }
}
function tokenFromReq(req) {
  const h = (req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m) return m[1].trim();
  const cookie = req.headers.cookie || '';
  const cm = /(?:^|;\s*)hf_admin=([^;]+)/.exec(cookie);
  return cm ? decodeURIComponent(cm[1]) : null;
}

function createAdminRouter(deps = {}) {
  const db = deps.db;
  const slack = deps.slack || null; // { postAs, updateMessage }
  const password = deps.adminPassword !== undefined ? deps.adminPassword : process.env.ADMIN_PASSWORD;
  const now = deps.now || Date.now;
  const router = express.Router();
  router.use(express.json({ limit: '128kb' }));

  async function audit(action, targetType, targetId, metadata) {
    try {
      await db.query(
        `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
         VALUES ('admin', NULL, $1, $2, $3, $4::jsonb)`,
        [action, targetType, targetId, JSON.stringify(metadata || {})]);
    } catch (e) { console.error('[admin] audit falhou:', e.message); }
  }

  const h = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
      console.error('[admin] erro em', req.path, '—', e.message);
      res.status(500).json({ error: 'internal', detail: e.message });
    }
  };

  // ── auth ────────────────────────────────────────────────────
  const loginHits = new Map();
  router.post('/api/admin/auth/login', h(async (req, res) => {
    const ip = req.ip || 'unknown';
    const t = now();
    let e = loginHits.get(ip);
    if (!e || t - e.windowStart >= LOGIN_WINDOW_MS) { e = { count: 0, windowStart: t }; loginHits.set(ip, e); }
    e.count += 1;
    if (e.count > LOGIN_LIMIT) {
      await audit('admin_login_rate_limited', 'admin', null, { ip });
      return res.status(429).json({ error: 'too_many_attempts' });
    }
    const given = String((req.body && req.body.password) || '');
    if (!password || given !== password) {
      await audit('admin_login_failed', 'admin', null, { ip });
      return res.status(401).json({ error: 'wrong_password' });
    }
    const exp = t + SESSION_HOURS * 3600 * 1000;
    const token = signToken(password, exp);
    await audit('admin_login_success', 'admin', null, { ip });
    res.set('Set-Cookie', `hf_admin=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_HOURS * 3600}; SameSite=Lax; Secure`);
    res.json({ ok: true, token, expires_at: new Date(exp).toISOString() });
  }));

  router.post('/api/admin/auth/logout', h(async (req, res) => {
    res.set('Set-Cookie', 'hf_admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure');
    res.json({ ok: true });
  }));

  // gate de sessão pra tudo abaixo
  const requireAdmin = (req, res, next) => {
    if (verifyToken(password, tokenFromReq(req), now())) return next();
    return res.status(401).json({ error: 'unauthorized' });
  };
  router.use('/api/admin/operators', requireAdmin);
  router.use('/api/admin/notifications', requireAdmin);

  // ── operators ───────────────────────────────────────────────
  router.get('/api/admin/operators', h(async (req, res) => {
    const r = await db.query(`
      SELECT p.id, p.display_name, (p.pin_hash IS NOT NULL) AS has_pin,
             p.auto_logoff_seconds, p.count_exempt, p.active AS is_active,
             p.last_page_login_at,
             (SELECT COUNT(*)::int FROM v3.operator_sessions s
              WHERE s.person_id = p.id AND s.logged_out_at IS NULL
                AND s.last_activity_at > NOW() - INTERVAL '16 hours') AS active_session_count,
             (SELECT MAX(e.started_at) FROM v3.events e
              WHERE e.person_id = p.id AND e.deleted_at IS NULL) AS last_event_at
      FROM v3.persons p
      WHERE p.role = 'operator' AND p.deleted_at IS NULL
      ORDER BY p.display_name LIMIT 100`);
    res.json({ operators: r.rows });
  }));

  router.post('/api/admin/operators/:id/pin', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const pin = String((req.body && req.body.pin) || '');
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'bad_pin_format', detail: '4 dígitos' });
    const { pin_hash, pin_salt } = opAuth.hashPin(pin);
    const r = await db.query(
      `UPDATE v3.persons SET pin_hash=$2, pin_salt=$3, updated_at=NOW()
       WHERE id=$1 AND role='operator' RETURNING id, display_name`, [id, pin_hash, pin_salt]);
    if (!r.rows[0]) return res.status(404).json({ error: 'operator_not_found' });
    await audit('person.pin_changed', 'person', id, { via: 'admin_panel' });
    res.json({ ok: true, id });
  }));

  router.put('/api/admin/operators/:id/auto-logoff', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const raw = req.body ? req.body.seconds : undefined;
    const seconds = raw === null ? null : parseInt(raw, 10);
    if (seconds !== null && (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600)) {
      return res.status(400).json({ error: 'bad_seconds' });
    }
    const r = await db.query(
      `UPDATE v3.persons SET auto_logoff_seconds=$2, updated_at=NOW()
       WHERE id=$1 AND role='operator' RETURNING id, auto_logoff_seconds`, [id, seconds]);
    if (!r.rows[0]) return res.status(404).json({ error: 'operator_not_found' });
    await audit('operator.auto_logoff_set', 'person', id, { seconds });
    res.json(r.rows[0]);
  }));

  router.put('/api/admin/operators/:id/count-exempt', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const exempt = !!(req.body && req.body.exempt);
    const r = await db.query(
      `UPDATE v3.persons SET count_exempt=$2, updated_at=NOW()
       WHERE id=$1 AND role='operator' RETURNING id, count_exempt`, [id, exempt]);
    if (!r.rows[0]) return res.status(404).json({ error: 'operator_not_found' });
    await audit('operator.count_exempt_set', 'person', id, { exempt });
    res.json(r.rows[0]);
  }));

  async function forceLogout(id) {
    const r = await db.query(
      `UPDATE v3.operator_sessions SET logged_out_at=NOW(), logoff_reason='admin_force'
       WHERE person_id=$1 AND logged_out_at IS NULL RETURNING id`, [id]);
    return r.rowCount;
  }

  router.put('/api/admin/operators/:id/active', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const active = !!(req.body && req.body.active);
    const r = await db.query(
      `UPDATE v3.persons SET active=$2, updated_at=NOW()
       WHERE id=$1 AND role='operator' RETURNING id, active`, [id, active]);
    if (!r.rows[0]) return res.status(404).json({ error: 'operator_not_found' });
    let closed = 0;
    if (!active) closed = await forceLogout(id);
    await audit('operator.active_set', 'person', id, { active, sessions_closed: closed });
    res.json({ id, active, sessions_closed: closed });
  }));

  router.post('/api/admin/operators/:id/force-logout', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const closed = await forceLogout(id);
    await audit('operator.force_logout', 'person', id, { sessions_closed: closed });
    res.json({ ok: true, sessions_closed: closed });
  }));

  router.get('/api/admin/operators/:id/sessions', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const r = await db.query(`
      SELECT id, source, ip_address, created_at, last_activity_at, logged_out_at, logoff_reason
      FROM v3.operator_sessions
      WHERE person_id=$1 AND created_at > NOW() - INTERVAL '30 days'
      ORDER BY created_at DESC LIMIT 100`, [id]);
    res.json({ sessions: r.rows });
  }));

  router.get('/api/admin/operators/:id/events', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const r = await db.query(`
      SELECT e.id, at.slug, pb.batch_number, e.source,
             to_char(e.started_at AT TIME ZONE '${EDT}', 'MM-DD HH12:MI AM') AS started_edt,
             CASE WHEN e.ended_at IS NULL THEN NULL
                  ELSE to_char(e.ended_at AT TIME ZONE '${EDT}', 'MM-DD HH12:MI AM') END AS ended_edt,
             e.is_long_running
      FROM v3.events e
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
      WHERE e.person_id=$1 AND e.deleted_at IS NULL
        AND e.started_at > NOW() - INTERVAL '7 days'
      ORDER BY e.started_at DESC LIMIT 200`, [id]);
    res.json({ events: r.rows });
  }));

  // ── notifications inbox (Fase C) ────────────────────────────
  router.get('/api/admin/notifications', h(async (req, res) => {
    const status = req.query.status === 'all' ? null : (req.query.status || 'pending');
    const type = (!req.query.type || req.query.type === 'all') ? null : String(req.query.type);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const r = await db.query(`
      SELECT id, type, payload, status, admin_action_by, admin_response_text,
             carolina_slack_ts, created_at, resolved_at,
             to_char(created_at AT TIME ZONE '${EDT}', 'MM-DD HH12:MI AM') AS created_edt
      FROM v3.notifications
      WHERE ($1::text IS NULL OR status = $1)
        AND ($2::text IS NULL OR type = $2)
      ORDER BY id DESC LIMIT $3 OFFSET $4`, [status, type, limit, offset]);
    const pend = await db.query(`SELECT COUNT(*)::int AS n FROM v3.notifications WHERE status='pending'`);
    res.json({ notifications: r.rows, pending_total: pend.rows[0].n });
  }));

  async function loadPendingNotif(id) {
    const r = await db.query(`SELECT * FROM v3.notifications WHERE id=$1 AND status='pending' LIMIT 1`, [id]);
    return r.rows[0] || null;
  }
  async function updateCarolinaMsg(notif, text) {
    if (!slack || !slack.updateMessage || !notif.carolina_slack_ts) return;
    try {
      await slack.updateMessage({ channel: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1', ts: notif.carolina_slack_ts, text });
    } catch (e) { console.error('[admin] chat.update falhou:', e.message); }
  }
  const headlineOf = (p) => `${p.person || p.text || '?'} — ${p.slug || p.error || ''}${p.batch ? ' · ' + p.batch : ''}`;

  router.post('/api/admin/notifications/:id/accept', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const notif = await loadPendingNotif(id);
    if (!notif) return res.status(404).json({ error: 'not_pending' });
    await db.query(`UPDATE v3.notifications SET status='admin_accepted', resolved_at=NOW() WHERE id=$1`, [id]);
    await audit('notification_accepted', 'notification', id, { via: 'admin_panel' });
    await updateCarolinaMsg(notif, `✅ Aceito via painel admin — ${headlineOf(notif.payload || {})}`);
    res.json({ ok: true, status: 'admin_accepted' });
  }));

  router.post('/api/admin/notifications/:id/reject', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const notif = await loadPendingNotif(id);
    if (!notif) return res.status(404).json({ error: 'not_pending' });
    await db.query(`UPDATE v3.notifications SET status='admin_rejected', resolved_at=NOW() WHERE id=$1`, [id]);
    const evId = notif.payload && notif.payload.slack_event_id ? parseInt(notif.payload.slack_event_id, 10) : null;
    if (evId && notif.type === 'slack_event_not_on_page') {
      await db.query(`UPDATE v3.events SET deleted_at=NOW(), updated_at=NOW() WHERE id=$1 AND deleted_at IS NULL`, [evId]);
      await audit('notification_rejected_event_deleted', 'event', evId, { notification_id: id, via: 'admin_panel' });
    } else {
      await audit('notification_rejected', 'notification', id, { via: 'admin_panel' });
    }
    await updateCarolinaMsg(notif, `❌ Ignorado via painel admin — ${headlineOf(notif.payload || {})}`);
    res.json({ ok: true, status: 'admin_rejected' });
  }));

  router.post('/api/admin/notifications/:id/edit', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const notif = await loadPendingNotif(id);
    if (!notif) return res.status(404).json({ error: 'not_pending' });
    const nd = (req.body && req.body.new_data) || {};
    const evId = notif.payload && notif.payload.slack_event_id ? parseInt(notif.payload.slack_event_id, 10) : null;
    if (!evId) return res.status(400).json({ error: 'no_event_to_edit' });

    // monta UPDATE só com campos permitidos e fornecidos
    const sets = []; const vals = [evId]; let i = 2;
    if (nd.batch !== undefined) {
      const b = await db.query(
        `SELECT id FROM v3.product_batches WHERE batch_number=$1 OR batch_number='BR-2026-'||$1 ORDER BY id DESC LIMIT 1`,
        [String(nd.batch)]);
      if (!b.rows[0]) return res.status(400).json({ error: 'unknown_batch' });
      sets.push(`product_batch_id=$${i++}`); vals.push(b.rows[0].id);
    }
    if (nd.person_id !== undefined) { sets.push(`person_id=$${i++}`); vals.push(parseInt(nd.person_id, 10)); }
    if (nd.slug !== undefined) {
      const a = await db.query(`SELECT id FROM v3.activity_types WHERE slug=$1 AND active=true LIMIT 1`, [String(nd.slug)]);
      if (!a.rows[0]) return res.status(400).json({ error: 'unknown_slug' });
      sets.push(`activity_type_id=$${i++}`); vals.push(a.rows[0].id);
    }
    if (nd.started_at !== undefined) { sets.push(`started_at=$${i++}`); vals.push(nd.started_at); }
    if (nd.ended_at !== undefined) { sets.push(`ended_at=$${i++}`); vals.push(nd.ended_at); }
    if (nd.note !== undefined) { sets.push(`description=COALESCE(description,'') || ' | admin: ' || $${i++}`); vals.push(String(nd.note).slice(0, 300)); }
    if (!sets.length) return res.status(400).json({ error: 'no_fields' });

    await db.query(`UPDATE v3.events SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$1`, vals);
    await db.query(
      `UPDATE v3.notifications SET status='admin_edited', resolved_at=NOW(), admin_response_text=$2 WHERE id=$1`,
      [id, JSON.stringify(nd)]);
    await audit('notification_edited', 'event', evId, { notification_id: id, new_data: nd, via: 'admin_panel' });
    await updateCarolinaMsg(notif, `📝 Editado via painel admin — ${headlineOf(notif.payload || {})} → ${JSON.stringify(nd).slice(0, 120)}`);
    res.json({ ok: true, status: 'admin_edited', event_id: evId });
  }));

  return router;
}

module.exports = { createAdminRouter, signToken, verifyToken };
