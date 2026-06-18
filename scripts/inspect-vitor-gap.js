'use strict';
/* Investiga o gap falso do Vitor (read-only). railway run node scripts/inspect-vitor-gap.js */
const { Pool } = require('pg');
const EDT = 'America/New_York';
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s, p) => pool.query(s, p).then((r) => r.rows);
  const vitor = (await q("SELECT id FROM v3.persons WHERE display_name ILIKE '%vitor%' AND deleted_at IS NULL"))[0];
  const id = vitor ? vitor.id : 4;
  console.log('Vitor = person#' + id);

  console.log('\n=== events de Vitor HOJE (EDT) ===');
  const evs = await q(`
    SELECT e.id, at.slug,
           to_char(e.started_at AT TIME ZONE '${EDT}', 'HH24:MI') AS started,
           to_char(e.ended_at   AT TIME ZONE '${EDT}', 'HH24:MI') AS ended,
           e.is_long_running AS lr, e.is_test AS test, e.closed_reason,
           (e.ended_at AT TIME ZONE '${EDT}')::date AS ended_date_edt,
           (e.started_at AT TIME ZONE '${EDT}')::date AS started_date_edt
    FROM v3.events e LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE e.person_id = $1 AND e.deleted_at IS NULL
      AND ((e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
           OR (e.ended_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
           OR e.ended_at IS NULL)
    ORDER BY e.started_at`, [id]);
  evs.forEach((e) => console.log(`  ev#${e.id} ${e.slug} ${e.started}–${e.ended || 'ABERTO'} lr=${e.lr} test=${e.test} reason=${e.closed_reason || '-'} startedDate=${e.started_date_edt && e.started_date_edt.toISOString().slice(0,10)} endedDate=${e.ended_date_edt ? e.ended_date_edt.toISOString().slice(0,10) : '-'}`));

  console.log('\n=== sessões de Vitor HOJE ===');
  const sess = await q(`SELECT to_char(created_at AT TIME ZONE '${EDT}', 'HH24:MI') AS login, to_char(last_activity_at AT TIME ZONE '${EDT}', 'HH24:MI') AS last_act, logged_out_at IS NULL AS active
                        FROM v3.operator_sessions WHERE person_id=$1 AND (created_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date ORDER BY created_at`, [id]);
  sess.forEach((s) => console.log(`  login ${s.login} · last_act ${s.last_act} · active=${s.active}`));

  console.log('\n=== gaps de Vitor HOJE ===');
  const gaps = await q(`SELECT g.id, g.gap_minutes, g.justification_type, g.justification_note, g.previous_event_id, g.next_event_id,
                               to_char(g.gap_started_at AT TIME ZONE '${EDT}','HH24:MI') AS gstart, to_char(g.gap_ended_at AT TIME ZONE '${EDT}','HH24:MI') AS gend
                        FROM v3.activity_gaps g WHERE g.person_id=$1 AND (g.created_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date ORDER BY g.created_at`, [id]);
  gaps.forEach((g) => console.log(`  gap#${g.id} ${g.gstart}–${g.gend} (${g.gap_minutes}min) tipo=${g.justification_type} prev=${g.previous_event_id} next=${g.next_event_id} "${g.justification_note}"`));

  console.log('\n=== o que detectGap retornaria AGORA p/ Vitor (simulação) ===');
  const open = await q("SELECT 1 FROM v3.events WHERE person_id=$1 AND ended_at IS NULL AND deleted_at IS NULL LIMIT 1", [id]);
  console.log('  tem event aberto? ' + (open.length ? 'SIM (→ sem gap)' : 'não'));
  const ref = await q(`SELECT
      to_char((SELECT MAX(ended_at) FROM v3.events WHERE person_id=$1 AND deleted_at IS NULL AND ended_at IS NOT NULL AND (ended_at AT TIME ZONE '${EDT}')::date=(NOW() AT TIME ZONE '${EDT}')::date) AT TIME ZONE '${EDT}','HH24:MI') AS last_end,
      to_char((SELECT MAX(created_at) FROM v3.operator_sessions WHERE person_id=$1 AND (created_at AT TIME ZONE '${EDT}')::date=(NOW() AT TIME ZONE '${EDT}')::date) AT TIME ZONE '${EDT}','HH24:MI') AS last_login`, [id]);
  console.log('  MAX(ended_at hoje)=' + ref[0].last_end + ' · MAX(login hoje)=' + ref[0].last_login + '  → GREATEST vira a referência do gap');

  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
