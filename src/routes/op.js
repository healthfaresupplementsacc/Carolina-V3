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
  const noteAnalyzer = deps.noteAnalyzer || null; // ③ Gemini lê motivos/notas (gated)
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
      // FASE PAUSA: pausa não retomada que virou o dia → unfinished (nunca bloqueia login)
      try { await expireOvernightPauses(person.id); } catch (e) { console.error('[op] expireOvernightPauses:', e.message); }
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
    // version = id do build/deploy. O app compara com o que carregou; se mudou
    // (deploy novo) → recarrega sozinho. Resolve "página aberta o dia todo não
    // atualiza". RAILWAY_GIT_COMMIT_SHA muda a cada deploy.
    const version = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.RAILWAY_DEPLOYMENT_ID || process.env.npm_package_version || 'dev';
    res.json({ ok: true, person_id: alive.person_id, version });
  }));

  // ── helpers de domínio ──────────────────────────────────────
  async function resolveActivity(slug) {
    const r = await db.query(
      'SELECT id, slug, requires_product, is_background, flow FROM v3.activity_types WHERE slug = $1 AND active = true LIMIT 1', [slug]);
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
  async function autoCreateBatch(batchNumber, productId, personId, targetBottles, unitsPerBottle) {
    const bn = String(batchNumber).trim();
    const tb = (targetBottles != null && Number.isFinite(+targetBottles)) ? +targetBottles : null;
    const upb = (unitsPerBottle != null && Number.isFinite(+unitsPerBottle)) ? +unitsPerBottle : null;
    const notes = tb != null ? ('EMS target: ' + tb + ' bottles') : null;
    const ins = await db.query(
      `INSERT INTO v3.product_batches
         (product_id, batch_number, started_at, status, origin, created_by_person_id, created_via, notes, target_bottles, units_per_bottle)
       VALUES ($1, $2, NOW(), 'in_progress', 'operator_created', $3, 'op_page', $4, $5, $6)
       RETURNING id, batch_number, product_id`, [productId, bn, personId, notes, tb, upb]);
    const row = ins.rows[0];
    let product = null;
    try { const p = await db.query('SELECT canonical_name FROM v3.products WHERE id = $1', [productId]); product = p.rows[0] ? p.rows[0].canonical_name : null; } catch (e) {}
    return { id: row.id, batch_number: row.batch_number, product_id: row.product_id, product };
  }
  // resolve OU cria. Nunca lança "unknown_batch". Se não dá pra criar (sem produto
  // identificável), volta typedUnlinked pro nº ser preservado na descrição do event.
  // PRINCÍPIO ÚNICO: o EMS é a fonte da verdade dos lotes. Acha o lote no pipeline
  // EMS por nº → devolve produto/fórmula/target bottles, pra LINKAR (não "desconhecido").
  async function emsBatchInfo(batchNumber) {
    if (!batchNumber) return null;
    try {
      const pl = await emsPipeline(); if (!pl) return null;
      const bn = String(batchNumber).trim().toUpperCase();
      const alt = bn.indexOf('BR-2026-') === 0 ? bn.slice(8) : ('BR-2026-' + bn);
      // Bruno 06-24: varre TODAS as stages do EMS (não só 3). BR-2026-0231 estava em
      // production_line.yield_review — flattenStage acha sub-stages, mas iterar todas
      // as chaves cobre qualquer stage futura/extra. flattenStage ignora não-arrays.
      for (const g of Object.keys(pl)) {
        for (const b of flattenStage(pl[g])) {
          const x = String((b && (b.batch_record_number || b.batch_number)) || '').toUpperCase();
          if (x && (x === bn || x === alt)) {
            return {
              product_name: (b.product && b.product.name) || (b.formula && b.formula.name) || null,
              formula_code: (b.formula && b.formula.formula_code) || null,
              target_bottles: b.target_qty_bottles != null ? b.target_qty_bottles : null,
              units_per_bottle: (b.formula && b.formula.units_per_bottle != null) ? b.formula.units_per_bottle : null,
            };
          }
        }
      }
    } catch (e) { console.error('[op] emsBatchInfo falhou:', e.message); }
    return null;
  }
  // resolve OU cria + LINKA produto. Ordem: lote local → product_id explícito →
  // nome (hint do frontend) → EMS (fonte da verdade). Só vira "desconhecido" se
  // realmente não dá pra identificar o produto em lugar nenhum. NUNCA bloqueia.
  async function resolveOrCreateBatch(batchNumber, productIdRaw, personId, hints) {
    if (!batchNumber) return { batch: null, autoCreated: false, typedUnlinked: null, resolvedFromEms: false };
    const existing = await resolveBatch(batchNumber);
    if (existing) return { batch: existing, autoCreated: false, typedUnlinked: null, resolvedFromEms: false };
    let pid = parseInt(productIdRaw, 10);
    let resolvedFromEms = false, targetBottles = null, unitsPerBottle = null;
    {
      // SEMPRE consulta o EMS pelo nº (fonte da verdade) p/ pegar target + cápsulas/frasco,
      // mesmo quando o product_id veio explícito (assim o lote guarda estimated bottles).
      const ems = await emsBatchInfo(batchNumber);
      if (ems) {
        if (ems.target_bottles != null) targetBottles = ems.target_bottles;
        if (ems.units_per_bottle != null) unitsPerBottle = ems.units_per_bottle;
      }
      if (!(Number.isFinite(pid) && pid > 0)) {
        // sem product_id → resolve pelo NOME (hint do frontend) ou pelo nome do EMS
        let name = (hints && hints.product_name) || (ems && ems.product_name) || null;
        if (ems && name) resolvedFromEms = true;
        if (name) { const byName = await productIdByName(name); if (Number.isFinite(byName) && byName > 0) pid = byName; }
        if (!(Number.isFinite(pid) && pid > 0)) resolvedFromEms = false; // no EMS mas sem produto local
      }
    }
    if (Number.isFinite(pid) && pid > 0) {
      try {
        const batch = await autoCreateBatch(batchNumber, pid, personId, targetBottles, unitsPerBottle);
        return { batch, autoCreated: true, typedUnlinked: null, resolvedFromEms };
      } catch (e) { console.error('[op] auto-create batch falhou:', e.message); }
    }
    // sem produto p/ vincular (ou falhou): NÃO bloqueia — segue sem batch
    return { batch: null, autoCreated: false, typedUnlinked: String(batchNumber).trim(), resolvedFromEms: false };
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
  // FASE 3b — Revisão SEM lote #: avisa o GRUPO DOS OPERADORES (canal produção).
  // Regra Bruno: "antes da revisão pedir o lote; se usar bottle sem lote, anunciar
  // no grupo". REGRA #0: NÃO bloqueia — captura e avisa. Voz do sistema, fire-and-forget.
  async function notifyReviewNoLot({ operatorName }) {
    if (!slack || !slack.postAs) return;
    const text = ':mag: *Revisão sem lote* — *' + (operatorName || '?') +
      '* começou uma revisão sem informar o lote (lot #). Por favor, sempre informe o lote na revisão pra gente medir cápsulas/frascos por lote.';
    try {
      await slack.postAs({
        channel: productionChannel,
        sender: { name: 'HealthFare Tracker (Sistema)', icon: ':mag:' },
        thread_ts: null, text, unfurl_links: false, unfurl_media: false,
      });
    } catch (e) { console.error('[op] aviso revisão sem lote falhou:', e.message); }
  }
  // audita + alerta admin quando um lote foi auto-criado ou não pôde ser vinculado.
  // Notificação é fire-and-forget (não atrasa a resposta ao operador).
  async function flagUnknownBatch({ res, autoCreated, typedUnlinked, resolvedFromEms, batch, batchNumber, body, slug, s }) {
    if (!autoCreated && !typedUnlinked) return;
    const bn = String(batchNumber || '').trim();
    const productId = batch ? batch.product_id : (body && parseInt(body.product_id, 10)) || null;
    await audit('batch.auto_created', batch ? 'product_batch' : 'event', batch ? batch.id : res.id,
      { batch_number: bn, product_id: Number.isFinite(productId) ? productId : null, person_id: s.person_id, auto_created: !!autoCreated, linked: !!batch, resolved_from_ems: !!resolvedFromEms, reason: 'operator_input_not_found', is_test: !!s.is_sandbox }, s.person_id);
    if (s.is_sandbox) return; // sandbox: NÃO notifica Slack (invisível pro resto do sistema)
    // lote do EMS resolvido e LINKADO ao produto → é legítimo, não é "desconhecido":
    // só auditа, NÃO spamma o admin. Notifica só quando realmente não deu pra identificar.
    if (resolvedFromEms && batch) return;
    notifyUnknownBatch({ batchNumber: bn, productName: batch ? batch.product : (body && body.product_name) || null, operatorName: s.display_name, slug, autoCreated: !!autoCreated });
  }
  // PRODUÇÃO (Bruno 06-23): existe OUTRA pessoa ainda na linha (production_line aberta)
  // do MESMO lote? Se sim, quem fecha agora NÃO informa bottles — só o último conta.
  async function othersOnBatchLine(batchId, exceptEventId) {
    if (!batchId) return false;
    const r = await db.query(
      `SELECT 1 FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
       WHERE at.slug = 'production_line' AND e.ended_at IS NULL AND e.deleted_at IS NULL
         AND e.product_batch_id = $1 AND e.id <> $2 LIMIT 1`, [batchId, exceptEventId]);
    return r.rowCount > 0;
  }
  async function insertCount({ event, bottles, unit, personId, kind = 'bottles' }) {
    await db.query(
      `INSERT INTO v3.production_counts
         (product_id, product_batch_id, bottles, reported_at, production_date,
          reported_by_person_id, source_event_id, unit, confidence, kind)
       VALUES ($1, $2, $3, NOW(), (NOW() AT TIME ZONE '${EDT}')::date, $4, $5, $6, 'high', $7)`,
      [event.product_id || null, event.product_batch_id || null, bottles, personId, event.id, unit || 'bottle', kind]);
  }

  // slugs cuja nota é OBRIGATÓRIA (Fase 0: + impressão de ordens, especial, Outros;
  // patch outros-por-grupo: + os 5 "*_other", tarefa livre exige explicação).
  const NOTE_REQUIRED_SLUGS = new Set([
    'break', 'special_task', 'meeting', 'training',
    'production_line_other', 'formulation_other', 'cleaning_other', 'packaging_other', 'shipping_other',
    'label_change', 'label_repair',
    'machine_downtime', // mudança #5: motivo da parada obrigatório
    'repair',           // Fase 3.3: conserto de máquina exige nota
  ]);
  // Impressão de ordens — a P&P do dia conta a partir da QUANTIDADE informada na
  // PRIMEIRA ABERTURA (regra Bruno). order_printing_2 = 2ª impressão (outro lote
  // de ordens no dia). Quem ABRE primeiro informa a quantidade (obrigatório) e ela
  // já é gravada como production_counts kind='orders' no START — não depende mais
  // do fim (que perdia conta em exceção / esquecimento). Quem ENTRA depois (joiner)
  // ou SAI não precisa informar nada (nem motivo). NÃO pede mais no fim.
  const ORDER_PRINTING_SLUGS = new Set(['order_printing', 'order_printing_2']);
  // slugs que exigem quantidade de ordens no retroativo (mantém regra antiga lá)
  const ORDERS_REQUIRED_SLUGS = ORDER_PRINTING_SLUGS;
  // grava a contagem de ordens (P&P) a partir da abertura — fonte única do total.
  async function insertOrdersCount({ eventId, productId, batchId, orders, personId, kind = 'orders' }) {
    await db.query(
      `INSERT INTO v3.production_counts
         (product_id, product_batch_id, bottles, reported_at, production_date,
          reported_by_person_id, source_event_id, unit, confidence, kind, marketplace)
       VALUES ($1, $2, $3, NOW(), (NOW() AT TIME ZONE '${EDT}')::date, $4, $5, 'orders', 'high', $6, NULL)`,
      [productId || null, batchId || null, orders, personId, eventId, kind]);
  }

  // ── COWORK AUTOMÁTICO DE P&P (regra Bruno) ──────────────────────────────
  // O P&P é uma CADEIA síncrona: quem está ativo no P&P trabalha junto. Sempre
  // que alguém inicia/termina uma tarefa P&P, religamos TODAS as P&P ao vivo do
  // dia num cowork_group compartilhado (cada event aponta cowork_with pros outros
  // participantes). Quando sobra 1 (ou 0), limpa o grupo.
  // EXCLUI clinic_shipment: envio da clínica é tarefa ISOLADA, NÃO é P&P.
  // É display-friendly: o dashboard já desenha cowork a partir de cowork_with.
  const PNP_COWORK_EXCLUDE = new Set(['clinic_shipment']);
  function isPnpCowork(act) { return !!act && act.flow === 'pnp' && !PNP_COWORK_EXCLUDE.has(act.slug); }
  async function syncPnpCowork(isSandbox) {
    try {
      const live = (await db.query(
        `SELECT e.id, e.person_id, e.cowork_group_id
           FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
          WHERE e.ended_at IS NULL AND e.deleted_at IS NULL AND COALESCE(e.is_test, false) = $1
            AND at.flow = 'pnp' AND at.slug <> 'clinic_shipment'
            AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
          ORDER BY e.started_at`, [!!isSandbox])).rows;
      const persons = [...new Set(live.map((e) => e.person_id))];
      // >=2 pessoas → grupo compartilhado; <2 → limpa (gid null, cowork_with vazio).
      const existing = live.find((e) => e.cowork_group_id);
      const gid = persons.length >= 2 ? (existing ? existing.cowork_group_id : crypto.randomUUID()) : null;
      for (const e of live) {
        const others = persons.filter((p) => p !== e.person_id);
        await db.query(
          'UPDATE v3.events SET cowork_with = $2::int[], cowork_group_id = $3::uuid, updated_at = NOW() WHERE id = $1',
          [e.id, others, gid]);
      }
    } catch (err) {
      console.error('[op] syncPnpCowork falhou (não bloqueia):', err.message);
    }
  }

  // ── COWORK GERAL: limpeza ao SAIR (regra Bruno 06-24) ───────────────────
  // Vale pra QUALQUER cowork (produção, limpeza, etc — não só P&P). Quando alguém
  // FECHA um event que tinha cowork_group_id, recomputa quem AINDA está aberto no
  // grupo e atualiza o cowork_with de cada um; sobrando <2 limpa o grupo. Era isso
  // que deixava o Vitor "em grupo / Já junto" com a Ana DEPOIS que ela saiu pro
  // almoço (cowork_with órfão). REGRA: todo fim de cowork chama isto.
  async function cleanupCoworkGroup(groupId) {
    if (!groupId) return;
    try {
      const live = (await db.query(
        `SELECT id, person_id FROM v3.events
          WHERE cowork_group_id = $1 AND ended_at IS NULL AND deleted_at IS NULL`, [groupId])).rows;
      const persons = [...new Set(live.map((e) => e.person_id))];
      if (persons.length >= 2) {
        for (const e of live) {
          const others = persons.filter((p) => p !== e.person_id);
          await db.query('UPDATE v3.events SET cowork_with = $2::int[], updated_at = NOW() WHERE id = $1', [e.id, others]);
        }
      } else {
        // 0 ou 1 → não é mais cowork: limpa grupo + cowork_with dos remanescentes.
        for (const e of live) {
          await db.query("UPDATE v3.events SET cowork_with = '{}'::int[], cowork_group_id = NULL, updated_at = NOW() WHERE id = $1", [e.id]);
        }
      }
    } catch (err) { console.error('[op] cleanupCoworkGroup falhou (não bloqueia):', err.message); }
  }

  // ── FASE PAUSA — pausa congela TODOS os processos ativos do operador ──
  const PAUSE_SLUGS = new Set(['break']); // 'break' = pausa (nota obrigatória já no NOTE_REQUIRED_SLUGS)
  // FASE OVERLAP+ALMOÇO (regra Bruno): almoço PARA o trabalho e não pode
  // trabalhar durante o almoço; duas tasks de foreground ao mesmo tempo exigem
  // confirmação. Background (máquina) NUNCA conflita.
  const LUNCH_SLUGS = new Set(['lunch']);
  // congela: marca paused_at=NOW nos events ativos do operador (menos pausas e o
  // próprio break). Relógio para; o tempo não conta como trabalho.
  async function freezeActiveFor(personId, exceptEventId) {
    await db.query(
      `UPDATE v3.events SET paused_at = NOW(), updated_at = NOW()
       WHERE person_id = $1 AND ended_at IS NULL AND deleted_at IS NULL
         AND paused_at IS NULL AND is_unfinished = FALSE AND id <> $2
         AND activity_type_id NOT IN (SELECT id FROM v3.activity_types WHERE slug = ANY($3::text[]))`,
      [personId, exceptEventId || -1, [...PAUSE_SLUGS]]);
  }
  // retoma: soma o tempo pausado em total_paused_seconds e zera paused_at. O
  // relógio volta a contar de onde parou (descontando a pausa).
  async function resumePausedFor(personId) {
    const r = await db.query(
      `UPDATE v3.events
       SET total_paused_seconds = total_paused_seconds + GREATEST(0, EXTRACT(EPOCH FROM (NOW() - paused_at))::int),
           paused_at = NULL, updated_at = NOW()
       WHERE person_id = $1 AND ended_at IS NULL AND deleted_at IS NULL AND paused_at IS NOT NULL
       RETURNING id`, [personId]);
    if (!r.rowCount) return { count: 0, tasks: [] };
    // detalhes das tarefas DESCONGELADAS → o app pergunta "continuar ou finalizar?"
    // (regra Bruno: ao voltar da pausa, escolhe; se finalizar e a task pede contagem,
    // o fluxo de finalizar já cobra a quantidade). needs_count: linha/encaps/fnsku/ordens.
    const det = await db.query(
      `SELECT e.id, at.slug, at.display_name AS label, pb.batch_number,
              pr.canonical_name AS product,
              (at.slug IN ('production_line','encapsulation','fnsku_labeling') OR at.requires_order_count = true) AS needs_count
         FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
         LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
         LEFT JOIN v3.products pr ON pr.id = pb.product_id
        WHERE e.id = ANY($1::int[])`, [r.rows.map((x) => x.id)]);
    return { count: r.rowCount, tasks: det.rows };
  }

  // ── OPERADORES DE MÁQUINA — handoff de background no almoço/pausa (regra Bruno 06-22) ──
  // Operador de máquina (Bruno/Vitor) vai pro almoço/pausa enquanto roda background
  // (encapsulação/tablete/mistura/formulação) → as máquinas PASSAM pro próximo operador
  // de máquina disponível (e SEGUEM rodando lá; não congelam). Quando ele volta, voltam
  // pra ele — só as que eram dele (bg_handoff_from_person_id), não as que o outro abriu.
  async function machineSlack(text) {
    if (!slack || !slack.postAs) return;
    try {
      await slack.postAs({ channel: 'production', sender: { name: 'HealthFare Tracker', icon: ':gear:' }, thread_ts: null, unfurl_links: false, unfurl_media: false, text });
    } catch (e) { console.error('[machine] slack falhou:', e.message); }
  }
  // máquinas (background) que esta pessoa SEGURA agora — PRÓPRIAS *e* HERDADAS de
  // outro (auditoria 07-07): antes excluía herdadas (bg_handoff IS NULL), então
  // quando o substituto que segurava a máquina de alguém ia pro almoço/logava out,
  // a máquina ficava INVISÍVEL → sem re-handoff, sem alerta de "sem supervisão", e
  // o event aberto pra sempre. Agora inclui herdadas e devolve bg_handoff_from
  // pra PRESERVAR o dono ORIGINAL no re-handoff (A→B→C mantém A como dono).
  async function myRunningMachines(personId) {
    return (await db.query(
      `SELECT e.id, e.activity_type_id, e.product_batch_id, e.is_test, e.bg_handoff_from_person_id AS handoff_from,
              at.slug, at.display_name AS act_name
         FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
        WHERE e.person_id = $1 AND e.ended_at IS NULL AND e.deleted_at IS NULL
          AND at.is_background = true`, [personId])).rows;
  }
  // PRÓXIMO operador de máquina DISPONÍVEL (invariante Bruno 07-02: presença ≠ sessão):
  // outro machine-op PRESENTE hoje — trabalhou hoje (qualquer evento) OU sessão viva OU
  // evento aberto — que NÃO está em almoço/pausa e NÃO encerrou o dia (end_of_day).
  async function findMachineRecv(personId, isSandbox) {
    const breakSlugs = [...PAUSE_SLUGS, ...LUNCH_SLUGS];
    return (await db.query(
      `SELECT p.id, p.display_name, p.slack_user_id FROM v3.persons p
        WHERE p.is_machine_operator = true AND p.active = true AND p.deleted_at IS NULL
          AND COALESCE(p.is_sandbox, false) = $2 AND p.id <> $1
          AND (
            EXISTS (SELECT 1 FROM v3.events et WHERE et.person_id = p.id AND et.deleted_at IS NULL
                    AND (et.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date)
            OR EXISTS (SELECT 1 FROM v3.operator_sessions s WHERE s.person_id = p.id AND s.logged_out_at IS NULL)
            OR EXISTS (SELECT 1 FROM v3.events ea WHERE ea.person_id = p.id AND ea.ended_at IS NULL AND ea.deleted_at IS NULL)
          )
          AND NOT EXISTS (SELECT 1 FROM v3.events e2 JOIN v3.activity_types at2 ON at2.id = e2.activity_type_id
                          WHERE e2.person_id = p.id AND e2.ended_at IS NULL AND e2.deleted_at IS NULL AND at2.slug = ANY($3::text[]))
          AND NOT EXISTS (SELECT 1 FROM v3.events e3 JOIN v3.activity_types at3 ON at3.id = e3.activity_type_id
                          WHERE e3.person_id = p.id AND e3.deleted_at IS NULL AND at3.slug = 'end_of_day'
                            AND (e3.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date)
        ORDER BY p.id LIMIT 1`, [personId, !!isSandbox, breakSlugs])).rows[0] || null;
  }
  // candidatos NÃO-operadores-de-máquina pra ficar de olho na máquina (apontados
  // pelo operador que sai) — presentes hoje, sem almoço/pausa aberto, sem end_of_day.
  async function appointCandidates(personId) {
    const breakSlugs = [...PAUSE_SLUGS, ...LUNCH_SLUGS];
    return (await db.query(
      `SELECT p.id, p.display_name FROM v3.persons p
        WHERE p.role = 'operator' AND p.active = true AND p.deleted_at IS NULL
          AND COALESCE(p.is_sandbox, false) = false AND p.id <> $1
          AND COALESCE(p.is_machine_operator, false) = false
          AND EXISTS (SELECT 1 FROM v3.events et WHERE et.person_id = p.id AND et.deleted_at IS NULL
                      AND (et.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date)
          AND NOT EXISTS (SELECT 1 FROM v3.events e2 JOIN v3.activity_types at2 ON at2.id = e2.activity_type_id
                          WHERE e2.person_id = p.id AND e2.ended_at IS NULL AND e2.deleted_at IS NULL AND at2.slug = ANY($2::text[]))
          AND NOT EXISTS (SELECT 1 FROM v3.events e3 JOIN v3.activity_types at3 ON at3.id = e3.activity_type_id
                          WHERE e3.person_id = p.id AND e3.deleted_at IS NULL AND at3.slug = 'end_of_day'
                            AND (e3.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date)
        ORDER BY p.display_name`, [personId, breakSlugs])).rows;
  }
  // ── CUSTÓDIA DURÁVEL (Bruno 07-08): quem cobre a máquina de quem, persistido em
  // v3.machine_custody. Sobrevive ao job concluir — a responsabilidade fica até o
  // dono VOLTAR e CONFIRMAR (SIM/NÃO) no app. Escala a N operadores de máquina. ──
  async function setCoverage(ownerId, coverId) {
    if (!ownerId || !coverId || ownerId === coverId) return;
    await db.query("UPDATE v3.machine_custody SET ended_at = NOW(), resolution = 'superseded' WHERE owner_person_id = $1 AND ended_at IS NULL", [ownerId]);
    await db.query("INSERT INTO v3.machine_custody (owner_person_id, cover_person_id) VALUES ($1, $2)", [ownerId, coverId]);
  }
  async function activeCoverageForOwner(ownerId) {
    return (await db.query("SELECT id, cover_person_id FROM v3.machine_custody WHERE owner_person_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1", [ownerId])).rows[0] || null;
  }
  async function activeCoverageForCover(coverId) {
    // date-scope HOJE (auditoria 07-08): defesa extra contra cobertura órfã de um
    // dia anterior que ainda não foi expirada — não mis-taggeia job novo do substituto.
    return (await db.query(
      `SELECT id, owner_person_id FROM v3.machine_custody
        WHERE cover_person_id = $1 AND ended_at IS NULL
          AND (started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date`, [coverId])).rows;
  }
  async function endCoverage(id, resolution) {
    await db.query("UPDATE v3.machine_custody SET ended_at = NOW(), resolution = $2 WHERE id = $1 AND ended_at IS NULL", [id, resolution]);
  }
  // jobs de MÁQUINA abertos que pertencem ao dono (bg_handoff_from = dono), com quem segura + produto.
  async function openCustodyJobs(ownerId) {
    return (await db.query(
      `SELECT e.id, e.person_id AS holder_id, hp.display_name AS holder_name,
              at.slug, at.display_name AS act_name, pb.batch_number, pr.canonical_name AS product
         FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
         LEFT JOIN v3.persons hp ON hp.id = e.person_id
         LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
         LEFT JOIN v3.products pr ON pr.id = pb.product_id
        WHERE e.bg_handoff_from_person_id = $1 AND e.ended_at IS NULL AND e.deleted_at IS NULL
        ORDER BY e.started_at`, [ownerId])).rows;
  }
  // Dono VOLTOU da pausa: NÃO devolve automático (Bruno 07-08). Monta o que o app
  // vai perguntar. null = ele não tinha cobertura ativa (fluxo normal, sem prompt).
  async function buildMachineReturn(ownerId) {
    const cov = await activeCoverageForOwner(ownerId);
    if (!cov) return null;
    const jobs = await openCustodyJobs(ownerId);
    const coverRow = (await db.query('SELECT display_name FROM v3.persons WHERE id = $1', [cov.cover_person_id])).rows[0];
    const coverName = coverRow ? coverRow.display_name : 'o substituto';
    if (!jobs.length) {
      // nada aberto → o substituto concluiu e não começou outra → AVISA (parada).
      await endCoverage(cov.id, 'stopped');
      await machineSlack(`:warning: *${coverName}* concluiu a(s) máquina(s) que estava cobrindo e *não começou outra* — a máquina está *parada*. Definam qual a próxima fórmula e comecem; a máquina não pode ficar parada.`);
      return { machine_return_notice: { cover_name: coverName } };
    }
    return { machine_return_confirm: {
      coverage_id: cov.id, cover_name: coverName,
      jobs: jobs.map((j) => ({ id: j.id, product: j.product || j.batch_number || j.act_name, batch_number: j.batch_number, activity: j.act_name, holder: j.holder_name })),
    } };
  }
  // Transfere UM job de máquina pro dono que voltou: fecha o do substituto e abre
  // um novo pro dono (rastreia o período de cada um), como o returnMachineWork faz.
  async function transferMachineJob(jobId, toOwnerId) {
    const j = (await db.query(
      `SELECT id, activity_type_id, product_batch_id, is_test FROM v3.events
        WHERE id = $1 AND ended_at IS NULL AND deleted_at IS NULL AND bg_handoff_from_person_id = $2`, [jobId, toOwnerId])).rows[0];
    if (!j) return false;
    await db.query("UPDATE v3.events SET ended_at = NOW(), closed_reason = 'machine_return', updated_at = NOW() WHERE id = $1", [j.id]);
    await db.query(
      `INSERT INTO v3.events (person_id, activity_type_id, product_batch_id, started_at, description, confidence, source, is_long_running, is_test)
       VALUES ($1, $2, $3, NOW(), 'Máquina retomada (dono confirmou no retorno)', 'high', 'operator_page', true, $4)`,
      [toOwnerId, j.activity_type_id, j.product_batch_id, !!j.is_test]);
    return true;
  }
  async function adminSlack(text) {
    if (!slack || !slack.postAs) return;
    try {
      await slack.postAs({ channel: adminChannel, sender: { name: 'HealthFare Tracker', icon: ':rotating_light:' }, thread_ts: null, unfurl_links: false, unfurl_media: false, text });
    } catch (e) { console.error('[machine] admin slack falhou:', e.message); }
  }
  // appointee: null = acha outro machine-op; number = pessoa APONTADA pelo operador
  // (inexperiente → mensagem SÉRIA); 'none' = ninguém disponível → formulação PARA.
  async function handoffMachineWork(personId, isSandbox, appointee = null, leaveLabel = 'almoço/pausa') {
    try {
      const me = (await db.query('SELECT is_machine_operator, display_name FROM v3.persons WHERE id = $1', [personId])).rows[0];
      if (!me || !me.is_machine_operator) return;
      const mine = await myRunningMachines(personId);
      if (!mine.length) return;
      const slugsAll = mine.map((m) => m.act_name || m.slug);
      // NINGUÉM (nem apontado): situação gravíssima — máquinas sem supervisão → PARAR.
      if (appointee === 'none') {
        const txt = `:rotating_light: *ATENÇÃO GERENTES — MÁQUINAS SEM SUPERVISÃO.* ${me.display_name} saiu (${leaveLabel}) com máquina(s) rodando (${slugsAll.join(', ')}) e NÃO HÁ NINGUÉM disponível para assumir. *A FORMULAÇÃO DEVE PARAR até alguém assumir as máquinas.* Confirmem IMEDIATAMENTE quem fica responsável.`;
        await machineSlack(txt); await adminSlack(txt);
        await audit('machine.unattended', 'person', personId, { slugs: slugsAll }, personId);
        return;
      }
      let recv = null; let inexperienced = false;
      if (Number.isFinite(appointee)) {
        recv = (await db.query('SELECT id, display_name, slack_user_id, is_machine_operator FROM v3.persons WHERE id = $1 AND active = true AND deleted_at IS NULL', [appointee])).rows[0] || null;
        inexperienced = !!recv && !recv.is_machine_operator;
      }
      if (!recv) recv = await findMachineRecv(personId, isSandbox);
      if (!recv) {
        const txt = `:rotating_light: *${me.display_name}* saiu (${leaveLabel}) com máquina(s) rodando (${slugsAll.join(', ')}) e não há outro operador de máquina disponível. *As máquinas NÃO PODEM ficar sozinhas — a formulação deve PARAR até alguém assumir.* Gerentes, confirmem quem fica responsável.`;
        await machineSlack(txt); await adminSlack(txt);
        return;
      }
      // FECHA pra ele e ABRE um novo pro receptor — rastreia o PERÍODO de cada um
      // (regra Bruno 06-24: dá pra ver quanto tempo cada um foi responsável pela máquina).
      const slugs = [];
      for (const m of mine) {
        // PRESERVA o dono ORIGINAL (auditoria 07-07): se a máquina já era HERDADA
        // (m.handoff_from setado), o novo receptor herda o MESMO dono original — não
        // vira "de mim". Assim A→B→C mantém A, e returnMachineWork(A) reencontra.
        const originalOwner = m.handoff_from || personId;
        await db.query("UPDATE v3.events SET ended_at = NOW(), closed_reason = 'machine_handoff', updated_at = NOW() WHERE id = $1", [m.id]);
        await db.query(
          `INSERT INTO v3.events (person_id, activity_type_id, product_batch_id, started_at, description, confidence, source, bg_handoff_from_person_id, is_long_running, is_test)
           VALUES ($1, $2, $3, NOW(), $4, 'high', 'operator_page', $5, true, $6)`,
          [recv.id, m.activity_type_id, m.product_batch_id, `Máquina assumida de ${me.display_name} (almoço/pausa)${inexperienced ? ' — APONTADO (não é operador de máquina)' : ''}`, originalOwner, !!m.is_test]);
        slugs.push(m.act_name || m.slug);
      }
      // registra COBERTURA por DONO original (Bruno 07-08) — durável: o retorno
      // do dono é que resolve (SIM/NÃO). Chained A→B→C mantém A como dono.
      const owners = [...new Set(mine.map((m) => m.handoff_from || personId))];
      for (const ownerId of owners) { try { await setCoverage(ownerId, recv.id); } catch (_) {} }
      await audit('machine.handoff', 'person', personId, { from: personId, to: recv.id, slugs, appointed: Number.isFinite(appointee), inexperienced }, personId);
      const ping = recv.slack_user_id ? `<@${recv.slack_user_id}>` : recv.display_name;
      const willReturn = leaveLabel === 'almoço/pausa'; // clock-out não volta hoje
      if (inexperienced) {
        // TOM SÉRIO (regra Bruno 07-02): substituto NÃO é operador de máquina.
        const txt = `:rotating_light: *ATENÇÃO: ${me.display_name} saiu (${leaveLabel}) E APONTOU ${ping} PARA CUIDAR DA(S) MÁQUINA(S) (${slugs.join(', ')}).* ${recv.display_name} NÃO é operador de máquina. *GERENTES: confirmem se está correto.* ${ping}: se precisar de QUALQUER ajuda, comunique os gerentes IMEDIATAMENTE.`;
        await machineSlack(txt); await adminSlack(txt);
      } else {
        await machineSlack(`:gear: *Operação de máquinas passada para ${ping}.* ${me.display_name} saiu (${leaveLabel}) — as máquinas (${slugs.join(', ')}) agora são sua responsabilidade. Fica de olho!${willReturn ? ` Voltam pro ${me.display_name} quando ele retornar.` : ' A máquina NÃO pode parar.'}`);
      }
    } catch (e) { console.error('[machine] handoff falhou:', e.message); }
  }
  async function returnMachineWork(personId) {
    try {
      // tarefas de máquina que o RECEPTOR (substituto) está tocando, herdadas de personId.
      // Traz QUEM cobriu (sub) e DESDE QUANDO (started_at) pra reportar o período.
      const back = (await db.query(
        `SELECT e.id, e.activity_type_id, e.product_batch_id, e.is_test, at.slug, at.display_name AS act_name,
                sub.display_name AS sub_name,
                to_char(e.started_at AT TIME ZONE '${EDT}', 'HH24:MI') AS since_t,
                to_char(NOW() AT TIME ZONE '${EDT}', 'HH24:MI') AS now_t
           FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
           LEFT JOIN v3.persons sub ON sub.id = e.person_id
          WHERE e.bg_handoff_from_person_id = $1 AND e.ended_at IS NULL AND e.deleted_at IS NULL`, [personId])).rows;
      if (!back.length) return;
      // FECHA pro substituto e REABRE pro dono original — fecha o período do substituto.
      const slugs = [];
      for (const b of back) {
        await db.query("UPDATE v3.events SET ended_at = NOW(), closed_reason = 'machine_return', updated_at = NOW() WHERE id = $1", [b.id]);
        await db.query(
          `INSERT INTO v3.events (person_id, activity_type_id, product_batch_id, started_at, description, confidence, source, is_long_running, is_test)
           VALUES ($1, $2, $3, NOW(), 'Máquina retomada (voltou do almoço/pausa)', 'high', 'operator_page', true, $4)`,
          [personId, b.activity_type_id, b.product_batch_id, !!b.is_test]);
        slugs.push(b.act_name || b.slug);
      }
      const me = (await db.query('SELECT display_name FROM v3.persons WHERE id = $1', [personId])).rows[0];
      const meName = me ? me.display_name : 'Operador';
      const sub = back[0].sub_name || 'o substituto';
      const since = back[0].since_t, nowT = back[0].now_t;
      await audit('machine.return', 'person', personId, { to: personId, slugs, sub, since, now: nowT }, personId);
      // Mensagem (regra Bruno 06-24): registra o PERÍODO que o substituto foi responsável.
      await machineSlack(`:white_check_mark: *${meName} voltou* — a operação de máquina (${slugs.join(', ')}) volta de ${sub} pra ${meName}. Ficou registrado como responsabilidade de *${sub}* das *${since}* às *${nowT}* (enquanto ${meName} estava em almoço/pausa).`);
    } catch (e) { console.error('[machine] return falhou:', e.message); }
  }
  // pausa não retomada que virou o dia (P-PAUSA.5): fecha o break velho e marca o
  // trabalho congelado como is_unfinished (some das tarefas ativas; fica aberto p/
  // outro finalizar/continuar). Roda no login. NUNCA bloqueia (try/catch no caller).
  async function expireOvernightPauses(personId) {
    await db.query(
      `UPDATE v3.events SET ended_at = NOW(), closed_reason = 'pause_expired_overnight', updated_at = NOW()
       WHERE person_id = $1 AND ended_at IS NULL AND deleted_at IS NULL
         AND activity_type_id IN (SELECT id FROM v3.activity_types WHERE slug = ANY($2::text[]))
         AND (started_at AT TIME ZONE '${EDT}')::date < (NOW() AT TIME ZONE '${EDT}')::date`,
      [personId, [...PAUSE_SLUGS]]);
    // CUSTÓDIA de máquina que virou o dia (auditoria 07-07): um evento de custódia
    // (bg_handoff) aberto de um dia ANTERIOR = o dono não voltou naquele dia →
    // órfão. Fecha GLOBAL (qualquer login limpa) pra não ficar aberto pra sempre
    // nem re-devolver fantasma amanhã. Own-machines (bg_handoff NULL) não tocadas.
    await db.query(
      `UPDATE v3.events SET ended_at = NOW(), closed_reason = 'machine_custody_expired_overnight', updated_at = NOW()
       WHERE bg_handoff_from_person_id IS NOT NULL AND ended_at IS NULL AND deleted_at IS NULL
         AND (started_at AT TIME ZONE '${EDT}')::date < (NOW() AT TIME ZONE '${EDT}')::date`);
    // …e RESOLVE as linhas de cobertura órfãs (auditoria 07-08): a cobertura é
    // durável, então se o dono não voltou e virou o dia, a linha ficava ATIVA pra
    // sempre — mis-taggeava jobs novos do substituto e disparava "máquina parada"
    // falso. Fecha as de dias anteriores como 'expired'.
    await db.query(
      "UPDATE v3.machine_custody SET ended_at = NOW(), resolution = 'expired' WHERE ended_at IS NULL AND (started_at AT TIME ZONE '" + EDT + "')::date < (NOW() AT TIME ZONE '" + EDT + "')::date").catch(() => {});
    const r = await db.query(
      `UPDATE v3.events SET is_unfinished = TRUE, updated_at = NOW()
       WHERE person_id = $1 AND ended_at IS NULL AND deleted_at IS NULL AND paused_at IS NOT NULL
         AND (paused_at AT TIME ZONE '${EDT}')::date < (NOW() AT TIME ZONE '${EDT}')::date
       RETURNING id`, [personId]);
    return r.rowCount;
  }

  // ── start ───────────────────────────────────────────────────
  router.post('/api/v3/op/event/start', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const { activity_slug, batch_number, cowork_with, note } = req.body || {};
    const act = await resolveActivity(String(activity_slug || ''));
    if (!act) return res.status(400).json({ error: 'unknown_activity_slug', slug: activity_slug || null });
    if (NOTE_REQUIRED_SLUGS.has(act.slug) && !(note && String(note).trim())) {
      return res.status(400).json({ error: 'note_required', detail: 'Esta task exige uma nota.' });
    }
    // IMPRESSÃO DE ORDENS — a quantidade só é OBRIGATÓRIA na PRIMEIRA ABERTURA do
    // dia (ninguém com esse slug aberto agora). Quem entra depois (joiner) não
    // precisa informar. A quantidade do 1º-abre é o total de ordens do P&P.
    let ordersPrinted = null;
    let isFirstOrderOpen = false;
    if (ORDER_PRINTING_SLUGS.has(act.slug)) {
      const openSame = (await db.query(
        `SELECT 1 FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
         WHERE at.slug = $1 AND e.ended_at IS NULL AND e.deleted_at IS NULL
           AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date LIMIT 1`,
        [act.slug])).rows[0];
      isFirstOrderOpen = !openSame;
      const qty = parseInt(req.body && req.body.orders_printed, 10);
      if (isFirstOrderOpen) {
        if (!Number.isFinite(qty) || qty <= 0) {
          return res.status(400).json({ error: 'orders_printed_required', detail: 'Informe quantas ordens vão imprimir (número > 0).' });
        }
        ordersPrinted = qty;
      } else {
        ordersPrinted = (Number.isFinite(qty) && qty > 0) ? qty : null; // joiner: opcional
      }
    } else if (act.slug === 'clinic_shipment') {
      // ENVIO CLÍNICA (regra Bruno 06-22): quantidade OPCIONAL no começo. Se vier,
      // grava como métrica PRÓPRIA (kind='clinic') no START — NUNCA soma no P&P.
      // Se NÃO vier aqui, é obrigatória no FIM (ver needClinic no /end). Cada envio
      // informa a sua (não tem lógica de 1º-abre).
      const qty = parseInt(req.body && req.body.orders_printed, 10);
      ordersPrinted = (Number.isFinite(qty) && qty > 0) ? qty : null;
    }
    // PASSADA 2 — gap detection: >20min sem atividade → pausa pra justificar ANTES
    // de iniciar (captura info, NÃO nega trabalho). Sandbox e retry (gap_ack) pulam.
    if (!s.is_sandbox && !(req.body && req.body.gap_ack)) {
      const gap = await detectGap(s.person_id);
      if (gap && gap.minutes > 20 && gap.minutes < 480) {
        return res.json({ ok: true, gap_detected: true, gap_minutes: gap.minutes, gap_started_at: gap.since });
      }
    }
    // ── EXCLUSIVIDADE (overlap + almoço) ─────────────────────────
    // Regra Bruno (06/19 Victor estava em linha+limpeza+almoço ao mesmo tempo):
    //  • almoço PARA (fecha) as tasks de foreground ativas; máquina/background segue.
    //  • durante o almoço, NÃO pode começar trabalho de foreground (precisa encerrar).
    //  • duas tasks de foreground (slug diferente) ao mesmo tempo → confirma
    //    ("fechar a anterior" OU "tem certeza que vai fazer 2 ao mesmo tempo").
    //  • background (encapsulação/mistura/tablete) nunca conflita.
    // Mesmo padrão do gap: devolve ok:true + flag (NUNCA 4xx); o front confirma e
    // recama com concurrent_ack ('close' | 'both' | 'end_lunch').
    const isBackground = !!act.is_background;
    const isLunch = LUNCH_SLUGS.has(act.slug);
    const isPause = PAUSE_SLUGS.has(act.slug);
    const cAck = (req.body && req.body.concurrent_ack) || null;
    // custódia: se o dono voltou da pausa (encerrou almoço/break aqui pra trabalhar),
    // o app PERGUNTA se ele assume a máquina (Bruno 07-08). Preenchido nas transições.
    let machineReturn = null;
    // ── MÁQUINAS SEM SUPERVISÃO (regra Bruno 07-02) ──────────────────────────
    // Operador de máquina saindo pra almoço/pausa com máquina rodando e SEM outro
    // operador de máquina disponível → pergunta QUEM fica responsável ANTES de
    // deixar sair (flag interativa, nunca 4xx; o app mostra a lista e recama com
    // machine_appointee_id = <person_id> ou 'none').
    const apRaw = req.body && req.body.machine_appointee_id;
    if ((isLunch || isPause) && !s.is_sandbox && apRaw == null) {
      const machines = await myRunningMachines(s.person_id);
      if (machines.length && !(await findMachineRecv(s.person_id, false))) {
        const candidates = await appointCandidates(s.person_id);
        return res.json({ ok: true, machine_appoint_required: true,
          machines: machines.map((m) => m.act_name || m.slug), candidates });
      }
    }
    if (!s.is_sandbox) {
      const openFg = (await db.query(
        `SELECT e.id, e.started_at, e.cowork_group_id, at.slug, at.display_name AS activity_name
         FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
         WHERE e.person_id = $1 AND e.ended_at IS NULL AND e.deleted_at IS NULL
           AND e.is_unfinished = false AND COALESCE(at.is_background, false) = false
         ORDER BY e.started_at`, [s.person_id])).rows;
      // COWORK (Bruno 06-24): ao auto-fechar tarefas do operador (almoço/troca de
      // task), limpa o cowork_with dos COLEGAS que ficaram nos grupos fechados —
      // senão eles seguem "em grupo / Já junto" com quem saiu (bug Ana×Vitor).
      const cleanupGids = (ids) => {
        const gids = [...new Set(openFg.filter((o) => ids.indexOf(o.id) >= 0 && o.cowork_group_id).map((o) => o.cowork_group_id))];
        return Promise.all(gids.map((g) => cleanupCoworkGroup(g)));
      };
      const openLunch = openFg.find((o) => LUNCH_SLUGS.has(o.slug));
      if (isLunch) {
        // começar almoço PARA o trabalho de foreground (fecha); máquina segue rodando.
        const toClose = openFg.filter((o) => !LUNCH_SLUGS.has(o.slug)).map((o) => o.id);
        if (toClose.length) {
          await db.query(`UPDATE v3.events SET ended_at = NOW(), closed_reason = 'lunch_started', updated_at = NOW() WHERE id = ANY($1::int[])`, [toClose]);
          await cleanupGids(toClose); // tira o operador do cowork dos colegas
        }
      } else if (!isBackground && !isPause) {
        // (a) almoço aberto → não pode trabalhar (a menos que encerre o almoço)
        if (openLunch) {
          if (cAck === 'end_lunch') {
            await db.query(`UPDATE v3.events SET ended_at = NOW(), closed_reason = 'lunch_ended_to_work', updated_at = NOW() WHERE id = $1`, [openLunch.id]);
            try { machineReturn = await buildMachineReturn(s.person_id); } catch (e) { console.error('[machine] return-confirm falhou:', e.message); }
          } else {
            return res.json({ ok: true, lunch_active: true, lunch_event_id: openLunch.id });
          }
        }
        // (b) outra foreground (slug diferente) já aberta → confirma
        const others = openFg.filter((o) => !LUNCH_SLUGS.has(o.slug) && o.slug !== act.slug);
        if (others.length) {
          if (cAck === 'close') {
            const oids = others.map((o) => o.id);
            await db.query(`UPDATE v3.events SET ended_at = NOW(), closed_reason = 'closed_for_new_task', updated_at = NOW() WHERE id = ANY($1::int[])`, [oids]);
            await cleanupGids(oids); // tira o operador do cowork dos colegas
            // retomou de um BREAK começando outra task → também é "dono voltou" → pergunta.
            if (others.some((o) => PAUSE_SLUGS.has(o.slug))) {
              try { machineReturn = await buildMachineReturn(s.person_id); } catch (e) { console.error('[machine] return-confirm falhou:', e.message); }
            }
          } else if (cAck !== 'both') {
            return res.json({ ok: true, concurrent_open: true,
              open_tasks: others.map((o) => ({ id: o.id, slug: o.slug, activity: o.activity_name, started_at: o.started_at })) });
          }
          // cAck === 'both' → segue e permite a sobreposição (operador confirmou)
        }
      }
    }
    // CUSTÓDIA (Bruno 07-08): se QUEM inicia está COBRINDO a máquina de alguém
    // (cobertura ativa), um job novo de MÁQUINA pertence ao DONO — entra no pool
    // que o dono confirma quando voltar (SIM/NÃO). Só quando é 1 dono (sem
    // ambiguidade); background só. Vira o bg_handoff_from_person_id no INSERT.
    let bgHandoffFrom = null;
    if (isBackground && !s.is_sandbox) {
      try { const cov = await activeCoverageForCover(s.person_id); if (cov.length === 1) bgHandoffFrom = cov[0].owner_person_id; } catch (_) {}
    }
    // NUNCA bloqueia: resolve o lote OU auto-cria (alerta admin depois)
    const { batch, autoCreated, typedUnlinked, resolvedFromEms } = await resolveOrCreateBatch(batch_number, req.body && req.body.product_id, s.person_id, { product_name: req.body && req.body.product_name });
    // FASE 3b — Revisão sem lote #: avisa o grupo dos operadores (não bloqueia, fire-and-forget).
    if (act.slug === 'review' && !(batch_number && String(batch_number).trim()) && !s.is_sandbox) {
      notifyReviewNoLot({ operatorName: s.display_name });
    }
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
              cowork_with, confidence, source, orders_printed, cowork_group_id, is_test, is_long_running)
           VALUES ($1, $2, $3, $4::timestamptz, $5, $6::int[], 'high', 'operator_page', $7, $8::uuid, $9, $10)
           RETURNING id, person_id, activity_type_id, product_batch_id, started_at, cowork_with, orders_printed, cowork_group_id`,
          [pid, act.id, batch ? batch.id : null, startedAt, desc, others, ordersPrinted, gid, !!s.is_sandbox, !!act.is_background]);
        if (pid === s.person_id) starterEv = r.rows[0];
      }
      await audit('event.created_via_page', 'event', starterEv.id,
        { slug: act.slug, batch: batch ? batch.batch_number : null, cowork_with: cw, cowork_group_id: gid, cowork_size: participants.length }, s.person_id);
      await flagUnknownBatch({ res: starterEv, autoCreated, typedUnlinked, resolvedFromEms, batch, batchNumber: batch_number, body: req.body, slug: act.slug, s });
      await actionLog({ personId: s.person_id, personName: s.display_name, actionType: 'task_start', payload: { slug: act.slug, batch_number, cowork_with: cw, cowork_group_id: gid, note }, relatedEventId: starterEv.id, isTest: !!s.is_sandbox });
      if (PAUSE_SLUGS.has(act.slug)) await freezeActiveFor(s.person_id, starterEv.id); // FASE PAUSA: congela o resto
      if (ORDER_PRINTING_SLUGS.has(act.slug) && isFirstOrderOpen && ordersPrinted > 0) {
        await insertOrdersCount({ eventId: starterEv.id, productId: null, batchId: batch ? batch.id : null, orders: ordersPrinted, personId: s.person_id });
      } else if (act.slug === 'clinic_shipment' && ordersPrinted > 0) {
        await insertOrdersCount({ eventId: starterEv.id, productId: null, batchId: batch ? batch.id : null, orders: ordersPrinted, personId: s.person_id, kind: 'clinic' });
      }
      if (isPnpCowork(act)) await syncPnpCowork(s.is_sandbox);   // cadeia P&P → cowork automático
      return res.json({ ok: true, event: { ...starterEv, slug: act.slug, batch_number: batch ? batch.batch_number : null, product: batch ? batch.product : null }, ...(machineReturn || {}) });
    }

    // DEDUP (anti "mesma task sobre a mesma task"): se já existe event ABERTO
    // desta pessoa, MESMA atividade E MESMO lote → devolve o existente em vez de
    // criar um duplicado sobreposto. Só quando há lote (caso claro: encapsular o
    // MESMO lote 2x ao mesmo tempo não existe). REGRA #0: não bloqueia, reaproveita.
    if (batch && cw.length === 0) {
      const dup = (await db.query(
        `SELECT e.id, e.started_at FROM v3.events e
         WHERE e.person_id = $1 AND e.activity_type_id = $2 AND e.product_batch_id = $3
           AND e.ended_at IS NULL AND e.deleted_at IS NULL AND e.is_unfinished = false
         ORDER BY e.started_at DESC LIMIT 1`, [s.person_id, act.id, batch.id])).rows[0];
      if (dup) {
        await actionLog({ personId: s.person_id, personName: s.display_name, actionType: 'task_start_dedup', payload: { slug: act.slug, batch_number: batch.batch_number, existing_event_id: dup.id }, relatedEventId: dup.id, isTest: !!s.is_sandbox });
        return res.json({ ok: true, duplicate: true, event: { id: dup.id, person_id: s.person_id, started_at: dup.started_at, slug: act.slug, batch_number: batch.batch_number, product: batch.product }, ...(machineReturn || {}) });
      }
    }
    // ── SOLO: comportamento original (1 event, sem grupo) ──
    // is_long_running = is_background (encapsulação/tablete/mistura rodam na MÁQUINA
    // em background → não ocupam o operador em foreground; não conflitam, não entram
    // na detecção de ausência, e a pessoa pode pegar outra função enquanto roda).
    const ins = await db.query(
      `INSERT INTO v3.events
         (person_id, activity_type_id, product_batch_id, started_at, description,
          cowork_with, confidence, source, orders_printed, is_test, is_long_running, bg_handoff_from_person_id)
       VALUES ($1, $2, $3, NOW(), $4, $5::int[], 'high', 'operator_page', $6, $7, $8, $9)
       RETURNING id, person_id, activity_type_id, product_batch_id, started_at, cowork_with, orders_printed`,
      [s.person_id, act.id, batch ? batch.id : null, desc, cw, ordersPrinted, !!s.is_sandbox, !!act.is_background, bgHandoffFrom]);
    const ev = ins.rows[0];
    await audit('event.created_via_page', 'event', ev.id,
      { slug: act.slug, batch: batch ? batch.batch_number : null, cowork_with: cw }, s.person_id);
    await flagUnknownBatch({ res: ev, autoCreated, typedUnlinked, resolvedFromEms, batch, batchNumber: batch_number, body: req.body, slug: act.slug, s });
    await actionLog({ personId: s.person_id, personName: s.display_name, actionType: 'task_start', payload: { slug: act.slug, batch_number, note }, relatedEventId: ev.id, isTest: !!s.is_sandbox });
    if (noteAnalyzer && note && String(note).trim()) noteAnalyzer.queue({ text: String(note).trim(), personId: s.person_id, personName: s.display_name, slug: act.slug, isSandbox: !!s.is_sandbox }); // ③ lê o motivo
    // operador de máquina indo pro almoço/pausa → passa as máquinas ANTES de congelar
    // (handoff reatribui o background; o que sobra dele é que congela).
    if (LUNCH_SLUGS.has(act.slug) || PAUSE_SLUGS.has(act.slug)) {
      // apontado pelo operador ('none' = ninguém → alerta FORMULAÇÃO PARA)
      const ap = apRaw === 'none' ? 'none' : (Number.isFinite(parseInt(apRaw, 10)) ? parseInt(apRaw, 10) : null);
      await handoffMachineWork(s.person_id, s.is_sandbox, ap);
    }
    if (PAUSE_SLUGS.has(act.slug)) await freezeActiveFor(s.person_id, ev.id); // FASE PAUSA: congela o resto
    if (ORDER_PRINTING_SLUGS.has(act.slug) && isFirstOrderOpen && ordersPrinted > 0) {
      await insertOrdersCount({ eventId: ev.id, productId: null, batchId: batch ? batch.id : null, orders: ordersPrinted, personId: s.person_id });
    } else if (act.slug === 'clinic_shipment' && ordersPrinted > 0) {
      await insertOrdersCount({ eventId: ev.id, productId: null, batchId: batch ? batch.id : null, orders: ordersPrinted, personId: s.person_id, kind: 'clinic' });
    }
    if (isPnpCowork(act)) await syncPnpCowork(s.is_sandbox);   // cadeia P&P → cowork automático
    res.json({ ok: true, event: { ...ev, slug: act.slug, batch_number: batch ? batch.batch_number : null, product: batch ? batch.product : null }, ...(machineReturn || {}) });
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
    // validação de tempo no DB (evita ciladas de TZ no JS). Guardas duras
    // (espelhadas no frontend op/app.js): nunca no futuro; mesmo dia NY p/
    // início E fim; fim > início; início >= 06:00 (linha não abre antes);
    // fim <= 23:00 (teto). Bloqueia na origem o "8:33am invertido" (fim
    // antes do início / em outro dia). Os avisos "confirme" (6–8h, >2h,
    // depois das 21h) são soft e vivem só no frontend.
    const tv = await db.query(
      `SELECT ($1::timestamptz <= NOW()) AS not_future,
              (($1::timestamptz AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date) AS same_day,
              (($1::timestamptz AT TIME ZONE '${EDT}')::time >= TIME '06:00') AS start_after_6,
              ($2::timestamptz IS NULL OR ($2::timestamptz > $1::timestamptz AND $2::timestamptz <= NOW())) AS end_ok,
              ($2::timestamptz IS NULL OR ($2::timestamptz AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date) AS end_same_day,
              ($2::timestamptz IS NULL OR ($2::timestamptz AT TIME ZONE '${EDT}')::time <= TIME '23:00') AS end_before_2300`,
      [started_at, ended_at || null]);
    const v = tv.rows[0];
    if (!v.not_future) return res.status(400).json({ error: 'started_at_future' });
    if (!v.same_day) return res.status(400).json({ error: 'started_at_not_today', detail: 'Operador só adiciona tasks de hoje. Dias anteriores: peça ao admin.' });
    if (!v.start_after_6) return res.status(400).json({ error: 'started_at_too_early', detail: 'A linha não abre antes das 6h da manhã.' });
    if (!v.end_ok) return res.status(400).json({ error: 'ended_at_invalid', detail: 'Fim deve ser depois do início e não pode ser futuro.' });
    if (!v.end_same_day) return res.status(400).json({ error: 'ended_at_not_today', detail: 'O fim tem que ser no mesmo dia do início.' });
    if (!v.end_before_2300) return res.status(400).json({ error: 'ended_at_too_late', detail: 'O fim não pode passar das 11pm.' });
    // NUNCA bloqueia: resolve OU auto-cria o lote (alerta admin depois)
    const { batch, autoCreated, typedUnlinked, resolvedFromEms } = await resolveOrCreateBatch(batch_number, req.body && req.body.product_id, s.person_id, { product_name: req.body && req.body.product_name });
    const cw = Array.isArray(cowork_with)
      ? cowork_with.map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && x > 0 && x !== s.person_id) : [];
    let rdesc = note ? String(note).slice(0, 500) : null;
    if (typedUnlinked) rdesc = (rdesc ? rdesc + ' ' : '') + '[lote digitado: ' + typedUnlinked + ' — produto não identificado]';
    const ins = await db.query(
      `INSERT INTO v3.events
         (person_id, activity_type_id, product_batch_id, started_at, ended_at, description,
          cowork_with, confidence, source, orders_printed, closed_reason, is_test, is_long_running)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7::int[], 'high', 'operator_page_retroactive', $8,
               CASE WHEN $5::timestamptz IS NULL THEN NULL ELSE 'operator_retroactive_close' END, $9, $10)
       RETURNING id, started_at, ended_at`,
      [s.person_id, act.id, batch ? batch.id : null, started_at, ended_at || null,
        rdesc, cw, ordersPrinted, !!s.is_sandbox, !!act.is_background]);
    const ev = ins.rows[0];
    // SINCRONIA (Bruno 07-02): retroativo com cowork ESPELHA o evento pros colegas
    // (mesma janela/atividade/lote, grupo compartilhado) — igual ao start ao vivo,
    // que cria 1 evento por participante. Antes só gravava cowork_with no evento do
    // autor e o colega ficava SEM NADA na timeline (mesmo buraco do dashboard).
    if (cw.length) {
      const gid = crypto.randomUUID();
      await db.query('UPDATE v3.events SET cowork_group_id = $2::uuid, updated_at = NOW() WHERE id = $1', [ev.id, gid]);
      for (const pid of cw) {
        // anti-duplicata: colega já tem a MESMA atividade sobrepondo a janela? pula.
        const dup = await db.query(
          `SELECT 1 FROM v3.events WHERE person_id = $1 AND deleted_at IS NULL AND activity_type_id = $2
             AND started_at < COALESCE($4::timestamptz, NOW()) AND COALESCE(ended_at, NOW()) > $3::timestamptz LIMIT 1`,
          [pid, act.id, started_at, ended_at || null]);
        if (dup.rowCount) continue;
        await db.query(
          `INSERT INTO v3.events
             (person_id, activity_type_id, product_batch_id, started_at, ended_at, description,
              cowork_with, cowork_group_id, confidence, source, closed_reason, is_test, is_long_running)
           VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7::int[], $8::uuid, 'high', 'operator_page_retroactive',
                   CASE WHEN $5::timestamptz IS NULL THEN NULL ELSE 'operator_retroactive_close' END, $9, $10)`,
          [pid, act.id, batch ? batch.id : null, started_at, ended_at || null, rdesc,
            [s.person_id, ...cw.filter((x) => x !== pid)], gid, !!s.is_sandbox, !!act.is_background]);
      }
    }
    const gapMin = await db.query("SELECT ROUND(EXTRACT(EPOCH FROM (NOW() - $1::timestamptz))/60)::int g", [started_at]);
    await audit('event.retroactive_create', 'event', ev.id,
      { slug: act.slug, retroactive: true, gap_minutes: gapMin.rows[0].g, ended: !!ended_at, batch: batch ? batch.batch_number : null, cowork_mirrored: cw.length }, s.person_id);
    await flagUnknownBatch({ res: ev, autoCreated, typedUnlinked, resolvedFromEms, batch, batchNumber: batch_number, body: req.body, slug: act.slug, s });
    res.json({ ok: true, event_id: ev.id, status: 'created' });
  }));

  // ── end ─────────────────────────────────────────────────────
  async function loadOwnedOpenEvent(req, res, s) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'bad_id' }); return null; }
    const r = await db.query(
      `SELECT e.id, e.person_id, e.cowork_with, e.product_batch_id, e.ended_at, e.deleted_at,
              e.is_long_running, e.cowork_group_id, at.slug, at.flow, at.requires_order_count, pb.product_id,
              pb.batch_number, pb.target_bottles, pr.canonical_name AS product
       FROM v3.events e
       LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
       LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
       LEFT JOIN v3.products pr ON pr.id = pb.product_id
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
  // ITEM 1 — aviso de divergência bottles (real vs estimado do EMS) → produção.
  async function notifyBottleMismatch({ ev, target, actual, pct, s }) {
    if (!slack || !slack.postAs) return;
    const arrow = pct > 0 ? ':arrow_up:' : ':arrow_down:';
    const text =
      ':bar_chart: *Contagem fora do estimado*\n\n' +
      '*Operador(a):* ' + (s.display_name || '?') + '\n' +
      '*Produto/Lote:* ' + (ev.product || '—') + ' · ' + (ev.batch_number || '—') + '\n' +
      '*Estimado (EMS):* ' + target + ' bottles\n' +
      '*Informado:* ' + actual + ' bottles  ' + arrow + ' ' + (pct > 0 ? '+' : '') + pct + '%\n\n' +
      '_Diferença ≥ 10% — verificar se a contagem está correta._';
    try {
      await slack.postAs({ channel: productionChannel, sender: { name: 'HealthFare Tracker (Sistema)', icon: ':bar_chart:' }, thread_ts: null, text, unfurl_links: false, unfurl_media: false });
    } catch (e) { console.error('[op] aviso bottle mismatch falhou:', e.message); }
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
    const isFnsku = ev.slug === 'fnsku_labeling';   // FNSKU: conta LABELS colados
    const isCowork = !!ev.cowork_group_id;
    let isLast = true, remaining = 1;
    if (isCowork) {
      const rc = await db.query(
        'SELECT COUNT(*)::int AS n FROM v3.events WHERE cowork_group_id = $1 AND ended_at IS NULL AND deleted_at IS NULL',
        [ev.cowork_group_id]);
      remaining = rc.rows[0].n; // inclui o event atual (ainda aberto)
      isLast = remaining <= 1;
    }
    // precisa pedir contagem de ordens no fim? clinic_shipment: SÓ se não foi
    // informada no início (senão duplicava). Outros: pelo requires_order_count.
    let needsOrderCount = (!isCowork || isLast) && !!ev.requires_order_count && !ORDER_PRINTING_SLUGS.has(ev.slug) && ev.slug !== 'clinic_shipment';
    if (ev.slug === 'clinic_shipment' && (!isCowork || isLast)) {
      const cc = await db.query(
        "SELECT 1 FROM v3.production_counts WHERE source_event_id = $1 AND kind = 'clinic' AND deleted_at IS NULL LIMIT 1", [ev.id]);
      needsOrderCount = cc.rowCount === 0;
    }
    // PRODUÇÃO (Bruno 06-23): só o ÚLTIMO a fechar a linha do MESMO LOTE informa as
    // bottles. Se OUTRA pessoa ainda está na linha do mesmo lote (cowork de fato,
    // mesmo sem cowork_group), NÃO pede agora — não pergunta pra quem sai pro almoço
    // enquanto o colega continua produzindo. (FNSKU é por pessoa → não entra aqui.)
    let requiresBottleCount = (!isCowork || isLast) && isProd;
    if (requiresBottleCount && ev.product_batch_id && await othersOnBatchLine(ev.product_batch_id, ev.id)) {
      requiresBottleCount = false;
    }
    res.json({
      ok: true,
      event_id: ev.id,
      slug: ev.slug,
      is_cowork: isCowork,
      is_last_finisher: isLast,
      requires_bottle_count: requiresBottleCount,
      requires_fnsku_count: (!isCowork || isLast) && isFnsku,  // FNSKU: # labels colados
      needs_order_count: needsOrderCount,
      estimated_bottles: ev.target_bottles != null ? ev.target_bottles : null, // ITEM 1 — EMS target
      cowork_remaining: isCowork ? Math.max(0, remaining - 1) : 0, // colegas além de mim ainda na tarefa
    });
  }));

  router.post('/api/v3/op/event/:id/end', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const ev = await loadOwnedOpenEvent(req, res, s); if (!ev) return;
    if (ev.ended_at) return res.status(409).json({ error: 'already_ended' });
    const body = req.body || {};
    const { unit, note } = body;
    // aceita bottles OU bottles_count (alias) OU fnsku_labels (FNSKU usa o MESMO campo de contagem)
    const bottlesRaw = body.bottles != null ? body.bottles
      : (body.bottles_count != null ? body.bottles_count : body.fnsku_labels);
    const b = parseInt(bottlesRaw, 10);
    const isProd = ev.slug === 'production_line';
    const isFnsku = ev.slug === 'fnsku_labeling';   // FNSKU: conta LABELS colados (kind='fnsku')

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
    let needCount = (!isCowork || isLast) && isProd;                         // bottles (linha)
    // Bruno 06-23: se OUTRA pessoa ainda está na linha do MESMO lote, quem fecha
    // agora NÃO informa bottles (só o último conta). Não vale p/ FNSKU (é por pessoa).
    if (needCount && ev.product_batch_id && await othersOnBatchLine(ev.product_batch_id, ev.id)) {
      needCount = false;
    }
    const needFnsku = (!isCowork || isLast) && isFnsku;                      // labels (FNSKU)
    const needBottleLike = needCount || needFnsku;   // ambos usam o valor `b` (mesma UI)
    const countKind = needFnsku ? 'fnsku' : 'bottles';
    const countUnit = needFnsku ? 'label' : (unit || 'bottle');
    // ordens: NÃO pede mais no fim da impressão de ordens — a P&P conta a partir
    // da quantidade da PRIMEIRA ABERTURA (gravada no START). Some o "quantas
    // foram empacotadas?" e a exceção "não tenho o número" (regra Bruno).
    // clinic_shipment (regra Bruno 06-22): conta no START se informado (kind='clinic').
    // Se NÃO foi informado no início → OBRIGATÓRIO no FIM (needClinic). Se já foi,
    // não pergunta de novo (não duplica). NUNCA soma no P&P.
    const needOrders = (!isCowork || isLast) && !!ev.requires_order_count && !ORDER_PRINTING_SLUGS.has(ev.slug) && ev.slug !== 'clinic_shipment';
    let needClinic = false;
    if (ev.slug === 'clinic_shipment' && (!isCowork || isLast)) {
      const cc = await db.query(
        "SELECT 1 FROM v3.production_counts WHERE source_event_id = $1 AND kind = 'clinic' AND deleted_at IS NULL LIMIT 1", [ev.id]);
      needClinic = cc.rowCount === 0; // não informou no início → exige agora
    }
    const oc = parseInt(body.orders_count, 10);
    const marketplace = body.marketplace ? String(body.marketplace).slice(0, 40) : null;
    const exception = (needBottleLike || needOrders || needClinic) && (body.exception_no_count === true || body.exception_no_count === 'true');
    const reason = exception ? String(body.exception_reason || '').trim() : null;

    if (!exception) {
      if (needBottleLike && !(Number.isFinite(b) && b > 0)) {
        return res.status(400).json({
          error: needFnsku ? 'fnsku_required' : 'bottles_required',
          detail: needFnsku ? 'Informe quantos FNSKU / labels foram colados (ou marque a exceção).' : 'Informe quantas bottles foram produzidas (ou marque a exceção).',
        });
      }
      if ((needOrders || needClinic) && !(Number.isFinite(oc) && oc > 0)) {
        return res.status(400).json({ error: 'orders_required', detail: needClinic ? 'Informe a quantidade de ordens da clínica (ou marque a exceção).' : 'Informe quantas ordens/unidades (ou marque a exceção).' });
      }
    } else if ((needBottleLike || needOrders || needClinic) && reason.length < 10) {
      return res.status(400).json({ error: 'exception_reason_required', detail: 'Explique por que não tem a contagem (mín. 10 caracteres).' });
    }

    // PROTEÇÃO CONTRA CONTAGEM DOBRADA (regra Bruno 06-22): se ESTE lote já tem
    // contagem de bottles hoje (de OUTRO evento), confirma antes de somar de novo
    // — pega o caso da Ana+Vitor contando o mesmo lote 2× (1136 vs 600). Evento
    // ainda NÃO foi fechado aqui → na confirmação (dup_count_ack) refaz e fecha.
    if (needCount && !exception && Number.isFinite(b) && b > 0 && ev.product_batch_id && body.dup_count_ack !== true) {
      const dup = await db.query(
        `SELECT COALESCE(SUM(pc.bottles),0)::int AS total, MAX(pe.display_name) AS by_name
         FROM v3.production_counts pc LEFT JOIN v3.persons pe ON pe.id = pc.reported_by_person_id
         WHERE pc.kind = 'bottles' AND pc.deleted_at IS NULL AND pc.superseded_by IS NULL
           AND pc.product_batch_id = $1 AND pc.source_event_id <> $2
           AND pc.production_date = (NOW() AT TIME ZONE '${EDT}')::date`, [ev.product_batch_id, ev.id]);
      const drow = dup.rows[0] || {};
      if (Number(drow.total) > 0) {
        return res.json({ ok: true, dup_count_warning: true, existing_total: Number(drow.total), existing_by: drow.by_name || null, attempted: b });
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

    // Cadeia P&P: ao terminar, religa o cowork das que sobraram ao vivo (tira
    // quem saiu; limpa o grupo se sobrou 1). clinic_shipment não é P&P.
    if (ev.flow === 'pnp' && ev.slug !== 'clinic_shipment') await syncPnpCowork(s.is_sandbox);
    // COWORK GERAL (Bruno 06-24): qualquer cowork (produção, limpeza…) ao fechar
    // tira quem saiu do cowork_with dos que ficaram. Sem isto o colega seguia
    // "em grupo / Já junto" com quem já tinha saído (bug recorrente da Ana×Vitor).
    if (ev.cowork_group_id) await cleanupCoworkGroup(ev.cowork_group_id);

    // FASE PAUSA: terminar a PAUSA (break) = voltar ao trabalho → descongela tudo
    let resumedCount = 0;
    let resumedTasks = [];
    if (PAUSE_SLUGS.has(ev.slug)) { const ri = await resumePausedFor(s.person_id); resumedCount = ri.count; resumedTasks = ri.tasks; }
    // CUSTÓDIA (Bruno 07-08): NÃO devolve mais automático. Se o dono VOLTA da
    // pausa, o app PERGUNTA se ele assume a máquina (SIM/NÃO + escolher jobs).
    // Se um SUBSTITUTO acabou de CONCLUIR um job que cobria, avisa que ele
    // continua responsável (e o resto vai pro dono quando confirmar).
    let machineReturn = null;
    if (PAUSE_SLUGS.has(ev.slug) || LUNCH_SLUGS.has(ev.slug)) {
      try { machineReturn = await buildMachineReturn(s.person_id); } catch (e) { console.error('[machine] return-confirm falhou:', e.message); }
    } else {
      try {
        const cov = (await db.query('SELECT bg_handoff_from_person_id FROM v3.events WHERE id = $1', [ev.id])).rows[0];
        if (cov && cov.bg_handoff_from_person_id && cov.bg_handoff_from_person_id !== s.person_id) {
          const owner = (await db.query('SELECT display_name FROM v3.persons WHERE id = $1', [cov.bg_handoff_from_person_id])).rows[0];
          const prod = ev.batch_number ? (' (' + ev.batch_number + ')') : '';
          await machineSlack(`:white_check_mark: *${s.display_name}* concluiu a *${ev.activity_name || 'operação de máquina'}*${prod} que estava cobrindo enquanto *${owner ? owner.display_name : 'o operador'}* estava fora. *${s.display_name}* continua responsável pela máquina e deve começar a próxima; o que estiver relacionado vai pro *${owner ? owner.display_name : 'dono'}* quando ele confirmar na volta.`);
        }
      } catch (e) { console.error('[machine] notify conclusão falhou:', e.message); }
    }

    let countCreated = false;
    if (needBottleLike && !exception && Number.isFinite(b) && b > 0) {
      // FNSKU → kind='fnsku'/unit='label' (some por pessoa no cowork, estilo P&P);
      // linha → kind='bottles' (com proteção de dobra acima).
      await insertCount({ event: ev, bottles: b, unit: countUnit, personId: s.person_id, kind: countKind });
      countCreated = true;
    }
    // ITEM 1 — estimated bottles: compara o real com o target do EMS. Diferença
    // relevante (>=10%) → warning na resposta + aviso na produção (sistema).
    let bottleWarning = null;
    if (needCount && countCreated && ev.product_batch_id) {
      try {
        const target = ev.target_bottles;
        if (target && target > 0) {
          const pct = Math.round(((b - target) / target) * 100);
          if (Math.abs(pct) >= 10) {
            bottleWarning = { target, actual: b, diff: b - target, pct };
            await audit('bottle.count_mismatch', 'event', ev.id, { target, actual: b, pct }, s.person_id);
            if (!s.is_sandbox) notifyBottleMismatch({ ev, target, actual: b, pct, s });
          }
        }
      } catch (e) { console.error('[op] estimated-bottles warning falhou:', e.message); }
    }
    // FASE 5 — contagem de ORDENS no fim. Envio Clínica = MÉTRICA PRÓPRIA
    // (kind='clinic'), separada do P&P (regra Bruno: empacotamento da clínica tem
    // métrica própria). Demais seguem kind='orders'. unit fica 'orders' (tem CHECK).
    // kind='clinic' fica fora do P&P (counts_as_pp=false) E fora das garrafas (kind!='bottles').
    if ((needOrders || needClinic) && !exception && Number.isFinite(oc) && oc > 0) {
      const ckind = ev.slug === 'clinic_shipment' ? 'clinic' : 'orders';
      await db.query(
        `INSERT INTO v3.production_counts
           (product_id, product_batch_id, bottles, reported_at, production_date,
            reported_by_person_id, source_event_id, unit, confidence, kind, marketplace)
         VALUES ($1, $2, $3, NOW(), (NOW() AT TIME ZONE '${EDT}')::date, $4, $5, 'orders', 'high', $6, $7)`,
        [ev.product_id || null, ev.product_batch_id || null, oc, s.person_id, ev.id, ckind, marketplace]);
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
      return res.json({ ok: true, event_id: ev.id, is_last_finisher: true, count_created: countCreated, exception, bottle_warning: bottleWarning });
    }
    // SOLO (sem grupo) — comportamento original
    if (exception) {
      await audit('event.end_with_exception', 'event', ev.id, { slug: ev.slug, exception_reason: reason }, s.person_id);
      await notifyProductionException(ev, reason, s);
    } else {
      await audit('event.ended_via_page', 'event', ev.id, { bottles: countCreated ? b : null, slug: ev.slug }, s.person_id);
    }
    res.json({ ok: true, event_id: ev.id, count_created: countCreated, exception, resumed: resumedCount, resumed_tasks: resumedTasks, bottle_warning: bottleWarning, ...(machineReturn || {}) });
  }));

  // ── CUSTÓDIA: dono confirma no retorno (Bruno 07-08) ────────────────────────
  // body: { decision:'yes'|'no', job_ids:[int] }. SIM → transfere os jobs ESCOLHIDOS
  // pro dono; os não escolhidos viram do substituto (bg_handoff=NULL, não pergunta
  // de novo). NÃO → tudo continua do substituto. Resolve a cobertura + avisa no Slack.
  router.post('/api/v3/op/machine/confirm-return', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const body = req.body || {};
    const decision = body.decision === 'yes' ? 'yes' : (body.decision === 'no' ? 'no' : null);
    if (!decision) return res.status(400).json({ error: 'bad_decision', detail: "decision deve ser 'yes' ou 'no'." });
    const cov = await activeCoverageForOwner(s.person_id);
    if (!cov) return res.json({ ok: true, no_coverage: true });
    const open = await openCustodyJobs(s.person_id);
    const openIds = new Set(open.map((j) => j.id));
    const coverRow = (await db.query('SELECT display_name FROM v3.persons WHERE id = $1', [cov.cover_person_id])).rows[0];
    const coverName = coverRow ? coverRow.display_name : 'o substituto';

    if (decision === 'no') {
      if (openIds.size) await db.query('UPDATE v3.events SET bg_handoff_from_person_id = NULL, updated_at = NOW() WHERE id = ANY($1::int[])', [[...openIds]]);
      await endCoverage(cov.id, 'declined');
      await audit('machine.return_declined', 'person', s.person_id, { cover: cov.cover_person_id, jobs: [...openIds] }, s.person_id);
      await machineSlack(`:information_source: *${s.display_name}* informou que a encapsulação *não é responsabilidade dele agora* — segue com *${coverName}*.`);
      return res.json({ ok: true, decision: 'no' });
    }

    // SIM → transfere os escolhidos; o resto vira do substituto.
    const picked = Array.isArray(body.job_ids) ? body.job_ids.map((x) => parseInt(x, 10)).filter((x) => openIds.has(x)) : [];
    const takenNames = [];
    for (const jid of picked) {
      if (await transferMachineJob(jid, s.person_id)) {
        const j = open.find((x) => x.id === jid);
        takenNames.push((j && (j.product || j.batch_number || j.act_name)) || ('#' + jid));
      }
    }
    const leftover = [...openIds].filter((id) => !picked.includes(id));
    if (leftover.length) await db.query('UPDATE v3.events SET bg_handoff_from_person_id = NULL, updated_at = NOW() WHERE id = ANY($1::int[])', [leftover]);
    await endCoverage(cov.id, leftover.length ? 'partial' : 'taken_over');
    await audit('machine.return_taken', 'person', s.person_id, { taken: picked, leftover, cover: cov.cover_person_id }, s.person_id);
    if (picked.length && leftover.length) {
      await machineSlack(`:gear: *${s.display_name}* assumiu a responsabilidade da máquina de encapsulação — *${takenNames.join(', ')}* apenas. O resto continua com *${coverName}*.`);
    } else if (picked.length) {
      await machineSlack(`:gear: *${s.display_name}* voltou e assumiu a operação de máquina (${takenNames.join(', ')}) de volta.`);
    } else {
      await machineSlack(`:information_source: *${s.display_name}* voltou mas não assumiu nenhum job da máquina — seguem com *${coverName}*.`);
    }
    return res.json({ ok: true, decision: 'yes', taken: picked.length, leftover: leftover.length });
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
  // FASE 4 (dívida): no EMS, `pending_queue` é ARRAY, mas `formulation` e
  // `production_line` são OBJETOS-de-arrays por sub-stage
  // ({ yield_review:[...], encapsulating:[...], blended:[...] }). flattenStage
  // normaliza ambos numa lista única; se o batch não traz `status`, herda a
  // chave do sub-stage (ex.: 'encapsulating'). Sem isso, ler `pl.production_line`
  // como array volta vazio (bug latente apontado no estudo EMS §7).
  function flattenStage(node) {
    if (Array.isArray(node)) return node.slice();
    if (node && typeof node === 'object') {
      const out = [];
      for (const sub of Object.keys(node)) {
        const arr = node[sub];
        if (Array.isArray(arr)) for (const b of arr) {
          if (b && typeof b === 'object') out.push(b.status ? b : Object.assign({}, b, { status: sub }));
        }
      }
      return out;
    }
    return [];
  }
  // todos os batches do pipeline (pending + formulation + production_line), por nº
  function pipelineBatchMap(pl) {
    const m = new Map();
    if (!pl) return m;
    ['pending_queue', 'formulation', 'production_line'].forEach((k) => {
      flattenStage(pl[k]).forEach((b) => {
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

  // ── FASE 4 + FASE FORM: lotes disponíveis no EMS por tipo de tarefa ──
  // Lê do pipeline EMS (cache 30s). Cada slug que usa a lista mapeia pros grupos
  // do pipeline + (opcional) sub-stages relevantes (P-F.2: weighing↔weighing,
  // mixing↔blending, encapsulation↔encapsulating). Slug sem mapa → lots:[] →
  // frontend cai pro catálogo (REGRA #0, nunca bloqueia).
  // FASE LISTA: cada slug mostra a linha/pipeline INTEIRA (groups), mas marca
  // is_related=true nos batches do(s) stage(s) exato(s) da tarefa → renderizam NO
  // TOPO ("🎯 Prováveis"); o resto vai ABAIXO ("📋 Outros em produção").
  const LOT_SLUG_STAGES = {
    production_line: { groups: ['production_line', 'pending_queue', 'formulation'], related: ['yield_review', 'to_count', 'to_separate', 'label_printing', 'on_line', 'ready_for_line'] },
    review: { groups: ['production_line', 'pending_queue', 'formulation'], related: ['yield_review', 'to_count', 'to_separate'] },
    weighing: { groups: ['formulation', 'pending_queue', 'production_line'], related: ['weighing', 'weighed', 'pending'] },
    mixing: { groups: ['formulation', 'pending_queue', 'production_line'], related: ['blending', 'blended', 'mixing'] },
    encapsulation: { groups: ['formulation', 'production_line', 'pending_queue'], related: ['encapsulating', 'encapsulated'] },
  };
  router.get('/api/v3/op/lots/available', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const slug = String(req.query.slug || '');
    // FNSKU: lista os LOTES PRODUZIDOS nas últimas 2 semanas (linha já completada),
    // mais recentes em cima, produto + lote. Não-achou → catálogo (fallback padrão).
    if (slug === 'fnsku_labeling') {
      // METAS DE HOJE primeiro (o que o Henrique manda de manhã = o que vão etiquetar
      // hoje), depois os LOTES PRODUZIDOS nas últimas 2 semanas. Dedupe por batch.
      const goalRows = (await db.query(
        `SELECT g.batch_number, COALESCE(pr.canonical_name, '(produto)') AS product_name
         FROM v3.production_goals g LEFT JOIN v3.products pr ON pr.id = g.product_id
         WHERE g.production_date = (NOW() AT TIME ZONE '${EDT}')::date
           AND g.deleted_at IS NULL AND g.superseded_by IS NULL AND g.batch_number IS NOT NULL
         ORDER BY pr.canonical_name NULLS LAST, g.batch_number`)).rows;
      const prod = await db.query(
        `SELECT pb.batch_number, pr.canonical_name AS product_name,
                to_char(MAX(e.ended_at) AT TIME ZONE '${EDT}', 'DD/MM') AS produced_at
         FROM v3.events e
         JOIN v3.product_batches pb ON pb.id = e.product_batch_id
         JOIN v3.products pr ON pr.id = pb.product_id
         JOIN v3.activity_types at ON at.id = e.activity_type_id
         WHERE at.slug = 'production_line' AND e.ended_at IS NOT NULL AND e.deleted_at IS NULL
           AND e.ended_at > NOW() - INTERVAL '14 days'
         GROUP BY pb.batch_number, pr.canonical_name
         ORDER BY MAX(e.ended_at) DESC LIMIT 40`);
      const goalSet = new Set(goalRows.map((r) => String(r.batch_number).toUpperCase()));
      const goalLots = goalRows.map((r) => ({
        batch_number: r.batch_number, product_name: r.product_name, stage: 'meta de hoje',
        is_related: true, queue_position: null, group: 'goal', produced_at: null,
      }));
      const producedLots = prod.rows
        .filter((r) => !goalSet.has(String(r.batch_number).toUpperCase()))
        .map((r) => ({
          batch_number: r.batch_number, product_name: r.product_name, stage: 'produced',
          is_related: false, queue_position: null, group: 'produced', produced_at: r.produced_at,
        }));
      return res.json({ lots: [...goalLots, ...producedLots], related_count: goalLots.length, ems_stale: false });
    }
    const cfg = LOT_SLUG_STAGES[slug];
    if (!cfg) return res.json({ lots: [], ems_stale: false }); // sem lista EMS p/ esse slug → catálogo
    // Lotes RECENTES do banco (resiliência, Bruno 06-24): mesmo com EMS fora do ar a
    // lista NUNCA fica vazia — assim o operador clica num lote conhecido em vez de
    // digitar à mão e cair em "lote desconhecido".
    const dbLots = (await db.query(
      `SELECT pb.batch_number, pr.canonical_name AS product_name
         FROM v3.product_batches pb JOIN v3.products pr ON pr.id = pb.product_id
        WHERE pb.deleted_at IS NULL AND pb.created_at > NOW() - INTERVAL '45 days'
        ORDER BY pb.created_at DESC LIMIT 60`).catch(() => ({ rows: [] }))).rows
      .map((x) => ({ batch_number: x.batch_number, product_name: x.product_name, stage: 'recente', is_related: false, group: 'db', queue_position: null }));
    const pl = await emsPipeline();
    if (!pl) return res.json({ lots: dbLots, related_count: 0, ems_stale: true }); // EMS down → recentes do banco
    const relatedSet = new Set(cfg.related || []);
    const seen = new Set(); const lots = [];
    cfg.groups.forEach((g) => {
      flattenStage(pl[g]).forEach((b) => {
        const bn = b && (b.batch_record_number || b.batch_number);
        if (!bn || seen.has(bn)) return;
        seen.add(bn);
        const stage = b.status || g;
        lots.push({
          batch_number: bn,
          product_name: (b.product && b.product.name) || (b.formula && b.formula.name) || null,
          product_image: (b.product && b.product.image_url) || null,
          stage,
          is_related: relatedSet.has(stage), // 🎯 stage exato da tarefa → topo
          formula_code: (b.formula && b.formula.formula_code) || null,
          target_bottles: b.target_qty_bottles != null ? b.target_qty_bottles : null,
          queue_position: b.queue_position != null ? b.queue_position : null,
          group: g,
        });
      });
    });
    // completa com lotes recentes do banco que o EMS não trouxe (ex.: já saíram do
    // pipeline) — sempre clicáveis, com produto, evitando digitação manual.
    dbLots.forEach((d) => { const k = String(d.batch_number).toUpperCase(); if (!seen.has(d.batch_number) && !seen.has(k)) { seen.add(d.batch_number); lots.push(d); } });
    // RELACIONADOS primeiro; depois production_line; depois fila por posição.
    lots.sort((a, b2) =>
      (b2.is_related ? 1 : 0) - (a.is_related ? 1 : 0)
      || (a.group === 'production_line' ? -1 : 1) - (b2.group === 'production_line' ? -1 : 1)
      || (a.queue_position || 99) - (b2.queue_position || 99));
    res.json({ lots, related_count: lots.filter((l) => l.is_related).length, ems_stale: false });
  }));

  // ════════════════════════════════════════════════════════════
  // FASE FORM — detecção passiva: o EMS mostra o operador numa máquina
  // ════════════════════════════════════════════════════════════
  // Mapeia o sub-stage do EMS pro slug de atividade do tracker (≠ process_type,
  // que é genérico). Tempo SEMPRE do toque do operador, NUNCA do in_use_since.
  const EMS_STAGE_TO_SLUG = {
    weighing: 'weighing', weighed: 'weighing',
    blending: 'mixing', blended: 'mixing',
    encapsulating: 'encapsulation', encapsulated: 'encapsulation',
    yield_review: 'production_line', to_count: 'production_line', label_printing: 'production_line',
    finalized: 'production_line', on_line: 'production_line', ready_for_line: 'production_line',
    to_separate: 'review',
  };
  // nome AMIGÁVEL da máquina (PT, sem modelo técnico) — voz "do sistema".
  // equipment_type reais do EMS /line: capsule_machine, tablet_machine, blender, scale.
  const MACHINE_LABEL_PT = { capsule_machine: 'máquina de cápsula', tablet_machine: 'máquina de tablete', blender: 'misturador', scale: 'balança' };
  function machineLabelPt(type, name) { return MACHINE_LABEL_PT[type] || name || 'máquina'; }
  // FASE C2 — o que o EMS mostra ESTE operador fazendo agora, em MÁQUINA ou em
  // QUALQUER stage do pipeline (probe: operator presente em formulation.* e
  // production_line.*). Base do card sugestivo de 1 toque. Só ativo + recente
  // (worker 45s) + sem event já aberto pro mesmo lote. Máquina vence stage
  // (ordena machine-first). operator==null (fila) nunca chega aqui
  // (tracker_person_id = personId já implica atribuição).
  // Staleness: o quirk in_use_since PRESO só afeta MÁQUINA → guarda >24h SÓ p/
  // máquina; batch usa created_at (idade legítima do lote), filtrado por last_synced.
  async function detectedForPerson(personId) {
    // candidatos (máquina primeiro). Loop: oferece o 1º que NINGUÉM já está fazendo
    // (sincronia: se Vitor já está revisando o lote X, NÃO oferece revisão de X pro
    // Bruno; e some quando alguém assume). Operador-de-registro no EMS ≠ ativo.
    const r = await db.query(
      `SELECT ems_key, machine, machine_type, stage, process_type, supplement_name,
              batch_number, formula_code, product_image, started_at
       FROM v3.ems_activity_cache
       WHERE tracker_person_id = $1
         AND sync_status = 'active'
         AND last_synced_at > NOW() - INTERVAL '3 minutes'
         AND (machine IS NULL OR started_at IS NULL OR started_at > NOW() - INTERVAL '24 hours')
       ORDER BY (machine IS NOT NULL) DESC, last_synced_at DESC
       LIMIT 8`, [personId]);
    for (const d of r.rows) {
      const slug = EMS_STAGE_TO_SLUG[d.stage] || 'production_line';
      if (d.batch_number) {
        // ALGUÉM (qualquer pessoa) já tem essa FUNÇÃO+LOTE aberta? → não oferece.
        const claimed = await db.query(
          `SELECT 1 FROM v3.events e
           JOIN v3.activity_types at ON at.id = e.activity_type_id
           LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
           WHERE e.ended_at IS NULL AND e.deleted_at IS NULL AND at.slug = $1
             AND (pb.batch_number = $2 OR pb.batch_number = 'BR-2026-' || $2)
           LIMIT 1`, [slug, d.batch_number]);
        if (claimed.rowCount) continue;
      }
      return {
        ems_key: d.ems_key, machine: d.machine, machine_type: d.machine_type || null,
        machine_label: d.machine ? machineLabelPt(d.machine_type, d.machine) : null,
        is_machine: !!d.machine, stage: d.stage, slug,
        product_name: d.supplement_name || null, batch_number: d.batch_number || null,
        formula_code: d.formula_code || null, product_image: d.product_image || null,
      };
    }
    return null;
  }
  router.get('/api/v3/op/ems/my-activity', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    try { res.json({ detected: await detectedForPerson(s.person_id) }); }
    catch (e) { console.error('[op] my-activity erro:', e.message); res.json({ detected: null }); }
  }));

  // resolve product_id LOCAL por nome (best-effort) pra vincular o lote do EMS.
  async function productIdByName(name) {
    if (!name) return null;
    try {
      const locals = (await db.query('SELECT id, canonical_name, aliases FROM v3.products WHERE active = true')).rows;
      const target = norm(name); if (!target) return null;
      let hit = locals.find((p) => norm(p.canonical_name) === target);
      if (!hit) hit = locals.find((p) => [p.canonical_name].concat(p.aliases || []).some((a) => norm(a) === target));
      if (!hit) hit = locals.find((p) => { const n = norm(p.canonical_name); return n && target.length >= 5 && (n.indexOf(target) >= 0 || target.indexOf(n) >= 0); });
      return hit ? hit.id : null;
    } catch (e) { return null; }
  }
  // 1 toque "Registrar tarefa" → cria event com produto+lote+stage do EMS,
  // started_at = AGORA (toque). NUNCA in_use_since. Revalida via detectedForPerson
  // (anti-fantasma): só cria se o EMS AINDA mostra essa atividade.
  router.post('/api/v3/op/ems/register-detected', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const emsKey = String((req.body && req.body.ems_key) || '');
    if (!emsKey) return res.status(400).json({ error: 'ems_key_required' });
    const det = await detectedForPerson(s.person_id);
    if (!det || det.ems_key !== emsKey) return res.status(409).json({ error: 'not_detected', detail: 'O EMS não mostra mais essa atividade.' });
    const act = await resolveActivity(det.slug) || await resolveActivity('production_line');
    if (!act) return res.status(400).json({ error: 'unknown_activity_slug', slug: det.slug });
    // Parte 2: hora de início. Default AGORA (toque). Operador pode marcar hora
    // passada (esqueceu de registrar). Nunca futura; >8h atrás aceita mas FLAGa
    // pro admin (REGRA #0 — registra, não bloqueia). NUNCA usa in_use_since.
    let startedAtIso = null, lateFlag = false;
    if (req.body && req.body.started_at) {
      const t = Date.parse(req.body.started_at);
      if (Number.isFinite(t)) {
        if (t > Date.now() + 60000) return res.status(400).json({ error: 'started_at_future', detail: 'A hora não pode ser no futuro.' });
        startedAtIso = new Date(t).toISOString();
        if (Date.now() - t > 8 * 3600 * 1000) lateFlag = true;
      }
    }
    const pid = await productIdByName(det.product_name);
    const { batch, autoCreated, typedUnlinked, resolvedFromEms } = await resolveOrCreateBatch(det.batch_number, pid, s.person_id, { product_name: det.product_name });
    let desc = '[detecção EMS: ' + (det.machine || '?') + (det.stage ? ' · ' + det.stage : '') + ']';
    if (startedAtIso) desc += ' [início informado]';
    if (lateFlag) desc += ' [⚠ início >8h atrás — revisar]';
    if (typedUnlinked) desc += ' [lote ' + typedUnlinked + ' — produto não identificado]';
    const ins = await db.query(
      `INSERT INTO v3.events
         (person_id, activity_type_id, product_batch_id, started_at, description,
          confidence, source, is_test, is_long_running)
       VALUES ($1, $2, $3, COALESCE($6::timestamptz, NOW()), $4, 'high', 'ems_passive_detect', $5, $7)
       RETURNING id, person_id, activity_type_id, product_batch_id, started_at`,
      [s.person_id, act.id, batch ? batch.id : null, desc.slice(0, 500), !!s.is_sandbox, startedAtIso, !!act.is_background]);
    const ev = ins.rows[0];
    await audit('event.created_via_ems_detect', 'event', ev.id,
      { slug: act.slug, batch: batch ? batch.batch_number : null, ems_key: emsKey, machine: det.machine, stage: det.stage, started_at_informed: !!startedAtIso, late_flag: lateFlag }, s.person_id);
    await flagUnknownBatch({ res: ev, autoCreated, typedUnlinked, resolvedFromEms, batch, batchNumber: det.batch_number, body: { product_name: det.product_name }, slug: act.slug, s });
    await actionLog({ personId: s.person_id, personName: s.display_name, actionType: 'task_start_ems_detect', payload: { slug: act.slug, batch_number: det.batch_number, ems_key: emsKey, machine: det.machine, stage: det.stage, started_at: startedAtIso, late_flag: lateFlag }, relatedEventId: ev.id, isTest: !!s.is_sandbox });
    res.json({ ok: true, late_flag: lateFlag, event: { ...ev, slug: act.slug, batch_number: batch ? batch.batch_number : null, product: batch ? batch.product : det.product_name || null } });
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
    if (noteAnalyzer) noteAnalyzer.queue({ text, personId: s.person_id, personName: s.display_name, slug: 'nota', isSandbox: !!s.is_sandbox }); // ③ fire-and-forget
    res.json({ ok: true, note_id: r.rows[0].id });
  }));

  // ── ajuste de ordens do dia (Embalagem/Outro) — regra Bruno 06-22 ──────────
  // mode='additional' soma N ao total; mode='reset' ZERA (supersede) as contagens
  // do dia e grava só o novo total N (antigas ficam visíveis riscadas no dashboard)
  // + warning no Slack pra todos. Permite corrigir ordens entradas erradas.
  router.post('/api/v3/op/orders/adjust', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const body = req.body || {};
    const mode = body.mode === 'reset' ? 'reset' : (body.mode === 'additional' ? 'additional' : null);
    const qty = parseInt(body.quantity, 10);
    const srcEventId = Number.isFinite(parseInt(body.source_event_id, 10)) ? parseInt(body.source_event_id, 10) : null;
    if (!mode) return res.status(400).json({ error: 'bad_mode', detail: "mode deve ser 'additional' ou 'reset'." });
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'quantity_required', detail: 'Informe um número de ordens maior que 0.' });
    // total vivo atual das ordens do P&P hoje (mesma base do card "P&P do dia")
    const oldTotal = (await db.query(
      `SELECT COALESCE(SUM(pc.bottles),0)::int total FROM v3.production_counts pc
       WHERE pc.kind='orders' AND pc.deleted_at IS NULL AND pc.superseded_by IS NULL
         AND pc.production_date=(NOW() AT TIME ZONE '${EDT}')::date`)).rows[0].total;
    const ins = (await db.query(
      `INSERT INTO v3.production_counts
         (product_id, product_batch_id, bottles, reported_at, production_date, reported_by_person_id,
          source_event_id, unit, confidence, kind, marketplace, adjustment_kind)
       VALUES (NULL, NULL, $1, NOW(), (NOW() AT TIME ZONE '${EDT}')::date, $2, $3, 'orders', 'high', 'orders', NULL, $4)
       RETURNING id`, [qty, s.person_id, srcEventId, mode])).rows[0];
    let newTotal = oldTotal + qty;
    if (mode === 'reset') {
      await db.query(
        `UPDATE v3.production_counts SET superseded_by=$1, updated_at=NOW()
         WHERE kind='orders' AND deleted_at IS NULL AND superseded_by IS NULL AND id<>$1
           AND production_date=(NOW() AT TIME ZONE '${EDT}')::date`, [ins.id]);
      newTotal = qty;
      if (!s.is_sandbox && slack && slack.postAs) {
        try {
          await slack.postAs({ channel: 'production', sender: { name: 'HealthFare Tracker', icon: ':warning:' }, thread_ts: null, unfurl_links: false, unfurl_media: false,
            text: `:warning: *${s.display_name} reajustou o TOTAL de ordens do dia.*\nAntes: *${oldTotal}* → Agora: *${qty}* ordens (edição manual do operador — confiram se está certo).` });
        } catch (e) { console.error('[orders.adjust] slack falhou:', e.message); }
      }
    }
    await audit('orders.adjust', 'production_count', ins.id, { mode, quantity: qty, old_total: oldTotal, new_total: newTotal }, s.person_id);
    await actionLog({ personId: s.person_id, personName: s.display_name, actionType: 'orders_adjust', payload: { mode, quantity: qty, old_total: oldTotal, new_total: newTotal }, relatedEventId: srcEventId, isTest: !!s.is_sandbox });
    res.json({ ok: true, mode, old_total: oldTotal, new_total: newTotal });
  }));

  // ── trocar o TIPO de uma task AO VIVO (operador escolheu errado) — regra Bruno ──
  // Ex.: marcou "Especial/Outros" mas era "Envio Clínica". Só a própria task aberta.
  router.post('/api/v3/op/event/:id/reclassify', h(async (req, res) => {
    const s = await requireSession(req, res); if (!s) return;
    const ev = await loadOwnedOpenEvent(req, res, s); if (!ev) return;
    if (ev.ended_at) return res.status(409).json({ error: 'already_ended' });
    const act = await resolveActivity(String((req.body && req.body.activity_slug) || ''));
    if (!act) return res.status(400).json({ error: 'unknown_activity_slug', slug: (req.body && req.body.activity_slug) || null });
    if (act.slug === ev.slug) return res.json({ ok: true, unchanged: true, slug: act.slug });
    const oldSlug = ev.slug;
    await db.query('UPDATE v3.events SET activity_type_id = $2, is_long_running = $3, updated_at = NOW() WHERE id = $1',
      [ev.id, act.id, !!act.is_background]);
    await audit('event.reclassified', 'event', ev.id, { from: oldSlug, to: act.slug }, s.person_id);
    await actionLog({ personId: s.person_id, personName: s.display_name, actionType: 'task_reclassify', payload: { from: oldSlug, to: act.slug }, relatedEventId: ev.id, isTest: !!s.is_sandbox });
    res.json({ ok: true, slug: act.slug });
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
             ce.product AS current_product,
             ce.started_at AS current_started_at,
             -- COWORK AO VIVO (Bruno 06-24): quem está REALMENTE aberto no mesmo grupo
             -- AGORA (não o cowork_with armazenado, que ficava órfão quando alguém saía
             -- pro almoço → "em grupo / Já junto" fantasma). Bulletproof contra stale.
             COALESCE((SELECT array_agg(DISTINCT e3.person_id)
                       FROM v3.events e3
                       WHERE ce.cowork_group_id IS NOT NULL AND e3.cowork_group_id = ce.cowork_group_id
                         AND e3.ended_at IS NULL AND e3.deleted_at IS NULL AND e3.person_id <> p.id), '{}') AS current_cowork,
             COALESCE(bg.items, '[]'::json) AS bg_tasks
      FROM v3.persons p
      LEFT JOIN LATERAL (
        SELECT e.id, at.slug, pb.batch_number, pr.canonical_name AS product, e.started_at, e.cowork_with, e.cowork_group_id
        FROM v3.events e
        LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
        LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
        LEFT JOIN v3.products pr ON pr.id = pb.product_id
        WHERE e.person_id = p.id AND e.ended_at IS NULL AND e.deleted_at IS NULL
          AND e.is_long_running = false
        ORDER BY e.started_at DESC LIMIT 1
      ) ce ON true
      LEFT JOIN LATERAL (
        -- tarefas de BACKGROUND (na máquina: encapsulação/mistura/tablete) abertas.
        -- Antes não apareciam em "Equipe agora" (ce filtra is_long_running=false).
        SELECT json_agg(json_build_object(
                 'event_id', e2.id, 'slug', at2.slug, 'batch', pb2.batch_number,
                 'product', pr2.canonical_name,
                 'started_at', e2.started_at) ORDER BY e2.started_at) AS items
        FROM v3.events e2
        LEFT JOIN v3.activity_types at2 ON at2.id = e2.activity_type_id
        LEFT JOIN v3.product_batches pb2 ON pb2.id = e2.product_batch_id
        LEFT JOIN v3.products pr2 ON pr2.id = pb2.product_id
        WHERE e2.person_id = p.id AND e2.ended_at IS NULL AND e2.deleted_at IS NULL
          AND e2.is_long_running = true
      ) bg ON true
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

    // 0) SUPERVISÃO (Bruno 07-08): se ele SEGURA máquina rodando (própria OU
    // herdada de alguém que está fora) e bate o ponto → RE-PASSA pra outro operador
    // de máquina disponível, ou dispara o alerta "MÁQUINAS SEM SUPERVISÃO" se não
    // há ninguém. A máquina NUNCA fica sozinha. (myRunningMachines já inclui herdadas.)
    if (!s.is_sandbox) {
      try { await handoffMachineWork(s.person_id, s.is_sandbox, null, 'fim do expediente (bateu ponto)'); }
      catch (e) { console.error('[machine] handoff no clock-out falhou:', e.message); }
    }
    // 1) fecha as tasks ABERTAS do operador (long_running fica)
    const closed = await db.query(
      `UPDATE v3.events
       SET ended_at = NOW(), closed_reason = 'clock_out', updated_at = NOW()
       WHERE person_id = $1 AND ended_at IS NULL AND deleted_at IS NULL AND is_long_running = false
       RETURNING id`, [s.person_id]);
    // 1b) CUSTÓDIA (auditoria 07-08): se ele é DONO com cobertura ativa e está
    // batendo o ponto (não vai voltar hoje), o substituto FICA com a máquina →
    // os jobs abertos viram do substituto (bg_handoff=NULL) e a cobertura resolve.
    // Evita cobertura órfã mis-taggeando jobs do substituto no resto do dia.
    try {
      const owned = await activeCoverageForOwner(s.person_id);
      if (owned) {
        await db.query('UPDATE v3.events SET bg_handoff_from_person_id = NULL, updated_at = NOW() WHERE bg_handoff_from_person_id = $1 AND ended_at IS NULL AND deleted_at IS NULL', [s.person_id]);
        await endCoverage(owned.id, 'owner_clocked_out');
      }
    } catch (e) { console.error('[machine] cleanup custódia no clock-out falhou:', e.message); }

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
    // GUARD: o fim NUNCA pode ser antes do início (gerava evento invertido —
    // ex.: cleaning 16:31→08:33 da Ana, que desenhava um gap fantasma no
    // dashboard) nem no futuro. ended_at = clamp entre started_at e NOW().
    await db.query(
      `UPDATE v3.events SET ended_at = LEAST(NOW(), GREATEST(started_at, COALESCE($2, NOW()))), closed_reason = 'forgotten_checkout_cascade', updated_at = NOW()
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
               (((CASE EXTRACT(DOW FROM ((NOW() AT TIME ZONE '${EDT}')::date + 1))::int
                    WHEN 6 THEN (NOW() AT TIME ZONE '${EDT}')::date + 3   -- amanhã=sábado → segunda
                    WHEN 0 THEN (NOW() AT TIME ZONE '${EDT}')::date + 2   -- amanhã=domingo → segunda
                    ELSE (NOW() AT TIME ZONE '${EDT}')::date + 1 END) + TIME '08:30') AT TIME ZONE '${EDT}'),
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
