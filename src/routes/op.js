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
const { ems: emsSingleton } = require('../v3/services/ems-api');

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
  const ems = deps.ems !== undefined ? deps.ems : emsSingleton; // EMS read-only (server-side; chave nunca vai ao browser)

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

  // ── FASE 1.5 — action_log APPEND-ONLY (rede de segurança, retém 5+ dias) ──
  // Registra TODA ação num lugar separado que sobrevive a fechar/deletar event.
  // Fire-and-forget: NUNCA bloqueia o operador (REGRA #0). Sandbox marcado is_test.
  async function actionLog(o) {
    try {
      await db.query(
        `INSERT INTO v3.operator_action_log
           (person_id, person_name, action_type, source, payload, raw_text, related_event_id, is_test)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [o.personId || null, o.personName || null, o.actionType, o.source || 'operator_page',
          JSON.stringify(o.payload || {}), o.rawText || null, o.relatedEventId || null, !!o.isTest]);
    } catch (e) { console.error('[op] action_log falhou:', e.message); }
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
        `SELECT id, display_name, role, pin_hash, pin_salt, auto_logoff_seconds, count_exempt, is_sandbox
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
      await actionLog({ personId: person.id, personName: person.display_name, actionType: 'login', payload: { session_id: session.id }, isTest: !!person.is_sandbox });
      const forgotten = await detectForgottenOperators(person.id);
      res.json({
        session_token: session.session_token,
        person: { id: person.id, display_name: person.display_name, role: person.role, count_exempt: !!person.count_exempt, is_sandbox: !!person.is_sandbox },
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
  // FILOSOFIA: o sistema NUNCA bloqueia o operador. Lote que ele digitou e não
  // existe → AUTO-CRIA (origin='operator_created') e segue; admin revisa depois.
  async function autoCreateBatch(batchNumber, productId, personId) {
    const bn = String(batchNumber).trim();
    const ins = await db.query(
      `INSERT INTO v3.product_batches
         (product_id, batch_number, started_at, status, origin, created_by_person_id, created_via)
       VALUES ($1, $2, NOW(), 'in_progress', 'operator_created', $3, 'op_page')
       RETURNING id, batch_number, product_id`, [productId, bn, personId]);
    const row = ins.rows[0];
    let product = null;
    try { const p = await db.query('SELECT canonical_name FROM v3.products WHERE id = $1', [productId]); product = p.rows[0] ? p.rows[0].canonical_name : null; } catch (e) {}
    return { id: row.id, batch_number: row.batch_number, product_id: row.product_id, product };
  }
  // resolve OU cria. Nunca lança "unknown_batch". Se não dá pra criar (sem produto
  // identificável), volta typedUnlinked pro nº ser preservado na descrição do event.
  async function resolveOrCreateBatch(batchNumber, productIdRaw, personId) {
    if (!batchNumber) return { batch: null, autoCreated: false, typedUnlinked: null };
    const existing = await resolveBatch(batchNumber);
    if (existing) return { batch: existing, autoCreated: false, typedUnlinked: null };
    const pid = parseInt(productIdRaw, 10);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        const batch = await autoCreateBatch(batchNumber, pid, personId);
        return { batch, autoCreated: true, typedUnlinked: null };
      } catch (e) { console.error('[op] auto-create batch falhou:', e.message); }
    }
    // sem produto p/ vincular (ou falhou): NÃO bloqueia — segue sem batch
    return { batch: null, autoCreated: false, typedUnlinked: String(batchNumber).trim() };
  }
  // alerta operacional pros owners/manager (canal admin). Voz do SISTEMA (não Carolina).
  async function notifyUnknownBatch({ batchNumber, productName, operatorName, slug, autoCreated }) {
    if (!slack || !slack.postAs) return;
    const whenEdt = new Date().toLocaleString('en-US', { timeZone: EDT, hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
    const text =
      ':warning: *Lote desconhecido iniciado*\n\n' +
      '*Operador(a):* ' + (operatorName || '?') + '\n' +
      '*Produto:* ' + (productName || '— (não identificado)') + '\n' +
      '*Lote digitado:* ' + batchNumber + '\n' +
      '*Task:* ' + (slug || '—') + '\n' +
      '*Iniciado em:* ' + whenEdt + ' EDT\n\n' +
      (autoCreated
        ? 'Este lote não existia no tracker nem no EMS. Foi *auto-criado* pra não bloquear o trabalho.\n\n'
        : 'Este lote não existia e *não pôde ser vinculado a um produto* — a task começou sem lote e o número ficou na nota.\n\n') +
      'Verifique com o operador se: o número está correto · se deveria existir no EMS (criar lá) · se é um lote válido a registrar.\n\n' +
      '_Notificação automática do sistema._';
    try {
      await slack.postAs({
        channel: adminChannel,
        sender: { name: 'HealthFare Tracker (Sistema)', icon: ':warning:' },
        thread_ts: null, text, unfurl_links: false, unfurl_media: false,
      });
    } catch (e) { console.error('[op] aviso lote desconhecido falhou:', e.message); }
  }
  // audita + alerta admin quando um lote foi auto-criado ou não pôde ser vinculado.
  // Notificação é fire-and-forget (não atrasa a resposta ao operador).
  async function flagUnknownBatch({ res, autoCreated, typedUnlinked, batch, batchNumber, body, slug, s }) {
    if (!autoCreated && !typedUnlinked) return;
    const bn = String(batchNumber || '').trim();
    const productId = batch ? batch.product_id : (body && parseInt(body.product_id, 10)) || null;
    await audit('batch.auto_created', batch ? 'product_batch' : 'event', batch ? batch.id : res.id,
      { batch_number: bn, product_id: Number.isFinite(productId) ? productId : null, person_id: s.person_id, auto_created: !!autoCreated, linked: !!batch, reason: 'operator_input_not_found', is_test: !!s.is_sandbox }, s.person_id);
    if (s.is_sandbox) return; // sandbox: NÃO notifica Slack (invisível pro resto do sistema)
    notifyUnknownBatch({ batchNumber: bn, productName: batch ? batch.product : (body && body.product_name) || null, operatorName: s.display_name, slug, autoCreated: !!autoCreated });
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
    // PASSADA 2 — gap detection: >20min sem atividade → pausa pra justificar ANTES
    // de iniciar (captura info, NÃO nega trabalho). Sandbox e retry (gap_ack) pulam.
    if (!s.is_sandbox && !(req.body && req.body.gap_ack)) {
      const gap = await detectGap(s.person_id);
      if (gap && gap.minutes > 20 && gap.minutes < 480) {
        return res.json({ ok: true, gap_detected: true, gap_minutes: gap.minutes, gap_started_at: gap.since });
      }
    }
    // NUNCA bloqueia: resolve o lote OU auto-cria (alerta admin depois)
    const { batch, autoCreated, typedUnlinked } = await resolveOrCreateBatch(batch_number, req.body && req.body.product_id, s.person_id);
    const cw = Array.isArray(cowork_with)
      ? cowork_with.map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && x > 0 && x !== s.person_id)
      : [];
    let desc = note ? String(note).slice(0, 500) : null;
    if (typedUnlinked) desc = (desc ? desc + ' ' : '') + '[lote digitado: ' + typedUnlinked + ' — produto não identificado]';

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
              cowork_with, confidence, source, orders_printed, cowork_group_id, is_test)
           VALUES ($1, $2, $3, $4::timestamptz, $5, $6::int[], 'high', 'operator_page', $7, $8::uuid, $9)
           RETURNING id, person_id, activity_type_id, product_batch_id, started_at, cowork_with, orders_printed, cowork_group_id`,
          [pid, act.id, batch ? batch.id : null, startedAt, desc, others, ordersPrinted, gid, !!s.is_sandbox]);
        if (pid === s.person_id) starterEv = r.rows[0];
      }
      await audit('event.created_via_page', 'event', starterEv.id,
        { slug: act.slug, batch: batch ? batch.batch_number : null, cowork_with: cw, cowork_group_id: gid, cowork_size: participants.length }, s.person_id);
      await flagUnknownBatch({ res: starterEv, autoCreated, typedUnlinked, batch, batchNumber: batch_number, body: req.body, slug: act.slug, s });
      await actionLog({ personId: s.person_id, personName: s.display_name, actionType: 'task_start', payload: { slug: act.slug, batch_number, cowork_with: cw, cowork_group_id: gid, note }, relatedEventId: starterEv.id, isTest: !!s.is_sandbox });
      return res.json({ ok: true, event: { ...starterEv, slug: act.slug, batch_number: batch ? batch.batch_number : null, product: batch ? batch.product : null } });
    }

    // ── SOLO: comportamento original (1 event, sem grupo) ──
    const ins = await db.query(
      `INSERT INTO v3.events
         (person_id, activity_type_id, product_batch_id, started_at, description,
          cowork_with, confidence, source, orders_printed, is_test)
       VALUES ($1, $2, $3, NOW(), $4, $5::int[], 'high', 'operator_page', $6, $7)
       RETURNING id, person_id, activity_type_id, product_batch_id, started_at, cowork_with, orders_printed`,
      [s.person_id, act.id, batch ? batch.id : null, desc, cw, ordersPrinted, !!s.is_sandbox]);
    const ev = ins.rows[0];
    await audit('event.created_via_page', 'event', ev.id,
      { slug: act.slug, batch: batch ? batch.batch_number : null, cowork_with: cw }, s.person_id);
    await flagUnknownBatch({ res: ev, autoCreated, typedUnlinked, batch, batchNumber: batch_number, body: req.body, slug: act.slug, s });
    await actionLog({ personId: s.person_id, personName: s.display_name, actionType: 'task_start', payload: { slug: act.slug, batch_number, note }, relatedEventId: ev.id, isTest: !!s.is_sandbox });
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
    // NUNCA bloqueia: resolve OU auto-cria o lote (alerta admin depois)
    const { batch, autoCreated, typedUnlinked } = await resolveOrCreateBatch(batch_number, req.body && req.body.product_id, s.person_id);
    const cw = Array.isArray(cowork_with)
      ? cowork_with.map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && x > 0 && x !== s.person_id) : [];
    let rdesc = note ? String(note).slice(0, 500) : null;
    if (typedUnlinked) rdesc = (rdesc ? rdesc + ' ' : '') + '[lote digitado: ' + typedUnlinked + ' — produto não identificado]';
    const ins = await db.query(
      `INSERT INTO v3.events
         (person_id, activity_type_id, product_batch_id, started_at, ended_at, description,
          cowork_with, confidence, source, orders_printed, closed_reason, is_test)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7::int[], 'high', 'operator_page_retroactive', $8,
               CASE WHEN $5::timestamptz IS NULL THEN NULL ELSE 'operator_retroactive_close' END, $9)
       RETURNING id, started_at, ended_at`,
      [s.person_id, act.id, batch ? batch.id : null, started_at, ended_at || null,
        rdesc, cw, ordersPrinted, !!s.is_sandbox]);
    const ev = ins.rows[0];
    const gapMin = await db.query("SELECT ROUND(EXTRACT(EPOCH FROM (NOW() - $1::timestamptz))/60)::int g", [started_at]);
    await audit('event.retroactive_create', 'event', ev.id,
      { slug: act.slug, retroactive: true, gap_minutes: gapMin.rows[0].g, ended: !!ended_at, batch: batch ? batch.batch_number : null }, s.person_id);
    await flagUnknownBatch({ res: ev, autoCreated, typedUnlinked, batch, batchNumber: batch_number, body: req.body, slug: act.slug, s });
    res.json({ ok: true, event_id: ev.id, status: 'created' });
  }));

  // ── end ─────────────────────────────────────────────────────
  async function loadOwnedOpenEvent(req, res, s) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'bad_id' }); return null; }
    const r = await db.query(
      `SELECT e.id, e.person_id, e.cowork_with, e.product_batch_id, e.ended_at, e.deleted_at,
              e.is_long_running, e.cowork_group_id, at.slug, at.requires_order_count, pb.product_id
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
    if (s && s.is_sandbox) return; // sandbox: invisível pro Slack/resto do sistema
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
    const isLine = ev.slug === 'production_line';
    const text =
      '⚠️ *' + (isLine ? 'Linha de Produção' : 'Tarefa (P&P/embalagem)') + ' fechada sem contagem*\n\n' +
      '*Tarefa:* ' + (ev.slug || '—') + '\n' +
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

  // ── finish-preview ──────────────────────────────────────────
  // Detecta UPFRONT (antes de abrir o overlay de finalizar) se ESTE operador
  // é o último do grupo cowork e se precisa de contagem — pro frontend renderizar
  // a tela certa de cara, sem depender do "bounce" via 400. Mesma lógica do /end.
  router.get('/api/v3/op/event/:id/finish-preview', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const ev = await loadOwnedOpenEvent(req, res, s); if (!ev) return;
    if (ev.ended_at) return res.status(409).json({ error: 'already_ended' });
    const isProd = ev.slug === 'production_line';
    const isCowork = !!ev.cowork_group_id;
    let isLast = true, remaining = 1;
    if (isCowork) {
      const rc = await db.query(
        'SELECT COUNT(*)::int AS n FROM v3.events WHERE cowork_group_id = $1 AND ended_at IS NULL AND deleted_at IS NULL',
        [ev.cowork_group_id]);
      remaining = rc.rows[0].n; // inclui o event atual (ainda aberto)
      isLast = remaining <= 1;
    }
    res.json({
      ok: true,
      event_id: ev.id,
      slug: ev.slug,
      is_cowork: isCowork,
      is_last_finisher: isLast,
      requires_bottle_count: (!isCowork || isLast) && isProd,
      cowork_remaining: isCowork ? Math.max(0, remaining - 1) : 0, // colegas além de mim ainda na tarefa
    });
  }));

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
    // contagem/exceção só p/ SOLO ou ÚLTIMO do cowork.
    const needCount = (!isCowork || isLast) && isProd;                       // bottles (linha)
    const needOrders = (!isCowork || isLast) && !!ev.requires_order_count;   // ordens (P&P/embalagem)
    const oc = parseInt(body.orders_count, 10);
    const marketplace = body.marketplace ? String(body.marketplace).slice(0, 40) : null;
    const exception = (needCount || needOrders) && (body.exception_no_count === true || body.exception_no_count === 'true');
    const reason = exception ? String(body.exception_reason || '').trim() : null;

    if (!exception) {
      if (needCount && !(Number.isFinite(b) && b > 0)) {
        return res.status(400).json({ error: 'bottles_required', detail: 'Informe quantas bottles foram produzidas (ou marque a exceção).' });
      }
      if (needOrders && !(Number.isFinite(oc) && oc > 0)) {
        return res.status(400).json({ error: 'orders_required', detail: 'Informe quantas ordens/unidades (ou marque a exceção).' });
      }
    } else if ((needCount || needOrders) && reason.length < 10) {
      return res.status(400).json({ error: 'exception_reason_required', detail: 'Explique por que não tem a contagem (mín. 10 caracteres).' });
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
    // FASE 5 — contagem de ORDENS (P&P): production_counts kind='orders' + marketplace
    if (needOrders && !exception && Number.isFinite(oc) && oc > 0) {
      await db.query(
        `INSERT INTO v3.production_counts
           (product_id, product_batch_id, bottles, reported_at, production_date,
            reported_by_person_id, source_event_id, unit, confidence, kind, marketplace)
         VALUES ($1, $2, $3, NOW(), (NOW() AT TIME ZONE '${EDT}')::date, $4, $5, 'orders', 'high', 'orders', $6)`,
        [ev.product_id || null, ev.product_batch_id || null, oc, s.person_id, ev.id, marketplace]);
      countCreated = true;
    }
    await actionLog({ personId: s.person_id, personName: s.display_name, actionType: 'task_finish', payload: { slug: ev.slug, bottles: Number.isFinite(b) ? b : null, orders_count: Number.isFinite(oc) ? oc : null, marketplace, exception, reason, note, is_cowork: isCowork, is_last: isLast }, relatedEventId: ev.id, isTest: !!s.is_sandbox });

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
  // FASE 1.2 — JOIN cria um EVENT SEPARADO pro operador que entra (B), começando
  // AGORA (não do início de A). B passa a aparecer em "Minhas Tarefas" dele, ativo
  // no admin, e o tempo dele é contado separado. Mesmo cowork_group_id de A.
  router.post('/api/v3/op/event/:id/join', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
    const tr = await db.query(
      `SELECT id, person_id, activity_type_id, product_batch_id, cowork_group_id, ended_at, deleted_at
       FROM v3.events WHERE id = $1 LIMIT 1`, [id]);
    const ev = tr.rows[0];
    if (!ev || ev.deleted_at) return res.status(404).json({ error: 'event_not_found' });
    if (ev.ended_at) return res.status(409).json({ error: 'already_ended' });
    if (ev.person_id === s.person_id) return res.json({ ok: true, already: true, event_id: ev.id }); // já é dono
    // garante um grupo cowork (se A começou solo, cria o grupo agora e marca A)
    let gid = ev.cowork_group_id;
    if (!gid) {
      gid = crypto.randomUUID();
      await db.query('UPDATE v3.events SET cowork_group_id = $1::uuid, updated_at = NOW() WHERE id = $2', [gid, ev.id]);
    }
    // idempotente: B já tem event aberto nesse grupo?
    const mine = await db.query(
      'SELECT id FROM v3.events WHERE cowork_group_id = $1 AND person_id = $2 AND ended_at IS NULL AND deleted_at IS NULL LIMIT 1',
      [gid, s.person_id]);
    if (mine.rows[0]) return res.json({ ok: true, already: true, event_id: mine.rows[0].id });
    // membros abertos do grupo (pra montar cowork_with do B)
    const grp = await db.query(
      'SELECT DISTINCT person_id FROM v3.events WHERE cowork_group_id = $1 AND ended_at IS NULL AND deleted_at IS NULL', [gid]);
    const others = [...new Set([ev.person_id, ...grp.rows.map((r) => r.person_id)])].filter((x) => x !== s.person_id);
    // cria o event do B começando AGORA
    const ins = await db.query(
      `INSERT INTO v3.events
         (person_id, activity_type_id, product_batch_id, started_at, cowork_with, confidence, source, cowork_group_id, is_test)
       VALUES ($1, $2, $3, NOW(), $4::int[], 'high', 'operator_page', $5::uuid, $6)
       RETURNING id, started_at`,
      [s.person_id, ev.activity_type_id, ev.product_batch_id, others, gid, !!s.is_sandbox]);
    // adiciona B ao cowork_with dos outros membros abertos
    await db.query(
      `UPDATE v3.events SET cowork_with = array_append(COALESCE(cowork_with, '{}'), $2), updated_at = NOW()
       WHERE cowork_group_id = $1 AND ended_at IS NULL AND deleted_at IS NULL
         AND person_id <> $2 AND NOT (COALESCE(cowork_with, '{}') @> ARRAY[$2]::int[])`, [gid, s.person_id]);
    await audit('event.cowork_joined_via_page', 'event', ins.rows[0].id,
      { cowork_group_id: gid, joined_person_id: s.person_id, source_event_id: ev.id }, s.person_id);
    await actionLog({ personId: s.person_id, personName: s.display_name, actionType: 'cowork_join', payload: { cowork_group_id: gid, source_event_id: ev.id }, relatedEventId: ins.rows[0].id, isTest: !!s.is_sandbox });
    res.json({ ok: true, event_id: ins.rows[0].id, cowork_group_id: gid, joined: true });
  }));

  // ── EMS enrichment (Bug 2/3): caches em memória, best-effort ──
  // A chave do EMS vive SÓ no servidor; ao browser só vão URLs públicas de
  // imagem (Amazon CDN) e status de batch. Falha do EMS = degrada (não quebra).
  const emsCache = { products: { at: 0, val: null }, pipeline: { at: 0, val: null } };
  const norm = (s) => String(s || '').toLowerCase().replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|iu|ml|ct|count|caps?|capsules?|softgels?|tablets?|servings?)\b/g, '').replace(/[^a-z0-9]+/g, '');
  async function emsProducts() { // cache 1h
    if (!ems || !ems.configured || !ems.configured()) return null;
    if (emsCache.products.val && (now() - emsCache.products.at) < 3600000) return emsCache.products.val;
    try {
      const data = await ems.products();
      const arr = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : (data && Array.isArray(data.products) ? data.products : []));
      emsCache.products = { at: now(), val: arr };
      return arr;
    } catch (e) { console.error('[op] EMS products falhou:', e.message); return emsCache.products.val; }
  }
  async function emsPipeline() { // cache 30s
    if (!ems || !ems.configured || !ems.configured()) return null;
    if (emsCache.pipeline.val && (now() - emsCache.pipeline.at) < 30000) return emsCache.pipeline.val;
    try {
      const data = await ems.pipeline();
      emsCache.pipeline = { at: now(), val: data };
      return data;
    } catch (e) { console.error('[op] EMS pipeline falhou:', e.message); return emsCache.pipeline.val; }
  }
  // todos os batches do pipeline (pending + formulation + production_line), por nº
  function pipelineBatchMap(pl) {
    const m = new Map();
    if (!pl) return m;
    ['pending_queue', 'formulation', 'production_line'].forEach((k) => {
      (Array.isArray(pl[k]) ? pl[k] : []).forEach((b) => {
        const bn = b && (b.batch_record_number || b.batch_number);
        if (bn) m.set(String(bn).toUpperCase(), { status: b.status || k, target_bottles: b.target_qty_bottles != null ? b.target_qty_bottles : null, actual_bottles: b.actual_yield_bottles != null ? b.actual_yield_bottles : null });
      });
    });
    return m;
  }

  // ── Bug 3: imagens dos produtos (EMS → mapa por product_id LOCAL) ─
  router.get('/api/v3/op/products/images', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const emsP = await emsProducts();
    const locals = (await db.query('SELECT id, canonical_name, aliases FROM v3.products WHERE active = true')).rows;
    const byId = {};
    let matched = 0, emsOk = !!emsP;
    if (emsP && emsP.length) {
      // index EMS por nome normalizado (1ª imagem vence)
      const idx = [];
      emsP.forEach((p) => { if (p && p.image_url) idx.push({ n: norm(p.name), url: p.image_url }); });
      locals.forEach((lp) => {
        const cands = [norm(lp.canonical_name)].concat((lp.aliases || []).map(norm)).filter(Boolean);
        let hit = null;
        for (const c of cands) {
          hit = idx.find((e) => e.n === c) || idx.find((e) => e.n.indexOf(c) === 0 && c.length >= 4) || idx.find((e) => c.length >= 5 && (e.n.indexOf(c) >= 0 || c.indexOf(e.n) >= 0));
          if (hit) break;
        }
        if (hit) { byId[lp.id] = hit.url; matched++; }
      });
    }
    res.json({ by_id: byId, matched, total_local: locals.length, ems_ok: emsOk });
  }));

  // ── Bug 2: lotes recentes filtrados por produto (local + EMS status) ─
  router.get('/api/v3/op/batches/recent', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const pid = parseInt(req.query.product_id, 10);
    if (!Number.isFinite(pid) || pid <= 0) return res.status(400).json({ error: 'product_id_required' });
    const limit = Math.min(12, Math.max(1, parseInt(req.query.limit, 10) || 8));
    const local = (await db.query(
      `SELECT pb.batch_number,
              MAX(e.started_at) AS last_seen,
              (array_agg(p.display_name ORDER BY e.started_at DESC))[1] AS last_operator
       FROM v3.product_batches pb
       JOIN v3.events e ON e.product_batch_id = pb.id AND e.deleted_at IS NULL
       JOIN v3.persons p ON p.id = e.person_id
       WHERE pb.product_id = $1 AND pb.batch_number IS NOT NULL
       GROUP BY pb.batch_number
       ORDER BY MAX(e.started_at) DESC
       LIMIT $2`, [pid, limit])).rows;
    const plMap = pipelineBatchMap(await emsPipeline());
    const batches = local.map((b) => {
      const pe = plMap.get(String(b.batch_number).toUpperCase()); // entrada do pipeline EMS (se houver)
      return {
        batch_number: b.batch_number,
        last_seen: b.last_seen,
        last_operator: b.last_operator || null,
        status_in_ems: pe ? pe.status : null,
        target_bottles: pe ? pe.target_bottles : null,
      };
    });
    res.json({ product_id: pid, batches });
  }));

  // ════════════════════════════════════════════════════════════
  // PASSADA 2 — fim-do-dia + gap detection
  // ════════════════════════════════════════════════════════════
  const ANA_ID = 6; // operadora designada pros totais do dia

  // ── fim-do-dia: precisa pedir os totais? ──
  router.get('/api/v3/op/end-of-day/check', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const meta = await db.query(`
      SELECT (EXTRACT(HOUR FROM (NOW() AT TIME ZONE '${EDT}')))::int AS hour_edt,
             EXISTS (SELECT 1 FROM v3.daily_totals_log WHERE day = (NOW() AT TIME ZONE '${EDT}')::date) AS already_submitted,
             EXISTS (SELECT 1 FROM v3.operator_sessions WHERE person_id = ${ANA_ID}
                       AND (created_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date) AS ana_active`);
    const m = meta.rows[0];
    const timeOK = m.hour_edt >= 17;
    const pending = timeOK && !s.count_exempt && !s.is_sandbox && !m.already_submitted;
    const isAna = s.person_id === ANA_ID;
    // Ana sempre; outros só se Ana não vai fazer (não logou hoje) — fallback
    const shouldPrompt = isAna ? true : !m.ana_active;
    // produtos produzidos hoje (referência pro formulário de totais)
    const prods = await db.query(`
      SELECT pr.id AS product_id, pr.canonical_name AS product,
             COALESCE(SUM(pc.bottles),0)::int AS count_so_far
      FROM v3.production_counts pc
      JOIN v3.product_batches pb ON pb.id = pc.product_batch_id
      JOIN v3.products pr ON pr.id = pb.product_id
      WHERE pc.deleted_at IS NULL
        AND (pc.created_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
      GROUP BY pr.id, pr.canonical_name ORDER BY pr.canonical_name`);
    res.json({
      pending: !!pending,
      already_submitted: !!m.already_submitted,
      should_prompt_user: !!(pending && shouldPrompt),
      current_hour_edt: m.hour_edt,
      products: prods.rows,
    });
  }));

  // ── fim-do-dia: submeter os totais ──
  router.post('/api/v3/op/end-of-day/submit', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const body = req.body || {};
    const totals = body.totals && typeof body.totals === 'object' ? body.totals : {};
    const note = body.general_note ? String(body.general_note).slice(0, 1000) : null;
    const ins = await db.query(
      `INSERT INTO v3.daily_totals_log (day, person_id, totals_json, general_note)
       VALUES ((NOW() AT TIME ZONE '${EDT}')::date, $1, $2::jsonb, $3)
       ON CONFLICT (day) DO NOTHING
       RETURNING id`, [s.person_id, JSON.stringify(totals), note]);
    if (!ins.rowCount) return res.status(409).json({ error: 'already_submitted', detail: 'Os totais de hoje já foram confirmados.' });
    await audit('end_of_day.submitted', 'daily_totals_log', ins.rows[0].id, { totals_keys: Object.keys(totals).length, is_test: !!s.is_sandbox }, s.person_id);
    await actionLog({ personId: s.person_id, personName: s.display_name, actionType: 'end_of_day', payload: { totals, general_note: note }, isTest: !!s.is_sandbox });
    // resumo no canal de produção (sandbox NÃO posta)
    if (!s.is_sandbox && slack && slack.postAs) {
      try {
        const lines = [];
        for (const pid of Object.keys(totals)) {
          const b = parseInt(totals[pid] && (totals[pid].bottles != null ? totals[pid].bottles : totals[pid]), 10);
          if (!Number.isFinite(b)) continue;
          const pr = await db.query('SELECT canonical_name FROM v3.products WHERE id = $1', [parseInt(pid, 10)]);
          lines.push('• ' + (pr.rows[0] ? pr.rows[0].canonical_name : 'Produto ' + pid) + ': ' + b + ' bottles');
        }
        const sum = lines.length ? Object.keys(totals).reduce((a, k) => a + (parseInt(totals[k] && (totals[k].bottles != null ? totals[k].bottles : totals[k]), 10) || 0), 0) : 0;
        const dateStr = new Date().toLocaleDateString('pt-BR', { timeZone: EDT });
        await slack.postAs({
          channel: productionChannel,
          sender: { name: 'HealthFare Tracker (Sistema)', icon: ':bar_chart:' }, thread_ts: null,
          text: '📊 *Totais do dia ' + dateStr + '* confirmados por ' + (s.display_name || '?') + ':\n' + (lines.join('\n') || '_(sem produtos)_') + (lines.length ? '\n*Total: ' + sum + ' bottles*' : '') + (note ? '\n_Nota: “' + note + '”_' : ''),
          unfurl_links: false, unfurl_media: false,
        });
      } catch (e) { console.error('[op] EOD slack falhou:', e.message); }
    }
    res.json({ ok: true });
  }));

  // ── gap detection: tempo desde a última atividade do operador ──
  async function detectGap(personId) {
    const open = await db.query("SELECT 1 FROM v3.events WHERE person_id = $1 AND ended_at IS NULL AND deleted_at IS NULL LIMIT 1", [personId]);
    if (open.rowCount) return null; // está com task aberta → ativo
    const r = await db.query(`
      SELECT GREATEST(
        COALESCE((SELECT MAX(ended_at) FROM v3.events WHERE person_id=$1 AND deleted_at IS NULL AND ended_at IS NOT NULL
                    AND (ended_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date), 'epoch'::timestamptz),
        COALESCE((SELECT MAX(created_at) FROM v3.operator_sessions WHERE person_id=$1
                    AND (created_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date), 'epoch'::timestamptz)
      ) AS ref,
      ROUND(EXTRACT(EPOCH FROM (NOW() - GREATEST(
        COALESCE((SELECT MAX(ended_at) FROM v3.events WHERE person_id=$1 AND deleted_at IS NULL AND ended_at IS NOT NULL
                    AND (ended_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date), 'epoch'::timestamptz),
        COALESCE((SELECT MAX(created_at) FROM v3.operator_sessions WHERE person_id=$1
                    AND (created_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date), 'epoch'::timestamptz)
      )))/60)::int AS minutes`, [personId]);
    const row = r.rows[0];
    if (!row || !row.ref || new Date(row.ref).getUTCFullYear() < 2000) return null; // 1º login do dia (H6) → sem gap
    return { minutes: row.minutes, since: row.ref };
  }

  // ── gap: justificar + (frontend recama o start com gap_ack) ──
  router.post('/api/v3/op/gap/justify', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const body = req.body || {};
    const startedAt = body.gap_started_at;
    const jtype = body.justification_type ? String(body.justification_type).slice(0, 40) : null;
    const note = String(body.justification_note || '').trim();
    if (!startedAt) return res.status(400).json({ error: 'gap_started_at_required' });
    if (note.length < 3) return res.status(400).json({ error: 'justification_required', detail: 'Explique o gap (mín. 3 caracteres).' });
    const ins = await db.query(
      `INSERT INTO v3.activity_gaps (person_id, gap_started_at, gap_ended_at, gap_minutes, justification_type, justification_note)
       VALUES ($1, $2::timestamptz, NOW(), ROUND(EXTRACT(EPOCH FROM (NOW() - $2::timestamptz))/60)::int, $3, $4)
       RETURNING id, gap_minutes`, [s.person_id, startedAt, jtype, note.slice(0, 500)]);
    await audit('activity_gap.justified', 'activity_gap', ins.rows[0].id, { gap_minutes: ins.rows[0].gap_minutes, type: jtype, is_test: !!s.is_sandbox }, s.person_id);
    await actionLog({ personId: s.person_id, personName: s.display_name, actionType: 'gap_justify', payload: { gap_started_at: startedAt, gap_minutes: ins.rows[0].gap_minutes, type: jtype, note }, isTest: !!s.is_sandbox });
    res.json({ ok: true, gap_minutes: ins.rows[0].gap_minutes });
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
        AND p.is_sandbox = false
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
