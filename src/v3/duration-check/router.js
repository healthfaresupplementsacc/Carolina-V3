'use strict';
/**
 * HEALTHFARE V3 — CHECAGEM DE DURAÇÃO — /api/v3/duration-check/* (Bruno 09-11).
 *
 * "Se uma tarefa é feita em menos de 5 min, pergunta no kiosk se foi entrada sem
 *  querer (tirando as que são curtas por natureza); se tomou muito tempo também
 *  pergunta. Primeiro o sistema aprende a média daquela tarefa."
 *
 *   GET  /event/:id          (kiosk: page token + sessão) → { data: { check } }
 *          check = null | { kind: 'too_short'|'too_long', dur_min, median_min, samples }
 *          Regra em `evaluate()` (pura, testada):
 *            - aprende com as concluídas da MESMA atividade nos últimos 60 dias
 *              (≥ MIN_SAMPLES, sem teste, sem apagadas, ≥ 1 min); mediana, não média,
 *              pra um esquecimento de 6 h não puxar tudo;
 *            - too_short: dur < 5 min E a atividade normalmente leva ≥ 15 min
 *              (impressão de ordens, que é curta, nunca pergunta);
 *            - too_long: dur ≥ 30 min E dur > max(2 × mediana, mediana + 30).
 *   POST /event/:id/answer   (kiosk) { ok: true|false, kind } → ok=false grava
 *          duration_flag + status 'open' (a linha do tempo marca com alerta).
 *   POST /event/:id/fix      (PIN do dashboard) { note? } → status 'fixed'.
 *
 * REGRA #0: perguntar nunca bloqueia — o registro já foi salvo pelo /end; isto é
 * só uma pergunta depois. Router pequeno: op.js e o data router não crescem.
 */
const express = require('express');
const opAuth = require('../../lib/op-auth');
const { makeAuthMiddleware } = require('../data/auth');

const BASE = '/api/v3/duration-check';
const DAYS = 60;
const PRODUCT_MIN_SAMPLES = 3;

/* Mediana por atividade e por (atividade, produto) nos últimos DAYS dias.
   Devolve { by_activity: {slug:{median_min,samples}}, by_product: {slug:{product_id:{median_min,samples,last_min,last_at}}} }.
   O dashboard e o kiosk comparam contra ISTO (Bruno 09-11): "a média que gastamos com o
   empacotamento todo dia"; "a revisão do Devil's Claw contra a última e a média das
   revisões do Devil's Claw". Nunca contra a média só de hoje. */
async function learnExpectations(db) {
  const DUR = "(EXTRACT(EPOCH FROM (x.ended_at - x.started_at)) - COALESCE(x.total_paused_seconds, 0)) / 60.0";
  const WHERE = `x.ended_at IS NOT NULL AND x.deleted_at IS NULL AND COALESCE(x.is_test, false) = false
                 AND x.started_at > NOW() - INTERVAL '${DAYS} days' AND x.ended_at - x.started_at >= INTERVAL '1 minute'`;
  const a = await db.query(`
    SELECT at.slug, COUNT(*)::int AS samples, percentile_cont(0.5) WITHIN GROUP (ORDER BY ${DUR}) AS median_min
      FROM v3.events x JOIN v3.activity_types at ON at.id = x.activity_type_id
     WHERE ${WHERE} GROUP BY at.slug`);
  const p = await db.query(`
    SELECT at.slug, pb.product_id, COUNT(*)::int AS samples, percentile_cont(0.5) WITHIN GROUP (ORDER BY ${DUR}) AS median_min,
           (ARRAY_AGG(${DUR} ORDER BY x.ended_at DESC))[1] AS last_min, MAX(x.ended_at) AS last_at
      FROM v3.events x JOIN v3.activity_types at ON at.id = x.activity_type_id
      JOIN v3.product_batches pb ON pb.id = x.product_batch_id
     WHERE ${WHERE} AND pb.product_id IS NOT NULL GROUP BY at.slug, pb.product_id HAVING COUNT(*) >= ${PRODUCT_MIN_SAMPLES}`);
  const by_activity = {}; for (const r of a.rows) by_activity[r.slug] = { median_min: Math.round(Number(r.median_min)), samples: r.samples };
  const by_product = {}; for (const r of p.rows) { (by_product[r.slug] = by_product[r.slug] || {})[r.product_id] = { median_min: Math.round(Number(r.median_min)), samples: r.samples, last_min: Math.round(Number(r.last_min)), last_at: r.last_at }; }
  return { by_activity, by_product, days: DAYS, min_samples: MIN_SAMPLES, product_min_samples: PRODUCT_MIN_SAMPLES };
}
const MIN_SAMPLES = 5;
const SHORT_MIN = 5;          // "menos de 5 min"
const SHORT_ONLY_IF_MEDIAN_GE = 15;
const LONG_ABS_MIN = 30;

/** Regra pura. durMin = duração do registro; medianMin/samples = aprendido. */
function evaluate(durMin, medianMin, samples) {
  if (durMin == null || !(samples >= MIN_SAMPLES) || !(medianMin > 0)) return null;
  if (durMin < SHORT_MIN && medianMin >= SHORT_ONLY_IF_MEDIAN_GE) return { kind: 'too_short', dur_min: Math.round(durMin), median_min: Math.round(medianMin), samples };
  if (durMin >= LONG_ABS_MIN && durMin > Math.max(2 * medianMin, medianMin + 30)) return { kind: 'too_long', dur_min: Math.round(durMin), median_min: Math.round(medianMin), samples };
  return null;
}

/* Ajustes (v3.settings 'duration_check'): { kiosk_ask: false } por padrão —
   Bruno 09-11: "não alertar nada aos funcionários ainda, estamos ajustando". */
const SETTINGS_KEY = 'duration_check';
async function getSettings(db) {
  try { const r = await db.query('SELECT value FROM v3.settings WHERE key = $1', [SETTINGS_KEY]); const v = r.rows[0] && r.rows[0].value; return { kiosk_ask: false, ...(v && typeof v === 'object' ? v : {}) }; }
  catch (_) { return { kiosk_ask: false }; }
}
async function setSettings(db, patch, by) {
  const cur = await getSettings(db); const next = { ...cur, ...patch, updated_by: by || null, updated_at: new Date().toISOString() };
  await db.query(`INSERT INTO v3.settings (key, value, description) VALUES ($1, $2::jsonb, $3) ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`, [SETTINGS_KEY, JSON.stringify(next), 'checagem de duração (kiosk pergunta? etc.)']);
  return next;
}

function extractBearer(req) { const h = String(req.headers.authorization || ''); return h.startsWith('Bearer ') ? h.slice(7) : null; }

function createDurationCheckRouter(deps = {}) {
  const db = deps.db;
  const operatorToken = deps.operatorToken !== undefined ? deps.operatorToken : process.env.OPERATOR_PAGE_TOKEN;
  const router = express.Router();
  router.use(BASE, express.json({ limit: '32kb' }));
  const ok = (res, data) => res.json({ data });
  const err = (res, code, message, status) => res.status(status || 400).json({ error: { code, message } });

  // kiosk: página + sessão do operador; o registro tem que ser DELE
  async function kioskOwned(req, res) {
    const t = extractBearer(req);
    if (!operatorToken || t !== operatorToken) { err(res, 'invalid_page_token', 'página inválida', 401); return null; }
    const s = await opAuth.getSession(db, req.headers['x-session-token']);
    if (!s) { err(res, 'invalid_session', 'sessão inválida', 401); return null; }
    const id = parseInt(req.params.id, 10);
    if (!id) { err(res, 'bad_id', 'id inválido'); return null; }
    const r = await db.query(`
      SELECT e.id, e.person_id, e.activity_type_id, e.started_at, e.ended_at, e.deleted_at,
             COALESCE(e.total_paused_seconds, 0) AS paused, e.product_batch_id, at.slug, at.display_name AS activity
        FROM v3.events e LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
       WHERE e.id = $1`, [id]);
    const ev = r.rows[0];
    if (!ev || ev.deleted_at) { err(res, 'not_found', 'registro não encontrado', 404); return null; }
    if (Number(ev.person_id) !== Number(s.person_id)) { err(res, 'not_owner', 'esse registro não é seu', 403); return null; }
    return { s, ev };
  }

  router.get(BASE + '/event/:id', async (req, res) => {
    try {
      const got = await kioskOwned(req, res); if (!got) return;
      const { ev } = got;
      const settings = await getSettings(db);
      if (!settings.kiosk_ask) return ok(res, { check: null, kiosk_ask: false });   // desligado enquanto ajustamos (Bruno 09-11)
      if (!ev.ended_at || !ev.activity_type_id) return ok(res, { check: null });
      const durMin = (new Date(ev.ended_at) - new Date(ev.started_at)) / 60000 - Number(ev.paused) / 60;
      // por PRODUTO primeiro (revisão do Devil's Claw contra as revisões do Devil's Claw), senão a atividade
      let basis = 'atividade';
      let st = null;
      if (ev.product_batch_id) {
        const ps = (await db.query(`
          SELECT COUNT(*)::int AS samples,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY (EXTRACT(EPOCH FROM (x.ended_at - x.started_at)) - COALESCE(x.total_paused_seconds, 0)) / 60.0) AS median_min
            FROM v3.events x JOIN v3.product_batches pb ON pb.id = x.product_batch_id
           WHERE x.activity_type_id = $1 AND x.id <> $2 AND x.ended_at IS NOT NULL AND x.deleted_at IS NULL
             AND COALESCE(x.is_test, false) = false AND x.started_at > NOW() - INTERVAL '60 days'
             AND x.ended_at - x.started_at >= INTERVAL '1 minute'
             AND pb.product_id = (SELECT product_id FROM v3.product_batches WHERE id = $3)`, [ev.activity_type_id, ev.id, ev.product_batch_id])).rows[0];
        if (ps && Number(ps.samples) >= PRODUCT_MIN_SAMPLES) { st = { samples: MIN_SAMPLES, median_min: ps.median_min, real_samples: ps.samples }; basis = 'produto'; }
      }
      if (!st) st = (await db.query(`
        SELECT COUNT(*)::int AS samples,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY (EXTRACT(EPOCH FROM (x.ended_at - x.started_at)) - COALESCE(x.total_paused_seconds, 0)) / 60.0) AS median_min
          FROM v3.events x
         WHERE x.activity_type_id = $1 AND x.id <> $2 AND x.ended_at IS NOT NULL AND x.deleted_at IS NULL
           AND COALESCE(x.is_test, false) = false AND x.started_at > NOW() - INTERVAL '60 days'
           AND x.ended_at - x.started_at >= INTERVAL '1 minute'`, [ev.activity_type_id, ev.id])).rows[0];
      const check = evaluate(durMin, Number(st.median_min), Number(st.samples));
      ok(res, { check: check ? { ...check, samples: st.real_samples || check.samples, basis, activity: ev.activity, slug: ev.slug } : null });
    } catch (e) { console.error('[duration-check]', e.message); err(res, 'internal', e.message, 500); }
  });

  router.post(BASE + '/event/:id/answer', async (req, res) => {
    try {
      const got = await kioskOwned(req, res); if (!got) return;
      const b = req.body || {};
      const kind = b.kind === 'too_long' ? 'too_long' : 'too_short';
      if (b.ok === false) {
        await db.query(`UPDATE v3.events SET duration_flag = $2, duration_flag_status = 'open', duration_flag_at = NOW(), duration_flag_note = $3 WHERE id = $1`, [got.ev.id, kind, b.note || null]);
        return ok(res, { flagged: true, kind });
      }
      ok(res, { flagged: false });
    } catch (e) { console.error('[duration-check]', e.message); err(res, 'internal', e.message, 500); }
  });

  // dashboard (PIN): o que o sistema aprendeu — a Timeline compara contra isto
  router.get(BASE + '/expectations', makeAuthMiddleware({ db }), async (req, res) => {
    try { ok(res, await learnExpectations(db)); }
    catch (e) { console.error('[duration-check]', e.message); err(res, 'internal', e.message, 500); }
  });

  // dashboard (PIN): ajustes (kiosk pergunta?) — ler qualquer PIN; mudar só quem configura
  router.get(BASE + '/settings', makeAuthMiddleware({ db }), async (req, res) => { try { ok(res, await getSettings(db)); } catch (e) { err(res, 'internal', e.message, 500); } });
  router.post(BASE + '/settings', makeAuthMiddleware({ db }), async (req, res) => {
    const l = req.login || {}; const fns = l.functions || [];
    if (!(fns.includes('*') || fns.includes('config_page') || fns.includes('manage_system'))) return err(res, 'forbidden', 'Só quem configura o sistema liga a pergunta no kiosk.', 403);
    try { const b = req.body || {}; ok(res, await setSettings(db, { kiosk_ask: !!b.kiosk_ask }, l.name)); } catch (e) { err(res, 'internal', e.message, 500); }
  });

  // dashboard (PIN): as últimas tarefas iguais (pra explicar o sinal no detalhe)
  router.get(BASE + '/history', makeAuthMiddleware({ db }), async (req, res) => {
    try {
      const slug = String(req.query.slug || '').trim(); if (!slug) return err(res, 'bad_request', 'slug obrigatório');
      const productId = req.query.product_id ? parseInt(req.query.product_id, 10) : null;
      const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 8));
      const exclude = req.query.exclude ? parseInt(req.query.exclude, 10) : 0;
      const rows = (await db.query(`
        SELECT x.id, x.started_at, x.ended_at, pe.display_name AS person, pb.batch_number, COALESCE(pr.nickname, pr.canonical_name) AS product,
               ROUND((EXTRACT(EPOCH FROM (x.ended_at - x.started_at)) - COALESCE(x.total_paused_seconds, 0)) / 60.0) AS duration_min
          FROM v3.events x JOIN v3.activity_types at ON at.id = x.activity_type_id
          JOIN v3.persons pe ON pe.id = x.person_id
          LEFT JOIN v3.product_batches pb ON pb.id = x.product_batch_id
          LEFT JOIN v3.products pr ON pr.id = pb.product_id
         WHERE at.slug = $1 AND x.ended_at IS NOT NULL AND x.deleted_at IS NULL AND COALESCE(x.is_test, false) = false
           AND x.started_at > NOW() - INTERVAL '${DAYS} days' AND x.ended_at - x.started_at >= INTERVAL '1 minute' AND x.id <> $4
           AND ($2::int IS NULL OR pb.product_id = $2)
         ORDER BY x.ended_at DESC LIMIT $3`, [slug, productId || null, limit, exclude || 0])).rows;
      ok(res, { rows, slug, product_id: productId, days: DAYS });
    } catch (e) { console.error('[duration-check]', e.message); err(res, 'internal', e.message, 500); }
  });

  // dashboard (PIN): marcar como consertado → para o alerta na linha do tempo
  router.post(BASE + '/event/:id/fix', makeAuthMiddleware({ db }), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10); if (!id) return err(res, 'bad_id', 'id inválido');
      const r = await db.query(`UPDATE v3.events SET duration_flag_status = 'fixed', duration_flag_fixed_by = $2, duration_flag_fixed_at = NOW(), duration_flag_note = COALESCE($3, duration_flag_note)
                                 WHERE id = $1 AND duration_flag_status = 'open' RETURNING id, duration_flag`, [id, (req.login && req.login.name) || null, (req.body && req.body.note) || null]);
      if (!r.rows[0]) return err(res, 'not_open', 'esse registro não tem alerta aberto', 409);
      try { await db.query(`INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata) VALUES ('admin', NULL, 'event.duration_flag_fixed', 'event', $1, $2::jsonb)`, [id, JSON.stringify({ login: req.login && req.login.name, kind: r.rows[0].duration_flag })]); } catch (_) { /* auditoria nunca derruba */ }
      ok(res, { fixed: true, id });
    } catch (e) { console.error('[duration-check]', e.message); err(res, 'internal', e.message, 500); }
  });

  return router;
}

module.exports = { createDurationCheckRouter, evaluate, learnExpectations, getSettings, setSettings, BASE, MIN_SAMPLES, PRODUCT_MIN_SAMPLES };
