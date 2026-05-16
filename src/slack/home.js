'use strict';
/**
 * Entrega 3 Fase 6.2 — App Home Block Kit renderer.
 *
 * Layout (per the master doc §6 / Entrega 3 §6.3):
 *   A. "Quem é você?" — operator buttons (no person memory: every action
 *      re-asks via the modal Passo 1; this block is the entry point)
 *   B. Workflow instances + phases active (everyone's)
 *   C. Ad-hoc activities active
 *   D. Who's on break
 *   E. Action buttons (Iniciar batch / Iniciar tarefa avulsa / Pausa /
 *      Voltei / Registrar produção / Nota)
 *
 * No person memory — every button opens a modal whose first step asks
 * "quem é você?".
 */

const config = require('../config');
const db = require('../db');
const appState = require('../app-state');

let _client = null;
function client() {
  if (!_client) {
    const { WebClient } = require('@slack/web-api');
    _client = new WebClient(config.slack.token);
  }
  return _client;
}

function fmtElapsed(since) {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h${m.toString().padStart(2, '0')}min` : `${m}min`;
}

async function fetchHomeState() {
  const [ops, activeWf, activePhases, activeAdhoc, breaks] = await Promise.all([
    db.query(`SELECT id, name FROM operators WHERE active = TRUE ORDER BY name`),
    db.query(`
      SELECT wi.id, wi.product_name, wi.batch_number, wi.started_at,
             wi.batch_change_approved, wt.name AS workflow_name
      FROM workflow_instances wi
      JOIN workflow_templates wt ON wt.id = wi.workflow_template_id
      WHERE wi.status = 'active' AND wi.ended_at IS NULL
      ORDER BY wi.started_at DESC`),
    db.query(`
      SELECT pi.id, pi.workflow_instance_id, pi.phase_name, pi.status,
             pi.started_at, o.name AS starter_name,
             (SELECT string_agg(DISTINCT op2.name, ' + ' ORDER BY op2.name)
                FROM operator_activity_log oal2
                JOIN operators op2 ON op2.id = oal2.operator_id
                WHERE oal2.phase_instance_id = pi.id
                  AND oal2.ended_at IS NULL) AS participants
      FROM phase_instances pi
      LEFT JOIN operators o ON o.id = pi.started_by_operator_id
      WHERE pi.status = 'open' AND pi.ended_at IS NULL
      ORDER BY pi.started_at DESC`),
    db.query(`
      SELECT ati.id, ati.task_name, ati.started_at, aht.admin_approved,
             o.name AS starter_name,
             (SELECT string_agg(DISTINCT op2.name, ' + ' ORDER BY op2.name)
                FROM operator_activity_log oal2
                JOIN operators op2 ON op2.id = oal2.operator_id
                WHERE oal2.ad_hoc_task_instance_id = ati.id
                  AND oal2.ended_at IS NULL) AS participants
      FROM ad_hoc_task_instances ati
      LEFT JOIN ad_hoc_tasks aht ON aht.id = ati.ad_hoc_task_id
      LEFT JOIN operators o ON o.id = ati.started_by_operator_id
      WHERE ati.status = 'open' AND ati.ended_at IS NULL
      ORDER BY ati.started_at DESC`),
    db.query(`
      SELECT oal.id, oal.started_at, o.name AS operator_name
      FROM operator_activity_log oal
      JOIN operators o ON o.id = oal.operator_id
      WHERE oal.activity_type = 'break' AND oal.ended_at IS NULL
      ORDER BY oal.started_at DESC`),
  ]);
  return {
    operators: ops.rows,
    workflows: activeWf.rows,
    phases: activePhases.rows,
    adhoc: activeAdhoc.rows,
    breaks: breaks.rows,
  };
}

function buildHomeView(state) {
  const blocks = [];

  const appName = state.appName || appState.getAppNameSync();
  blocks.push({ type: 'header', text: { type: 'plain_text', text: `🌿 ${appName}` } });

  // E. Primary actions (top so they're always reachable)
  blocks.push({
    type: 'actions',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: '▶️ Iniciar batch' }, style: 'primary', action_id: 'start_batch' },
      { type: 'button', text: { type: 'plain_text', text: '🧹 Tarefa avulsa' }, action_id: 'start_adhoc' },
      { type: 'button', text: { type: 'plain_text', text: '⏸️ Pausa' }, action_id: 'start_break' },
      { type: 'button', text: { type: 'plain_text', text: '↩️ Voltei' }, action_id: 'end_break' },
      { type: 'button', text: { type: 'plain_text', text: '📦 Produção' }, action_id: 'register_count' },
      { type: 'button', text: { type: 'plain_text', text: '📝 Nota' }, action_id: 'add_note' },
    ],
  });
  blocks.push({ type: 'divider' });

  // B. Active workflow instances with their open phases
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*⏱ Batches em andamento*' } });
  if (state.workflows.length === 0) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Nenhum batch ativo agora._' }] });
  } else {
    for (const wf of state.workflows) {
      const title = `${wf.product_name || wf.workflow_name}${wf.batch_number ? ' #' + wf.batch_number : ''}`;
      const batchFlag = wf.batch_change_approved === false ? ' ⏳ _batch alterado_' : '';
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `🧪 *${title}*${batchFlag}\n_iniciado ${fmtElapsed(wf.started_at)} atrás_` },
      });
      const phs = state.phases.filter((p) => p.workflow_instance_id === wf.id);
      for (const p of phs) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `   🟢 *${p.phase_name}* · ${p.participants || p.starter_name || '?'} · ${fmtElapsed(p.started_at)}` },
          accessory: {
            type: 'overflow',
            action_id: `phase_menu_${p.id}`,
            options: [
              { text: { type: 'plain_text', text: 'Entrar nessa fase' }, value: `join_phase:${p.id}` },
              { text: { type: 'plain_text', text: 'Concluir essa fase' }, value: `close_phase:${p.id}` },
            ],
          },
        });
      }
    }
  }
  blocks.push({ type: 'divider' });

  // C. Ad-hoc activities
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*🧹 Atividades avulsas*' } });
  if (state.adhoc.length === 0) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Nenhuma agora._' }] });
  } else {
    for (const a of state.adhoc) {
      const pend = a.admin_approved === false ? ' ⏳ _pendente de revisão_' : '';
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `🧹 *${a.task_name}*${pend} · ${a.participants || a.starter_name || '?'} · ${fmtElapsed(a.started_at)}` },
        accessory: {
          type: 'button', text: { type: 'plain_text', text: 'Concluir' },
          action_id: `close_adhoc_${a.id}`, value: `${a.id}`,
        },
      });
    }
  }
  blocks.push({ type: 'divider' });

  // D. On break
  const breakTxt = state.breaks.length === 0
    ? '_Ninguém em break._'
    : state.breaks.map((b) => `⏸ ${b.operator_name} (${fmtElapsed(b.started_at)})`).join('\n');
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*☕ Em break*\n${breakTxt}` } });

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Toda ação pergunta _quem é você?_ primeiro. Sem memória de pessoa.' }],
  });

  return { type: 'home', blocks };
}

async function publishHome(slackUserId) {
  if (!slackUserId) return;
  try {
    const state = await fetchHomeState();
    const view = buildHomeView(state);
    await client().views.publish({ user_id: slackUserId, view: JSON.stringify(view) });
  } catch (err) {
    console.error('[Home] publish error:', err.message);
  }
}

module.exports = { fetchHomeState, buildHomeView, publishHome };
