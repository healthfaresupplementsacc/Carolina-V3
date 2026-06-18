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
const crypto = require('crypto');
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
  // canal orders-and-inventory (operadores veem) — aviso de exceção da linha
  const productionChannel = deps.productionChannelId || process.env.V3_PRODUCTION_CHANNEL || 'C09UNBXFRKK';
  const slack = deps.slack || null; // { postAs }
  const now = deps.now || (() => Date.now());
  const bf = deps.bruteForce || null; // Fase D brute-force guard

  const router = express.Router();
  // JSON 256kb pra tudo, EXCETO upload de voz (que tem parser 8mb próprio).
  const json256 = express.json({ limit: '256kb' });
  router.use((req, res, next) => (req.path === '/api/v3/op/voice/upload' ? next() : json256(req, res, next)));

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
      if (bf && bf.isBanned(ip)) return res.status(429).json({ error: 'ip_temporarily_blocked' });
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
        if (bf) await bf.recordFailure(ip);
        return res.status(401).json({ error: 'invalid_pin' });
      }
      if (bf) bf.recordSuccess(ip);
      const session = await opAuth.createSession(db, { personId: person.id, ip, userAgent: req.headers['user-agent'] });
      await db.query('UPDATE v3.persons SET last_page_login_at = NOW() WHERE id = $1', [person.id]);
      await audit('op_login_success', 'person', person.id, { ip, session_id: session.id }, person.id);
      const forgotten = await detectForgottenOperators(person.id);
      res.json({
        session_token: session.session_token,
        person: { id: person.id, display_name: person.display_name, role: person.role, count_exempt: !!person.count_exempt },
        auto_logoff_seconds: person.auto_logoff_seconds,
        forgotten_check_prompts: forgotten,
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

  // ── Fase 4: detecta colegas que passaram do horário e seguem logados ──
  // Usado no login/clock-out pra perguntar ao operador atual se o colega
  // ainda trabalha. Nunca lança (retorna [] em erro) — não quebra login.
  async function detectForgottenOperators(triggeringPersonId) {
    try {
      const r = await db.query(
        `SELECT s.person_id, p.display_name,
                to_char(sched.expected_end_time, 'HH24:MI') AS expected_end_time,
                to_char(s.last_activity_at AT TIME ZONE '${EDT}', 'MM-DD HH12:MI AM') AS last_activity_edt,
                at.display_name AS last_task, at.slug AS last_slug,
                pr.canonical_name AS last_product, pb.batch_number
         FROM v3.operator_sessions s
         JOIN v3.persons p ON p.id = s.person_id
         JOIN v3.operator_schedules sched
           ON sched.person_id = s.person_id
           AND sched.day_of_week = EXTRACT(DOW FROM (NOW() AT TIME ZONE '${EDT}'))::int
         LEFT JOIN LATERAL (
           SELECT activity_type_id, product_batch_id FROM v3.events
           WHERE person_id = s.person_id AND deleted_at IS NULL
           ORDER BY started_at DESC LIMIT 1
         ) e ON true
         LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
         LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
         LEFT JOIN v3.products pr ON pr.id = pb.product_id
         WHERE s.logged_out_at IS NULL
           AND s.person_id <> $1
           AND sched.is_workday = true
           AND sched.expected_end_time IS NOT NULL
           AND (NOW() AT TIME ZONE '${EDT}')::time > sched.expected_end_time
           AND s.last_activity_at < NOW() - INTERVAL '15 minutes'`, [triggeringPersonId]);
      const seen = new Set();
      const prompts = [];
      for (const x of r.rows) {
        if (seen.has(x.person_id)) continue;
        seen.add(x.person_id);
        const taskTxt = x.last_task ? x.last_task.toLowerCase() : 'alguma tarefa';
        const prod = x.last_product ? ` (${x.last_product}${x.batch_number ? ' ' + x.batch_number : ''})` : '';
        prompts.push({
          person_id: x.person_id, person_name: x.display_name,
          last_task: x.last_task || null, last_product: x.last_product || null, batch: x.batch_number || null,
          last_activity_at: x.last_activity_edt, expected_end_time: x.expected_end_time,
          prompt_text: `${x.display_name} ainda está trabalhando em ${taskTxt}${prod}?`,
        });
      }
      return prompts;
    } catch (e) { console.error('[op] detectForgotten erro:', e.message); return []; }
  }

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

  // slugs cuja nota é OBRIGATÓRIA (Fase 0: + impressão de ordens, especial, Outros;
  // patch outros-por-grupo: + os 5 "*_other", tarefa livre exige explicação).
  const NOTE_REQUIRED_SLUGS = new Set([
    'break', 'order_printing', 'order_printing_2', 'special_task', 'meeting', 'training',
    'production_line_other', 'formulation_other', 'cleaning_other', 'packaging_other', 'shipping_other',
    'label_change', 'label_repair',
    'machine_downtime', // mudança #5: motivo da parada obrigatório
    'repair',           // Fase 3.3: conserto de máquina exige nota
  ]);
  // slugs que exigem quantidade de ordens (Fase 0)
  const ORDERS_REQUIRED_SLUGS = new Set(['order_printing', 'order_printing_2']);

  // ── start ───────────────────────────────────────────────────
  router.post('/api/v3/op/event/start', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const { activity_slug, batch_number, cowork_with, note } = req.body || {};
    const act = await resolveActivity(String(activity_slug || ''));
    if (!act) return res.status(400).json({ error: 'unknown_activity_slug', slug: activity_slug || null });
    if (NOTE_REQUIRED_SLUGS.has(act.slug) && !(note && String(note).trim())) {
      return res.status(400).json({ error: 'note_required', detail: 'Esta task exige uma nota.' });
    }
    let ordersPrinted = null;
    if (ORDERS_REQUIRED_SLUGS.has(act.slug)) {
      ordersPrinted = parseInt(req.body && req.body.orders_printed, 10);
      if (!Number.isFinite(ordersPrinted) || ordersPrinted <= 0) {
        return res.status(400).json({ error: 'orders_printed_required', detail: 'Informe quantas ordens (número > 0).' });
      }
    }
    const batch = await resolveBatch(batch_number);
    if (batch_number && !batch) return res.status(400).json({ error: 'unknown_batch', batch_number });
    const cw = Array.isArray(cowork_with)
      ? cowork_with.map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && x > 0 && x !== s.person_id)
      : [];
    const desc = note ? String(note).slice(0, 500) : null;

    // ── COWORK (Fase 1): N events, 1 por participante, mesmo cowork_group_id ──
    // Cada operador passa a ter o SEU event → aparece em "Minhas Tarefas" dele
    // (q.personToday filtra por person_id) e ele finaliza sozinho.
    if (cw.length > 0) {
      const gid = crypto.randomUUID();
      const startedAt = new Date().toISOString();
      const participants = [...new Set([s.person_id, ...cw])]; // starter + colegas, sem dup
      let starterEv = null;
      for (const pid of participants) {
        const others = participants.filter((x) => x !== pid);
        const r = await db.query(
          `INSERT INTO v3.events
             (person_id, activity_type_id, product_batch_id, started_at, description,
              cowork_with, confidence, source, orders_printed, cowork_group_id)
           VALUES ($1, $2, $3, $4::timestamptz, $5, $6::int[], 'high', 'operator_page', $7, $8::uuid)
           RETURNING id, person_id, activity_type_id, product_batch_id, started_at, cowork_with, orders_printed, cowork_group_id`,
          [pid, act.id, batch ? batch.id : null, startedAt, desc, others, ordersPrinted, gid]);
        if (pid === s.person_id) starterEv = r.rows[0];
      }
      await audit('event.created_via_page', 'event', starterEv.id,
        { slug: act.slug, batch: batch ? batch.batch_number : null, cowork_with: cw, cowork_group_id: gid, cowork_size: participants.length }, s.person_id);
      return res.json({ ok: true, event: { ...starterEv, slug: act.slug, batch_number: batch ? batch.batch_number : null, product: batch ? batch.product : null } });
    }

    // ── SOLO: comportamento original (1 event, sem grupo) ──
    const ins = await db.query(
      `INSERT INTO v3.events
         (person_id, activity_type_id, product_batch_id, started_at, description,
          cowork_with, confidence, source, orders_printed)
       VALUES ($1, $2, $3, NOW(), $4, $5::int[], 'high', 'operator_page', $6)
       RETURNING id, person_id, activity_type_id, product_batch_id, started_at, cowork_with, orders_printed`,
      [s.person_id, act.id, batch ? batch.id : null, desc, cw, ordersPrinted]);
    const ev = ins.rows[0];
    await audit('event.created_via_page', 'event', ev.id,
      { slug: act.slug, batch: batch ? batch.batch_number : null, cowork_with: cw }, s.person_id);
    res.json({ ok: true, event: { ...ev, slug: act.slug, batch_number: batch ? batch.batch_number : null, product: batch ? batch.product : null } });
  }));

  // ── retroactive check-in (task esquecida) — operador, SÓ HOJE ───────────
  // started_at não pode ser futuro nem de outro dia (G8: dias anteriores só admin).
  router.post('/api/v3/op/event/retroactive', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const { activity_slug, batch_number, cowork_with, note, started_at, ended_at } = req.body || {};
    const act = await resolveActivity(String(activity_slug || ''));
    if (!act) return res.status(400).json({ error: 'unknown_activity_slug', slug: activity_slug || null });
    if (!started_at) return res.status(400).json({ error: 'started_at_required' });
    if (NOTE_REQUIRED_SLUGS.has(act.slug) && !(note && String(note).trim())) return res.status(400).json({ error: 'note_required' });
    let ordersPrinted = null;
    if (ORDERS_REQUIRED_SLUGS.has(act.slug)) {
      ordersPrinted = parseInt(req.body && req.body.orders_printed, 10);
      if (!Number.isFinite(ordersPrinted) || ordersPrinted <= 0) return res.status(400).json({ error: 'orders_printed_required' });
    }
    // validação de tempo no DB (evita ciladas de TZ no JS)
    const tv = await db.query(
      `SELECT ($1::timestamptz <= NOW()) AS not_future,
              (($1::timestamptz AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date) AS same_day,
              ($2::timestamptz IS NULL OR ($2::timestamptz > $1::timestamptz AND $2::timestamptz <= NOW())) AS end_ok`,
      [started_at, ended_at || null]);
    const v = tv.rows[0];
    if (!v.not_future) return res.status(400).json({ error: 'started_at_future' });
    if (!v.same_day) return res.status(400).json({ error: 'started_at_not_today', detail: 'Operador só adiciona tasks de hoje. Dias anteriores: peça ao admin.' });
    if (!v.end_ok) return res.status(400).json({ error: 'ended_at_invalid', detail: 'Fim deve ser depois do início e não pode ser futuro.' });
    const batch = await resolveBatch(batch_number);
    if (batch_number && !batch) return res.status(400).json({ error: 'unknown_batch', batch_number });
    const cw = Array.isArray(cowork_with)
      ? cowork_with.map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && x > 0 && x !== s.person_id) : [];
    const ins = await db.query(
      `INSERT INTO v3.events
         (person_id, activity_type_id, product_batch_id, started_at, ended_at, description,
          cowork_with, confidence, source, orders_printed, closed_reason)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7::int[], 'high', 'operator_page_retroactive', $8,
               CASE WHEN $5::timestamptz IS NULL THEN NULL ELSE 'operator_retroactive_close' END)
       RETURNING id, started_at, ended_at`,
      [s.person_id, act.id, batch ? batch.id : null, started_at, ended_at || null,
        note ? String(note).slice(0, 500) : null, cw, ordersPrinted]);
    const ev = ins.rows[0];
    const gapMin = await db.query("SELECT ROUND(EXTRACT(EPOCH FROM (NOW() - $1::timestamptz))/60)::int g", [started_at]);
    await audit('event.retroactive_create', 'event', ev.id,
      { slug: act.slug, retroactive: true, gap_minutes: gapMin.rows[0].g, ended: !!ended_at, batch: batch ? batch.batch_number : null }, s.person_id);
    res.json({ ok: true, event_id: ev.id, status: 'created' });
  }));

  // ── end ─────────────────────────────────────────────────────
  async function loadOwnedOpenEvent(req, res, s) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'bad_id' }); return null; }
    const r = await db.query(
      `SELECT e.id, e.person_id, e.cowork_with, e.product_batch_id, e.ended_at, e.deleted_at,
              e.is_long_running, e.cowork_group_id, at.slug, pb.product_id
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

  // aviso de exceção (production_line fechada SEM contagem) → orders-and-inventory.
  // É voz do SISTEMA (não a Carolina). Síncrono no close: NÃO passa pelo worker
  // dedupe, então ignora o silent-mode (é alerta operacional, não nudge).
  async function notifyProductionException(ev, reason, s) {
    if (!slack || !slack.postAs) return;
    let d = {};
    try {
      const r = await db.query(
        `SELECT p.display_name AS operator, pr.canonical_name AS product, pb.batch_number,
                ROUND(EXTRACT(EPOCH FROM (NOW() - e.started_at)) / 60)::int AS duration_min
         FROM v3.events e
         JOIN v3.persons p ON p.id = e.person_id
         LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
         LEFT JOIN v3.products pr ON pr.id = pb.product_id
         WHERE e.id = $1 LIMIT 1`, [ev.id]);
      d = r.rows[0] || {};
    } catch (e) { console.error('[op] detalhes exceção falharam:', e.message); }
    const text =
      '⚠️ *Linha de Produção fechada sem contagem*\n\n' +
      '*Operador(a):* ' + (d.operator || s.display_name || '?') + '\n' +
      '*Produto:* ' + (d.product || '—') + '\n' +
      '*Lote:* ' + (d.batch_number || '—') + '\n' +
      '*Duração:* ' + (d.duration_min != null ? d.duration_min + ' min' : '—') + '\n' +
      '*Motivo informado:* "' + reason + '"\n\n' +
      '_Notificação automática — favor verificar contagem com o operador quando possível._';
    try {
      await slack.postAs({
        channel: productionChannel,
        sender: { name: 'HealthFare Tracker (Sistema)', icon: ':package:' },
        thread_ts: null, text, unfurl_links: false, unfurl_media: false,
      });
      await audit('slack.notification.production_exception', 'event', ev.id, { channel: productionChannel }, s.person_id);
    } catch (e) { console.error('[op] aviso exceção falhou:', e.message); }
  }

  router.post('/api/v3/op/event/:id/end', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const ev = await loadOwnedOpenEvent(req, res, s); if (!ev) return;
    if (ev.ended_at) return res.status(409).json({ error: 'already_ended' });
    const body = req.body || {};
    const { unit, note } = body;
    // aceita bottles OU bottles_count (alias)
    const bottlesRaw = body.bottles != null ? body.bottles : body.bottles_count;
    const b = parseInt(bottlesRaw, 10);
    const isProd = ev.slug === 'production_line';

    // ── cowork: este é o ÚLTIMO a finalizar do grupo? ──
    const isCowork = !!ev.cowork_group_id;
    let isLast = true, remainingBefore = 1;
    if (isCowork) {
      const rc = await db.query(
        'SELECT COUNT(*)::int AS n FROM v3.events WHERE cowork_group_id = $1 AND ended_at IS NULL AND deleted_at IS NULL',
        [ev.cowork_group_id]);
      remainingBefore = rc.rows[0].n; // inclui o event atual (ainda aberto)
      isLast = remainingBefore <= 1;
    }
    // contagem/exceção só p/ SOLO ou ÚLTIMO do cowork — e só production_line
    const needCount = (!isCowork || isLast) && isProd;
    const exception = needCount && (body.exception_no_count === true || body.exception_no_count === 'true');
    const reason = exception ? String(body.exception_reason || '').trim() : null;

    if (needCount) {
      if (!exception) {
        if (!(Number.isFinite(b) && b > 0)) {
          return res.status(400).json({ error: 'bottles_required', detail: 'Informe quantas bottles foram produzidas (ou marque a exceção).' });
        }
      } else if (reason.length < 10) {
        return res.status(400).json({ error: 'exception_reason_required', detail: 'Explique por que não tem a contagem (mín. 10 caracteres).' });
      }
    }

    await db.query(
      `UPDATE v3.events
       SET ended_at = NOW(), closed_reason = 'operator_page',
           description = CASE WHEN $2::text IS NULL THEN description
                              ELSE COALESCE(description, '') || ' | fim: ' || $2 END,
           exception_no_count = $3, exception_reason = $4,
           cowork_member_finished_at = CASE WHEN $5::boolean THEN NOW() ELSE cowork_member_finished_at END,
           cowork_is_last_finisher = $6, updated_at = NOW()
       WHERE id = $1`,
      [ev.id, note ? String(note).slice(0, 300) : null, exception, exception ? reason.slice(0, 500) : null, isCowork, isCowork && isLast]);

    let countCreated = false;
    if (needCount && !exception && Number.isFinite(b) && b > 0) {
      await insertCount({ event: ev, bottles: b, unit, personId: s.person_id });
      countCreated = true;
    }

    // ── resposta + audit por caminho ──
    if (isCowork && !isLast) {
      await audit('cowork.member.finished', 'event', ev.id, { cowork_group_id: ev.cowork_group_id, remaining: remainingBefore - 1, slug: ev.slug }, s.person_id);
      return res.json({ ok: true, event_id: ev.id, is_last_finisher: false, remaining: remainingBefore - 1, count_created: false, exception: false });
    }
    if (isCowork && isLast) {
      await audit('cowork.group.completed', 'event', ev.id, { cowork_group_id: ev.cowork_group_id, slug: ev.slug, bottles: countCreated ? b : null, exception }, s.person_id);
      if (exception) await notifyProductionException(ev, reason, s);
      return res.json({ ok: true, event_id: ev.id, is_last_finisher: true, count_created: countCreated, exception });
    }
    // SOLO (sem grupo) — comportamento original
    if (exception) {
      await audit('event.end_with_exception', 'event', ev.id, { slug: ev.slug, exception_reason: reason }, s.person_id);
      await notifyProductionException(ev, reason, s);
    } else {
      await audit('event.ended_via_page', 'event', ev.id, { bottles: countCreated ? b : null, slug: ev.slug }, s.person_id);
    }
    res.json({ ok: true, event_id: ev.id, count_created: countCreated, exception });
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

  // ── voz: upload (Fase 0) ────────────────────────────────────
  const VOICE_MAX_BYTES = 5 * 1024 * 1024;
  const VOICE_MIMES = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav']);
  const voiceJson = express.json({ limit: '8mb' }); // base64 infla ~33%
  const voiceHits = new Map(); // person_id -> [timestamps] (20/h)
  router.post('/api/v3/op/voice/upload', voiceJson, h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    // rate-limit 20/h por pessoa (Fase D — anti-flood de uploads grandes)
    const t = now();
    const arr = (voiceHits.get(s.person_id) || []).filter((x) => t - x < 3600000);
    if (arr.length >= 20) { return res.status(429).json({ error: 'too_many_uploads', detail: 'Máx 20 áudios/hora.' }); }
    arr.push(t); voiceHits.set(s.person_id, arr);

    const b64 = String((req.body && req.body.audio_base64) || '').replace(/^data:[^,]+,/, '');
    if (!b64) return res.status(400).json({ error: 'audio_required' });
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch (_) { return res.status(400).json({ error: 'bad_base64' }); }
    if (!buf.length) return res.status(400).json({ error: 'empty_audio' });
    if (buf.length > VOICE_MAX_BYTES) return res.status(413).json({ error: 'too_large', detail: 'Máx 5MB.' });
    const mime = String((req.body && req.body.audio_mime) || 'audio/webm').split(';')[0];
    if (!VOICE_MIMES.has(mime)) return res.status(400).json({ error: 'bad_mime', mime });
    const eventId = req.body && req.body.event_id ? parseInt(req.body.event_id, 10) : null;
    const dur = req.body && req.body.duration_seconds ? Math.min(parseInt(req.body.duration_seconds, 10) || 0, 120) : null;
    const lang = String((req.body && req.body.language) || 'pt-BR').slice(0, 10);
    const transcript = req.body && req.body.transcript ? String(req.body.transcript).slice(0, 4000) : null;
    const ins = await db.query(
      `INSERT INTO v3.voice_recordings
         (event_id, person_id, audio_bytes, audio_mime, audio_duration_seconds, audio_size_bytes, transcript, transcript_language)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [eventId, s.person_id, buf, mime, dur, buf.length, transcript, lang]);
    await audit('voice.uploaded', 'voice', ins.rows[0].id, { event_id: eventId, bytes: buf.length, dur }, s.person_id);
    res.json({ ok: true, id: ins.rows[0].id, transcript });
  }));

  router.delete('/api/v3/op/voice/:id', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const id = parseInt(req.params.id, 10);
    const r = await db.query(
      `UPDATE v3.voice_recordings SET deleted_at = NOW()
       WHERE id = $1 AND person_id = $2 AND deleted_at IS NULL RETURNING id`, [id, s.person_id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found_or_not_yours' });
    await audit('voice.deleted', 'voice', id, {}, s.person_id);
    res.json({ ok: true });
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
    const forgotten = await detectForgottenOperators(s.person_id);
    res.json({ ok: true, closed_events: closed.rows.map((r2) => r2.id), unknown_notified: unknownIds.length, forgotten_check_prompts: forgotten });
  }));

  // ── Fase 4: resolve forgotten checkout (operador confirma se colega trabalha) ──
  router.post('/api/v3/op/forgotten-checkout/resolve', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const b = req.body || {};
    const personId = parseInt(b.person_id, 10);
    const stillWorking = !!b.still_working;
    const via = ['login', 'logout'].includes(b.discovered_via) ? b.discovered_via : 'login';
    if (!Number.isFinite(personId) || personId === s.person_id) return res.status(400).json({ error: 'bad_person' });

    // dados do suspeito: última atividade + horário esperado + última task
    const info = await db.query(
      `SELECT p.display_name, p.slack_user_id, s2.last_activity_at,
              to_char(sched.expected_end_time, 'HH24:MI') AS expected_end_time,
              at.display_name AS last_task, pr.canonical_name AS last_product, pb.batch_number,
              to_char(s2.last_activity_at AT TIME ZONE '${EDT}', 'MM-DD HH12:MI AM') AS last_activity_edt
       FROM v3.persons p
       LEFT JOIN LATERAL (SELECT last_activity_at FROM v3.operator_sessions
         WHERE person_id = p.id AND logged_out_at IS NULL ORDER BY last_activity_at DESC LIMIT 1) s2 ON true
       LEFT JOIN v3.operator_schedules sched ON sched.person_id = p.id
         AND sched.day_of_week = EXTRACT(DOW FROM (NOW() AT TIME ZONE '${EDT}'))::int
       LEFT JOIN LATERAL (SELECT activity_type_id, product_batch_id FROM v3.events
         WHERE person_id = p.id AND deleted_at IS NULL ORDER BY started_at DESC LIMIT 1) e ON true
       LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
       LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
       LEFT JOIN v3.products pr ON pr.id = pb.product_id
       WHERE p.id = $1 LIMIT 1`, [personId]);
    if (!info.rows[0]) return res.status(404).json({ error: 'person_not_found' });
    const sus = info.rows[0];
    const taskDesc = [sus.last_task, sus.last_product, sus.batch_number].filter(Boolean).join(' · ') || null;

    if (stillWorking) {
      // mantém logado; estende o benefício da dúvida (renova last_activity)
      await db.query("UPDATE v3.operator_sessions SET last_activity_at = NOW() WHERE person_id = $1 AND logged_out_at IS NULL", [personId]);
      await db.query(
        `INSERT INTO v3.forgotten_checkouts (person_id, discovered_by_person_id, discovered_via, last_activity_at, last_task_description, expected_end_time, resolved_at, resolution)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'still_working')`,
        [personId, s.person_id, via, sus.last_activity_at || null, taskDesc, sus.expected_end_time || null]);
      await audit('forgotten_checkout.confirmed_working', 'person', personId, { by: s.person_id, via }, s.person_id);
      return res.json({ ok: true, kept: true });
    }

    // still_working=false → cascade: fecha tasks no last_activity + logout + agenda DM + avisa admin
    await db.query(
      `UPDATE v3.events SET ended_at = COALESCE($2, NOW()), closed_reason = 'forgotten_checkout_cascade', updated_at = NOW()
       WHERE person_id = $1 AND ended_at IS NULL AND deleted_at IS NULL AND is_long_running = false`,
      [personId, sus.last_activity_at || null]);
    await db.query(
      `UPDATE v3.operator_sessions SET logged_out_at = COALESCE($2, NOW()), logoff_reason = 'forgotten_checkout_cascade'
       WHERE person_id = $1 AND logged_out_at IS NULL`, [personId, sus.last_activity_at || null]);
    const fc = await db.query(
      `INSERT INTO v3.forgotten_checkouts
         (person_id, discovered_by_person_id, discovered_via, last_activity_at, last_task_description,
          expected_end_time, auto_logout_at, carolina_dm_scheduled_for, admin_alert_sent_at, resolution)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(),
               ((((NOW() AT TIME ZONE '${EDT}')::date + 1) + TIME '08:30') AT TIME ZONE '${EDT}'),
               NOW(), 'auto_logout')
       RETURNING id, to_char(carolina_dm_scheduled_for AT TIME ZONE '${EDT}', 'MM-DD HH12:MI AM') AS dm_edt`,
      [personId, s.person_id, via, sus.last_activity_at || null, taskDesc, sus.expected_end_time || null]);
    if (slack && slack.postAs) {
      try {
        await slack.postAs({
          channel: adminChannel, sender: { name: 'Carolina' }, thread_ts: null,
          text: `🚨 Forgotten checkout: *${sus.display_name}* esqueceu de fazer checkout (descoberto por ${s.display_name} no ${via} de hoje).\n`
            + `Última atividade: ${sus.last_activity_edt || '?'}\n`
            + `Última task: ${taskDesc || '?'}\n`
            + `Horário esperado de saída: ${sus.expected_end_time || '?'}\n`
            + `Auto-checkout aplicado. Carolina avisará ${sus.display_name} amanhã 8:30am.`,
        });
      } catch (e) { console.error('[op] forgotten admin alert falhou:', e.message); }
    }
    await audit('forgotten_checkout.cascade', 'person', personId, { by: s.person_id, via, fc_id: fc.rows[0].id }, s.person_id);
    res.json({ ok: true, logged_out: true, dm_scheduled_for: fc.rows[0].dm_edt });
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
