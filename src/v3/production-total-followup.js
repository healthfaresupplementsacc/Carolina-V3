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

/* O MOTIVO JA EXPLICA A FALTA DO TOTAL? (Bruno 10-03: "stop this warning, he
 * already said it was made by mistake"). Historico: 8 cobrancas desde agosto,
 * ZERO viraram numero, todas descartadas, porque o operador ja tinha dito que a
 * tarefa foi aberta por engano (produto/lote/tarefa errada), que nao foi ele,
 * que a linha ainda esta rodando ou que outra pessoa fechou/contou. Perguntar
 * "quantas unidades?" pra quem disse "nao fui eu" so parece bot confuso.
 * Motivo vazio ou lixo ("aaaaaaa") continua sendo cobrado: ai sim falta tudo. */
const REASON_EXPLAINS_RE = new RegExp([
  'errad[oa]', 'engano', 'sem querer', 'erroneament', 'atrapalh',
  'n[aã]o (estou|estava|fui|era|foi|fiquei|iniciad|comec|come[cç]ou|passou|passad|termin|finaliz|colocad)',
  'nem estava', 'n[aã]o (estou|estava) (em|na) linha',
  'ainda (est[aá]|ta|t[aá] )', 'ainda n[aã]o', 'continua(r|ndo)?', 'dando continuidade', 'assumiu', 'assumiram',
  'outra pessoa', 'j[aá] (coloquei|lancei|registrei|est[aá] na aba)', 'na aba anterior', 'lan[cç]ou no login',
  'almo[cç]o', 'pausa', 'fnsku', 'fnusku', 'revis(ao|ão|ando)', 'tarefa (aberta )?errada', 'lote errado', 'produto errado',
  'abri (a )?tarefa', 'abertura errada', 'abriu duas vezes', 'n[aã]o consegui',
  'parando', 'saindo', 'vou para', 'fui (pegar|falar)', 'depois so quando', 'nao finalizado',
].join('|'), 'i');
function reasonExplainsNoTotal(reason) {
  const r = String(reason || '').trim();
  if (r.length < 10) return false;                              // vazio/curto: nao explica nada
  const compact = r.replace(/\s/g, '');
  if (/^(.)\1{5,}$/.test(compact)) return false;                // "aaaaaaaa": lixo, cobra
  if (!/[aeiouáéíóúãõ]/i.test(r) || !/\s/.test(r)) return false; // sem vogal ou palavra unica: lixo
  return REASON_EXPLAINS_RE.test(r);
}

/** Cria o followup + inicia a conversa no Slack. Chamado no close sem total.
 *  Devolve null SEM postar nada quando o motivo ja explica (ver acima): a
 *  excecao continua gravada no evento (exception_reason) e visivel no admin. */
async function openFollowup({ db, slack, productionChannel, ev, reason, s, detail }) {
  if (!db) return null;
  if (reasonExplainsNoTotal(reason)) {
    try {
      await db.query("INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata) VALUES ('system', NULL, 'production.total_followup.skipped', 'event', $1, $2::jsonb)",
        [ev.id, JSON.stringify({ reason: String(reason).slice(0, 300), why: 'motivo ja explica a falta do total (Bruno 10-03)' })]);
    } catch (_) { /* audit nunca derruba */ }
    return null;
  }
  // já existe followup aberto pra esse evento? (idempotente)
  const existing = await db.query(
    `SELECT id, thread_ts FROM v3.production_total_followups WHERE event_id=$1`, [ev.id]);
  if (existing.rows[0]) return existing.rows[0];

  const productName = detail.product || null;
  const batchNumber = detail.batch_number || null;

  // pergunta conversacional — calorosa mas firme, pedindo o NÚMERO.
  const question =
    `${slackWho(s, detail)}, fechou a linha` +
    (productName ? ` do ${productName}` : '') + (batchNumber ? ` (${batchNumber})` : '') + ' sem o total. ' +
    (reason ? `Vi o motivo "${reason}". ` : '') +
    `Quantas unidades você completou? Só o número. Se não souber agora, confere e me fala.`;

  // TRAVA (Bruno 10-04): a pergunta NAO vai pro grupo daqui. Fica retida no
  // admin-orin com a prova; se um admin reagir ✅, o gate posta e abre o followup
  // (thread_ts = a msg aprovada). Sem ✅ nao existe cobranca.
  const gate = require('./accusation-gate');
  const adminChannelId = process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1';
  const proof = `evento ${ev.id} fechado sem total; motivo digitado: "${reason || '(nenhum)'}"; produto ${productName || '?'}; lote ${batchNumber || '?'}`;
  const held = await gate.holdForAdmin({
    db, slack, adminChannelId, productionChannelId: productionChannel,
    kind: 'total de producao', person: { id: s.person_id, display_name: detail.operator || s.display_name || null, slack_user_id: s.slack_user_id || null },
    groupText: question, proof,
    onApprove: { type: 'total_followup', event_id: ev.id, person_id: s.person_id, person_name: detail.operator || s.display_name || null,
                 slack_user_id: s.slack_user_id || null, product_id: ev.product_id || null, product_name: productName, batch_number: batchNumber, close_reason: reason || null },
  });
  try {
    await db.query("INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata) VALUES ('system', NULL, 'production.total_followup.held', 'event', $1, $2::jsonb)",
      [ev.id, JSON.stringify({ held: !!held.held, admin_msg_ts: held.msg_ts || null, reason: held.reason || null })]);
  } catch (_) {}
  return null;
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

module.exports = { openFollowup, interpretReply, reasonExplainsNoTotal, MAX_OPERATOR_PROMPTS, REPROMPT_AFTER_MIN };
