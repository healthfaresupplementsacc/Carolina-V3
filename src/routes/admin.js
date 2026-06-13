'use strict';
/**
 * HEALTHFARE V3 — Admin Panel API (/api/adminpanel/*). Fases B+C do bloco noturno.
 *
 * NOVO path — NÃO toca o dashboard V4 admin existente (R8).
 *
 * Auth: ADMIN_PASSWORD (env) → POST /api/adminpanel/auth/login → token HMAC
 * stateless (8h) em cookie HttpOnly `hf_admin` (a UI usa cookie; clients
 * podem mandar Authorization: Bearer <token>). Rate-limit 3 tentativas/5min/IP.
 *
 * Operators:
 *   GET  /api/adminpanel/operators                      lista + sessões/último event
 *   POST /api/adminpanel/operators/:id/pin              {pin} re-hash scrypt
 *   PUT  /api/adminpanel/operators/:id/auto-logoff      {seconds|null}
 *   PUT  /api/adminpanel/operators/:id/count-exempt     {exempt}
 *   PUT  /api/adminpanel/operators/:id/active           {active} (false força logout)
 *   POST /api/adminpanel/operators/:id/force-logout
 *   GET  /api/adminpanel/operators/:id/sessions         últimas 30d
 *   GET  /api/adminpanel/operators/:id/events           últimos 7d (read-only)
 *
 * Notifications (Fase C):
 *   GET  /api/adminpanel/notifications?status=&type=&limit=&offset=
 *   POST /api/adminpanel/notifications/:id/accept|reject|edit
 */
const express = require('express');
const crypto = require('crypto');
const opAuth = require('../lib/op-auth');
const { makeRateLimit } = require('../middleware/security');

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
  const bf = deps.bruteForce || null; // brute-force guard (Fase D)
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
  router.post('/api/adminpanel/auth/login', h(async (req, res) => {
    const ip = req.ip || 'unknown';
    if (bf && bf.isBanned(ip)) return res.status(429).json({ error: 'ip_temporarily_blocked' });
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
      if (bf) await bf.recordFailure(ip);
      return res.status(401).json({ error: 'wrong_password' });
    }
    if (bf) bf.recordSuccess(ip);
    const exp = t + SESSION_HOURS * 3600 * 1000;
    const token = signToken(password, exp);
    await audit('admin_login_success', 'admin', null, { ip });
    res.set('Set-Cookie', `hf_admin=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_HOURS * 3600}; SameSite=Lax; Secure`);
    res.json({ ok: true, token, expires_at: new Date(exp).toISOString() });
  }));

  router.post('/api/adminpanel/auth/logout', h(async (req, res) => {
    res.set('Set-Cookie', 'hf_admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure');
    res.json({ ok: true });
  }));

  // gate de sessão pra tudo abaixo
  const requireAdmin = (req, res, next) => {
    if (verifyToken(password, tokenFromReq(req), now())) return next();
    return res.status(401).json({ error: 'unauthorized' });
  };
  router.use('/api/adminpanel/operators', requireAdmin);
  router.use('/api/adminpanel/notifications', requireAdmin, makeRateLimit({ limit: 30 }));

  // ── operators ───────────────────────────────────────────────
  router.get('/api/adminpanel/operators', h(async (req, res) => {
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

  // criar operador (Fase E)
  router.post('/api/adminpanel/operators', makeRateLimit({ limit: 10 }), h(async (req, res) => {
    const name = String((req.body && req.body.display_name) || '').trim();
    const pin = String((req.body && req.body.pin) || '');
    if (!name) return res.status(400).json({ error: 'name_required' });
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'bad_pin_format', detail: '4 dígitos' });
    const dup = await db.query(
      `SELECT 1 FROM v3.persons WHERE role='operator' AND deleted_at IS NULL AND lower(display_name)=lower($1) LIMIT 1`, [name]);
    if (dup.rows.length) return res.status(400).json({ error: 'name_taken' });
    // PIN não pode colidir com operador ativo (scrypt → compara via verify)
    const actives = await db.query(`SELECT pin_hash, pin_salt FROM v3.persons WHERE role='operator' AND active=true AND deleted_at IS NULL AND pin_hash IS NOT NULL`);
    if (actives.rows.some((p) => opAuth.verifyPin(pin, p.pin_salt, p.pin_hash))) {
      return res.status(400).json({ error: 'pin_taken', detail: 'PIN já usado por outro operador ativo.' });
    }
    const autoLogoff = (req.body && req.body.auto_logoff_seconds !== undefined) ? req.body.auto_logoff_seconds : 30;
    const countExempt = !!(req.body && req.body.count_exempt);
    const { pin_hash, pin_salt } = opAuth.hashPin(pin);
    const ins = await db.query(
      `INSERT INTO v3.persons (display_name, role, active, pin_hash, pin_salt, auto_logoff_seconds, count_exempt, created_at, updated_at)
       VALUES ($1, 'operator', true, $2, $3, $4, $5, NOW(), NOW())
       RETURNING id, display_name, auto_logoff_seconds, count_exempt`,
      [name, pin_hash, pin_salt, autoLogoff === null ? null : parseInt(autoLogoff, 10) || 30, countExempt]);
    await audit('operator.created', 'person', ins.rows[0].id, { display_name: name, via: 'admin_panel' });
    res.json({ ok: true, operator: ins.rows[0] });
  }));

  // remover operador (soft-delete; mantém events históricos) (Fase E)
  router.delete('/api/adminpanel/operators/:id', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const r = await db.query(
      `UPDATE v3.persons SET active=false, deleted_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND role='operator' AND deleted_at IS NULL RETURNING id, display_name`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'operator_not_found' });
    const closed = await db.query(
      `UPDATE v3.operator_sessions SET logged_out_at=NOW(), logoff_reason='admin_force'
       WHERE person_id=$1 AND logged_out_at IS NULL RETURNING id`, [id]);
    await audit('operator.deleted', 'person', id, { display_name: r.rows[0].display_name, sessions_closed: closed.rowCount, via: 'admin_panel' });
    res.json({ ok: true, id, sessions_closed: closed.rowCount });
  }));

  router.post('/api/adminpanel/operators/:id/pin', makeRateLimit({ limit: 5 }), h(async (req, res) => {
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

  router.put('/api/adminpanel/operators/:id/auto-logoff', h(async (req, res) => {
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

  router.put('/api/adminpanel/operators/:id/count-exempt', h(async (req, res) => {
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

  router.put('/api/adminpanel/operators/:id/active', h(async (req, res) => {
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

  router.post('/api/adminpanel/operators/:id/force-logout', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const closed = await forceLogout(id);
    await audit('operator.force_logout', 'person', id, { sessions_closed: closed });
    res.json({ ok: true, sessions_closed: closed });
  }));

  router.get('/api/adminpanel/operators/:id/sessions', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const r = await db.query(`
      SELECT id, source, ip_address, created_at, last_activity_at, logged_out_at, logoff_reason
      FROM v3.operator_sessions
      WHERE person_id=$1 AND created_at > NOW() - INTERVAL '30 days'
      ORDER BY created_at DESC LIMIT 100`, [id]);
    res.json({ sessions: r.rows });
  }));

  router.get('/api/adminpanel/operators/:id/events', h(async (req, res) => {
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
  router.get('/api/adminpanel/notifications', h(async (req, res) => {
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

  router.post('/api/adminpanel/notifications/:id/accept', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const notif = await loadPendingNotif(id);
    if (!notif) return res.status(404).json({ error: 'not_pending' });
    await db.query(`UPDATE v3.notifications SET status='admin_accepted', resolved_at=NOW() WHERE id=$1`, [id]);
    await audit('notification_accepted', 'notification', id, { via: 'admin_panel' });
    await updateCarolinaMsg(notif, `✅ Aceito via painel admin — ${headlineOf(notif.payload || {})}`);
    res.json({ ok: true, status: 'admin_accepted' });
  }));

  router.post('/api/adminpanel/notifications/:id/reject', h(async (req, res) => {
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

  router.post('/api/adminpanel/notifications/:id/edit', h(async (req, res) => {
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

  // ── ações das notifs proativas (Fase G) ────────────────────
  router.post('/api/adminpanel/notifications/:id/force-logout', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const notif = await loadPendingNotif(id);
    if (!notif) return res.status(404).json({ error: 'not_pending' });
    const sid = notif.payload && notif.payload.session_id;
    let closed = 0;
    if (sid) {
      const r = await db.query(
        `UPDATE v3.operator_sessions SET logged_out_at=NOW(), logoff_reason='admin_force'
         WHERE id=$1 AND logged_out_at IS NULL RETURNING id`, [sid]);
      closed = r.rowCount;
    }
    await db.query(`UPDATE v3.notifications SET status='admin_accepted', resolved_at=NOW() WHERE id=$1`, [id]);
    await audit('notification_force_logout', 'notification', id, { session_id: sid, closed });
    await updateCarolinaMsg(notif, `💤 Logout forçado via painel — ${(notif.payload || {}).person || ''} (${closed} sessão)`);
    res.json({ ok: true, sessions_closed: closed });
  }));

  router.post('/api/adminpanel/notifications/:id/close-event', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const notif = await loadPendingNotif(id);
    if (!notif) return res.status(404).json({ error: 'not_pending' });
    const evId = notif.payload && notif.payload.event_id;
    let closed = false;
    if (evId) {
      const r = await db.query(
        `UPDATE v3.events SET ended_at=NOW(), closed_reason='admin_close_via_notification', updated_at=NOW()
         WHERE id=$1 AND ended_at IS NULL AND deleted_at IS NULL RETURNING id`, [evId]);
      closed = r.rowCount > 0;
    }
    await db.query(`UPDATE v3.notifications SET status='admin_accepted', resolved_at=NOW() WHERE id=$1`, [id]);
    await audit('notification_close_event', 'event', evId, { notification_id: id, closed });
    await updateCarolinaMsg(notif, `⏱️ Fechado via painel — ev${evId}`);
    res.json({ ok: true, closed });
  }));

  // ── analytics (Fase B) ──────────────────────────────────────
  router.use('/api/adminpanel/analytics', requireAdmin, makeRateLimit({ limit: 60 }));
  const rangeDays = (r) => ({ '7d': 7, '30d': 30, '90d': 90 }[String(r)] || 7);
  // duração só conta events FECHADOS (ended_at não-null) pra não inflar com abertos
  const DUR_MIN = `EXTRACT(EPOCH FROM (e.ended_at - e.started_at)) / 60.0`;

  router.get('/api/adminpanel/analytics/summary', h(async (req, res) => {
    const days = rangeDays(req.query.range);
    const since = `NOW() - INTERVAL '${days} days'`;
    const [tot, bottles, topSup, topOps, durBySlug, daily] = await Promise.all([
      db.query(`SELECT COUNT(*)::int n FROM v3.events e WHERE e.deleted_at IS NULL AND e.started_at > ${since}`),
      db.query(`SELECT COALESCE(SUM(bottles),0)::int n FROM v3.production_counts WHERE deleted_at IS NULL AND created_at > ${since}`),
      db.query(`
        SELECT pr.canonical_name AS product, COUNT(e.id)::int AS events
        FROM v3.events e JOIN v3.product_batches pb ON pb.id=e.product_batch_id
        JOIN v3.products pr ON pr.id=pb.product_id
        WHERE e.deleted_at IS NULL AND e.started_at > ${since}
        GROUP BY pr.canonical_name ORDER BY events DESC LIMIT 10`),
      db.query(`
        SELECT p.id, p.display_name, COUNT(e.id)::int AS events,
               ROUND(COALESCE(SUM(${DUR_MIN}) FILTER (WHERE e.ended_at IS NOT NULL),0)/60.0, 1) AS hours
        FROM v3.events e JOIN v3.persons p ON p.id=e.person_id
        WHERE e.deleted_at IS NULL AND e.started_at > ${since} AND p.role='operator'
        GROUP BY p.id, p.display_name ORDER BY events DESC LIMIT 10`),
      db.query(`
        SELECT at.slug, COUNT(e.id)::int AS n,
               ROUND(AVG(${DUR_MIN}) FILTER (WHERE e.ended_at IS NOT NULL)) AS avg_min
        FROM v3.events e LEFT JOIN v3.activity_types at ON at.id=e.activity_type_id
        WHERE e.deleted_at IS NULL AND e.started_at > ${since}
        GROUP BY at.slug ORDER BY n DESC LIMIT 20`),
      db.query(`
        SELECT (e.started_at AT TIME ZONE '${EDT}')::date AS day,
               COUNT(*)::int AS events,
               ROUND(COALESCE(SUM(${DUR_MIN}) FILTER (WHERE e.ended_at IS NOT NULL),0)/60.0,1) AS hours
        FROM v3.events e WHERE e.deleted_at IS NULL AND e.started_at > ${since}
        GROUP BY day ORDER BY day`),
    ]);
    // Fase B addition: tempo médio por ordem impressa + uso de voz 7d
    const [ordersEff, voiceUse] = await Promise.all([
      db.query(`
        SELECT at.slug, COUNT(*)::int n, SUM(e.orders_printed)::int total_orders,
               ROUND(SUM(${DUR_MIN}) FILTER (WHERE e.ended_at IS NOT NULL)) total_min,
               ROUND((SUM(${DUR_MIN}) FILTER (WHERE e.ended_at IS NOT NULL)) / NULLIF(SUM(e.orders_printed),0), 2) AS min_por_ordem
        FROM v3.events e JOIN v3.activity_types at ON at.id=e.activity_type_id
        WHERE e.deleted_at IS NULL AND e.started_at > ${since} AND e.orders_printed > 0
        GROUP BY at.slug`),
      db.query(`SELECT COUNT(*)::int n, COALESCE(SUM(audio_duration_seconds),0)::int total_s
                FROM v3.voice_recordings WHERE deleted_at IS NULL AND created_at > ${since}`),
    ]);
    // bottles por dia (separado — production_counts)
    const bottlesDaily = await db.query(`
      SELECT (created_at AT TIME ZONE '${EDT}')::date AS day, COALESCE(SUM(bottles),0)::int AS bottles
      FROM v3.production_counts WHERE deleted_at IS NULL AND created_at > ${since}
      GROUP BY day ORDER BY day`);
    const bMap = new Map(bottlesDaily.rows.map((r) => [String(r.day), r.bottles]));
    const daily_breakdown = daily.rows.map((r) => ({ day: r.day, events: r.events, hours: Number(r.hours), bottles: bMap.get(String(r.day)) || 0 }));
    res.json({
      range: days + 'd',
      total_events_count: tot.rows[0].n,
      total_bottles: bottles.rows[0].n,
      top_supplements: topSup.rows,
      top_operators: topOps.rows,
      avg_task_duration_minutes_by_slug: durBySlug.rows,
      minutes_per_order: ordersEff.rows,
      voice_usage: { count: voiceUse.rows[0].n, total_seconds: voiceUse.rows[0].total_s },
      daily_breakdown,
    });
  }));

  router.get('/api/adminpanel/analytics/operator/:id', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const days = rangeDays(req.query.range);
    const since = `NOW() - INTERVAL '${days} days'`;
    const info = await db.query(`SELECT id, display_name, role FROM v3.persons WHERE id=$1`, [id]);
    if (!info.rows[0]) return res.status(404).json({ error: 'person_not_found' });
    const [bySlug, daily, cowork, batches] = await Promise.all([
      db.query(`
        SELECT at.slug, COUNT(e.id)::int AS n, ROUND(AVG(${DUR_MIN}) FILTER (WHERE e.ended_at IS NOT NULL)) AS avg_min
        FROM v3.events e LEFT JOIN v3.activity_types at ON at.id=e.activity_type_id
        WHERE e.person_id=$1 AND e.deleted_at IS NULL AND e.started_at > ${since}
        GROUP BY at.slug ORDER BY n DESC`, [id]),
      db.query(`
        SELECT (e.started_at AT TIME ZONE '${EDT}')::date AS day,
               ROUND(COALESCE(SUM(${DUR_MIN}) FILTER (WHERE e.ended_at IS NOT NULL),0)/60.0,1) AS hours,
               COUNT(*)::int AS events
        FROM v3.events e WHERE e.person_id=$1 AND e.deleted_at IS NULL AND e.started_at > ${since}
        GROUP BY day ORDER BY day`, [id]),
      db.query(`SELECT COUNT(*)::int n FROM v3.events e WHERE e.cowork_with @> ARRAY[$1]::int[] AND e.deleted_at IS NULL AND e.started_at > ${since}`, [id]),
      db.query(`SELECT COUNT(DISTINCT e.product_batch_id)::int n FROM v3.events e WHERE e.person_id=$1 AND e.product_batch_id IS NOT NULL AND e.deleted_at IS NULL AND e.started_at > ${since}`, [id]),
    ]);
    const totalEvents = bySlug.rows.reduce((a, r) => a + r.n, 0);
    const totalHours = daily.rows.reduce((a, r) => a + Number(r.hours), 0);
    res.json({
      person: info.rows[0], range: days + 'd',
      total_events: totalEvents, total_hours_worked: Math.round(totalHours * 10) / 10,
      events_by_slug: bySlug.rows, cowork_count: cowork.rows[0].n,
      batches_touched: batches.rows[0].n, daily_activity: daily.rows,
    });
  }));

  router.get('/api/adminpanel/analytics/supplement/:pid', h(async (req, res) => {
    const pid = parseInt(req.params.pid, 10);
    const days = rangeDays(req.query.range);
    const since = `NOW() - INTERVAL '${days} days'`;
    const info = await db.query(`SELECT id, canonical_name FROM v3.products WHERE id=$1`, [pid]);
    if (!info.rows[0]) return res.status(404).json({ error: 'product_not_found' });
    const [counts, ops, timeline] = await Promise.all([
      db.query(`
        SELECT COUNT(DISTINCT pb.id)::int batches, COALESCE(SUM(pc.bottles),0)::int bottles
        FROM v3.product_batches pb LEFT JOIN v3.production_counts pc ON pc.product_batch_id=pb.id AND pc.deleted_at IS NULL AND pc.created_at > ${since}
        WHERE pb.product_id=$1`, [pid]),
      db.query(`
        SELECT DISTINCT p.display_name FROM v3.events e
        JOIN v3.product_batches pb ON pb.id=e.product_batch_id JOIN v3.persons p ON p.id=e.person_id
        WHERE pb.product_id=$1 AND e.deleted_at IS NULL AND e.started_at > ${since}`, [pid]),
      db.query(`
        SELECT (pc.created_at AT TIME ZONE '${EDT}')::date AS day, SUM(pc.bottles)::int AS bottles
        FROM v3.production_counts pc JOIN v3.product_batches pb ON pb.id=pc.product_batch_id
        WHERE pb.product_id=$1 AND pc.deleted_at IS NULL AND pc.created_at > ${since}
        GROUP BY day ORDER BY day`, [pid]),
    ]);
    const c = counts.rows[0];
    res.json({
      product: info.rows[0], range: days + 'd',
      total_batches: c.batches, total_bottles: c.bottles,
      avg_bottles_per_batch: c.batches ? Math.round(c.bottles / c.batches) : 0,
      operators_involved: ops.rows.map((r) => r.display_name), timeline: timeline.rows,
    });
  }));

  router.get('/api/adminpanel/analytics/daily-production', h(async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    const dayCond = `(${'%COL%'} AT TIME ZONE '${EDT}')::date = COALESCE($1::date, (NOW() AT TIME ZONE '${EDT}')::date)`;
    const [bottles, hours, tasks, notifs] = await Promise.all([
      db.query(`SELECT pr.canonical_name AS product, SUM(pc.bottles)::int AS bottles
        FROM v3.production_counts pc JOIN v3.product_batches pb ON pb.id=pc.product_batch_id JOIN v3.products pr ON pr.id=pb.product_id
        WHERE pc.deleted_at IS NULL AND ${dayCond.replace('%COL%', 'pc.created_at')} GROUP BY pr.canonical_name ORDER BY bottles DESC`, [date]),
      db.query(`SELECT p.display_name, ROUND(COALESCE(SUM(${DUR_MIN}) FILTER (WHERE e.ended_at IS NOT NULL),0)/60.0,1) AS hours
        FROM v3.events e JOIN v3.persons p ON p.id=e.person_id
        WHERE e.deleted_at IS NULL AND p.role='operator' AND ${dayCond.replace('%COL%', 'e.started_at')} GROUP BY p.display_name ORDER BY hours DESC`, [date]),
      db.query(`SELECT COUNT(*)::int n FROM v3.events e WHERE e.deleted_at IS NULL AND e.ended_at IS NOT NULL AND ${dayCond.replace('%COL%', 'e.started_at')}`, [date]),
      db.query(`SELECT COUNT(*)::int n FROM v3.notifications WHERE resolved_at IS NOT NULL AND ${dayCond.replace('%COL%', 'resolved_at')}`, [date]),
    ]);
    res.json({
      date: date || 'today_edt',
      bottles_produced_by_supplement: bottles.rows,
      hours_worked_by_operator: hours.rows,
      tasks_completed: tasks.rows[0].n,
      notifications_resolved: notifs.rows[0].n,
    });
  }));

  // ── voz (Fase 0 / addition C) ───────────────────────────────
  router.use('/api/adminpanel/voice', requireAdmin);
  router.get('/api/adminpanel/voice/recent', h(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const r = await db.query(
      `SELECT v.id, v.audio_mime, v.audio_duration_seconds, v.transcript, v.transcript_language,
              p.display_name AS person, to_char(v.created_at AT TIME ZONE '${EDT}','MM-DD HH12:MI AM') AS created_edt
       FROM v3.voice_recordings v JOIN v3.persons p ON p.id = v.person_id
       WHERE v.deleted_at IS NULL ORDER BY v.id DESC LIMIT $1`, [limit]);
    res.json({ voice: r.rows });
  }));
  // Lista filtrável (Fase 0.7 — aba 🎤 Voices dedicada). Filtros opcionais:
  // event_id, person_id, date_from, date_to, limit, offset. Sem filtro = últimas.
  router.get('/api/adminpanel/voice', h(async (req, res) => {
    const conds = ['v.deleted_at IS NULL']; const vals = []; let i = 1;
    const evId = parseInt(req.query.event_id, 10);
    if (Number.isFinite(evId)) { conds.push(`v.event_id = $${i++}`); vals.push(evId); }
    const pid = parseInt(req.query.person_id, 10);
    if (Number.isFinite(pid)) { conds.push(`v.person_id = $${i++}`); vals.push(pid); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.date_from || '')) { conds.push(`v.created_at >= $${i++}::date`); vals.push(req.query.date_from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.date_to || '')) { conds.push(`v.created_at < ($${i++}::date + INTERVAL '1 day')`); vals.push(req.query.date_to); }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    vals.push(limit, offset);
    const r = await db.query(
      `SELECT v.id, v.event_id, v.audio_mime, v.audio_duration_seconds, v.audio_size_bytes,
              v.transcript, v.transcript_language, v.person_id,
              p.display_name AS person, to_char(v.created_at AT TIME ZONE '${EDT}','MM-DD HH12:MI AM') AS created_edt
       FROM v3.voice_recordings v JOIN v3.persons p ON p.id = v.person_id
       WHERE ${conds.join(' AND ')} ORDER BY v.id DESC LIMIT $${i++} OFFSET $${i++}`, vals);
    res.json({ voice: r.rows });
  }));
  router.get('/api/adminpanel/voice/:id', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const r = await db.query('SELECT audio_bytes, audio_mime FROM v3.voice_recordings WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.set('Content-Type', r.rows[0].audio_mime || 'audio/webm');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(r.rows[0].audio_bytes);
  }));
  // Soft-delete pelo admin (Fase 0.7). Mantém a row + transcript; zera o áudio
  // só no cleanup de retenção (TODO 90d). Audita.
  router.delete('/api/adminpanel/voice/:id', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
    const r = await db.query(
      'UPDATE v3.voice_recordings SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id, person_id', [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    await db.query(
      `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
       VALUES ('admin', NULL, 'voice_deleted', 'voice', $1, $2::jsonb)`,
      [id, JSON.stringify({ person_id: r.rows[0].person_id })]).catch(() => {});
    res.json({ ok: true, id });
  }));

  // ── audit log (Fase C) ──────────────────────────────────────
  router.use('/api/adminpanel/audit', requireAdmin);
  router.get('/api/adminpanel/audit', h(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const conds = []; const vals = []; let i = 1;
    if (req.query.actor_type) { conds.push(`a.actor_type = $${i++}`); vals.push(String(req.query.actor_type)); }
    if (req.query.action) { conds.push(`a.action ILIKE $${i++}`); vals.push('%' + String(req.query.action) + '%'); }
    if (req.query.target_type) { conds.push(`a.target_type = $${i++}`); vals.push(String(req.query.target_type)); }
    if (req.query.target_id) { conds.push(`a.target_id = $${i++}`); vals.push(parseInt(req.query.target_id, 10)); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.date_from || '')) { conds.push(`a.created_at >= $${i++}::date`); vals.push(req.query.date_from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.date_to || '')) { conds.push(`a.created_at < ($${i++}::date + INTERVAL '1 day')`); vals.push(req.query.date_to); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    vals.push(limit); const limI = i++; vals.push(offset); const offI = i++;
    const r = await db.query(`
      SELECT a.id, a.actor_type, a.actor_person_id, p.display_name AS actor_name,
             a.action, a.target_type, a.target_id, a.metadata,
             a.created_at, to_char(a.created_at AT TIME ZONE '${EDT}', 'MM-DD HH12:MI:SS AM') AS created_edt
      FROM v3.audit_log a LEFT JOIN v3.persons p ON p.id = a.actor_person_id
      ${where}
      ORDER BY a.id DESC LIMIT $${limI} OFFSET $${offI}`, vals);
    res.json({ entries: r.rows, limit, offset });
  }));

  return router;
}

module.exports = { createAdminRouter, signToken, verifyToken };
