'use strict';
/**
 * Entrega 3 Fase 5.1 — Bridge from parser output to the workflow engine.
 *
 * The legacy poller (src/slack/poller.js) already routes parsed messages
 * to taskEngine / ordersEngine / formulationEng which write to the old
 * tables (tasks, orders_sessions, formulation_sessions, pauses). Those
 * still run.
 *
 * This dispatcher runs AFTER the legacy handlers, in parallel, and
 * writes to the new model (workflow_instances + phase_instances +
 * ad_hoc_task_instances + operator_activity_log). Failures here NEVER
 * block the legacy path — they're logged and swallowed so a bug in the
 * new code can't break production.
 *
 * Mapping:
 *   parsed.type = 'start'              → findOrCreateWorkflowInstance + startPhase
 *   parsed.type = 'finish'             → closePhase (newest open phase for supplement)
 *   parsed.type = 'pause_start'        → engine.startBreak
 *   parsed.type = 'pause_end'          → engine.endBreak
 *   parsed.type = 'orders_start'       → findOrCreate Picking workflow + startPhase Imprimir
 *   parsed.type = 'orders_finish'      → closePhase Imprimir
 *   parsed.type = 'formulation_start'  → findOrCreate Produção wf + startPhase Formulação
 *   parsed.type = 'formulation_finish' → closePhase Formulação
 *   parsed.type = 'count'              → ad-hoc 'Reporte no sistema'
 *                                         (fallback duplo via resolveReporteLink)
 *   parsed.type = 'join_producao'      → joinPhase on the active Linha de Produção
 */

const db = require('../db');
const engine = require('./engine');
const announce = require('./announce');
const { detectPhaseHint } = require('../parser');

// task_type → phase template name within "Produção de Suplemento"
const TASK_TYPE_TO_PHASE = {
  producao: 'Linha de Produção',
  linha_producao: 'Linha de Produção',
  revisao: 'Revisão',
  encapsulacao: 'Encapsulação',
  formulacao: 'Formulação',
};

async function getOperatorId(name) {
  if (!name) return null;
  const r = await db.query(
    `SELECT id FROM operators WHERE LOWER(name) = LOWER($1) AND active = TRUE LIMIT 1`,
    [name]
  );
  return r.rows[0]?.id || null;
}

async function getTemplateContext() {
  const wf = await db.query(`SELECT id, name FROM workflow_templates`);
  const wfByName = Object.fromEntries(wf.rows.map((r) => [r.name, r.id]));
  const ph = await db.query(`
    SELECT pt.id, pt.name AS phase_name, wt.name AS workflow_name
    FROM phase_templates pt
    JOIN workflow_templates wt ON wt.id = pt.workflow_template_id
  `);
  const phaseByKey = {};
  for (const row of ph.rows) phaseByKey[`${row.workflow_name}::${row.phase_name}`] = row.id;
  return { wfByName, phaseByKey };
}

/**
 * Resolve the workflow + phase template a parsed start/finish should map to.
 * Returns { workflowName, phaseName, phaseTemplateId } or null when no match.
 */
async function resolveTemplate(parsed, ctx) {
  if (parsed.type === 'orders_start' || parsed.type === 'orders_finish') {
    return {
      workflowName: 'Picking & Packing',
      phaseName: 'Imprimir ordens',
      phaseTemplateId: ctx.phaseByKey['Picking & Packing::Imprimir ordens'] || null,
    };
  }
  if (parsed.type === 'formulation_start' || parsed.type === 'formulation_finish') {
    return {
      workflowName: 'Produção de Suplemento',
      phaseName: 'Formulação',
      phaseTemplateId: ctx.phaseByKey['Produção de Suplemento::Formulação'] || null,
    };
  }
  // start / finish — prefer a natural-language phase hint from the raw
  // text (Fase 5.2). "S: Encapsulação Green Tea" → Encapsulação even
  // though taskType is the generic 'producao'. Falls back to the
  // taskType mapping, then Linha de Produção.
  const hint = parsed._phaseHint || null;
  if (hint && ctx.phaseByKey[`Produção de Suplemento::${hint}`]) {
    return {
      workflowName: 'Produção de Suplemento',
      phaseName: hint,
      phaseTemplateId: ctx.phaseByKey[`Produção de Suplemento::${hint}`],
    };
  }
  const taskType = parsed.taskType || 'producao';
  // 'producao' / 'linha_producao' is the GENERIC default the parser
  // assigns when it couldn't tell — it is NOT a real signal. Only a
  // non-generic taskType (revisao/encapsulacao/formulacao) is specific.
  const GENERIC_TASK_TYPES = new Set(['producao', 'linha_producao']);
  const specificMapped = !GENERIC_TASK_TYPES.has(taskType)
    ? TASK_TYPE_TO_PHASE[taskType] : null;
  const phase = specificMapped || 'Linha de Produção';
  return {
    workflowName: 'Produção de Suplemento',
    phaseName: phase,
    phaseTemplateId: ctx.phaseByKey[`Produção de Suplemento::${phase}`] || null,
    // EMERGÊNCIA L-01/L-02/L-05 — true quando NÃO houve sinal real de
    // fase: sem phase-hint (já tratado acima), taskType genérico e sem
    // suplemento. Antes isso virava silenciosamente uma phase fantasma
    // "Linha de Produção" (produto/batch NULL) atribuída a quem o parser
    // chutou. Agora o dispatch trata esse caso sem poluir.
    fallbackNoContext: !specificMapped && !parsed.supplement,
  };
}

async function findOpenPhaseInstance({ workflowName, phaseName, supplement, batch, ctx }) {
  const wfId = ctx.wfByName[workflowName];
  if (!wfId) return null;
  const params = [wfId, phaseName];
  let cond = `wi.workflow_template_id = $1 AND pi.phase_name = $2 AND pi.status = 'open'`;
  if (supplement) { cond += ` AND wi.product_name = $${params.length + 1}`; params.push(supplement); }
  if (batch)      { cond += ` AND (wi.batch_number = $${params.length + 1} OR pi.batch_number = $${params.length + 1})`; params.push(batch); }
  const r = await db.query(
    `SELECT pi.id, pi.workflow_instance_id
     FROM phase_instances pi
     JOIN workflow_instances wi ON wi.id = pi.workflow_instance_id
     WHERE ${cond}
     ORDER BY pi.started_at DESC LIMIT 1`,
    params
  );
  return r.rows[0] || null;
}

async function dispatch(parsed, rawMsg) {
  if (!parsed || !parsed.type) return { dispatched: false, reason: 'no parsed' };
  // Fase 5.2: enrich with a natural-language phase hint from raw text.
  if (rawMsg?.text && parsed._phaseHint === undefined) {
    parsed._phaseHint = detectPhaseHint(rawMsg.text);
  }
  const ctx = await getTemplateContext();
  const when = rawMsg?.ts ? new Date(parseFloat(rawMsg.ts) * 1000).toISOString() : null;
  const operatorId = await getOperatorId(parsed.operator);

  // Operator-required types
  const needsOperator = ['start','finish','pause_start','pause_end','orders_start',
                         'orders_finish','formulation_start','formulation_finish',
                         'count','join_producao'];
  if (needsOperator.includes(parsed.type) && !operatorId) {
    return { dispatched: false, reason: 'unresolved operator' };
  }

  switch (parsed.type) {
    case 'pause_start':
      return { dispatched: true, kind: 'break_start',
               result: await engine.startBreak({ operatorId, reason: null, when, slackTs: rawMsg?.ts || null }) };

    case 'pause_end':
      return { dispatched: true, kind: 'break_end',
               result: await engine.endBreak({ operatorId, when }) };

    case 'start':
    case 'orders_start':
    case 'formulation_start': {
      const tpl = await resolveTemplate(parsed, ctx);
      // EMERGÊNCIA L-01/L-02/L-04/L-05 — generic 'start' with NO real
      // phase signal must NOT mint a phantom "Linha de Produção".
      // (orders_start/formulation_start are explicit → never fall here.)
      if (parsed.type === 'start' && tpl.fallbackNoContext) {
        const cur = await engine.getCurrentActivity(operatorId);
        if (cur) {
          // Operator is already on something (e.g. Simone on P&P). A
          // contextless start is noise / a cowork blip — do NOT open a
          // new phase. Leave their real activity untouched.
          return { dispatched: false, reason: 'start sem contexto; operador já ativo — fase fantasma evitada' };
        }
        // No context AND not currently active → record as ad-hoc
        // "Outro" with the original message as the note, never a
        // fake production phase.
        const r = await engine.startAdHocTask({
          taskName: 'Outro', operatorId,
          text: rawMsg?.text || null, when,
          notes: parsed.description || rawMsg?.text || null,
        });
        return { dispatched: true, kind: 'adhoc_outro_no_context',
                 result: r };
      }
      if (!tpl.phaseTemplateId) return { dispatched: false, reason: 'unknown phase template' };
      const wf = await engine.findOrCreateWorkflowInstance({
        workflowTemplateId: ctx.wfByName[tpl.workflowName],
        productName: parsed.supplement || null,
        batchNumber: parsed.batch || null,
        startedByOperatorId: operatorId,
        passNumber: (parsed.type === 'orders_start' && parsed.orderCount) ? null : null,
        when,
      });
      const phase = await engine.startPhase({
        workflowInstanceId: wf.workflowInstanceId,
        phaseTemplateId: tpl.phaseTemplateId,
        operatorId,
        batchNumber: parsed.batch || null,
        when,
        notes: parsed.description || null,
      });
      // R1: soft prereq violated → admin heads-up (never blocks here)
      if (phase.prereqWarning && phase.prereqWarning.length) {
        announce.prereqWarning({
          operatorName: parsed.operator,
          phaseName: tpl.phaseName,
          missing: phase.prereqWarning,
        }).catch(() => {});
      }
      return {
        dispatched: true, kind: 'phase_start',
        result: { workflowInstanceId: wf.workflowInstanceId, ...phase, prereqWarning: phase.prereqWarning },
      };
    }

    case 'finish':
    case 'orders_finish':
    case 'formulation_finish': {
      const tpl = await resolveTemplate(parsed, ctx);
      const open = await findOpenPhaseInstance({
        workflowName: tpl.workflowName,
        phaseName: tpl.phaseName,
        supplement: parsed.supplement || null,
        batch: parsed.batch || null,
        ctx,
      });
      if (!open) return { dispatched: false, reason: 'no open phase to close' };
      const closeRes = await engine.closePhase({
        phaseInstanceId: open.id,
        closedByOperatorId: operatorId,
        when,
      });
      return { dispatched: true, kind: 'phase_close', result: closeRes };
    }

    case 'join_producao': {
      // Find newest open Linha de Produção phase and join it
      const open = await findOpenPhaseInstance({
        workflowName: 'Produção de Suplemento',
        phaseName: 'Linha de Produção',
        supplement: null, batch: null, ctx,
      });
      if (!open) return { dispatched: false, reason: 'no open Linha de Produção to join' };
      const r = await engine.joinPhase({ phaseInstanceId: open.id, operatorId, when });
      return { dispatched: true, kind: 'phase_join', result: r };
    }

    case 'count': {
      // Treat as "Reporte no sistema" ad-hoc with fallback duplo.
      const r0 = await engine.startAdHocTask({
        taskName: 'Reporte no sistema',
        operatorId,
        text: rawMsg?.text || null,
        when,
      });
      const r = r0;
      // R4: ad-hoc started outside the catalog → admin review heads-up
      if (r0.isNewTaskInCatalog || r0.isPending) {
        announce.adHocPending({ operatorName: parsed.operator, taskName: r0.taskName })
          .catch(() => {});
      }
      // Reporte should close immediately — it's a punctual event, not a duration
      const closeRes = await engine.closeAdHocTask({
        adHocTaskInstanceId: r.adHocTaskInstanceId,
        closedByOperatorId: operatorId,
        when,
      });
      return { dispatched: true, kind: 'reporte', result: { ...r, ...closeRes } };
    }

    default:
      return { dispatched: false, reason: `unhandled type: ${parsed.type}` };
  }
}

/**
 * Safe wrapper for poller usage — never throws. Logs internal errors.
 */
async function safeDispatch(parsed, rawMsg) {
  try {
    return await dispatch(parsed, rawMsg);
  } catch (err) {
    console.error('[WorkflowDispatcher] error:', err.message, '— parsed:', JSON.stringify(parsed).slice(0, 200));
    return { dispatched: false, error: err.message };
  }
}

module.exports = {
  getOperatorId, getTemplateContext, resolveTemplate,
  findOpenPhaseInstance, dispatch, safeDispatch,
};
