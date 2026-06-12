'use strict';
/**
 * HEALTHFARE V3 — Operator Page API (/api/v3/op/*). Deploy 2.
 *
 * Input estruturado dos operadores → escrita DIRETA em v3.events /
 * v3.production_counts (source='operator_page'), SEM LLM.
 *
 * Auth em camadas:
 *   - Bearer OPERATOR_PAGE_TOKEN (a página embute via /op/config.js)
 *   - X-Session-Token (sessão criada no login por PIN — identidade real)
 *   - /api/admin/operator/:id/auto-logoff → header x-admin-pin (padrão V3)
 *
 * Rotas:
 *   GET  /op/config.js                       page token pro front (público)
 *   POST /api/v3/op/auth/login               { pin } → session (rate 5/min/IP)
 *   POST /api/v3/op/auth/logout              X-Session-Token (idempotente)
 *   POST /api/v3/op/auth/heartbeat           touch last_activity
 *   POST /api/v3/op/event/start              { activity_slug, batch_number?, cowork_with?, note? }
 *   POST /api/v3/op/event/:id/end            { bottles?, unit?, note? }
 *   POST /api/v3/op/event/:id/join           cowork B
 *   POST /api/v3/op/note                     { text } → v3.op_notes
 *   GET  /api/v3/op/active-operators         equipe agora (sessões + task atual)
 *   GET  /api/v3/op/missing-bottle-counts    pré-clock-out (P5)
 *   POST /api/v3/op/clock-out                { counts:[{event_id,bottles,unit?}], unknown_event_ids:[] }
 *   GET/PUT /api/admin/operator/:id/auto-logoff   { seconds: int|null }
 *
 * Todo write audita em v3.audit_log com actor_type='operator_page'
 * (CHECK ampliado na migration 018).
 */
const express = require('express');
const { extractBearer } = require('../middleware/architect-auth');
const opAuth = require('../lib/op-auth');

const EDT = 'America/New_York';
const LOGIN_LIMIT = 5;            // tentativas/min/IP
const LOGIN_WINDOW_MS = 60 * 1000;
const CLOSEABLE = true;

function createOpRouter(deps = {}) {
  const db = deps.db;
  const operatorToken = deps.operatorToken !== undefined ? deps.operatorToken : process.env.OPERATOR_PAGE_TOKEN;
  const adminPin = deps.adminPin !== undefined ? deps.adminPin : (process.env.ADMIN_PIN || '510510');
  const adminChannel = deps.adminChannelId || process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1';
  const slack = deps.slack || null; // { postAs }
  const now = deps.now || (() => Date.now());

  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  // ── audit helper ────────────────────────────────────────────
  async function audit(action, targetType, targetId, metadata, personId) {
    try {
      await db.query(
        `INSERT INTO v3.audit_log
           (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data, metadata)
         VALUES ('operator_page', $1, $2, $3, $4, NULL, NULL, $5::jsonb)`,
        [personId || null, action, targetType, targetId, JSON.stringify(metadata || {})]);
    } catch (e) { console.error('[op] audit falhou:', e.message); }
  }

  // ── config público (token da página; identidade real = PIN/sessão) ──
  router.get('/op/config.js', (req, res) => {
    res.type('application/javascript').send(
      'window.HF_OP_CONFIG = ' + JSON.stringify({ pageToken: operatorToken || '' }) + ';');
  });

  // ── gate: Bearer OPERATOR_PAGE_TOKEN em tudo /api/v3/op/* ──
  router.use('/api/v3/op', (req, res, next) => {
    const t = extractBearer(req);
    if (!operatorToken || t !== operatorToken) return res.status(401).json({ error: 'invalid_page_token' });
    next();
  });

  // ── login (rate-limit 5/min/IP) ─────────────────────────────
  const loginHits = new Map();
  router.post('/api/v3/op/auth/login', async (req, res) => {
    try {
      const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
      const t = now();
      let entry = loginHits.get(ip);
      if (!entry || t - entry.windowStart >= LOGIN_WINDOW_MS) { entry = { count: 0, windowStart: t }; loginHits.set(ip, entry); }
      entry.count += 1;
      if (entry.count > LOGIN_LIMIT) {
        await audit('op_login_rate_limited', 'person', null, { ip });
        return res.status(429).json({ error: 'too_many_attempts', retry_in_s: Math.ceil((entry.windowStart + LOGIN_WINDOW_MS - t) / 1000) });
      }
      const pin = String((req.body && req.body.pin) || '');
      if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'bad_pin_format' });

      const candidates = await db.query(
        `SELECT id, display_name, role, pin_hash, pin_salt, auto_logoff_seconds, count_exempt
         FROM v3.persons
         WHERE role = 'operator' AND active = true AND deleted_at IS NULL AND pin_hash IS NOT NULL`);
      const person = candidates.rows.find((p) => opAuth.verifyPin(pin, p.pin_salt, p.pin_hash));
      if (!person) {
        await audit('op_login_failed', 'person', null, { ip });
        return res.status(401).json({ error: 'invalid_pin' });
      }
      const session = await opAuth.createSession(db, { personId: person.id, ip, userAgent: req.headers['user-agent'] });
      await db.query('UPDATE v3.persons SET last_page_login_at = NOW() WHERE id = $1', [person.id]);
      await audit('op_login_success', 'person', person.id, { ip, session_id: session.id }, person.id);
      res.json({
        session_token: session.session_token,
        person: { id: person.id, display_name: person.display_name, role: person.role, count_exempt: !!person.count_exempt },
        auto_logoff_seconds: person.auto_logoff_seconds,
      });
    } catch (e) {
      console.error('[op] login erro:', e.message);
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── sessão obrigatória ──────────────────────────────────────
  async function requireSession(req, res) {
    const token = req.headers['x-session-token'];
    const s = await opAuth.getSession(db, token);
    if (!s) { res.status(401).json({ error: 'invalid_session' }); return null; }
    req.opSession = s;
    return s;
  }
  const h = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
      console.error('[op] erro em', req.path, '—', e.message);
      res.status(500).json({ error: 'internal', detail: e.message });
    }
  };

  router.post('/api/v3/op/auth/logout', h(async (req, res) => {
    const token = req.headers['x-session-token'];
    const reason = (req.body && req.body.reason) === 'auto_timeout' ? 'auto_timeout' : 'manual';
    const closed = await opAuth.closeSession(db, token, reason);
    if (closed) await audit('op_logout', 'person', closed.person_id, { reason }, closed.person_id);
    res.json({ ok: true, closed: !!closed });
  }));

  router.post('/api/v3/op/auth/heartbeat', h(async (req, res) => {
    const alive = await opAuth.touchSession(db, req.headers['x-session-token']);
    if (!alive) return res.status(401).json({ error: 'invalid_session' });
    res.json({ ok: true, person_id: alive.person_id });
  }));

  // ── helpers de domínio ──────────────────────────────────────
  async function resolveActivity(slug) {
    const r = await db.query(
      'SELECT id, slug, requires_product FROM v3.activity_types WHERE slug = $1 AND active = true LIMIT 1', [slug]);
    return r.rows[0] || null;
  }
  async function resolveBatch(batchNumber) {
    if (!batchNumber) return null;
    const bn = String(batchNumber).trim();
    const r = await db.query(
      `SELECT pb.id, pb.batch_number, pb.product_id, pr.canonical_name AS product
       FROM v3.product_batches pb LEFT JOIN v3.products pr ON pr.id = pb.product_id
       WHERE pb.batch_number = $1 OR pb.batch_number = 'BR-2026-' || $1
       ORDER BY pb.id DESC LIMIT 1`, [bn]);
    return r.rows[0] || null;
  }
  async function insertCount({ event, bottles, unit, personId }) {
    await db.query(
      `INSERT INTO v3.production_counts
         (product_id, product_batch_id, bottles, reported_at, production_date,
          reported_by_person_id, source_event_id, unit, confidence)
       VALUES ($1, $2, $3, NOW(), (NOW() AT TIME ZONE '${EDT}')::date, $4, $5, $6, 'high')`,
      [event.product_id || null, event.product_batch_id || null, bottles, personId, event.id, unit || 'bottle']);
  }

  // ── start ───────────────────────────────────────────────────
  router.post('/api/v3/op/event/start', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const { activity_slug, batch_number, cowork_with, note } = req.body || {};
    const act = await resolveActivity(String(activity_slug || ''));
    if (!act) return res.status(400).json({ error: 'unknown_activity_slug', slug: activity_slug || null });
    const batch = await resolveBatch(batch_number);
    if (batch_number && !batch) return res.status(400).json({ error: 'unknown_batch', batch_number });
    const cw = Array.isArray(cowork_with)
      ? cowork_with.map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && x > 0 && x !== s.person_id)
      : [];
    const ins = await db.query(
      `INSERT INTO v3.events
         (person_id, activity_type_id, product_batch_id, started_at, description,
          cowork_with, confidence, source)
       VALUES ($1, $2, $3, NOW(), $4, $5::int[], 'high', 'operator_page')
       RETURNING id, person_id, activity_type_id, product_batch_id, started_at, cowork_with`,
      [s.person_id, act.id, batch ? batch.id : null, note ? String(note).slice(0, 500) : null, cw]);
    const ev = ins.rows[0];
    await audit('event.created_via_page', 'event', ev.id,
      { slug: act.slug, batch: batch ? batch.batch_number : null, cowork_with: cw }, s.person_id);
    res.json({ ok: true, event: { ...ev, slug: act.slug, batch_number: batch ? batch.batch_number : null, product: batch ? batch.product : null } });
  }));

  // ── end ─────────────────────────────────────────────────────
  async function loadOwnedOpenEvent(req, res, s) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'bad_id' }); return null; }
    const r = await db.query(
      `SELECT e.id, e.person_id, e.cowork_with, e.product_batch_id, e.ended_at, e.deleted_at,
              e.is_long_running, at.slug, pb.product_id
       FROM v3.events e
       LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
       LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
       WHERE e.id = $1 LIMIT 1`, [id]);
    const ev = r.rows[0];
    if (!ev || ev.deleted_at) { res.status(404).json({ error: 'event_not_found' }); return null; }
    const mine = ev.person_id === s.person_id || (Array.isArray(ev.cowork_with) && ev.cowork_with.includes(s.person_id));
    if (!mine) { res.status(403).json({ error: 'not_your_event' }); return null; }
    return ev;
  }

  router.post('/api/v3/op/event/:id/end', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const ev = await loadOwnedOpenEvent(req, res, s); if (!ev) return;
    if (ev.ended_at) return res.status(409).json({ error: 'already_ended' });
    const { bottles, unit, note } = req.body || {};
    await db.query(
      `UPDATE v3.events
       SET ended_at = NOW(), closed_reason = 'operator_page',
           description = CASE WHEN $2::text IS NULL THEN description
                              ELSE COALESCE(description, '') || ' | fim: ' || $2 END,
           updated_at = NOW()
       WHERE id = $1`, [ev.id, note ? String(note).slice(0, 300) : null]);
    let countCreated = false;
    const b = parseInt(bottles, 10);
    if (Number.isFinite(b) && b > 0) {
      await insertCount({ event: ev, bottles: b, unit, personId: s.person_id });
      countCreated = true;
    }
    await audit('event.ended_via_page', 'event', ev.id, { bottles: countCreated ? b : null }, s.person_id);
    res.json({ ok: true, event_id: ev.id, count_created: countCreated });
  }));

  // ── join (cowork B) ─────────────────────────────────────────
  router.post('/api/v3/op/event/:id/join', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
    const r = await db.query(
      `UPDATE v3.events
       SET cowork_with = array_append(COALESCE(cowork_with, '{}'), $2), updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL AND ended_at IS NULL
         AND person_id <> $2 AND NOT (COALESCE(cowork_with, '{}') @> ARRAY[$2]::int[])
       RETURNING id, person_id, cowork_with`, [id, s.person_id]);
    if (r.rows.length === 0) {
      // distingue: já está / fechado / inexistente
      const chk = await db.query('SELECT id, ended_at, person_id, cowork_with FROM v3.events WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (!chk.rows[0]) return res.status(404).json({ error: 'event_not_found' });
      if (chk.rows[0].ended_at) return res.status(409).json({ error: 'already_ended' });
      return res.json({ ok: true, already: true, event_id: id });
    }
    await audit('event.cowork_joined_via_page', 'event', id, { joined_person_id: s.person_id }, s.person_id);
    res.json({ ok: true, event_id: id, cowork_with: r.rows[0].cowork_with });
  }));

  // ── nota livre ──────────────────────────────────────────────
  router.post('/api/v3/op/note', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'empty_text' });
    const r = await db.query(
      'INSERT INTO v3.op_notes (person_id, text) VALUES ($1, $2) RETURNING id', [s.person_id, text.slice(0, 2000)]);
    await audit('op_note.created', 'op_note', r.rows[0].id, { len: text.length }, s.person_id);
    res.json({ ok: true, note_id: r.rows[0].id });
  }));

  // ── equipe agora ────────────────────────────────────────────
  router.get('/api/v3/op/active-operators', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const r = await db.query(`
      SELECT p.id, p.display_name,
             (EXISTS (SELECT 1 FROM v3.operator_sessions os
                      WHERE os.person_id = p.id AND os.logged_out_at IS NULL
                        AND os.last_activity_at > NOW() - INTERVAL '16 hours')) AS online,
             ce.id AS current_event_id, ce.slug AS current_slug, ce.batch_number AS current_batch,
             ce.started_at AS current_started_at, ce.cowork_with AS current_cowork
      FROM v3.persons p
      LEFT JOIN LATERAL (
        SELECT e.id, at.slug, pb.batch_number, e.started_at, e.cowork_with
        FROM v3.events e
        LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
        LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
        WHERE e.person_id = p.id AND e.ended_at IS NULL AND e.deleted_at IS NULL
          AND e.is_long_running = false
        ORDER BY e.started_at DESC LIMIT 1
      ) ce ON true
      WHERE p.role = 'operator' AND p.active = true AND p.deleted_at IS NULL
      ORDER BY p.display_name LIMIT 50`);
    res.json({ operators: r.rows });
  }));

  // ── pré-clock-out: counts faltando (P5) ─────────────────────
  async function missingCounts() {
    const r = await db.query(`
      SELECT e.id AS event_id, p.display_name, at.slug, pb.batch_number,
             pr.canonical_name AS product,
             to_char(e.ended_at AT TIME ZONE '${EDT}', 'HH12:MI AM') AS finalized_at_edt
      FROM v3.events e
      JOIN v3.persons p ON p.id = e.person_id
      JOIN v3.activity_types at ON at.id = e.activity_type_id
      LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
      LEFT JOIN v3.products pr ON pr.id = pb.product_id
      WHERE at.slug IN ('production_line', 'encapsulation')
        AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
        AND e.ended_at IS NOT NULL AND e.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM v3.production_counts pc
                        WHERE pc.source_event_id = e.id AND pc.deleted_at IS NULL)
      ORDER BY e.ended_at LIMIT 50`);
    return r.rows;
  }

  router.get('/api/v3/op/missing-bottle-counts', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const missing = await missingCounts();
    const others = await opAuth.otherActiveOperators(db, s.session_id);
    const isLast = others === 0;
    res.json({
      missing,
      is_last_operator: isLast,
      can_skip: !!s.count_exempt || !isLast,
      count_exempt: !!s.count_exempt,
    });
  }));

  // ── clock-out (fecha tudo + counts + logout) ────────────────
  router.post('/api/v3/op/clock-out', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const body = req.body || {};
    const counts = Array.isArray(body.counts) ? body.counts : [];
    const unknownIds = Array.isArray(body.unknown_event_ids)
      ? body.unknown_event_ids.map((x) => parseInt(x, 10)).filter(Number.isFinite) : [];

    // 1) fecha as tasks ABERTAS do operador (long_running fica)
    const closed = await db.query(
      `UPDATE v3.events
       SET ended_at = NOW(), closed_reason = 'clock_out', updated_at = NOW()
       WHERE person_id = $1 AND ended_at IS NULL AND deleted_at IS NULL AND is_long_running = false
       RETURNING id`, [s.person_id]);

    // 2) aplica counts informados
    for (const citem of counts) {
      const evId = parseInt(citem && citem.event_id, 10);
      const b = parseInt(citem && citem.bottles, 10);
      if (!Number.isFinite(evId) || !Number.isFinite(b) || b < 0) continue;
      const evr = await db.query(
        `SELECT e.id, e.product_batch_id, pb.product_id FROM v3.events e
         LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
         WHERE e.id = $1 AND e.deleted_at IS NULL LIMIT 1`, [evId]);
      if (!evr.rows[0]) continue;
      await insertCount({ event: evr.rows[0], bottles: b, unit: citem.unit, personId: s.person_id });
      await audit('count.created_via_clockout', 'event', evId, { bottles: b }, s.person_id);
    }

    // 3) recomputa o que segue faltando
    const stillMissing = await missingCounts();
    const uncovered = stillMissing.filter((m) => !unknownIds.includes(m.event_id));
    const others = await opAuth.otherActiveOperators(db, s.session_id);
    const isLast = others === 0;

    // 4) regra P5: último não-admin sem exempt NÃO pode sair com buraco sem marcar "não sei"
    if (isLast && !s.count_exempt && uncovered.length > 0) {
      return res.status(422).json({
        error: 'counts_required_last_operator',
        missing: uncovered,
        detail: 'Você é o último a sair: preencha bottles ou marque "Não sei" em cada produção.',
      });
    }

    // 5) "não sei" → notification + Carolina avisa admin
    for (const evId of unknownIds) {
      const m = stillMissing.find((x) => x.event_id === evId);
      if (!m) continue;
      const notif = await db.query(
        `INSERT INTO v3.notifications (type, payload, status)
         VALUES ('unfilled_bottle_count', $1::jsonb, 'pending') RETURNING id`,
        [JSON.stringify({ event_id: m.event_id, person: m.display_name, batch: m.batch_number, product: m.product, finalized_at: m.finalized_at_edt, who_left: s.display_name })]);
      await audit('notification.unfilled_count', 'notification', notif.rows[0].id, { event_id: evId }, s.person_id);
      if (slack && slack.postAs) {
        try {
          await slack.postAs({
            channel: adminChannel, sender: { name: 'Carolina' }, thread_ts: null,
            text: `📊 ${s.display_name} saiu sem contar bottles de ${m.product || '?'} ${m.batch_number || ''} (finalizada ${m.finalized_at_edt}). Verifica?`,
          });
        } catch (e) { console.error('[op] aviso admin falhou:', e.message); }
      }
    }

    // 6) logout
    const token = req.headers['x-session-token'];
    await opAuth.closeSession(db, token, 'clock_out');
    await audit('op_clock_out', 'person', s.person_id,
      { closed_events: closed.rows.map((r2) => r2.id), counts_given: counts.length, unknown: unknownIds }, s.person_id);
    res.json({ ok: true, closed_events: closed.rows.map((r2) => r2.id), unknown_notified: unknownIds.length });
  }));

  // ── admin: auto-logoff por operador ─────────────────────────
  function checkAdminPin(req, res) {
    const pin = (req.query && req.query.pin) || (req.headers && req.headers['x-admin-pin']);
    if (String(pin || '') !== String(adminPin)) { res.status(401).json({ error: 'bad_admin_pin' }); return false; }
    return true;
  }

  router.get('/api/admin/operator/:id/auto-logoff', h(async (req, res) => {
    if (!checkAdminPin(req, res)) return;
    const id = parseInt(req.params.id, 10);
    const r = await db.query('SELECT id, display_name, auto_logoff_seconds FROM v3.persons WHERE id = $1', [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'person_not_found' });
    res.json(r.rows[0]);
  }));

  router.put('/api/admin/operator/:id/auto-logoff', h(async (req, res) => {
    if (!checkAdminPin(req, res)) return;
    const id = parseInt(req.params.id, 10);
    const raw = req.body ? req.body.seconds : undefined;
    const seconds = raw === null ? null : parseInt(raw, 10);
    if (seconds !== null && (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600)) {
      return res.status(400).json({ error: 'bad_seconds', detail: '5..3600 ou null (desativado)' });
    }
    const r = await db.query(
      'UPDATE v3.persons SET auto_logoff_seconds = $2, updated_at = NOW() WHERE id = $1 RETURNING id, display_name, auto_logoff_seconds',
      [id, seconds]);
    if (!r.rows[0]) return res.status(404).json({ error: 'person_not_found' });
    await audit('operator.auto_logoff_set', 'person', id, { seconds }, null);
    res.json(r.rows[0]);
  }));

  return router;
}

module.exports = { createOpRouter, CLOSEABLE };
