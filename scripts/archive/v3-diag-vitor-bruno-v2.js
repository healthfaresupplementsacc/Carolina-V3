'use strict';
/* v2 — usa TO_CHAR no SQL pra horários REAIS NY EDT em 12h AM/PM. */
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const D = '2026-05-27';
  const persons = await pool.query(`SELECT id, display_name, slack_user_id FROM v3.persons WHERE deleted_at IS NULL ORDER BY id`);
  const vitor = persons.rows.find((p) => p.display_name === 'Vitor');

  console.log('═══ persons (id / nome / slack) ═══');
  for (const p of persons.rows) console.log(`  ${p.id}  ${p.display_name.padEnd(15)} ${p.slack_user_id || '—'}`);

  console.log('\n═══ Msgs HOJE 27/mai da conta Vitor (' + vitor.slack_user_id + ') com assinatura "Bruno" — ATRIBUIÇÃO ═══');
  const msgs = await pool.query(`
    SELECT
      m.id AS msg_id,
      TO_CHAR(to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_12h,
      m.person_id AS resolved_to_person_id,
      p.display_name AS resolved_name,
      m.events_created, m.events_updated,
      LEFT(m.raw_text, 180) AS txt
    FROM v3.messages m
    LEFT JOIN v3.persons p ON p.id = m.person_id
    WHERE m.slack_user_id = $1
      AND (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = $2::date
      AND m.raw_text ~* '(\\bbruno\\b|[\\-–]\\s*bruno|bruno\\s*[\\-–])'
    ORDER BY m.slack_ts::numeric`, [vitor.slack_user_id, D]);

  console.log(`  ${msgs.rows.length} mensagens com pattern "Bruno" via Vitor's account hoje\n`);
  for (const m of msgs.rows) {
    const evIds = [...(m.events_created || []), ...(m.events_updated || [])];
    console.log(`  msg${m.msg_id} ${m.ny_12h} resolved=${m.resolved_name || 'NULL'} (id ${m.resolved_to_person_id || '—'})`);
    console.log(`    text: "${m.txt}"`);
    if (evIds.length === 0) {
      console.log(`    events: NENHUM criado/atualizado`);
    } else {
      const events = await pool.query(`
        SELECT
          e.id, e.person_id, p.display_name AS person, at.slug AS activity,
          TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_start,
          TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_end,
          e.cowork_with,
          LEFT(COALESCE(e.description, ''), 90) AS desc
        FROM v3.events e
        LEFT JOIN v3.persons p ON p.id = e.person_id
        LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
        WHERE e.id = ANY($1::int[]) AND e.deleted_at IS NULL
        ORDER BY e.id`, [evIds]);
      for (const e of events.rows) {
        const tag = e.person_id === 4 ? '❌ VITOR (esperado Bruno Sarmento)' : (e.person_id === 7 ? '✓ Bruno Sarmento' : `? person_id=${e.person_id}`);
        console.log(`    → ev${e.id} ${tag} · ${e.activity} · ${e.ny_start}→${e.ny_end || 'LIVE'} cw=[${e.cowork_with}]`);
        if (e.desc) console.log(`      desc: "${e.desc}"`);
      }
    }
    console.log('');
  }

  // EVENTOS DE HOJE ATRIBUÍDOS AO VITOR (id=4) — pra checar se algum era pra ser Bruno
  console.log('═══ TODOS events HOJE atribuídos ao VITOR (id=4) — caça por engano ═══');
  const vitorEvents = await pool.query(`
    SELECT e.id, at.slug AS activity,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_start,
      TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_end,
      e.source_message_ts,
      m.id AS msg_id, m.slack_user_id AS msg_slack,
      LEFT(COALESCE(e.description, ''), 90) AS desc,
      LEFT(COALESCE(m.raw_text, ''), 120) AS msg_txt
    FROM v3.events e
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.messages m ON m.slack_ts = e.source_message_ts
    WHERE e.person_id = 4 AND e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1::date
    ORDER BY e.started_at`, [D]);
  for (const r of vitorEvents.rows) {
    const brunoSign = /(\bbruno\b|[\-–]\s*bruno|bruno\s*[\-–])/i.test(r.msg_txt || r.desc || '');
    const tag = brunoSign ? '⚠ MSG/DESC tem Bruno' : '';
    console.log(`  ev${r.id} ${r.ny_start}→${r.ny_end || 'LIVE'} ${r.activity} ${tag}`);
    console.log(`    msg${r.msg_id || '—'} via ${r.msg_slack || '(admin)'} : "${r.msg_txt || '(sem msg)'}"`);
    if (r.desc) console.log(`    desc: "${r.desc}"`);
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
