'use strict';
/**
 * Entrega 3 Fase 8.1 — AI note classifier.
 *
 * When a production-channel message matches NO known parser pattern
 * (parsed.type === 'unknown'), this asks Haiku to classify it:
 *   intent: 'note' | 'casual_chat' | 'needs_action' | 'unknown_but_relevant'
 *   linked_to: phase_instance_id | workflow_instance_id | null
 *   suggested_action: string | null
 *   confidence: 'high' | 'medium' | 'low'
 *
 * Behavior (master doc §9 C3/C4/C5):
 *   - intent=note     & confidence>=medium → store as a note on the
 *                                            operator's current oal row
 *   - intent=needs_action OR confidence=low → alert admin chat with the
 *                                             original + interpretation
 *   - intent=casual_chat → ignore silently
 *
 * NEVER posts to the production channel. Admin chat only.
 *
 * Guarded: only runs when ANTHROPIC_API_KEY is set AND
 * AI_NOTE_CLASSIFIER_ENABLED !== '0'. Falls back to a cheap heuristic
 * when the API is unavailable so behavior is deterministic in tests and
 * when offline.
 */

const { withPersona } = require('./persona');

const SYSTEM_PROMPT = withPersona(`Você classifica mensagens do canal de produção de uma fábrica de
suplementos. Responda SOMENTE com JSON válido:
{"intent":"note|casual_chat|needs_action|unknown_but_relevant",
 "linked_to":null,"suggested_action":null,
 "confidence":"high|medium|low","reasoning":"curto"}
Regras: "bom dia", agradecimentos, conversa social = casual_chat.
Relato de problema/máquina parada/falta de material = needs_action.
Observação útil sobre o trabalho = note. Sem certeza = unknown_but_relevant.
Este é um classificador interno — o JSON não é visto pelo time, mas mantenha a persona caso gere texto.`, 'prod');

function heuristicClassify(text) {
  const t = (text || '').toLowerCase();
  if (/\b(bom dia|boa tarde|boa noite|obrigad|valeu|tchau|kk+|haha|rsrs)\b/.test(t)) {
    return { intent: 'casual_chat', linked_to: null, suggested_action: null, confidence: 'high', reasoning: 'saudação/conversa' };
  }
  if (/\b(parou|quebrou|travou|falta|acabou|problema|erro|defeito|nao funciona|não funciona|consert)\b/.test(t)) {
    return { intent: 'needs_action', linked_to: null,
             suggested_action: 'verificar relato de problema operacional',
             confidence: 'medium', reasoning: 'palavra de problema' };
  }
  if (t.length > 25) {
    return { intent: 'note', linked_to: null, suggested_action: null, confidence: 'medium', reasoning: 'texto substantivo' };
  }
  return { intent: 'unknown_but_relevant', linked_to: null, suggested_action: null, confidence: 'low', reasoning: 'curto/ambíguo' };
}

function isEnabled() {
  return !!process.env.ANTHROPIC_API_KEY && process.env.AI_NOTE_CLASSIFIER_ENABLED !== '0';
}

async function classify(text, ctx = {}) {
  if (!isEnabled()) return { ...heuristicClassify(text), source: 'heuristic' };
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Mensagem: """${String(text).slice(0, 800)}"""\n` +
          (ctx.operator ? `Operador: ${ctx.operator}\n` : '') +
          `Responda só o JSON.`,
      }],
    });
    const raw = msg.content?.[0]?.text || '{}';
    const j = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return {
      intent: j.intent || 'unknown_but_relevant',
      linked_to: j.linked_to || null,
      suggested_action: j.suggested_action || null,
      confidence: j.confidence || 'low',
      reasoning: j.reasoning || '',
      source: 'haiku',
    };
  } catch (err) {
    // API failure → deterministic heuristic, never throw
    return { ...heuristicClassify(text), source: 'heuristic_fallback', error: err.message };
  }
}

/**
 * Classify + act. Returns the action taken: 'noted' | 'admin_alerted'
 * | 'ignored'. Slack admin alerts go through slackClient.postToChannel
 * to managerChannelId (NOT silenced — silent mode only mutes the
 * production channel).
 */
async function classifyAndAct(parsed, rawMsg, deps = {}) {
  const db = deps.db || require('../db');
  const slackClient = deps.slackClient || require('../slack/client');
  const config = deps.config || require('../config');

  const text = rawMsg?.text || parsed?.raw || '';
  const r = await classify(text, { operator: parsed?.operator });

  if (r.intent === 'casual_chat') return { action: 'ignored', classification: r };

  if (r.intent === 'note' && (r.confidence === 'high' || r.confidence === 'medium')) {
    // Attach as a note on the operator's current oal row when resolvable
    if (parsed?.operator) {
      try {
        await db.query(
          `UPDATE operator_activity_log oal SET notes =
             COALESCE(oal.notes,'') || CASE WHEN oal.notes IS NULL OR oal.notes = '' THEN '' ELSE E'\\n' END || $1,
             updated_at = NOW()
           FROM operators o
           WHERE o.id = oal.operator_id AND LOWER(o.name) = LOWER($2)
             AND oal.ended_at IS NULL`,
          [text.slice(0, 500), parsed.operator]
        );
      } catch (_) { /* note is best-effort */ }
    }
    return { action: 'noted', classification: r };
  }

  // needs_action OR low confidence → admin chat (never production channel)
  try {
    await slackClient.postToChannel(
      config.slack.managerChannelId,
      `🧠 Mensagem não reconhecida pelo parser — classificada como *${r.intent}* (${r.confidence}).\n` +
      `Original: "${text.slice(0, 300)}"\n` +
      (r.suggested_action ? `Sugestão: ${r.suggested_action}\n` : '') +
      `_(${r.source})_`
    );
  } catch (_) { /* admin alert best-effort */ }
  return { action: 'admin_alerted', classification: r };
}

module.exports = { classify, classifyAndAct, heuristicClassify, isEnabled };
