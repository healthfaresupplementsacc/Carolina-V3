'use strict';
/**
 * PARTE 4 — Carolina hourly activity auto-check.
 *
 * Complements the 30-min Bloco-C detector. Every hour, for each OPEN
 * phase/ad-hoc whose responsible operator has had NO operator_activity_log
 * entry for > 1h (and the instance itself is older than 1h), Carolina
 * asks the admin channel whether it's right, then acts on the reply:
 *   sim/ok/tá  -> keep open, don't re-ask for 2h (verified)
 *   fechar     -> close the phase/ad-hoc with ended_at = last oal ts
 *   pausa      -> retroactive break (started_at = last oal, ended_at = NOW)
 *
 * Unanswered items are re-asked every hour (state in app_state key
 * 'activity_freshness_pending'). Every action is audited.
 */

// TAREFA 3 — regra permanente do Bruno: fase/ad-hoc aberta > 8h SEM
// atividade no oal → Carolina pergunta no admin chat. Se o admin não
// responder em +4h (total 12h desde a 1ª pergunta) → auto-close com
// nota '[auto_close_12h]' + audit.
const STALE_HOURS = 8;
const VERIFY_HOURS = 2;
const AUTO_CLOSE_HOURS = 12;
const PENDING_KEY = 'activity_freshness_pending';

const _STALE_SQL = (tbl, idCol, nameCol, joinExtra, prodCol) => `
  SELECT '${tbl === 'phase_instances' ? 'phase' : 'adhoc'}' AS kind,
         x.id, x.${nameCol} AS name, ${prodCol} AS product,
         o.name AS operator, o.id AS operator_id,
         lo.last_oal AS last_oal
  FROM ${tbl} x
  ${joinExtra}
  LEFT JOIN operators o ON o.id = x.started_by_operator_id
  LEFT JOIN LATERAL (
    SELECT MAX(started_at) AS last_oal FROM operator_activity_log
    WHERE operator_id = x.started_by_operator_id
  ) lo ON TRUE
  WHERE x.status = 'open' AND x.ended_at IS NULL
    AND x.started_at < NOW() - INTERVAL '${STALE_HOURS} hour'
    AND (lo.last_oal IS NULL OR lo.last_oal < NOW() - INTERVAL '${STALE_HOURS} hour')`;

async function findStale(db) {
  const ph = await db.query(_STALE_SQL(
    'phase_instances', 'id', 'phase_name',
    'JOIN workflow_instances wi ON wi.id = x.workflow_instance_id', 'wi.product_name'));
  const ah = await db.query(_STALE_SQL(
    'ad_hoc_task_instances', 'id', 'task_name', '', 'NULL'));
  return [...ph.rows, ...ah.rows].map((r) => ({
    kind: r.kind, id: r.id, name: r.name, product: r.product,
    operator: r.operator, operator_id: r.operator_id,
    last_oal: r.last_oal ? new Date(r.last_oal).toISOString() : null,
  }));
}

function _key(it) { return `${it.kind}:${it.id}`; }

async function _getPending(appState) {
  try {
    const raw = await appState.get(PENDING_KEY, null);
    if (!raw) return { items: [], verified: {} };
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { items: p.items || [], verified: p.verified || {}, firstAsked: p.firstAsked || {} };
  } catch (_) { return { items: [], verified: {}, firstAsked: {} }; }
}
async function _setPending(appState, p) {
  await appState.set(PENDING_KEY, JSON.stringify(p));
}

/**
 * Detect + ask. Re-asks every hour for items not yet verified.
 * @returns {Promise<{asked:number, items:Array}>}
 */
async function checkActivityFreshness(deps = {}) {
  const db = deps.db || require('../db');
  const appState = deps.appState || require('../app-state');
  const slack = deps.slack || require('../slack/client');
  const audit = deps.auditAction || require('../admin/audit').auditAction;
  const config = deps.config || require('../config');

  const engine = deps.engine || require('./engine');
  const stale = await findStale(db);
  const pending = await _getPending(appState);
  const now = Date.now();
  // drop expired "verified" marks
  for (const k of Object.keys(pending.verified)) {
    if (new Date(pending.verified[k]).getTime() <= now) delete pending.verified[k];
  }
  const firstAsked = pending.firstAsked || {};
  const candidates = stale.filter((it) => !pending.verified[_key(it)]);

  // ── Auto-close: asked first time ≥ AUTO_CLOSE_HOURS ago, still
  //    unanswered (admin didn't say sim/fechar/pausa) → close it. ──
  const autoClosed = [];
  const cutoff = now - AUTO_CLOSE_HOURS * 3600 * 1000;
  for (const it of candidates) {
    const fa = firstAsked[_key(it)];
    if (fa && new Date(fa).getTime() <= cutoff) {
      try {
        const when = it.last_oal || new Date().toISOString();
        if (it.kind === 'phase') {
          await engine.closePhase({ phaseInstanceId: it.id, when });
          await db.query(
            `UPDATE phase_instances SET notes = COALESCE(notes,'') || ' [auto_close_12h]', updated_at = NOW() WHERE id = $1`,
            [it.id]);
        } else {
          await engine.closeAdHocTask({ adHocTaskInstanceId: it.id, when });
          await db.query(
            `UPDATE ad_hoc_task_instances SET notes = COALESCE(notes,'') || ' [auto_close_12h]', updated_at = NOW() WHERE id = $1`,
            [it.id]);
        }
        delete firstAsked[_key(it)];
        autoClosed.push({ ...it, ended_at: when });
        await audit({
          action: 'activity_check.auto_close_12h', entityType: 'activity_freshness',
          entityId: _key(it), source: 'cron',
          before: { first_asked: fa, last_oal: it.last_oal },
          after: { closed: true, ended_at: when, note: '[auto_close_12h]' },
        });
      } catch (e) { /* never block the cron; retried next hour */ }
    }
  }
  const autoClosedKeys = new Set(autoClosed.map(_key));
  const toAsk = candidates.filter((it) => !autoClosedKeys.has(_key(it)));

  if (toAsk.length === 0) {
    await _setPending(appState, { items: [], verified: pending.verified, firstAsked });
    return { asked: 0, items: [], autoClosed };
  }

  let formatTime;
  try { ({ formatTime } = require('../utils/time')); } catch (_) { formatTime = (t) => String(t); }
  let tf = '12h';
  try { tf = await appState.getTimeFormat(); } catch (_) {}
  const lines = toAsk.map((it) => {
    const where = it.kind === 'phase'
      ? `'${it.name}${it.product ? ' · ' + it.product : ''}'`
      : `'${it.name}'`;
    const last = it.last_oal ? formatTime(it.last_oal, { format: tf }) : 'nenhum registro';
    return `🤔 ${it.operator || 'Operador'} tá em ${where} há +${STALE_HOURS}h sem nenhuma atividade detectada (último oal: ${last}). Tá certo?`;
  });
  const msg = lines.join('\n') +
    `\nResponde: "sim" (continua), "fechar" (encerra agora), "pausa" (registra break retroativo desde o último oal).`
    + `\n(sem resposta em ${AUTO_CLOSE_HOURS - STALE_HOURS}h eu fecho sozinha — nota [auto_close_12h])`;

  try {
    await slack.postToChannel(config.slack.managerChannelId, msg);
  } catch (e) { /* never block the cron on a Slack hiccup */ }

  // stamp first_asked once per item (carry it across hourly re-asks so
  // the 12h auto-close clock starts at the FIRST question, not the last).
  const nowIso = new Date().toISOString();
  for (const it of toAsk) {
    if (!firstAsked[_key(it)]) firstAsked[_key(it)] = nowIso;
  }
  await _setPending(appState, {
    items: toAsk, verified: pending.verified, firstAsked, asked_at: nowIso,
  });
  try {
    await audit({
      action: 'activity_check.asked', entityType: 'activity_freshness',
      entityId: 'cron', source: 'cron',
      before: null, after: { items: toAsk.map((i) => _key(i)), auto_close_in_h: AUTO_CLOSE_HOURS },
    });
  } catch (_) {}
  return { asked: toAsk.length, items: toAsk, autoClosed };
}

/**
 * Apply the admin's answer to the currently pending stale items.
 * @param {'keep'|'close'|'break'} action
 */
async function resolveActivityCheck(action, deps = {}) {
  const db = deps.db || require('../db');
  const appState = deps.appState || require('../app-state');
  const engine = deps.engine || require('./engine');
  const audit = deps.auditAction || require('../admin/audit').auditAction;

  const pending = await _getPending(appState);
  if (!pending.items.length) return { handled: false, reason: 'sem verificação pendente' };

  // an answered item must NOT keep its 12h auto-close clock running.
  const fa = pending.firstAsked || {};
  for (const it of pending.items) delete fa[_key(it)];

  const done = [];
  if (action === 'keep') {
    const until = new Date(Date.now() + VERIFY_HOURS * 3600 * 1000).toISOString();
    for (const it of pending.items) pending.verified[_key(it)] = until;
    await _setPending(appState, { items: [], verified: pending.verified, firstAsked: fa });
    for (const it of pending.items) done.push({ ...it, action: 'kept', verified_until: until });
  } else if (action === 'close') {
    for (const it of pending.items) {
      const when = it.last_oal || new Date().toISOString();
      if (it.kind === 'phase') {
        await engine.closePhase({ phaseInstanceId: it.id, when });
      } else {
        await engine.closeAdHocTask({ adHocTaskInstanceId: it.id, when });
      }
      done.push({ ...it, action: 'closed', ended_at: when });
    }
    await _setPending(appState, { items: [], verified: pending.verified, firstAsked: fa });
  } else if (action === 'break') {
    for (const it of pending.items) {
      if (!it.operator_id) { done.push({ ...it, action: 'skipped_no_operator' }); continue; }
      const startedAt = it.last_oal || new Date(Date.now() - STALE_HOURS * 3600 * 1000).toISOString();
      const pr = await db.query(
        `INSERT INTO pauses (operator, reason, started_at, ended_at, ended_reason)
         VALUES ($1, '[stale - break retroativo]', $2::timestamptz, NOW(), 'activity_check_retro')
         RETURNING id`, [it.operator || null, startedAt]);
      const pauseId = pr.rows[0] && pr.rows[0].id;
      await db.query(
        `INSERT INTO operator_activity_log
           (operator_id, activity_type, pause_id, started_at, ended_at, duration_seconds)
         VALUES ($1,'break',$2,$3::timestamptz, NOW(),
                 GREATEST(0, EXTRACT(EPOCH FROM (NOW() - $3::timestamptz))::int))`,
        [it.operator_id, pauseId, startedAt]);
      done.push({ ...it, action: 'retro_break', started_at: startedAt });
    }
    await _setPending(appState, { items: [], verified: pending.verified, firstAsked: fa });
  } else {
    return { handled: false, reason: 'ação inválida' };
  }

  try {
    await audit({
      action: 'activity_check.' + action, entityType: 'activity_freshness',
      entityId: 'admin_reply', source: deps.source || 'slack_admin',
      before: { items: pending.items.map(_key) }, after: { done },
    });
  } catch (_) {}
  return { handled: true, action, done };
}

/** For pendingSummary so Carolina knows to keep nagging. */
async function pendingFreshness(appState) {
  const p = await _getPending(appState || require('../app-state'));
  return p.items.length ? p.items : null;
}

module.exports = {
  STALE_HOURS, VERIFY_HOURS, AUTO_CLOSE_HOURS, PENDING_KEY,
  findStale, checkActivityFreshness, resolveActivityCheck, pendingFreshness,
};
