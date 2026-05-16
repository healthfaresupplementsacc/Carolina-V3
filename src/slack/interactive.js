'use strict';
/**
 * Entrega 3 Fase 6.3 — App Home interactivity handler.
 *
 * No person memory: every primary action opens a modal whose first
 * block is an operator picker ("Quem é você?"). The chosen operator is
 * carried through private_metadata so the final submit knows who acted.
 *
 * Flow:
 *   block_actions (button on Home) → open a modal (views.open) that
 *     starts with the operator picker + the action-specific fields.
 *   view_submission → resolve operator → call the engine → republish Home.
 *
 * Engine calls are wrapped so a failure surfaces as a modal error rather
 * than a 500. Slack is told to ack within 3s by events.js; this module
 * runs async after the ack.
 */

const config = require('../config');
const db = require('../db');
const engine = require('../workflow/engine');
const home = require('./home');

let _client = null;
function client() {
  if (!_client) {
    const { WebClient } = require('@slack/web-api');
    _client = new WebClient(config.slack.token);
  }
  return _client;
}

async function operatorOptions() {
  const r = await db.query(`SELECT id, name FROM operators WHERE active = TRUE ORDER BY name`);
  return r.rows.map((o) => ({
    text: { type: 'plain_text', text: o.name },
    value: String(o.id),
  }));
}

// Bug B — supplement autocomplete via external_select. Slack calls the
// app's Options Load URL (/slack/options) as the user types.
function supplementSelectBlock(blockId, label, optional = false) {
  return {
    type: 'input',
    block_id: blockId,
    optional,
    label: { type: 'plain_text', text: label },
    element: {
      type: 'external_select',
      action_id: 'supplement_select',
      min_query_length: 0, // 0 → also fetch on open (top-used list)
      placeholder: { type: 'plain_text', text: 'Digite p/ buscar…' },
    },
  };
}

// Resolve an external_select supplement value. Returns
// { name, isNew }. '__create__:<typed>' → brand-new supplement.
async function resolveSupplementValue(selected, deps = {}) {
  if (!selected) return { name: null, isNew: false };
  if (selected.startsWith('__create__:')) {
    const name = selected.slice('__create__:'.length).trim();
    if (!name) return { name: null, isNew: false };
    const db = deps.db || require('../db');
    const parser = deps.parser || require('../parser');
    const announce = deps.announce || require('../workflow/announce');
    try {
      await db.query(
        `INSERT INTO supplement_catalog (canonical_name, aliases)
         VALUES ($1, '') ON CONFLICT (canonical_name) DO NOTHING`,
        [name]
      );
      if (typeof parser.addCustomSupplement === 'function') parser.addCustomSupplement(name, '');
      // B3 — AI reviews the typed text vs the catalog and gives admin a
      // concrete propose-then-confirm choice in the admin channel.
      let aiHint = '';
      try {
        const corrector = deps.corrector || require('../ai/supplement-corrector');
        const guess = await corrector.correctSupplement(name);
        if (guess && guess.supplement && guess.supplement.toLowerCase() !== name.toLowerCase()) {
          aiHint = `\nAcho que quis dizer *${guess.supplement}* ` +
            `(${guess.via}, confiança ${guess.confidence}). Me diz no chat: ` +
            `*[a]* trocar pra ${guess.supplement} · *[b]* manter "${name}" como novo · ` +
            `*[c]* mesclar com outro.`;
        }
      } catch (_) { /* AI hint is best-effort */ }
      await announce.toAdmin(
        `🆕 Operador digitou o suplemento *"${name}"* (não estava no catálogo). ` +
        `Criei como pendente (admin_approved=false).${aiHint}`
      );
    } catch (err) {
      console.error('[Interactive] new supplement create error:', err.message);
    }
    return { name, isNew: true };
  }
  return { name: selected, isNew: false };
}

// F4 — optional free-text note appended to every wizard. block_id 'note'.
function noteFieldBlock(label = 'Anotação (opcional)') {
  return {
    type: 'input', optional: true, block_id: 'note',
    label: { type: 'plain_text', text: label },
    element: { type: 'plain_text_input', action_id: 'v', multiline: true,
      placeholder: { type: 'plain_text', text: 'algo que aconteceu, observação…' } },
  };
}

function operatorPickerBlock(options) {
  return {
    type: 'input',
    block_id: 'who',
    label: { type: 'plain_text', text: 'Quem é você?' },
    element: {
      type: 'static_select',
      action_id: 'operator',
      placeholder: { type: 'plain_text', text: 'Selecione' },
      options,
    },
  };
}

function modal(callbackId, title, blocks, privateMeta = {}) {
  return {
    type: 'modal',
    callback_id: callbackId,
    title: { type: 'plain_text', text: title.slice(0, 24) },
    submit: { type: 'plain_text', text: 'Confirmar' },
    close: { type: 'plain_text', text: 'Cancelar' },
    private_metadata: JSON.stringify(privateMeta),
    blocks,
  };
}

async function openModal(triggerId, view) {
  await client().views.open({ trigger_id: triggerId, view: JSON.stringify(view) });
}

function readOperatorId(view) {
  const v = view.state.values?.who?.operator?.selected_option?.value;
  return v ? parseInt(v) : null;
}

// ─── block_actions: open the right modal ────────────────────────────────
async function handleBlockAction(payload) {
  const action = payload.actions && payload.actions[0];
  if (!action) return;
  const triggerId = payload.trigger_id;
  const opts = await operatorOptions();

  // Overflow menu on a phase → join / close
  if (action.action_id && action.action_id.startsWith('phase_menu_')) {
    const [verb, phaseId] = String(action.selected_option.value).split(':');
    if (verb === 'join_phase') {
      return openModal(triggerId, modal('submit_join_phase', 'Entrar na fase',
        [operatorPickerBlock(opts),
         { type: 'section', text: { type: 'mrkdwn', text: `Entrar na fase #${phaseId}?` } },
         noteFieldBlock()],
        { phaseId: Number(phaseId) }));
    }
    if (verb === 'close_phase') {
      return openModal(triggerId, modal('submit_close_phase', 'Concluir fase',
        [operatorPickerBlock(opts),
         { type: 'section', text: { type: 'mrkdwn', text: `Concluir a fase #${phaseId}?` } },
         { type: 'input', optional: true, block_id: 'bottles',
           label: { type: 'plain_text', text: 'Bottles (se aplicável)' },
           element: { type: 'plain_text_input', action_id: 'v' } },
         noteFieldBlock()],
        { phaseId: Number(phaseId) }));
    }
  }

  switch (action.action_id) {
    case 'start_break':
      return openModal(triggerId, modal('submit_break', 'Pausa',
        [operatorPickerBlock(opts),
         { type: 'input', optional: true, block_id: 'reason',
           label: { type: 'plain_text', text: 'Motivo' },
           element: { type: 'plain_text_input', action_id: 'v', placeholder: { type: 'plain_text', text: 'almoço, banheiro…' } } },
         noteFieldBlock()]));
    case 'end_break':
      return openModal(triggerId, modal('submit_end_break', 'Voltei',
        [operatorPickerBlock(opts),
         { type: 'section', text: { type: 'mrkdwn', text: 'Marcar volta do break agora?' } },
         noteFieldBlock()]));
    case 'start_adhoc': {
      const tasks = await db.query(`SELECT id, name FROM ad_hoc_tasks WHERE is_active = TRUE ORDER BY name`);
      return openModal(triggerId, modal('submit_adhoc', 'Tarefa avulsa',
        [operatorPickerBlock(opts),
         { type: 'input', block_id: 'task',
           label: { type: 'plain_text', text: 'Qual tarefa?' },
           element: { type: 'static_select', action_id: 'v',
             options: tasks.rows.map((t) => ({ text: { type: 'plain_text', text: t.name }, value: String(t.id) })) } },
         // F5 — required iff "Outro" is chosen (enforced at submit via
         // response_action errors; block stays optional so other tasks
         // submit normally).
         { type: 'input', optional: true, block_id: 'desc_outro',
           label: { type: 'plain_text', text: 'Descrição (obrigatório se for "Outro")' },
           element: { type: 'plain_text_input', action_id: 'v',
             placeholder: { type: 'plain_text', text: 'descreva a tarefa' } } },
         noteFieldBlock()]));
    }
    case 'start_batch': {
      const wts = await db.query(`SELECT id, name FROM workflow_templates WHERE is_active = TRUE ORDER BY id`);
      // W3 — list every active phase grouped by workflow so the operator
      // picks exactly which phase they're starting (value = "wfId:ptId").
      const phs = await db.query(`
        SELECT pt.id AS pt_id, pt.name AS phase_name, pt.sequence_order,
               wt.id AS wt_id, wt.name AS workflow_name
        FROM phase_templates pt
        JOIN workflow_templates wt ON wt.id = pt.workflow_template_id
        WHERE wt.is_active = TRUE
        ORDER BY wt.id, pt.sequence_order, pt.id`);
      const groupsMap = {};
      for (const p of phs.rows) {
        (groupsMap[p.workflow_name] = groupsMap[p.workflow_name] || []).push({
          text: { type: 'plain_text', text: `${p.sequence_order}. ${p.phase_name}`.slice(0, 75) },
          value: `${p.wt_id}:${p.pt_id}`,
        });
      }
      const phaseGroups = Object.entries(groupsMap).map(([wfName, options]) => ({
        label: { type: 'plain_text', text: wfName.slice(0, 75) }, options,
      }));
      // W4 — "Outro" universal: synthetic option in workflow + phase.
      const wtOptions = wts.rows.map((w) => ({ text: { type: 'plain_text', text: w.name }, value: String(w.id) }));
      wtOptions.push({ text: { type: 'plain_text', text: '➕ Outro (criar novo)' }, value: '__outro__' });
      phaseGroups.push({
        label: { type: 'plain_text', text: 'Outro' },
        options: [{ text: { type: 'plain_text', text: '➕ Outra fase (criar)' }, value: '__outro__' }],
      });
      const blocks = [
        operatorPickerBlock(opts),
        { type: 'input', block_id: 'wt',
          label: { type: 'plain_text', text: 'Tipo de trabalho' },
          element: { type: 'static_select', action_id: 'v', options: wtOptions } },
      ];
      blocks.push({
        type: 'input', optional: true, block_id: 'phase',
        label: { type: 'plain_text', text: 'Fase (qual você está iniciando?)' },
        element: { type: 'static_select', action_id: 'v', option_groups: phaseGroups },
      });
      blocks.push(
        { type: 'input', optional: true, block_id: 'outro_name',
          label: { type: 'plain_text', text: 'Se escolheu "Outro": nome do novo workflow/fase' },
          element: { type: 'plain_text_input', action_id: 'v',
            placeholder: { type: 'plain_text', text: 'ex: Reembalagem especial' } } },
        supplementSelectBlock('product', 'Produto (se aplicável)', true),
        { type: 'input', optional: true, block_id: 'batch',
          label: { type: 'plain_text', text: 'Lote' },
          element: { type: 'plain_text_input', action_id: 'v' } },
        noteFieldBlock());
      return openModal(triggerId, modal('submit_start_batch', 'Iniciar batch', blocks));
    }
    case 'register_count':
      return openModal(triggerId, modal('submit_count', 'Registrar produção',
        [operatorPickerBlock(opts),
         supplementSelectBlock('supp', 'Suplemento'),
         { type: 'input', block_id: 'qty', label: { type: 'plain_text', text: 'Bottles' },
           element: { type: 'plain_text_input', action_id: 'v' } },
         noteFieldBlock()]));
    case 'add_note':
      return openModal(triggerId, modal('submit_note', 'Nota',
        [operatorPickerBlock(opts),
         { type: 'input', block_id: 'text', label: { type: 'plain_text', text: 'Observação' },
           element: { type: 'plain_text_input', action_id: 'v', multiline: true } }]));
    default:
      if (action.action_id && action.action_id.startsWith('close_adhoc_')) {
        const adhocId = Number(action.value);
        return openModal(triggerId, modal('submit_close_adhoc', 'Concluir tarefa',
          [operatorPickerBlock(opts),
           { type: 'section', text: { type: 'mrkdwn', text: `Concluir a atividade #${adhocId}?` } },
           noteFieldBlock()],
          { adhocId }));
      }
  }
}

// ─── view_submission: run the engine ────────────────────────────────────
async function handleViewSubmission(payload) {
  const view = payload.view;
  const cb = view.callback_id;
  const meta = JSON.parse(view.private_metadata || '{}');
  const operatorId = readOperatorId(view);
  const slackUser = payload.user && payload.user.id;
  if (!operatorId) return; // input block makes this required anyway

  // F5 — "Outro" requires a description. Validate BEFORE any side effect
  // and return a response_action so Slack keeps the modal open.
  if (cb === 'submit_adhoc') {
    const taskId = view.state.values?.task?.v?.selected_option?.value;
    const tr = await db.query(`SELECT name FROM ad_hoc_tasks WHERE id = $1`, [taskId]);
    const taskName = tr.rows[0]?.name || '';
    const desc = (view.state.values?.desc_outro?.v?.value || '').trim();
    if (/^outro$/i.test(taskName) && !desc) {
      return {
        response_action: 'errors',
        errors: { desc_outro: 'Descreva a tarefa — obrigatório quando escolhe "Outro".' },
      };
    }
  }

  // W4 — "Outro" in the workflow or phase select requires a name.
  if (cb === 'submit_start_batch') {
    const wtVal = view.state.values?.wt?.v?.selected_option?.value;
    const phVal = view.state.values?.phase?.v?.selected_option?.value;
    const oName = (view.state.values?.outro_name?.v?.value || '').trim();
    if ((wtVal === '__outro__' || phVal === '__outro__') && !oName) {
      return {
        response_action: 'errors',
        errors: { outro_name: 'Digite o nome do novo workflow/fase — obrigatório quando escolhe "Outro".' },
      };
    }
  }

  try {
    switch (cb) {
      case 'submit_break':
        await engine.startBreak({
          operatorId,
          reason: view.state.values?.reason?.v?.value || null,
        });
        break;
      case 'submit_end_break':
        await engine.endBreak({ operatorId });
        break;
      case 'submit_join_phase':
        await engine.joinPhase({ phaseInstanceId: meta.phaseId, operatorId });
        break;
      case 'submit_close_phase': {
        const raw = view.state.values?.bottles?.v?.value;
        const n = raw ? parseInt(raw) : null;
        await engine.closePhase({
          phaseInstanceId: meta.phaseId, closedByOperatorId: operatorId,
          finalBottleCount: Number.isFinite(n) ? n : null,
        });
        break;
      }
      case 'submit_close_adhoc':
        await engine.closeAdHocTask({ adHocTaskInstanceId: meta.adhocId, closedByOperatorId: operatorId });
        break;
      case 'submit_adhoc': {
        const taskId = view.state.values?.task?.v?.selected_option?.value;
        const tr = await db.query(`SELECT name FROM ad_hoc_tasks WHERE id = $1`, [taskId]);
        const picked = tr.rows[0]?.name || 'Outro';
        const desc = (view.state.values?.desc_outro?.v?.value || '').trim();
        // F5 — "Outro" + description → the description IS the task name.
        // findOrCreateAdHocTask creates it admin_approved=FALSE (pending);
        // alert admin so they can approve / merge / rename.
        if (/^outro$/i.test(picked) && desc) {
          await engine.startAdHocTask({
            taskName: desc, operatorId, createdByOperatorId: operatorId,
          });
          const opn = await db.query(`SELECT name FROM operators WHERE id = $1`, [operatorId]);
          try {
            await require('../workflow/announce').adHocPending({
              operatorName: opn.rows[0]?.name, taskName: desc,
            });
          } catch (e) { /* best-effort */ }
        } else {
          await engine.startAdHocTask({ taskName: picked, operatorId });
        }
        break;
      }
      case 'submit_start_batch': {
        const wtRaw = view.state.values?.wt?.v?.selected_option?.value;
        const phaseSel = view.state.values?.phase?.v?.selected_option?.value || null;
        const outroName = (view.state.values?.outro_name?.v?.value || '').trim();
        let wt, chosenPhaseTemplateId = null;
        const opNameRow = await db.query(`SELECT name FROM operators WHERE id = $1`, [operatorId]);
        const opName = opNameRow.rows[0]?.name;

        const { auditAction } = require('../admin/audit');
        // W4 — "Outro" workflow: create pending workflow_template + alert.
        if (wtRaw === '__outro__') {
          const ins = await db.query(
            `INSERT INTO workflow_templates (name, description, allows_product, is_active, pending_review)
             VALUES ($1, 'Criado via "Outro" no App Home — revisar', FALSE, TRUE, TRUE)
             ON CONFLICT (name) DO UPDATE SET pending_review = TRUE, updated_at = NOW()
             RETURNING id`, [outroName]);
          wt = ins.rows[0].id;
          await auditAction({ action: 'workflow_template.create', entityType: 'workflow_template',
                              entityId: wt, after: { name: outroName, pending_review: true }, source: 'app_home' });
          try { await require('../workflow/announce').adHocPending({ operatorName: opName, taskName: `workflow novo "${outroName}"` }); } catch (_) {}
        } else {
          wt = parseInt(wtRaw);
        }

        // W3 — specific phase "wfId:ptId" wins over the workflow select.
        if (phaseSel && /^\d+:\d+$/.test(phaseSel)) {
          const [pWf, pPt] = phaseSel.split(':').map(Number);
          wt = pWf; chosenPhaseTemplateId = pPt;
        } else if (phaseSel === '__outro__') {
          // W4 — "Outra fase": create pending phase_template under wt.
          const seqRow = await db.query(
            `SELECT COALESCE(MAX(sequence_order),0)+1 AS s FROM phase_templates WHERE workflow_template_id = $1`, [wt]);
          const insP = await db.query(
            `INSERT INTO phase_templates
               (workflow_template_id, name, sequence_order, is_required, soft_prereq, pending_review)
             VALUES ($1, $2, $3, FALSE, TRUE, TRUE) RETURNING id`,
            [wt, outroName || 'Outra fase', seqRow.rows[0].s]);
          chosenPhaseTemplateId = insP.rows[0].id;
          await auditAction({ action: 'phase_template.create', entityType: 'phase_template',
                              entityId: chosenPhaseTemplateId,
                              after: { name: outroName, workflow_template_id: wt, pending_review: true }, source: 'app_home' });
          try { await require('../workflow/announce').adHocPending({ operatorName: opName, taskName: `fase nova "${outroName}"` }); } catch (_) {}
        }
        const productSel = view.state.values?.product?.supplement_select?.selected_option?.value || null;
        const { name: product } = await resolveSupplementValue(productSel);
        const batch = view.state.values?.batch?.v?.value || null;
        const wf = await engine.findOrCreateWorkflowInstance({
          workflowTemplateId: wt, productName: product, batchNumber: batch,
          startedByOperatorId: operatorId,
        });
        // Open the chosen phase, or fall back to the first phase of the wf
        let phaseTemplateId = chosenPhaseTemplateId;
        if (!phaseTemplateId) {
          const ph = await db.query(
            `SELECT id FROM phase_templates WHERE workflow_template_id = $1
             ORDER BY sequence_order ASC, id ASC LIMIT 1`, [wt]);
          phaseTemplateId = ph.rows[0]?.id || null;
        }
        if (phaseTemplateId) {
          await engine.startPhase({
            workflowInstanceId: wf.workflowInstanceId,
            phaseTemplateId, operatorId, batchNumber: batch,
          });
        }
        break;
      }
      case 'submit_count': {
        const suppSel = view.state.values?.supp?.supplement_select?.selected_option?.value || null;
        const { name: suppName } = await resolveSupplementValue(suppSel);
        await engine.startAdHocTask({
          taskName: 'Reporte no sistema', operatorId,
          text: `${suppName || ''} ${view.state.values?.qty?.v?.value || ''}`,
        });
        break;
      }
      case 'submit_note': {
        // F2/F3 — persist to operator_notes (auto-linked to the author's
        // active phase) + announce. The old UPDATE-oal approach silently
        // lost the note when the operator had no open activity.
        const noteText = view.state.values?.text?.v?.value || '';
        if (noteText.trim()) {
          await engine.addNote({ operatorId, text: noteText });
        }
        break;
      }
    }

    // F4 — every other wizard carries an optional 'note' block. Persist
    // it via engine.addNote, which auto-links to whatever activity is
    // now active for this operator (the just-started phase/adhoc, or
    // the break for pausa/voltei). submit_note handles its own text.
    if (cb !== 'submit_note') {
      const f4 = (view.state.values?.note?.v?.value || '').trim();
      if (f4) {
        try { await engine.addNote({ operatorId, text: f4 }); }
        catch (e) { console.error('[Interactive] F4 note persist error:', e.message); }
      }
    }
  } catch (err) {
    console.error('[Interactive] engine error:', cb, err.message);
  }

  // Refresh the Home for the user who acted
  if (slackUser) home.publishHome(slackUser).catch(() => {});
}

async function handleInteraction(payload) {
  if (!payload || !payload.type) return;
  if (payload.type === 'block_actions')  return handleBlockAction(payload);
  if (payload.type === 'view_submission') return handleViewSubmission(payload);
}

module.exports = {
  handleInteraction, handleBlockAction, handleViewSubmission,
  resolveSupplementValue,
};
