'use strict';
/**
 * HEALTHFARE V3 — KIOSK: ORDEM POR USO, LIMPEZA COM SUBTIPO, "OUTROS" COM TÍTULO,
 * PAINEL DE RECLASSIFICAÇÃO — /api/v3/kiosk/* (Bruno 09-11).
 *
 *   GET  /order                  (kiosk) → contagem de uso da PESSOA por atividade e por
 *        subtipo de limpeza, numa janela de 60 dias FECHADA no dia 1 do mês (Bruno:
 *        "atualização mensal... fica um mês inteiro sem mudar"). O kiosk ordena com isso.
 *   POST /event/:id/subtype {kind}   (kiosk, registro da pessoa) → phase_label = 'limpeza:<kind>'
 *   POST /event/:id/title   {text}   (kiosk, registro da pessoa) → resume o texto num título
 *        curto (IA com fallback nas primeiras palavras) → phase_label; description fica inteira.
 *   GET  /others                 (PIN) → "Outros" ainda não revisados (todos os dias, até resolver)
 *   POST /others/:id/resolve {activity_slug?}  (PIN) → reclassifica (opcional) e marca revisado.
 *
 * Router pequeno: op.js não cresce. Nunca bloqueia o start; tudo aqui é depois.
 */
const express = require('express');
const opAuth = require('../../lib/op-auth');
const { makeAuthMiddleware } = require('../data/auth');

const BASE = '/api/v3/kiosk';
const WINDOW_DAYS = 60;
const CLEAN_KINDS = { linha: 'Linha de produção', capsula: 'Máquina de cápsula', tablet: 'Máquina de tablet', formulacao: 'Área da formulação', warehouse: 'Warehouse geral', pesada: 'Limpeza pesada (sexta)', fim: 'Fim do dia' };
// O painel começa a contar do dia em que entrou no ar: o passado (centenas de 'Outros') não
// vira fila; só o que entrar daqui pra frente fica lá até alguém resolver.
const OTHERS_SINCE = '2026-09-11';
const OTHER_SLUGS = ['special_task', 'production_line_other', 'formulation_other', 'cleaning_other', 'packaging_other', 'shipping_other'];

/** Primeiro dia do mês (NY) de `now`: a ordem vale o mês inteiro. */
function monthStartNy(now) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit' }).formatToParts(now || new Date());
  const y = p.find((x) => x.type === 'year').value, m = p.find((x) => x.type === 'month').value;
  return `${y}-${m}-01`;
}
/** Fallback do título: primeiras 5 palavras, ≤ 40 caracteres, inicial maiúscula. */
function fallbackTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  let out = t.split(' ').slice(0, 5).join(' ');
  if (out.length > 40) out = out.slice(0, 40).replace(/\s+\S*$/, '');
  return out.charAt(0).toUpperCase() + out.slice(1);
}
async function summarize(provider, text) {
  const fb = fallbackTitle(text);
  if (!provider || !text || String(text).trim().split(/\s+/).length <= 3) return { title: fb, via: 'fallback' };
  const SYSTEM = 'Você resume o que um operador de fábrica de suplementos escreveu numa tarefa "Outros" em um TÍTULO curto em português (3 a 5 palavras, sem ponto final, sem aspas), do jeito que apareceria numa linha do tempo. Responda SÓ JSON: {"title": "..."}';
  try {
    const r = await Promise.race([provider.classifyRaw(SYSTEM, String(text).slice(0, 600), { maxTokens: 60, temperature: 0 }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4500))]);
    const t = r && r.json_parsed && String(r.json_parsed.title || '').replace(/\s+/g, ' ').trim();
    if (t && t.length >= 3 && t.length <= 60) return { title: t.replace(/[."]+$/, ''), via: r.provider_used || 'llm' };
  } catch (_) { /* cai no fallback */ }
  return { title: fb, via: 'fallback' };
}

function extractBearer(req) { const h = String(req.headers.authorization || ''); return h.startsWith('Bearer ') ? h.slice(7) : null; }

function createKioskRouter(deps = {}) {
  const db = deps.db; const provider = deps.provider || null;
  const operatorToken = deps.operatorToken !== undefined ? deps.operatorToken : process.env.OPERATOR_PAGE_TOKEN;
  const nowFn = deps.now || (() => new Date());
  const router = express.Router();
  router.use(BASE, express.json({ limit: '32kb' }));
  const ok = (res, data) => res.json({ data });
  const err = (res, code, message, status) => res.status(status || 400).json({ error: { code, message } });

  async function kioskSession(req, res) {
    const t = extractBearer(req);
    if (!operatorToken || t !== operatorToken) { err(res, 'invalid_page_token', 'página inválida', 401); return null; }
    const s = await opAuth.getSession(db, req.headers['x-session-token']);
    if (!s) { err(res, 'invalid_session', 'sessão inválida', 401); return null; }
    return s;
  }
  async function ownedEvent(req, res, s) {
    const id = parseInt(req.params.id, 10);
    if (!id) { err(res, 'bad_id', 'id inválido'); return null; }
    const r = await db.query('SELECT e.id, e.person_id, e.deleted_at, at.slug FROM v3.events e LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id WHERE e.id = $1', [id]);
    const ev = r.rows[0];
    if (!ev || ev.deleted_at) { err(res, 'not_found', 'registro não encontrado', 404); return null; }
    if (Number(ev.person_id) !== Number(s.person_id)) { err(res, 'not_owner', 'esse registro não é seu', 403); return null; }
    return ev;
  }

  router.get(BASE + '/order', async (req, res) => {
    try {
      const s = await kioskSession(req, res); if (!s) return;
      const month = monthStartNy(nowFn());
      const r = await db.query(`
        SELECT at.slug, e.phase_label, COUNT(*)::int AS n
          FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
         WHERE e.person_id = $1 AND e.deleted_at IS NULL AND COALESCE(e.is_test, false) = false
           AND e.started_at >= ($2::date - INTERVAL '${WINDOW_DAYS} days') AND e.started_at < $2::date
         GROUP BY at.slug, e.phase_label`, [s.person_id, month]);
      const types = {}, clean_kinds = {};
      for (const row of r.rows) {
        types[row.slug] = (types[row.slug] || 0) + row.n;
        if (row.slug === 'cleaning' && row.phase_label && row.phase_label.startsWith('limpeza:')) { const k = row.phase_label.slice(8); clean_kinds[k] = (clean_kinds[k] || 0) + row.n; }
      }
      let hidden = [];
      try { const kp = (await db.query('SELECT kiosk_prefs FROM v3.persons WHERE id = $1', [s.person_id])).rows[0]; hidden = (kp && kp.kiosk_prefs && Array.isArray(kp.kiosk_prefs.hidden_groups)) ? kp.kiosk_prefs.hidden_groups : []; } catch (_) { hidden = []; }
      ok(res, { month, window_days: WINDOW_DAYS, types, clean_kinds, hidden_groups: hidden });
    } catch (e) { console.error('[kiosk]', e.message); err(res, 'internal', e.message, 500); }
  });

  router.post(BASE + '/event/:id/subtype', async (req, res) => {
    try {
      const s = await kioskSession(req, res); if (!s) return;
      const ev = await ownedEvent(req, res, s); if (!ev) return;
      const kind = String((req.body || {}).kind || '').trim();
      if (!CLEAN_KINDS[kind]) return err(res, 'bad_kind', 'tipo de limpeza inválido');
      await db.query("UPDATE v3.events SET phase_label = $2, updated_at = NOW() WHERE id = $1", [ev.id, 'limpeza:' + kind]);
      ok(res, { id: ev.id, kind, label: CLEAN_KINDS[kind] });
    } catch (e) { console.error('[kiosk]', e.message); err(res, 'internal', e.message, 500); }
  });

  router.post(BASE + '/event/:id/title', async (req, res) => {
    try {
      const s = await kioskSession(req, res); if (!s) return;
      const ev = await ownedEvent(req, res, s); if (!ev) return;
      const text = String((req.body || {}).text || '').trim();
      if (!text) return err(res, 'bad_request', 'texto vazio');
      const { title, via } = await summarize(provider, text);
      if (title) await db.query("UPDATE v3.events SET phase_label = $2, updated_at = NOW() WHERE id = $1", [ev.id, title]);
      ok(res, { id: ev.id, title, via });
    } catch (e) { console.error('[kiosk]', e.message); err(res, 'internal', e.message, 500); }
  });

  // dashboard (PIN): os "Outros" ainda não revisados — de qualquer dia, até alguém resolver
  router.get(BASE + '/others', makeAuthMiddleware({ db }), async (req, res) => {
    try {
      const rows = (await db.query(`
        SELECT e.id, e.person_id, pe.display_name AS person, at.slug, at.display_name AS activity, e.started_at, e.ended_at,
               e.phase_label AS title, e.description AS text,
               ROUND((EXTRACT(EPOCH FROM (COALESCE(e.ended_at, NOW()) - e.started_at)) - COALESCE(e.total_paused_seconds, 0)) / 60.0) AS duration_min
          FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id JOIN v3.persons pe ON pe.id = e.person_id
         WHERE at.slug = ANY($1) AND e.deleted_at IS NULL AND COALESCE(e.is_test, false) = false AND e.other_reviewed_at IS NULL
           AND e.started_at >= $2::date
         ORDER BY e.started_at DESC LIMIT 200`, [OTHER_SLUGS, OTHERS_SINCE])).rows;
      ok(res, { rows, count: rows.length });
    } catch (e) { console.error('[kiosk]', e.message); err(res, 'internal', e.message, 500); }
  });
  router.post(BASE + '/others/:id/resolve', makeAuthMiddleware({ db }), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10); if (!id) return err(res, 'bad_id', 'id inválido');
      const b = req.body || {}; const slug = b.activity_slug ? String(b.activity_slug).trim() : null;
      let reclassified = null;
      if (slug) {
        const act = (await db.query('SELECT id, slug, display_name FROM v3.activity_types WHERE slug = $1 AND active = true', [slug])).rows[0];
        if (!act) return err(res, 'unknown_activity_slug', 'atividade não existe: ' + slug);
        await db.query('UPDATE v3.events SET activity_type_id = $2, updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL', [id, act.id]);
        reclassified = act.slug;
      }
      const r = await db.query('UPDATE v3.events SET other_reviewed_at = NOW(), other_reviewed_by = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id, (req.login && req.login.name) || null]);
      if (!r.rows[0]) return err(res, 'not_found', 'registro não encontrado', 404);
      try { await db.query(`INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata) VALUES ('admin', NULL, 'event.other_reviewed', 'event', $1, $2::jsonb)`, [id, JSON.stringify({ login: req.login && req.login.name, reclassified, note: b.note || null })]); } catch (_) { /* nunca derruba */ }
      ok(res, { id, reclassified });
    } catch (e) { console.error('[kiosk]', e.message); err(res, 'internal', e.message, 500); }
  });

  return router;
}

module.exports = { createKioskRouter, monthStartNy, fallbackTitle, summarize, CLEAN_KINDS, OTHER_SLUGS, BASE };
