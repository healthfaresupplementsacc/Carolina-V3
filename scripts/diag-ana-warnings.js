'use strict';
// Por que a Ana não foi avisada? (1) checkout esquecido ontem sem DM 08:30; (2) ociosa >20min hoje sem aviso.
const { Pool } = require('pg');
const { AbsenceAlert } = require('../src/workers/absence-alert');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const EDT = 'America/New_York';
(async () => {
  const now = await pool.query(`SELECT to_char(NOW() AT TIME ZONE '${EDT}','YYYY-MM-DD HH24:MI') AS ny`);
  console.log('AGORA (NY):', now.rows[0].ny);

  // ── 1. FORGOTTEN CHECKOUT (ontem) ──
  const fc = await pool.query(
    `SELECT fc.id, p.display_name, fc.discovered_via, fc.resolution,
            to_char(fc.discovered_at AT TIME ZONE '${EDT}','MM-DD HH24:MI') AS discovered,
            to_char(fc.carolina_dm_scheduled_for AT TIME ZONE '${EDT}','MM-DD HH24:MI') AS dm_sched,
            to_char(fc.carolina_dm_sent_at AT TIME ZONE '${EDT}','MM-DD HH24:MI') AS dm_sent
     FROM v3.forgotten_checkouts fc JOIN v3.persons p ON p.id = fc.person_id
     WHERE fc.discovered_at > NOW() - INTERVAL '3 days' ORDER BY fc.id DESC LIMIT 12`);
  console.log('\n1) forgotten_checkouts (3 dias):', fc.rowCount ? '' : 'NENHUMA LINHA');
  fc.rows.forEach((r) => console.log(`   #${r.id} ${r.display_name} via=${r.discovered_via} res=${r.resolution} descoberto=${r.discovered} dm_agendado=${r.dm_sched} dm_enviado=${r.dm_sent || 'NÃO'}`));

  // Ana ontem: como os events dela fecharam?
  const anaY = await pool.query(
    `SELECT e.id, at.slug, to_char(e.started_at AT TIME ZONE '${EDT}','HH24:MI') AS ini,
            to_char(e.ended_at AT TIME ZONE '${EDT}','HH24:MI') AS fim, e.closed_reason
     FROM v3.events e JOIN v3.persons p ON p.id=e.person_id LEFT JOIN v3.activity_types at ON at.id=e.activity_type_id
     WHERE p.display_name ILIKE 'Ana%' AND e.deleted_at IS NULL
       AND (e.started_at AT TIME ZONE '${EDT}')::date = ((NOW() AT TIME ZONE '${EDT}')::date - 1)
     ORDER BY e.started_at`);
  console.log('\n   Ana ONTEM (events + como fecharam):');
  anaY.rows.forEach((r) => console.log(`   ev${r.id} ${r.slug} ${r.ini}→${r.fim || 'ABERTO'} closed_reason=${r.closed_reason || '—'}`));

  // ── 2. ABSENCE hoje ──
  const anaT = await pool.query(
    `SELECT p.id,
            (SELECT to_char(MAX(e.ended_at) AT TIME ZONE '${EDT}','HH24:MI') FROM v3.events e WHERE e.person_id=p.id AND e.deleted_at IS NULL AND e.ended_at IS NOT NULL AND (e.ended_at AT TIME ZONE '${EDT}')::date=(NOW() AT TIME ZONE '${EDT}')::date) AS last_end_today,
            (SELECT COUNT(*)::int FROM v3.events e WHERE e.person_id=p.id AND e.ended_at IS NULL AND e.deleted_at IS NULL) AS open_now,
            (SELECT to_char(MIN(s.created_at) AT TIME ZONE '${EDT}','HH24:MI') FROM v3.operator_sessions s WHERE s.person_id=p.id AND (s.created_at AT TIME ZONE '${EDT}')::date=(NOW() AT TIME ZONE '${EDT}')::date) AS first_login_today
     FROM v3.persons p WHERE p.display_name ILIKE 'Ana%' AND p.role='operator' LIMIT 1`);
  console.log('\n2) Ana HOJE:', JSON.stringify(anaT.rows[0]));
  const openDetail = await pool.query(
    `SELECT e.id, at.slug, COALESCE(at.is_background,false) AS bg, to_char(e.started_at AT TIME ZONE '${EDT}','MM-DD HH24:MI') AS ini, e.paused_at IS NOT NULL AS paused
     FROM v3.events e JOIN v3.persons p ON p.id=e.person_id LEFT JOIN v3.activity_types at ON at.id=e.activity_type_id
     WHERE p.display_name ILIKE 'Ana%' AND e.ended_at IS NULL AND e.deleted_at IS NULL`);
  openDetail.rows.forEach((r) => console.log(`   ABERTO: ev${r.id} ${r.slug} bg=${r.bg} desde=${r.ini} paused=${r.paused}`));

  // roda o findAbsent AO VIVO (mesma query do worker)
  const w = new AbsenceAlert({ db: pool, slack: null, channelId: null, enabled: true, thresholdMin: 15 });
  const absent = await w.findAbsent();
  console.log('\n   findAbsent() AO VIVO:', JSON.stringify(absent.map((a) => ({ who: a.display_name, idle_min: a.idle_min }))));

  // alertas enviados hoje
  const alerts = await pool.query(
    `SELECT person_name, action_type, to_char(created_at AT TIME ZONE '${EDT}','MM-DD HH24:MI') AS at
     FROM v3.operator_action_log
     WHERE action_type IN ('absence_alert') AND created_at > NOW() - INTERVAL '36 hours' ORDER BY created_at DESC LIMIT 10`);
  console.log('\n   absence_alerts enviados (36h):', alerts.rowCount ? '' : 'NENHUM');
  alerts.rows.forEach((r) => console.log(`   ${r.at} ${r.person_name}`));

  // DM worker: alguma auditoria de envio?
  const dmAudit = await pool.query(
    `SELECT action, to_char(created_at AT TIME ZONE '${EDT}','MM-DD HH24:MI') AS at, metadata
     FROM v3.audit_log WHERE action IN ('carolina_forgotten_dm_sent') AND created_at > NOW() - INTERVAL '3 days' ORDER BY created_at DESC LIMIT 8`);
  console.log('\n   DMs de checkout enviados (3 dias):', dmAudit.rowCount ? '' : 'NENHUM');
  dmAudit.rows.forEach((r) => console.log(`   ${r.at} ${JSON.stringify(r.metadata)}`));
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
