'use strict';
/**
 * PRODUCTION TOTAL FOLLOW-UP (Bruno 07-27) — a linha de produção SEMPRE tem que
 * terminar com um total. Se o operador fecha sem número, isso NÃO pode sumir:
 *
 *  1) ao fechar sem total → abre um followup (v3.production_total_followups) e o
 *     sistema COMEÇA UMA CONVERSA no Slack (numa thread), não só um warning seco:
 *     "Simone, o que houve que nenhuma quantidade foi registrada? Precisamos
 *      sempre de um total. Pode me informar quantas você completou?"
 *  2) o worker (production-total-worker) FICA OUVINDO a thread: quando o operador
 *     responde, entende via LLM. Se veio um NÚMERO → registra o total e fecha.
 *     Se veio um motivo sem número → insiste 1x pedindo o número. Se responde algo
 *     que o sistema não sabe resolver → ESCALA pro admin (#admin-orin) investigar.
 *  3) enquanto aberto, aparece numa caixa persistente no dashboard admin. O admin
 *     também pode registrar o total manualmente (fecha o followup dos dois jeitos).
 *
 * O LLM é o mesmo do resto (getProductionProvider → Gemini no Railway hoje;
 * OMNIROUTE plugável depois). Ver [[clarification-chat-feature]].
 *
 * REGRAS DO BRUNO: linha de produção EXIGE número; sem número → motivo explícito e
 * claro. Horários de relógio nunca entram aqui. Nada de spam: 1 pergunta, insiste
 * no máximo o suficiente, depois escala — não fica repetindo pro operador.
 */

const MAX_OPERATOR_PROMPTS = 2;        // pergunta inicial + no MÁX 1 insistência antes de escalar
const REPROMPT_AFTER_MIN = 20;         // só re-cobra o operador depois de 20min de silêncio

/** Cria o followup + inicia a conversa no Slack. Chamado no close sem total. */
async function openFollowup({ db, slack, productionChannel, ev, reason, s, detail }) {
  if (!db) return null;
  // já existe followup aberto pra esse evento? (idempotente)
  const existing = await db.query(
    `SELECT id, thread_ts FROM v3.production_total_followups WHERE event_id=$1`, [ev.id]);
  if (existing.rows[0]) return existing.rows[0];

  const productName = detail.product || null;
  const batchNumber = detail.batch_number || null;
  const firstName = (detail.operator || s.display_name || '').split(/\s+/)[0] || 'você';

  // pergunta conversacional — calorosa mas firme, pedindo o NÚMERO.
  const question =
    `${slackWho(s, detail)}, fechou a linha` +
    (productName ? ` do ${productName}` : '') + (batchNumber ? ` (${batchNumber})` : '') + ' sem o total. ' +
    (reason ? `Vi o motivo "${reason}". ` : '') +
    `Quantas unidades você completou? Só o número. Se não souber agora, confere e me fala.`;

  let threadTs = null;
  try {
    const posted = await slack.postAs({
      channel: productionChannel,
      sender: { name: 'HealthFare Tracker', icon: ':package:' },
      thread_ts: null, text: question, unfurl_links: false, unfurl_media: false,
    });
    threadTs = (posted && (posted.ts || posted.message_ts)) || null;
  } catch (e) { console.error('[total-followup] pergunta inicial falhou:', e.message); }

  const ins = await db.query(
    `INSERT INTO v3.production_total_followups
       (event_id, person_id, person_name, slack_user_id, product_id, product_name,
        batch_number, close_reason, status, thread_ts, state, attempts, last_prompt_at, last_seen_ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,'awaiting_number',1,NOW(),$10)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING *`,
    [ev.id, s.person_id, detail.operator || s.display_name || null, s.slack_user_id || null,
     ev.product_id || null, productName, batchNumber, reason || null, threadTs, threadTs]);
  return ins.rows[0] || existing.rows[0] || null;
}

function slackWho(s, detail) {
  if (s && s.slack_user_id) return `<@${s.slack_user_id}>`;
  const nm = (detail && detail.operator) || (s && s.display_name) || 'operador(a)';
  return `*${nm}*`;
}

/**
 * Extrai um total de garrafas de uma resposta livre do operador, com ajuda do LLM.
 * Retorna { kind:'number', bottles } | { kind:'reason', text } | { kind:'unclear' }.
 * Determinístico primeiro (barato); LLM só quando o texto tem número ambíguo ou
 * palavras que sugerem um motivo.
 */
async function interpretReply({ provider, text, productName, batchNumber }) {
  const t = String(text || '').trim();
  if (!t) return { kind: 'unclear' };

  // Heurística rápida:
  // (a) "NNN bottles/garrafas/unidades" — o número IMEDIATAMENTE antes da unidade é o
  //     total, mesmo se o texto tiver outros números (dosagem "60mg", lote "0293").
  const unitMatch = t.match(/(\d[\d.,]*)\s*(bottles?|garrafas?|unidades?|frascos?|un\b|pcs|pe[çc]as)\b/i);
  if (unitMatch) {
    const n = parseInt(unitMatch[1].replace(/[.,]/g, ''), 10);
    if (Number.isFinite(n) && n > 0 && n < 1000000) return { kind: 'number', bottles: n };
  }
  // (b) mensagem que é SÓ um número ("176").
  const nums = (t.match(/\d[\d.,]*/g) || []).map((x) => parseInt(x.replace(/[.,]/g, ''), 10)).filter((n) => Number.isFinite(n));
  const onlyNumber = /^\s*\d[\d.,]*\s*$/.test(t);
  if (onlyNumber && nums.length === 1 && nums[0] > 0 && nums[0] < 1000000) {
    return { kind: 'number', bottles: nums[0] };
  }

  // Senão, pede pro LLM decidir (entende "passei só metade, deu 176", "não passei tudo", etc.)
  if (provider && provider.classifyRaw) {
    const sys =
      'Você interpreta a resposta de um operador de fábrica sobre QUANTAS UNIDADES (garrafas) ele produziu ' +
      'numa linha de produção. Responda SÓ um JSON: {"kind":"number","bottles":N} se a mensagem contém a ' +
      'contagem final; {"kind":"reason","reason":"..."} se ele deu uma explicação mas NÃO um número final; ' +
      '{"kind":"unclear"} se não dá pra saber. Nunca invente número. Se ele cita vários números (ex.: lote, ' +
      'mg do produto), escolha o que representa o TOTAL produzido, não a dosagem nem o número do lote.';
    const user =
      `Produto: ${productName || '?'} · Lote: ${batchNumber || '?'}\nResposta do operador: "${t}"\n` +
      'Qual o total de unidades? Devolva o JSON.';
    try {
      const r = await provider.classifyRaw(sys, user, { maxTokens: 200, temperature: 0 });
      const j = r && r.json_parsed;
      if (j && j.kind === 'number' && Number.isFinite(Number(j.bottles)) && Number(j.bottles) > 0) {
        return { kind: 'number', bottles: Math.round(Number(j.bottles)) };
      }
      if (j && j.kind === 'reason') return { kind: 'reason', text: j.reason || t };
      return { kind: 'unclear' };
    } catch (e) {
      console.error('[total-followup] LLM interpret falhou:', e.message);
      // fallback: se tinha um único número, aceita; senão unclear
      if (nums.length === 1 && nums[0] > 0) return { kind: 'number', bottles: nums[0] };
      return { kind: 'unclear' };
    }
  }
  if (nums.length === 1 && nums[0] > 0) return { kind: 'number', bottles: nums[0] };
  return { kind: 'unclear' };
}

module.exports = { openFollowup, interpretReply, MAX_OPERATOR_PROMPTS, REPROMPT_AFTER_MIN };
