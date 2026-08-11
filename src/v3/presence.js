'use strict';
/**
 * HEALTHFARE — presença REAL de um operador (Bruno 07-18).
 *
 * O problema: o EMS às vezes atribui trabalho a alguém que NÃO está trabalhando
 * (ex.: login errado no EMS, lote atribuído à pessoa errada). O tracker espelhava
 * isso e passava a tratar a pessoa como "presente" — virava alvo de handoff de
 * máquina, de alarme de ausência, etc. (caso Bruno 18/07).
 *
 * REGRA: uma pessoa só conta como PRESENTE hoje se tem prova HUMANA de presença:
 *   - uma sessão de login (operator_sessions) hoje, OU
 *   - um evento hoje que NÃO seja uma task automática do EMS ainda NÃO confirmada.
 * Ou seja: uma task `ems_auto` presa em `v3.ems_unconfirmed` (status pending/
 * questionable) NÃO prova presença. Assim que alguém confirma ("foi ele mesmo"),
 * a linha sai de unconfirmed e a presença passa a valer.
 *
 * Exporta um FRAGMENTO SQL reutilizável (não uma query pronta) pra plugar dentro
 * das queries existentes de handoff/idle/ausência sem duplicar lógica.
 */

const EDT = 'America/New_York';

/**
 * Fragmento SQL booleano: "a pessoa <alias>.id conta como presente hoje?".
 * Usa EXISTS correlacionados. Passe o alias da tabela persons (ex.: 'p').
 * NÃO inclui checagem de almoço/end_of_day — isso é responsabilidade de quem chama
 * (findMachineRecv já filtra pausa/almoço/EoD por fora).
 */
function confirmedPresenceSQL(personAlias = 'p') {
  const a = personAlias;
  // Prova de presença REAL:
  //   - sessão de login hoje, OU
  //   - um evento hoje que NÃO seja `ems_auto` (auto-task do EMS NUNCA prova presença
  //     sozinha — o EMS pode atribuir a quem não está aqui). Só quando a pessoa tem
  //     OUTRA prova (login/evento manual) as auto-tasks passam a valer.
  // Robusto por design: não depende da linha em ems_unconfirmed existir (evita corrida
  // entre criar o evento e registrar o unconfirmed).
  return `(
    EXISTS (
      SELECT 1 FROM v3.operator_sessions s
       WHERE s.person_id = ${a}.id
         AND (s.created_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
    )
    OR EXISTS (
      SELECT 1 FROM v3.events e
       WHERE e.person_id = ${a}.id AND e.deleted_at IS NULL
         AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
         AND e.source <> 'ems_auto'
    )
  )`;
}

/**
 * Versão booleana em JS pra um person_id específico (quando não dá pra plugar SQL).
 * @returns {Promise<boolean>}
 */
async function isPresentToday(db, personId) {
  if (!personId) return false;
  const r = await db.query(
    `SELECT (
       EXISTS (SELECT 1 FROM v3.operator_sessions s
                WHERE s.person_id = $1
                  AND (s.created_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date)
       OR EXISTS (SELECT 1 FROM v3.events e
                   WHERE e.person_id = $1 AND e.deleted_at IS NULL
                     AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
                     AND e.source <> 'ems_auto')
     ) AS present`, [personId]);
  return !!(r.rows[0] && r.rows[0].present);
}

/**
 * Fez check-in MANUAL hoje? (login OU evento não-automático). Usado pelo worker EMS
 * pra decidir se uma auto-task precisa de confirmação. Difere de isPresentToday por
 * exigir prova manual pura (não olha ems_unconfirmed — é a montante disso).
 * @returns {Promise<boolean>}
 */
async function hasManualCheckinToday(db, personId) {
  if (!personId) return false;
  const r = await db.query(
    `SELECT (
       EXISTS (SELECT 1 FROM v3.operator_sessions s
                WHERE s.person_id = $1
                  AND (s.created_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date)
       OR EXISTS (SELECT 1 FROM v3.events e
                   WHERE e.person_id = $1 AND e.deleted_at IS NULL
                     AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
                     AND e.source NOT IN ('ems_auto'))
     ) AS manual`, [personId]);
  return !!(r.rows[0] && r.rows[0].manual);
}

module.exports = { confirmedPresenceSQL, isPresentToday, hasManualCheckinToday, EDT };
