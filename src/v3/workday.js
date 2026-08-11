'use strict';
/**
 * HEALTHFARE — Modo SOB DEMANDA (fim de semana / dias sem escala). Bruno 07-11.
 *
 * Sábado e domingo (e qualquer dia SEM escala fixa cadastrada) o sistema DORME:
 * câmeras desligadas, sem cobrança de alarme. Ele LIGA o dia quando:
 *   (a) alguém faz check-in / registra trabalho, OU
 *   (b) o admin anuncia no chat do admin ("Vitor trabalha amanhã 9:30–18h").
 *
 * Com o dia ligado: os alarmes voltam a valer, com ATENÇÃO DOBRADA (idle mais
 * curto + mais frequente — sábado eles enrolam e não marcam), e a IA pergunta o
 * horário de saída no chat do admin (pra saber até quando cobrar). O "plano do
 * dia" (horário de saída) fica em v3.settings, key='workday_plan', só vale se a
 * data == hoje. Ver [[clarification]] / horário fixo em operator_schedules.
 */
const EDT = 'America/New_York';
const PLAN_KEY = 'workday_plan';

/** { d: 'YYYY-MM-DD', dow: 0..6 } no fuso da fábrica. */
async function nyToday(db) {
  const r = await db.query(
    `SELECT (NOW() AT TIME ZONE '${EDT}')::date::text AS d, EXTRACT(DOW FROM (NOW() AT TIME ZONE '${EDT}'))::int AS dow`);
  return r.rows[0];
}

/** Hoje NÃO tem escala fixa? (nenhum operador escalado pra este dia da semana). */
async function isUnscheduledDay(db) {
  const r = await db.query(
    `SELECT NOT EXISTS (
       SELECT 1 FROM v3.operator_schedules
        WHERE is_workday = true AND expected_start_time IS NOT NULL
          AND day_of_week = EXTRACT(DOW FROM (NOW() AT TIME ZONE '${EDT}'))::int
     ) AS unscheduled`);
  return !!(r.rows[0] && r.rows[0].unscheduled);
}

/**
 * Tem trabalho de verdade hoje? = evento não-teste começado HOJE, OU uma sessão de
 * operador aberta que foi CRIADA HOJE e com atividade recente. NÃO basta
 * `logged_out_at IS NULL` sozinho — o kiosk mantém a sessão viva pelo heartbeat
 * mesmo sem ninguém, então uma sessão de sexta faria o fds "acordar" o fim de
 * semana todo (câmeras + alarmes). Mesmo aprendizado do anyonePresent (alert-gate).
 */
async function hasActivityToday(db) {
  const r = await db.query(
    `SELECT (
       EXISTS (SELECT 1 FROM v3.events e WHERE e.deleted_at IS NULL AND COALESCE(e.is_test,false)=false
               AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
               AND e.source <> 'ems_auto')  -- Bruno 07-18: task auto do EMS não acorda o fds sozinha
       OR EXISTS (SELECT 1 FROM v3.operator_sessions s JOIN v3.persons p ON p.id=s.person_id
               WHERE p.role='operator' AND p.active = true AND COALESCE(p.is_sandbox,false)=false
                 AND s.logged_out_at IS NULL
                 AND (s.created_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
                 AND s.last_activity_at > NOW() - INTERVAL '3 hours')
     ) AS active`);
  return !!(r.rows[0] && r.rows[0].active);
}

/** Plano do dia (horário de saída etc.) — só vale se a data salva == hoje. */
async function getPlan(db) {
  try {
    const t = await nyToday(db);
    const r = await db.query('SELECT value FROM v3.settings WHERE key=$1', [PLAN_KEY]);
    const v = r.rows[0] && r.rows[0].value;
    if (!v || v.date !== t.d) return null;
    return v; // { date, end:'HH:MM'|null, start:'HH:MM'|null, note, by }
  } catch (_) { return null; }
}

async function setPlan(db, { date, end = null, start = null, note = null, by = null }) {
  const val = JSON.stringify({ date, end, start, note, by });
  await db.query(
    `INSERT INTO v3.settings (key, value, description)
       VALUES ($1, $2::jsonb, 'plano do dia sob demanda (fds/on-demand) — horário de saída, Bruno 07-11')
     ON CONFLICT (key) DO UPDATE SET value=$2::jsonb, updated_at=NOW()`, [PLAN_KEY, val]);
}

/**
 * O modo sob demanda está ATIVO agora? = dia sem escala fixa E (alguém trabalhando
 * hoje OU o admin já anunciou um plano pra hoje). Em dia de escala fixa → false
 * (o fluxo normal cuida). Best-effort: erro de DB → false (não liga nada sozinho).
 */
async function onDemandActive(db) {
  try {
    if (!(await isUnscheduledDay(db))) return false;
    if (await getPlan(db)) return true;
    return await hasActivityToday(db);
  } catch (_) { return false; }
}

module.exports = { PLAN_KEY, EDT, nyToday, isUnscheduledDay, hasActivityToday, getPlan, setPlan, onDemandActive };
