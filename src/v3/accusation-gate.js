'use strict';
/**
 * TRAVA DE ACUSAÇÃO (Bruno 10-04, depois do caso Vitor: "make sure this won't
 * happen again, I wanna trust you").
 *
 * REGRA: NENHUMA automação nomeia um funcionário por uma falta no canal dos
 * operadores sem o Bruno aprovar antes. O texto que IRIA pro grupo vai primeiro
 * pra DM DO BRUNO (Bruno 10-04: "sem passar por mim por DM; o admin-orin tá
 * cheio de spam, ninguém olha mais"), com a PROVA ao lado (batidas, horários,
 * fonte), e só sai no grupo se ele reagir ✅. ❌ descarta. Sem reação = não sai.
 * Fallback pro admin-orin SÓ se a DM falhar (e avisando que falhou).
 *
 * Vale pra ponto (aviso do dia seguinte), checkout esquecido, total de produção
 * e qualquer aviso novo que cite nome. Mesmo depois de dias sem falso positivo.
 *
 * Histórico que justifica: 10-04 o aviso de ponto acusou o Vitor de uma saída
 * que ele bateu (16:32, NGTeco e att_state concordavam) e o Bruno defendeu o
 * sistema na frente dele. Antes disso: falso "não bateu o almoço" da Simone
 * (09-28), Carol respondendo o Henrique errado (09-07), 151 msgs vazias no
 * admin-orin (09-07). Padrão: automação falando em público sem certeza.
 *
 * Mecânica: v3.notifications type='accusation_hold' (payload = texto do grupo,
 * prova, on_approve). events-v2 escuta a reação ✅/❌ de admin na msg do
 * admin-orin e chama resolveHold().
 */

const BOT = { name: 'HealthFare Tracker', icon: ':shield:' };
const YES = ['white_check_mark', '+1', 'heavy_check_mark'];
const NO = ['x', 'no_entry_sign', 'red_circle'];

/**
 * Segura o aviso: posta no admin-orin e grava a notificação pendente.
 *  kind        'punch_nextday' | 'forgot_checkout' | 'production_total' | ...
 *  person      { id, display_name, slack_user_id? }
 *  groupText   o texto EXATO que iria pro canal dos operadores
 *  proof       string curta com a evidência (batidas, horários, fonte)
 *  onApprove   { type, ...dados } efeito colateral só se aprovado (opcional)
 * Devolve { held:true, msg_ts } ou { held:false, reason }.
 */
const BRUNO = process.env.BRUNO_USER_ID || 'U03URLL1D4L';

async function holdForAdmin({ db, slack, adminChannelId, productionChannelId, kind, person, groupText, proof, onApprove, audit, approverUserId }) {
  if (!db || !slack || !(slack.postDm || slack.postAs)) return { held: false, reason: 'sem db/slack' };
  const who = person && person.display_name ? person.display_name : 'funcionário';
  const approver = approverUserId || BRUNO;
  const text =
    `:shield: *AVISO RETIDO* (${kind}) sobre *${who}*. Só sai no grupo se você reagir :white_check_mark: nesta mensagem; :x: descarta. Sem reação, não sai.\n` +
    `> ${String(groupText).replace(/\n/g, '\n> ')}\n` +
    (proof ? `Prova: ${proof}` : 'Prova: (não informada)');
  let ts = null; let channel = null;
  // 1) DM do Bruno (canal certo). 2) se a DM falhar, admin-orin dizendo que a DM falhou.
  if (slack.postDm) {
    try {
      const r = await slack.postDm({ userId: approver, sender: BOT, text });
      ts = (r && (r.ts || r.message_ts)) || null; channel = (r && r.channel) || null;
    } catch (e) { console.error('[accusation-gate] DM falhou:', e.message); }
  }
  if (!ts && slack.postAs && adminChannelId) {
    try {
      const r = await slack.postAs({ channel: adminChannelId, sender: BOT, thread_ts: null, unfurl_links: false, unfurl_media: false, text: ':warning: (DM do Bruno falhou, caiu aqui) ' + text });
      ts = (r && (r.ts || r.message_ts)) || null; channel = adminChannelId;
    } catch (e) { return { held: false, reason: 'DM e admin-orin falharam: ' + e.message }; }
  }
  if (!ts) return { held: false, reason: 'nenhum canal aceitou a retencao' };
  const payload = {
    msg_ts: ts, channel, approver, target_channel: productionChannelId, kind,
    person_id: person && person.id, display_name: who, slack_user_id: (person && person.slack_user_id) || null,
    group_text: groupText, proof: proof || null, on_approve: onApprove || null,
  };
  await db.query(`INSERT INTO v3.notifications (type, payload, status) VALUES ('accusation_hold', $1::jsonb, 'pending')`, [JSON.stringify(payload)]);
  if (audit) { try { await audit('accusation.held', person && person.id, { kind, msg_ts: ts, channel, proof: proof || null }); } catch (_) {} }
  return { held: true, msg_ts: ts, channel };
}

/** Admin reagiu. approved=true → posta no grupo e aplica on_approve; false → descarta. */
async function resolveHold({ db, slack, notification, approved, reactorSlackUserId }) {
  const pay = notification.payload || {};
  await db.query(`UPDATE v3.notifications SET status=$2, resolved_at=NOW(), admin_response_text=$3 WHERE id=$1`,
    [notification.id, approved ? 'admin_accepted' : 'admin_rejected', reactorSlackUserId || null]);
  let groupTs = null;
  if (approved && slack && slack.postAs && pay.group_text) {
    try {
      const r = await slack.postAs({ channel: pay.target_channel, sender: { name: 'HealthFare Tracker', icon: ':alarm_clock:' }, thread_ts: null, unfurl_links: false, unfurl_media: false, text: pay.group_text });
      groupTs = (r && (r.ts || r.message_ts)) || null;
    } catch (e) { console.error('[accusation-gate] post no grupo falhou:', e.message); }
  }
  const oa = pay.on_approve || {};
  try {
    if (oa.type === 'punch_occurrence') {
      if (approved) {
        await db.query(`UPDATE v3.punch_occurrence SET notified_at=NOW(), notify_ts=$3 WHERE person_id=$1 AND occ_date=$2::date`, [oa.person_id, oa.occ_date, groupTs]);
      } else {
        await db.query(`DELETE FROM v3.punch_occurrence WHERE person_id=$1 AND occ_date=$2::date AND notified_at IS NULL`, [oa.person_id, oa.occ_date]);
      }
    } else if (oa.type === 'total_followup' && approved) {
      await db.query(
        `INSERT INTO v3.production_total_followups
           (event_id, person_id, person_name, slack_user_id, product_id, product_name, batch_number, close_reason, status, thread_ts, state, attempts, last_prompt_at, last_seen_ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,'awaiting_number',1,NOW(),$9)
         ON CONFLICT (event_id) DO NOTHING`,
        [oa.event_id, oa.person_id, oa.person_name || null, oa.slack_user_id || null, oa.product_id || null, oa.product_name || null, oa.batch_number || null, oa.close_reason || null, groupTs]);
    }
  } catch (e) { console.error('[accusation-gate] on_approve falhou:', e.message); }
  try {
    await db.query(`INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata) VALUES ('admin', NULL, $1, 'person', $2, $3::jsonb)`,
      [approved ? 'accusation.approved' : 'accusation.dismissed', pay.person_id || null, JSON.stringify({ kind: pay.kind, admin_msg_ts: pay.msg_ts, group_ts: groupTs, reactor: reactorSlackUserId || null })]);
  } catch (_) {}
  return { approved, group_ts: groupTs };
}

/** Pra events-v2: acha a notificação pendente pela msg reagida. */
async function findPendingByTs(db, ts) {
  const r = await db.query(`SELECT id, payload FROM v3.notifications WHERE type='accusation_hold' AND status='pending' AND payload->>'msg_ts'=$1 LIMIT 1`, [ts]);
  return r.rows[0] || null;
}

const isYes = (emoji) => YES.includes(emoji);
const isNo = (emoji) => NO.includes(emoji);

module.exports = { holdForAdmin, resolveHold, findPendingByTs, isYes, isNo };
