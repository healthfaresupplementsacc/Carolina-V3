'use strict';
/**
 * HEALTHFARE — confirmação de tarefas automáticas do EMS (Bruno 07-18).
 *
 * REGRA (do Bruno): SEMPRE desconfiar de auto-task do EMS. Fluxo:
 *  1. Task auto de quem NÃO fez check-in manual nasce em `v3.ems_unconfirmed` (o
 *     worker faz isso). A pessoa não conta como presente (ver presence.js).
 *  2. Escalonamento: após ESCALATE_MIN (1h30) sem check-in do "suspeito", vira
 *     'questionable' → pode perguntar.
 *  3. Quem perguntar PRIMEIRO:
 *     - o OUTRO operador de formulação, SE presente hoje (check-in manual) → pergunta
 *       de ADJACÊNCIA: "a pesagem do X (lote Y) foi você ou o Fulano?".
 *     - senão, QUALQUER funcionário que logar → pergunta de PRESENÇA: "o Fulano está
 *       trabalhando hoje?". Continua perguntando cada um até alguém responder.
 *     - se NINGUÉM está trabalhando → grito no #admin-orin (feito pelo worker de tick).
 *  4. Resposta é AUTORITATIVA:
 *     - 'me' / 'other' → reatribui o evento; confirma; Slack agradecendo.
 *     - 'subject' / presença 'sim' → confirma no suspeito (era ele mesmo).
 *     - 'not_working' → move TODAS as unconfirmed do suspeito hoje pro operador de
 *       formulação real (auto se só houver um); Slack.
 *  5. Todo fix avisa no #admin-orin; se veio de um funcionário, explica no canal dos
 *     operadores e agradece.
 */

const ESCALATE_MIN = parseInt(process.env.EMS_CONFIRM_ESCALATE_MIN, 10) || 90; // 1h30
const ADJ_WINDOW_MIN = 30;   // "adjacente" = evento manual no mesmo lote ±30min
const FORMULATION_SLUGS = ['weighing', 'mixing', 'encapsulation'];
const { hasManualCheckinToday, EDT } = require('./presence');

/** Marca como 'questionable' os incidentes 'pending' cujo suspeito não fez check-in
 *  e já passaram ESCALATE_MIN. Retorna as linhas recém-escaladas. */
async function escalate(db) {
  const rows = (await db.query(
    `SELECT u.* FROM v3.ems_unconfirmed u
      WHERE u.status = 'pending'
        AND u.since < NOW() - INTERVAL '${ESCALATE_MIN} minutes'`)).rows;
  const escalated = [];
  for (const u of rows) {
    // se o suspeito acabou fazendo check-in manual entretanto → confirma (era ele)
    if (await hasManualCheckinToday(db, u.subject_person_id)) {
      await db.query(`UPDATE v3.ems_unconfirmed SET status='confirmed', resolved_answer='subject', resolved_at=NOW(), updated_at=NOW() WHERE id=$1`, [u.id]);
      continue;
    }
    // o evento ainda existe e ainda é ems_auto do suspeito?
    const ev = (await db.query(`SELECT id, person_id, ended_at FROM v3.events WHERE id=$1 AND deleted_at IS NULL`, [u.event_id])).rows[0];
    if (!ev || ev.person_id !== u.subject_person_id) {
      await db.query(`UPDATE v3.ems_unconfirmed SET status='dismissed', resolved_at=NOW(), updated_at=NOW() WHERE id=$1`, [u.id]);
      continue;
    }
    await db.query(`UPDATE v3.ems_unconfirmed SET status='questionable', updated_at=NOW() WHERE id=$1`, [u.id]);
    escalated.push(u);
  }
  return escalated;
}

/** Os operadores de FORMULAÇÃO (máquina). */
async function formulationOperators(db) {
  return (await db.query(
    `SELECT id, display_name, slack_user_id FROM v3.persons
      WHERE is_machine_operator = true AND active = true AND deleted_at IS NULL
        AND COALESCE(is_sandbox,false) = false`)).rows;
}

/** Existe um evento MANUAL do operador `askerId` no mesmo lote, adjacente (±30min)
 *  ao evento suspeito? Se sim, dá pra fazer a pergunta de adjacência. */
async function isAdjacent(db, askerId, unconf) {
  if (!unconf.batch_number) return false;
  const r = await db.query(
    `SELECT 1 FROM v3.events e
       JOIN v3.product_batches pb ON pb.id = e.product_batch_id
      WHERE e.person_id = $1 AND e.deleted_at IS NULL AND e.source NOT IN ('ems_auto')
        AND (pb.batch_number = $2 OR pb.batch_number = 'BR-2026-' || $2)
        AND e.started_at BETWEEN (SELECT started_at FROM v3.events WHERE id=$3) - INTERVAL '${ADJ_WINDOW_MIN} minutes'
                             AND (SELECT started_at FROM v3.events WHERE id=$3) + INTERVAL '${ADJ_WINDOW_MIN} minutes'
      LIMIT 1`, [askerId, unconf.batch_number, unconf.event_id]);
  return r.rowCount > 0;
}

/**
 * Próxima pergunta pendente pro operador `askerId` (que acabou de logar). Escolhe:
 *  - primeiro incidentes 'questionable' cujo suspeito != asker e que o asker ainda
 *    não pulou hoje;
 *  - se o asker é o OUTRO operador de formulação presente → pergunta de adjacência
 *    (se adjacente) ou presença;
 *  - senão pergunta de presença.
 * Retorna { unconfirmed_id, kind:'adjacency'|'presence', subject, batch_number,
 *           product_name, stage } ou null.
 */
async function nextQuestionFor(db, askerId) {
  const open = (await db.query(
    `SELECT u.* FROM v3.ems_unconfirmed u
      WHERE u.status = 'questionable'
        AND u.subject_person_id <> $1
        AND NOT ($1 = ANY(u.skipped_by))
      ORDER BY u.since ASC`, [askerId])).rows;
  if (!open.length) return null;

  const asker = (await db.query('SELECT id, is_machine_operator FROM v3.persons WHERE id=$1', [askerId])).rows[0];
  const askerIsFormulation = !!(asker && asker.is_machine_operator);

  for (const u of open) {
    const subject = (await db.query('SELECT id, display_name FROM v3.persons WHERE id=$1', [u.subject_person_id])).rows[0];
    if (!subject) continue;
    // REGRA: se há OUTRO operador de formulação presente e NÃO é o asker, a pergunta
    // de adjacência é preferencialmente pra ELE. Mas se o asker É formulação e é
    // adjacente, pergunta agora. Caso contrário, presença serve pra qualquer um.
    let kind = 'presence';
    if (askerIsFormulation && await isAdjacent(db, askerId, u)) kind = 'adjacency';
    return {
      unconfirmed_id: u.id,
      kind,
      subject: { id: subject.id, name: subject.display_name },
      batch_number: u.batch_number,
      product_name: u.product_name,
      stage: u.stage,
      slug: u.slug,
    };
  }
  return null;
}

/** Marca que `askerId` pulou (disse "não sei") um incidente — não repergunta pra ele. */
async function skip(db, unconfirmedId, askerId) {
  await db.query(
    `UPDATE v3.ems_unconfirmed
        SET skipped_by = (SELECT ARRAY(SELECT DISTINCT unnest(skipped_by || $2::int))),
            asked_count = asked_count + 1, last_asked_at = NOW(), updated_at = NOW()
      WHERE id = $1`, [unconfirmedId, askerId]);
}

/**
 * Aplica uma resposta. answer ∈ 'me'|'subject'|'not_working'|'other'.
 * Retorna { moved:[{event_id,to}], subject, to_person, reason } pra o Slack.
 * NÃO posta Slack aqui (o caller decide o canal) — devolve o resumo.
 */
async function applyAnswer(db, { unconfirmedId, askerId, answer, otherPersonId, note }) {
  const u = (await db.query('SELECT * FROM v3.ems_unconfirmed WHERE id=$1', [unconfirmedId])).rows[0];
  if (!u) throw new Error('incidente não existe');
  if (u.status === 'confirmed' || u.status === 'reassigned' || u.status === 'dismissed') {
    return { already: true, status: u.status };
  }
  const subject = (await db.query('SELECT id, display_name FROM v3.persons WHERE id=$1', [u.subject_person_id])).rows[0];
  const asker = (await db.query('SELECT id, display_name FROM v3.persons WHERE id=$1', [askerId])).rows[0];

  const moveEvent = async (eventId, toPersonId) => {
    const before = (await db.query('SELECT * FROM v3.events WHERE id=$1', [eventId])).rows[0];
    if (!before) return null;
    await db.query(
      `UPDATE v3.events SET person_id=$2, confidence='high',
         bg_handoff_from_person_id = CASE WHEN bg_handoff_from_person_id=$2 THEN NULL ELSE bg_handoff_from_person_id END,
         description = description || $3, updated_at=NOW()
       WHERE id=$1`, [eventId, toPersonId, ' [confirmado por ' + (asker ? asker.display_name : '?') + ']']);
    const after = (await db.query('SELECT * FROM v3.events WHERE id=$1', [eventId])).rows[0];
    await db.query(
      `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data, metadata)
       VALUES ('operator_page', $4, 'event.reassign_confirmed', 'event', $1, $2::jsonb, $3::jsonb, $5::jsonb)`,
      [eventId, JSON.stringify(before), JSON.stringify(after), askerId, JSON.stringify({ answer, note: note || null })]);
    return { event_id: eventId, to: toPersonId };
  };

  const moved = [];
  let toPerson = null;
  let reason = answer;

  if (answer === 'subject') {
    // era ele mesmo → confirma; conta como presente daqui pra frente
    await db.query(`UPDATE v3.ems_unconfirmed SET status='confirmed', resolved_by_person_id=$2, resolved_answer='subject', resolved_at=NOW(), updated_at=NOW() WHERE id=$1`, [unconfirmedId, askerId]);
    return { confirmedSubject: true, subject };
  }

  if (answer === 'me') { toPerson = asker; }
  else if (answer === 'other' && otherPersonId) { toPerson = (await db.query('SELECT id, display_name FROM v3.persons WHERE id=$1', [otherPersonId])).rows[0]; }
  else if (answer === 'not_working') {
    // move TODAS as unconfirmed do suspeito HOJE pro operador de formulação real
    const ops = (await formulationOperators(db)).filter((o) => o.id !== u.subject_person_id);
    // "operador real" = o único outro de formulação; se >1, usa o asker se for formulação, senão o primeiro
    toPerson = ops.length === 1 ? ops[0]
      : (asker && ops.find((o) => o.id === asker.id)) || ops[0] || null;
  }

  if (!toPerson) throw new Error('não consegui determinar pra quem mover');

  if (answer === 'not_working') {
    // todas as unconfirmed abertas do suspeito hoje
    const all = (await db.query(
      `SELECT * FROM v3.ems_unconfirmed
        WHERE subject_person_id = $1 AND status IN ('pending','questionable')
          AND (since AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date`, [u.subject_person_id])).rows;
    for (const row of all) {
      const m = await moveEvent(row.event_id, toPerson.id);
      if (m) moved.push(m);
      await db.query(`UPDATE v3.ems_unconfirmed SET status='reassigned', resolved_by_person_id=$2, resolved_answer=$3, resolved_at=NOW(), updated_at=NOW() WHERE id=$1`, [row.id, askerId, answer]);
    }
  } else {
    const m = await moveEvent(u.event_id, toPerson.id);
    if (m) moved.push(m);
    await db.query(`UPDATE v3.ems_unconfirmed SET status='reassigned', resolved_by_person_id=$2, resolved_answer=$3, resolved_at=NOW(), updated_at=NOW() WHERE id=$1`, [unconfirmedId, askerId, answer]);
  }

  return { moved, subject, to_person: toPerson, asker, reason };
}

module.exports = {
  ESCALATE_MIN, FORMULATION_SLUGS,
  escalate, nextQuestionFor, applyAnswer, skip, formulationOperators, isAdjacent,
};
