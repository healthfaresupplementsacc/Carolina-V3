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

  // audit: actor_type='admin'; o admin específico (RBAC) vai em metadata
  // (audit_log.actor_person_id é p/ persons, não admin_users).
  async function audit(action, targetType, targetId, metadata, req) {
    try {
      const meta = { ...(metadata || {}) };
      if (req && req.admin) { meta.admin_user_id = req.admin.id; meta.admin_name = req.admin.name; meta.admin_role = req.admin.role; }
      await db.query(
        `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
         VALUES ('admin', NULL, $1, $2, $3, $4::jsonb)`,
        [action, targetType, targetId, JSON.stringify(meta)]);
    } catch (e) { console.error('[admin] audit falhou:', e.message); }
  }

  const h = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
      console.error('[admin] erro em', req.path, '—', e.message);
      res.status(500).json({ error: 'internal', detail: e.message });
    }
  };

  // ── auth: PIN individual (admin_users, scrypt) + sessão no DB ──────────
  // Fallback de emergência: ADMIN_PASSWORD só loga enquanto NÃO houver
  // admin_user ativo (token HMAC stateless legado). Depois do seed, só PIN.
  function setAdminCookie(res, token) {
    res.set('Set-Cookie', `hf_admin=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_HOURS * 3600}; SameSite=Lax; Secure`);
  }
  async function countActiveAdmins() {
    try { const r = await db.query('SELECT COUNT(*)::int n FROM v3.admin_users WHERE is_active = true'); return (r.rows[0] && r.rows[0].n) || 0; }
    catch (_) { return 0; }
  }
  async function findAdminByPin(pin) {
    const r = await db.query('SELECT id, name, role, pin_hash, pin_salt FROM v3.admin_users WHERE is_active = true');
    for (const u of (r.rows || [])) {
      if (opAuth.verifyPin(pin, u.pin_salt, u.pin_hash)) return { id: u.id, name: u.name, role: u.role };
    }
    return null;
  }
  async function createAdminSession(adminUserId, ip, ua) {
    const token = opAuth.makeSessionToken();
    const exp = new Date(now() + SESSION_HOURS * 3600 * 1000);
    await db.query(
      `INSERT INTO v3.admin_sessions (admin_user_id, session_token, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [adminUserId, token, ip || null, ua ? String(ua).slice(0, 300) : null, exp]);
    await db.query('UPDATE v3.admin_users SET last_login_at = NOW() WHERE id = $1', [adminUserId]).catch(() => {});
    return { token, exp };
  }
  async function lookupAdminSession(token) {
    if (!token) return null;
    const r = await db.query(
      `SELECT s.id AS session_id, u.id AS admin_user_id, u.name, u.role
       FROM v3.admin_sessions s JOIN v3.admin_users u ON u.id = s.admin_user_id
       WHERE s.session_token = $1 AND s.logged_out_at IS NULL AND s.expires_at > NOW() AND u.is_active = true
       LIMIT 1`, [token]);
    if (!r.rows[0]) return null;
    db.query('UPDATE v3.admin_sessions SET last_activity_at = NOW() WHERE id = $1', [r.rows[0].session_id]).catch(() => {});
    return { id: r.rows[0].admin_user_id, name: r.rows[0].name, role: r.rows[0].role, session_id: r.rows[0].session_id };
  }

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
    const body = req.body || {};
    const pin = body.pin != null ? String(body.pin).trim() : null;
    // 1) PIN individual (RBAC)
    if (pin) {
      const admin = await findAdminByPin(pin);
      if (!admin) {
        await audit('admin_login_failed', 'admin', null, { ip, mode: 'pin' });
        if (bf) await bf.recordFailure(ip);
        return res.status(401).json({ error: 'wrong_pin' });
      }
      if (bf) bf.recordSuccess(ip);
      const { token, exp } = await createAdminSession(admin.id, ip, req.headers['user-agent']);
      await audit('admin_login_success', 'admin', null, { ip, mode: 'pin', admin_user_id: admin.id, name: admin.name, role: admin.role });
      setAdminCookie(res, token);
      return res.json({ ok: true, token, admin: { id: admin.id, name: admin.name, role: admin.role }, expires_at: exp.toISOString() });
    }
    // 2) Fallback de emergência por senha — só se NÃO houver admin ativo
    const given = body.password != null ? String(body.password) : null;
    if (given !== null && password && given === password) {
      const active = await countActiveAdmins();
      if (active === 0) {
        if (bf) bf.recordSuccess(ip);
        const exp = t + SESSION_HOURS * 3600 * 1000;
        const token = signToken(password, exp);
        await audit('admin_login_success', 'admin', null, { ip, mode: 'emergency_password' });
        setAdminCookie(res, token);
        return res.json({ ok: true, token, admin: { id: null, name: 'emergency', role: 'owner' }, expires_at: new Date(exp).toISOString() });
      }
      await audit('admin_login_failed', 'admin', null, { ip, mode: 'emergency_password_disabled' });
      return res.status(401).json({ error: 'password_disabled', detail: 'Senha de emergência desativada — use seu PIN.' });
    }
    await audit('admin_login_failed', 'admin', null, { ip });
    if (bf) await bf.recordFailure(ip);
    return res.status(401).json({ error: 'wrong_password' });
  }));

  router.post('/api/adminpanel/auth/logout', h(async (req, res) => {
    const token = tokenFromReq(req);
    if (token) db.query('UPDATE v3.admin_sessions SET logged_out_at = NOW() WHERE session_token = $1 AND logged_out_at IS NULL', [token]).catch(() => {});
    res.set('Set-Cookie', 'hf_admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure');
    res.json({ ok: true });
  }));

  // ── gates de sessão / role ────────────────────────────────────────────
  // requireAdmin: tenta sessão DB (RBAC) → senão token de emergência.
  // Popula req.admin = { id, name, role }.
  const requireAdmin = async (req, res, next) => {
    try {
      const token = tokenFromReq(req);
      const sess = await lookupAdminSession(token);
      if (sess) { req.admin = sess; return next(); }
      if (verifyToken(password, token, now()) && (await countActiveAdmins()) === 0) {
        req.admin = { id: null, name: 'emergency', role: 'owner' };
        return next();
      }
      return res.status(401).json({ error: 'unauthorized' });
    } catch (e) {
      console.error('[admin] requireAdmin erro:', e.message);
      return res.status(401).json({ error: 'unauthorized' });
    }
  };
  // requireRole('owner'): manager → 403 (não escala privilégio, G14).
  const requireRole = (role) => (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: 'unauthorized' });
    if (role === 'owner' && req.admin.role !== 'owner') {
      return res.status(403).json({ error: 'forbidden', message: 'Acesso requer permissão de owner' });
    }
    return next();
  };
  router.use('/api/adminpanel/operators', requireAdmin);
  router.use('/api/adminpanel/notifications', requireAdmin, makeRateLimit({ limit: 30 }));
  router.use('/api/adminpanel/admins', requireAdmin, requireRole('owner'));

  // ── gerenciar admins (OWNER ONLY) ─────────────────────────────────────
  router.get('/api/adminpanel/admins', h(async (req, res) => {
    const r = await db.query(
      `SELECT u.id, u.name, u.role, u.slack_user_id, u.email, u.is_active,
              to_char(u.last_login_at AT TIME ZONE '${EDT}','MM-DD HH12:MI AM') AS last_login_edt,
              (SELECT COUNT(*)::int FROM v3.admin_sessions s
               WHERE s.admin_user_id = u.id AND s.logged_out_at IS NULL AND s.expires_at > NOW()) AS active_session_count
       FROM v3.admin_users u ORDER BY u.role, u.name`);
    res.json({ admins: r.rows, me: req.admin });
  }));
  router.post('/api/adminpanel/admins/:id/pin', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const pin = String((req.body && req.body.pin) || '');
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'bad_pin_format', detail: 'PIN: 4 a 8 dígitos numéricos.' });
    const tgt = await db.query('SELECT id FROM v3.admin_users WHERE id = $1', [id]);
    if (!tgt.rows[0]) return res.status(404).json({ error: 'not_found' });
    // PIN não pode colidir com outro admin ATIVO (verifica scrypt 1-a-1)
    const others = await db.query('SELECT id, pin_hash, pin_salt FROM v3.admin_users WHERE is_active = true AND id <> $1', [id]);
    if ((others.rows || []).some((u) => opAuth.verifyPin(pin, u.pin_salt, u.pin_hash))) {
      return res.status(409).json({ error: 'pin_taken', detail: 'PIN já usado por outro admin.' });
    }
    const { pin_hash, pin_salt } = opAuth.hashPin(pin);
    await db.query('UPDATE v3.admin_users SET pin_hash = $2, pin_salt = $3, updated_at = NOW() WHERE id = $1', [id, pin_hash, pin_salt]);
    await audit('admin_user.pin_changed', 'admin_user', id, {}, req);
    res.json({ ok: true });
  }));
  router.put('/api/adminpanel/admins/:id/role', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const role = String((req.body && req.body.role) || '');
    if (!['owner', 'manager'].includes(role)) return res.status(400).json({ error: 'bad_role' });
    if (req.admin && req.admin.id === id) return res.status(400).json({ error: 'cannot_change_own_role' });
    const cur = await db.query('SELECT role, is_active FROM v3.admin_users WHERE id = $1', [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'not_found' });
    // rebaixar um owner ativo: garante que sobra pelo menos 1 owner ativo
    if (cur.rows[0].role === 'owner' && role === 'manager' && cur.rows[0].is_active) {
      const owners = await db.query("SELECT COUNT(*)::int n FROM v3.admin_users WHERE role = 'owner' AND is_active = true");
      if ((owners.rows[0].n || 0) <= 1) return res.status(400).json({ error: 'last_owner', detail: 'Não dá pra rebaixar o único owner ativo.' });
    }
    await db.query('UPDATE v3.admin_users SET role = $2, updated_at = NOW() WHERE id = $1', [id, role]);
    await audit('admin_user.role_changed', 'admin_user', id, { new_role: role, old_role: cur.rows[0].role }, req);
    res.json({ ok: true, role });
  }));
  router.put('/api/adminpanel/admins/:id/active', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const active = !!(req.body && req.body.active);
    if (req.admin && req.admin.id === id && !active) return res.status(400).json({ error: 'cannot_deactivate_self' });
    const cur = await db.query('SELECT role, is_active FROM v3.admin_users WHERE id = $1', [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (!active && cur.rows[0].role === 'owner' && cur.rows[0].is_active) {
      const owners = await db.query("SELECT COUNT(*)::int n FROM v3.admin_users WHERE role = 'owner' AND is_active = true");
      if ((owners.rows[0].n || 0) <= 1) return res.status(400).json({ error: 'last_owner', detail: 'Não dá pra desativar o único owner ativo.' });
    }
    await db.query('UPDATE v3.admin_users SET is_active = $2, updated_at = NOW() WHERE id = $1', [id, active]);
    if (!active) await db.query('UPDATE v3.admin_sessions SET logged_out_at = NOW() WHERE admin_user_id = $1 AND logged_out_at IS NULL', [id]).catch(() => {});
    await audit('admin_user.active_changed', 'admin_user', id, { active }, req);
    res.json({ ok: true, is_active: active });
  }));

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

  // ── schedule por dia da semana (Fase 3) — owner+manager ─────
  // Sob o gate /operators (requireAdmin). 0=Dom..6=Sáb.
  router.get('/api/adminpanel/operators/:id/schedule', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
    const r = await db.query(
      `SELECT day_of_week, to_char(expected_start_time,'HH24:MI') AS expected_start_time,
              to_char(expected_end_time,'HH24:MI') AS expected_end_time, is_workday, notes
       FROM v3.operator_schedules WHERE person_id = $1 ORDER BY day_of_week`, [id]);
    const byDow = {}; r.rows.forEach((x) => { byDow[x.day_of_week] = x; });
    // 7 dias, default null pros não-definidos
    const days = [];
    for (let d = 0; d < 7; d++) {
      days.push(byDow[d] || { day_of_week: d, expected_start_time: null, expected_end_time: null, is_workday: null, notes: null });
    }
    res.json({ person_id: id, days });
  }));
  router.put('/api/adminpanel/operators/:id/schedule/:dow', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const dow = parseInt(req.params.dow, 10);
    if (!Number.isFinite(id) || !Number.isFinite(dow) || dow < 0 || dow > 6) return res.status(400).json({ error: 'bad_params' });
    const b = req.body || {};
    const isWorkday = b.is_workday === undefined ? true : !!b.is_workday;
    const start = b.expected_start_time ? String(b.expected_start_time) : null;
    const end = b.expected_end_time ? String(b.expected_end_time) : null;
    const tRe = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (start && !tRe.test(start)) return res.status(400).json({ error: 'bad_time', field: 'start' });
    if (end && !tRe.test(end)) return res.status(400).json({ error: 'bad_time', field: 'end' });
    if (isWorkday && start && end && end <= start) return res.status(400).json({ error: 'end_before_start' });
    const notes = b.notes ? String(b.notes).slice(0, 300) : null;
    await db.query(
      `INSERT INTO v3.operator_schedules (person_id, day_of_week, expected_start_time, expected_end_time, is_workday, notes, updated_by_admin_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (person_id, day_of_week) DO UPDATE
         SET expected_start_time = EXCLUDED.expected_start_time, expected_end_time = EXCLUDED.expected_end_time,
             is_workday = EXCLUDED.is_workday, notes = EXCLUDED.notes, updated_at = NOW(), updated_by_admin_id = EXCLUDED.updated_by_admin_id`,
      [id, dow, start, end, isWorkday, notes, (req.admin && req.admin.id) || null]);
    await audit('operator.schedule_changed', 'person', id, { day_of_week: dow, is_workday: isWorkday, start, end }, req);
    res.json({ ok: true });
  }));
  router.delete('/api/adminpanel/operators/:id/schedule/:dow', h(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const dow = parseInt(req.params.dow, 10);
    if (!Number.isFinite(id) || !Number.isFinite(dow) || dow < 0 || dow > 6) return res.status(400).json({ error: 'bad_params' });
    await db.query('DELETE FROM v3.operator_schedules WHERE person_id = $1 AND day_of_week = $2', [id, dow]);
    await audit('operator.schedule_removed', 'person', id, { day_of_week: dow }, req);
    res.json({ ok: true });
  }));

  // ── notifications inbox (Fase C) ────────────────────────────
  router.get('/api/adminpanel/notifications', h(async (req, res) => {
    const status = req.query.status === 'all' ? null : (req.query.status || 'pending');
    const type = (!req.query.type || req.query.type === 'all') ? null : String(req.query.type);
    // filtro de origem (silent mode): all | slack | inbox
    const origin = req.query.origin === 'slack' ? 'slack_and_inbox'
      : req.query.origin === 'inbox' ? 'admin_inbox_only' : null;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const r = await db.query(`
      SELECT id, type, payload, status, admin_action_by, admin_response_text,
             carolina_slack_ts, delivery_method, created_at, resolved_at,
             to_char(created_at AT TIME ZONE '${EDT}', 'MM-DD HH12:MI AM') AS created_edt
      FROM v3.notifications
      WHERE ($1::text IS NULL OR status = $1)
        AND ($2::text IS NULL OR type = $2)
        AND ($3::text IS NULL OR delivery_method = $3)
      ORDER BY id DESC LIMIT $4 OFFSET $5`, [status, type, origin, limit, offset]);
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

  // ════════════════════════════════════════════════════════════
  // Fase 5 — Metrics dashboard. Lê de v3.events_enriched (matview) +
  // task_targets. owner+manager em tudo; FINANCE é owner-only e NUNCA
  // grava/loga salário (G12/G13).
  // ════════════════════════════════════════════════════════════
  router.use('/api/adminpanel/metrics', requireAdmin, makeRateLimit({ limit: 60 }));
  const mRange = (req) => ({ '7d': 7, '30d': 30, '90d': 90 }[String(req.query.range || '30d')] || 30);

  // 1) Hoje (realtime)
  router.get('/api/adminpanel/metrics/realtime', h(async (req, res) => {
    const loggedIn = await db.query(
      `SELECT s.person_id, p.display_name,
              to_char(s.last_activity_at AT TIME ZONE '${EDT}','HH12:MI AM') AS last_activity,
              EXTRACT(EPOCH FROM (NOW() - s.last_activity_at))/60.0 AS idle_min,
              (SELECT at.display_name FROM v3.events e LEFT JOIN v3.activity_types at ON at.id=e.activity_type_id
                WHERE e.person_id=s.person_id AND e.ended_at IS NULL AND e.deleted_at IS NULL
                ORDER BY e.started_at DESC LIMIT 1) AS current_task
       FROM v3.operator_sessions s JOIN v3.persons p ON p.id=s.person_id
       WHERE s.logged_out_at IS NULL ORDER BY p.display_name`);
    const today = await db.query(
      `SELECT
         (SELECT COALESCE(SUM(bottles),0)::int FROM v3.production_counts
            WHERE deleted_at IS NULL AND production_date = (NOW() AT TIME ZONE '${EDT}')::date) AS bottles_today,
         (SELECT COALESCE(SUM(orders_printed),0)::int FROM v3.events
            WHERE deleted_at IS NULL AND (started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date) AS orders_today,
         (SELECT COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at,NOW())-started_at)))/3600.0,1),0) FROM v3.events
            WHERE deleted_at IS NULL AND is_long_running=false AND (started_at AT TIME ZONE '${EDT}')::date=(NOW() AT TIME ZONE '${EDT}')::date) AS hours_today`);
    const openLong = await db.query(
      `SELECT e.id, p.display_name, at.display_name AS task,
              ROUND(EXTRACT(EPOCH FROM (NOW()-e.started_at))/3600.0,1) AS hours_open
       FROM v3.events e JOIN v3.persons p ON p.id=e.person_id LEFT JOIN v3.activity_types at ON at.id=e.activity_type_id
       WHERE e.ended_at IS NULL AND e.deleted_at IS NULL AND e.is_long_running=false
         AND e.started_at < NOW() - INTERVAL '1 hour' ORDER BY e.started_at LIMIT 50`);
    res.json({
      logged_in_operators: loggedIn.rows.map((r) => ({ ...r, idle_min: Math.round(Number(r.idle_min)) })),
      ...today.rows[0], tasks_open_long: openLong.rows,
    });
  }));

  // 2) Por operador (drill-down)
  router.get('/api/adminpanel/metrics/operator/:id', h(async (req, res) => {
    const id = parseInt(req.params.id, 10); const d = mRange(req);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
    const base = await db.query(
      `SELECT COUNT(*)::int total_events,
              ROUND(SUM(CASE WHEN NOT is_long_running THEN duration_min ELSE 0 END)/60.0,1) AS total_hours,
              COUNT(DISTINCT slug)::int slugs_count, COUNT(DISTINCT date_edt)::int active_days
       FROM v3.events_enriched WHERE person_id=$1 AND started_at > NOW() - ($2||' days')::interval AND ended_at IS NOT NULL`,
      [id, d]);
    const bySlug = await db.query(
      `SELECT slug, task_name, COUNT(*)::int n, ROUND(AVG(duration_min)::numeric,1) avg_min
       FROM v3.events_enriched WHERE person_id=$1 AND ended_at IS NOT NULL AND is_long_running=false
         AND started_at > NOW() - ($2||' days')::interval GROUP BY slug, task_name ORDER BY n DESC`, [id, d]);
    // métrica exótica: day-of-week effect (minutos médios por dia da semana)
    const byDow = await db.query(
      `SELECT day_of_week, COUNT(*)::int n, ROUND(AVG(duration_min)::numeric,1) avg_min
       FROM v3.events_enriched WHERE person_id=$1 AND ended_at IS NOT NULL AND is_long_running=false
         AND started_at > NOW() - ($2||' days')::interval GROUP BY day_of_week ORDER BY day_of_week`, [id, d]);
    // energy drain: tasks/h manhã (<13h) vs tarde (>=14h)
    const energy = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE hour_of_day < 13)::int AS morning_events,
         COUNT(*) FILTER (WHERE hour_of_day >= 14)::int AS afternoon_events
       FROM v3.events_enriched WHERE person_id=$1 AND ended_at IS NOT NULL AND is_long_running=false
         AND started_at > NOW() - ($2||' days')::interval`, [id, d]);
    const voice = await db.query(
      `SELECT COUNT(*)::int n, to_char(MAX(created_at) AT TIME ZONE '${EDT}','MM-DD HH12:MI AM') AS last
       FROM v3.voice_recordings WHERE person_id=$1 AND deleted_at IS NULL AND created_at > NOW() - ($2||' days')::interval`, [id, d]);
    const em = energy.rows[0];
    const drain = (em.morning_events > 0) ? Math.round((em.afternoon_events / em.morning_events) * 100) / 100 : null;
    res.json({
      range_days: d, ...base.rows[0],
      by_slug: bySlug.rows, by_day_of_week: byDow.rows,
      energy_drain_ratio: drain, // afternoon/morning event ratio
      voice_recordings_count: voice.rows[0].n, last_voice_at: voice.rows[0].last,
    });
  }));

  // 3) Por task type
  router.get('/api/adminpanel/metrics/slug/:slug', h(async (req, res) => {
    const slug = String(req.params.slug); const d = mRange(req);
    const stats = await db.query(
      `SELECT COUNT(*)::int n,
              ROUND((percentile_cont(0.25) WITHIN GROUP (ORDER BY duration_min))::numeric,1) p25,
              ROUND((percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_min))::numeric,1) p50,
              ROUND((percentile_cont(0.75) WITHIN GROUP (ORDER BY duration_min))::numeric,1) p75,
              ROUND(AVG(duration_min)::numeric,1) avg_min
       FROM v3.events_enriched WHERE slug=$1 AND ended_at IS NOT NULL AND is_long_running=false
         AND started_at > NOW() - ($2||' days')::interval`, [slug, d]);
    const byOp = await db.query(
      `SELECT person_name, COUNT(*)::int n, ROUND(AVG(duration_min)::numeric,1) avg_min,
              ROUND((percentile_cont(0.25) WITHIN GROUP (ORDER BY duration_min))::numeric,1) p25
       FROM v3.events_enriched WHERE slug=$1 AND ended_at IS NOT NULL AND is_long_running=false
         AND started_at > NOW() - ($2||' days')::interval GROUP BY person_name ORDER BY p25 ASC NULLS LAST`, [slug, d]);
    const tgt = await db.query('SELECT target_minutes FROM v3.task_targets WHERE slug=$1', [slug]);
    res.json({ slug, range_days: d, ...stats.rows[0], target_minutes: tgt.rows[0] ? tgt.rows[0].target_minutes : null, by_operator: byOp.rows });
  }));

  // 4) Comparativo de targets
  router.get('/api/adminpanel/metrics/targets-comparison', h(async (req, res) => {
    const r = await db.query(
      `SELECT t.slug, t.target_minutes, t.method_applied,
              ROUND(AVG(ee.duration_min)::numeric,1) AS actual_avg,
              COUNT(ee.id)::int AS n
       FROM v3.task_targets t
       LEFT JOIN v3.events_enriched ee ON ee.slug=t.slug AND ee.ended_at IS NOT NULL AND ee.is_long_running=false
         AND ee.started_at > NOW() - INTERVAL '30 days'
       GROUP BY t.slug, t.target_minutes, t.method_applied ORDER BY t.slug`);
    res.json({ targets: r.rows.map((x) => ({ ...x, delta_pct: (x.actual_avg && x.target_minutes) ? Math.round(((x.actual_avg - x.target_minutes) / x.target_minutes) * 100) : null })) });
  }));
  router.post('/api/adminpanel/metrics/targets/:slug', h(async (req, res) => {
    const slug = String(req.params.slug);
    const b = req.body || {};
    const minutes = parseInt(b.custom_minutes, 10);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 100000) return res.status(400).json({ error: 'bad_minutes' });
    const method = b.method_applied ? String(b.method_applied).slice(0, 20) : 'manual';
    await db.query(
      `INSERT INTO v3.task_targets (slug, target_minutes, method_applied, applied_by_admin_id, notes)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (slug) DO UPDATE SET target_minutes=EXCLUDED.target_minutes, method_applied=EXCLUDED.method_applied,
         applied_by_admin_id=EXCLUDED.applied_by_admin_id, applied_at=NOW(), notes=EXCLUDED.notes`,
      [slug, minutes, method, (req.admin && req.admin.id) || null, b.notes ? String(b.notes).slice(0, 300) : null]);
    await audit('task_target.changed', 'task_target', null, { slug, target_minutes: minutes, method }, req);
    res.json({ ok: true, slug, target_minutes: minutes });
  }));

  // 6) Tendências (produtividade diária)
  router.get('/api/adminpanel/metrics/trends', h(async (req, res) => {
    const d = mRange(req);
    const daily = await db.query(
      `SELECT date_edt AS day, COUNT(*)::int events,
              ROUND(SUM(CASE WHEN NOT is_long_running THEN duration_min ELSE 0 END)/60.0,1) hours
       FROM v3.events_enriched WHERE ended_at IS NOT NULL AND started_at > NOW() - ($1||' days')::interval
       GROUP BY date_edt ORDER BY date_edt`, [d]);
    const bottlesDaily = await db.query(
      `SELECT production_date AS day, SUM(bottles)::int bottles FROM v3.production_counts
       WHERE deleted_at IS NULL AND production_date > (NOW() AT TIME ZONE '${EDT}')::date - $1::int
       GROUP BY production_date ORDER BY production_date`, [d]);
    res.json({ range_days: d, productivity_daily: daily.rows, bottles_daily: bottlesDaily.rows });
  }));

  // 7) Anomalias
  router.get('/api/adminpanel/metrics/anomalies', h(async (req, res) => {
    const forgotten = await db.query("SELECT COUNT(*)::int n FROM v3.forgotten_checkouts WHERE resolved_at IS NULL");
    const idle = await db.query(
      `SELECT p.display_name, ROUND(EXTRACT(EPOCH FROM (NOW()-s.last_activity_at))/60.0)::int idle_min
       FROM v3.operator_sessions s JOIN v3.persons p ON p.id=s.person_id
       WHERE s.logged_out_at IS NULL AND s.last_activity_at < NOW() - INTERVAL '2 hours' ORDER BY idle_min DESC`);
    const stale = await db.query(
      `SELECT e.id, p.display_name, ROUND(EXTRACT(EPOCH FROM (NOW()-e.started_at))/3600.0,1) hours_open
       FROM v3.events e JOIN v3.persons p ON p.id=e.person_id
       WHERE e.ended_at IS NULL AND e.deleted_at IS NULL AND e.is_long_running=false
         AND e.started_at < NOW() - INTERVAL '3 hours' ORDER BY e.started_at LIMIT 50`);
    res.json({ forgotten_pending: forgotten.rows[0].n, idle_operators: idle.rows, stale_events: stale.rows });
  }));

  // 8) Rankings
  router.get('/api/adminpanel/metrics/rankings', h(async (req, res) => {
    const d = req.query.period === 'week' ? 7 : 30;
    const volume = await db.query(
      `SELECT person_name, COUNT(*)::int events FROM v3.events_enriched
       WHERE ended_at IS NOT NULL AND started_at > NOW() - ($1||' days')::interval
       GROUP BY person_name ORDER BY events DESC LIMIT 5`, [d]);
    const hours = await db.query(
      `SELECT person_name, ROUND(SUM(CASE WHEN NOT is_long_running THEN duration_min ELSE 0 END)/60.0,1) hours
       FROM v3.events_enriched WHERE ended_at IS NOT NULL AND started_at > NOW() - ($1||' days')::interval
       GROUP BY person_name ORDER BY hours DESC LIMIT 5`, [d]);
    const cowork = await db.query(
      `SELECT p.display_name AS person_name, COUNT(*)::int helped
       FROM v3.events e JOIN v3.persons p ON p.id = ANY(e.cowork_with)
       WHERE e.deleted_at IS NULL AND e.started_at > NOW() - ($1||' days')::interval
       GROUP BY p.display_name ORDER BY helped DESC LIMIT 5`, [d]);
    res.json({ period_days: d, volume_leaders: volume.rows, hours_leaders: hours.rows, most_helpful_cowork: cowork.rows });
  }));

  // 11) Aderência a schedule
  router.get('/api/adminpanel/metrics/schedule-adherence', h(async (req, res) => {
    const r = await db.query(
      `SELECT p.display_name, sc.day_of_week, to_char(sc.expected_start_time,'HH24:MI') AS expected_start,
              to_char(sc.expected_end_time,'HH24:MI') AS expected_end, sc.is_workday
       FROM v3.operator_schedules sc JOIN v3.persons p ON p.id=sc.person_id
       ORDER BY p.display_name, sc.day_of_week`);
    res.json({ schedules: r.rows });
  }));

  // 12) Insights (estáticos, gerados via SQL — Carolina não age)
  router.get('/api/adminpanel/metrics/insights', h(async (req, res) => {
    const insights = [];
    const slowest = await db.query(
      `SELECT slug, task_name, ROUND(AVG(duration_min)::numeric,1) avg_min, COUNT(*)::int n
       FROM v3.events_enriched WHERE ended_at IS NOT NULL AND is_long_running=false
         AND started_at > NOW() - INTERVAL '30 days' AND slug IS NOT NULL
       GROUP BY slug, task_name HAVING COUNT(*) >= 5 ORDER BY avg_min DESC LIMIT 3`);
    slowest.rows.forEach((x) => insights.push({ category: 'produtividade', text: `${x.task_name || x.slug} leva em média ${x.avg_min}min (${x.n} events em 30d) — task mais demorada.` }));
    const knowledge = await db.query(
      `SELECT slug, person_name, cnt, total, ROUND(100.0*cnt/total)::int pct FROM (
         SELECT slug, person_name, COUNT(*) cnt, SUM(COUNT(*)) OVER (PARTITION BY slug) total
         FROM v3.events_enriched WHERE ended_at IS NOT NULL AND slug IS NOT NULL AND started_at > NOW() - INTERVAL '30 days'
         GROUP BY slug, person_name) q WHERE total >= 8 AND 100.0*cnt/total > 70 ORDER BY pct DESC LIMIT 3`);
    knowledge.rows.forEach((x) => insights.push({ category: 'risco', text: `${x.pct}% de "${x.slug}" é feito por ${x.person_name} — concentração de conhecimento (risco se sair).` }));
    res.json({ insights });
  }));

  // refresh manual da matview (owner only)
  router.post('/api/adminpanel/metrics/refresh-cache', requireRole('owner'), h(async (req, res) => {
    await db.query('SELECT v3.refresh_events_enriched()');
    res.json({ ok: true });
  }));

  // ── FINANCE (OWNER ONLY) — NUNCA grava/loga salário (G12/G13) ──────────
  router.use('/api/adminpanel/metrics/financial', requireRole('owner'));
  router.post('/api/adminpanel/metrics/financial/calculate', h(async (req, res) => {
    const b = req.body || {};
    const personId = parseInt(b.person_id, 10);
    const salary = Number(b.hourly_salary); // INPUT TEMPORÁRIO — não persiste
    const d = [7, 30, 90].includes(parseInt(b.range_days, 10)) ? parseInt(b.range_days, 10) : 30;
    if (!Number.isFinite(personId)) return res.status(400).json({ error: 'bad_person' });
    if (!Number.isFinite(salary) || salary <= 0) return res.status(400).json({ error: 'bad_salary' });
    const agg = await db.query(
      `SELECT ROUND(SUM(CASE WHEN NOT is_long_running THEN duration_min ELSE 0 END)/60.0,2) AS hours,
              COUNT(*)::int AS tasks,
              COALESCE(SUM(CASE WHEN category IN ('production_phase','pnp_phase') THEN duration_min ELSE 0 END),0) AS productive_min,
              COALESCE(SUM(CASE WHEN category NOT IN ('production_phase','pnp_phase') OR category IS NULL THEN duration_min ELSE 0 END),0) AS support_min
       FROM v3.events_enriched WHERE person_id=$1 AND ended_at IS NOT NULL AND started_at > NOW() - ($2||' days')::interval`,
      [personId, d]);
    const bottles = await db.query(
      `SELECT COALESCE(SUM(pc.bottles),0)::int n FROM v3.production_counts pc
       JOIN v3.events e ON e.id = pc.source_event_id
       WHERE e.person_id=$1 AND pc.deleted_at IS NULL AND pc.reported_at > NOW() - ($2||' days')::interval`, [personId, d]);
    const a = agg.rows[0]; const hours = Number(a.hours) || 0;
    const totalCost = Math.round(hours * salary * 100) / 100;
    const bottlesN = bottles.rows[0].n;
    // audit: SÓ o fato do acesso (sem salário) — G13
    await audit('finance_calculation', 'person', personId, { range_days: d }, req);
    res.json({
      person_id: personId, range_days: d,
      hourly_salary_echo: salary, // só eco de confirmação, não gravado
      hours_worked: hours, total_cost: totalCost,
      tasks_completed: a.tasks,
      cost_per_task: a.tasks ? Math.round((totalCost / a.tasks) * 100) / 100 : null,
      bottles_touched: bottlesN,
      cost_per_bottle: bottlesN ? Math.round((totalCost / bottlesN) * 100) / 100 : null,
      productive_minutes: Number(a.productive_min), support_minutes: Number(a.support_min),
      productive_pct: (Number(a.productive_min) + Number(a.support_min)) > 0
        ? Math.round(100 * Number(a.productive_min) / (Number(a.productive_min) + Number(a.support_min))) : null,
      _note: 'Salário não foi salvo nem registrado em log.',
    });
  }));

  // ── audit log (Fase C + Fase 6: filtro por role + CSV) ──────
  // Ações "sensíveis": só owner vê. Manager vê apenas operacional.
  const SENSITIVE_ACTIONS = [
    'admin_login_success', 'admin_login_failed', 'admin_login_rate_limited',
    'admin_user.pin_changed', 'admin_user.role_changed', 'admin_user.active_changed', 'admin_user.created',
    'finance_calculation', 'login_bruteforce_ban',
  ];
  router.use('/api/adminpanel/audit', requireAdmin);
  function buildAuditQuery(req, forCsv) {
    const conds = []; const vals = []; let i = 1;
    if (req.query.actor_type) { conds.push(`a.actor_type = $${i++}`); vals.push(String(req.query.actor_type)); }
    if (req.query.action) { conds.push(`a.action ILIKE $${i++}`); vals.push('%' + String(req.query.action) + '%'); }
    if (req.query.target_type) { conds.push(`a.target_type = $${i++}`); vals.push(String(req.query.target_type)); }
    if (req.query.target_id) { conds.push(`a.target_id = $${i++}`); vals.push(parseInt(req.query.target_id, 10)); }
    if (req.query.q) { conds.push(`a.metadata::text ILIKE $${i++}`); vals.push('%' + String(req.query.q) + '%'); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.date_from || '')) { conds.push(`a.created_at >= $${i++}::date`); vals.push(req.query.date_from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.date_to || '')) { conds.push(`a.created_at < ($${i++}::date + INTERVAL '1 day')`); vals.push(req.query.date_to); }
    // role gating: manager nunca vê ações sensíveis
    const isOwner = req.admin && req.admin.role === 'owner';
    if (!isOwner) { conds.push(`a.action <> ALL($${i++}::text[])`); vals.push(SENSITIVE_ACTIONS); }
    else if (req.query.sensitive_only === '1') { conds.push(`a.action = ANY($${i++}::text[])`); vals.push(SENSITIVE_ACTIONS); }
    return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', vals, i };
  }
  router.get('/api/adminpanel/audit', h(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const { where, vals, i } = buildAuditQuery(req);
    vals.push(limit); const limI = i; vals.push(offset); const offI = i + 1;
    const r = await db.query(`
      SELECT a.id, a.actor_type, a.actor_person_id, p.display_name AS actor_name,
             a.action, a.target_type, a.target_id, a.metadata,
             a.created_at, to_char(a.created_at AT TIME ZONE '${EDT}', 'MM-DD HH12:MI:SS AM') AS created_edt
      FROM v3.audit_log a LEFT JOIN v3.persons p ON p.id = a.actor_person_id
      ${where}
      ORDER BY a.id DESC LIMIT $${limI} OFFSET $${offI}`, vals);
    res.json({ entries: r.rows, limit, offset, role: (req.admin && req.admin.role) || null });
  }));
  // Export CSV (owner only) — Fase 6
  router.get('/api/adminpanel/audit/export.csv', requireRole('owner'), h(async (req, res) => {
    const { where, vals } = buildAuditQuery(req);
    const r = await db.query(`
      SELECT to_char(a.created_at AT TIME ZONE '${EDT}', 'YYYY-MM-DD HH24:MI:SS') AS ts,
             a.actor_type, COALESCE(p.display_name,'') AS actor_name, a.action,
             COALESCE(a.target_type,'') AS target_type, COALESCE(a.target_id::text,'') AS target_id,
             COALESCE(a.metadata::text,'{}') AS metadata
      FROM v3.audit_log a LEFT JOIN v3.persons p ON p.id = a.actor_person_id
      ${where} ORDER BY a.id DESC LIMIT 10000`, vals);
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const head = ['timestamp_edt', 'actor_type', 'actor_name', 'action', 'target_type', 'target_id', 'metadata'];
    const lines = [head.join(',')].concat(r.rows.map((x) => [x.ts, x.actor_type, x.actor_name, x.action, x.target_type, x.target_id, x.metadata].map(esc).join(',')));
    await audit('audit_exported_csv', 'audit', null, { rows: r.rowCount }, req);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="audit-export.csv"');
    res.send(lines.join('\n'));
  }));

  return router;
}

module.exports = { createAdminRouter, signToken, verifyToken };
