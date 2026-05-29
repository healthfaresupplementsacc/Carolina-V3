'use strict';
/* DIAG read-only — duplo-almoço 29/mai 3:19/3:22 PM:
   - msg "Bruno-voltei do almoco" 3:19 PM    → certo: Bruno (id=7)
   - msg "F: Finalizando ajuda na linha..." 3:22 PM → era Vitor (id=4), virou Bruno
   - msg "S: Inicio Almoco" 3:22 PM           → era Vitor, virou Bruno (lunch fantasma) */
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' 1. Msgs Slack 3:15-3:30 PM 29/mai (da conta U08JC85HMNE Vitor)');
  console.log('═══════════════════════════════════════════════════════════');
  const msgs = (await pool.query(`
    SELECT m.id, m.slack_user_id, m.slack_ts, m.person_id,
      TO_CHAR(to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH12:MI:SS AM') AS ny,
      m.events_created, m.events_updated,
      m.llm_result->>'categorization' AS cat,
      m.llm_result->>'uncertain' AS uncertain,
      m.llm_result->'actions' AS actions,
      m.raw_text
    FROM v3.messages m
    WHERE (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = '2026-05-29'
      AND to_timestamp(m.slack_ts::numeric) >= '2026-05-29 15:15:00-04'
      AND to_timestamp(m.slack_ts::numeric) <= '2026-05-29 15:35:00-04'
    ORDER BY m.slack_ts::numeric`)).rows;
  for (const m of msgs) {
    console.log(`\n  msg${m.id} ${m.ny} slack=${m.slack_user_id} resolved_person=${m.person_id}`);
    console.log(`    raw: "${m.raw_text}"`);
    console.log(`    cat=${m.cat} uncertain=${m.uncertain}`);
    console.log(`    events_created=${JSON.stringify(m.events_created || [])} events_updated=${JSON.stringify(m.events_updated || [])}`);
    if (m.actions) {
      for (const a of m.actions) {
        console.log(`    action: ${a.type} person=${a.person_id} activity_type_id=${a.activity_type_id} product=${a.product_id} ended_at=${a.ended_at} desc="${(a.description || '').slice(0, 80)}"`);
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 2. Events criados / atualizados naquela janela (envolvidos)');
  console.log('═══════════════════════════════════════════════════════════');
  // Pega todos events que tem source_message_ts dessas msgs OU foram updated por elas
  const eventIds = new Set();
  for (const m of msgs) {
    for (const id of (m.events_created || [])) eventIds.add(id);
    for (const id of (m.events_updated || [])) eventIds.add(id);
  }
  if (eventIds.size === 0) { console.log('  (nenhum)'); }
  else {
    const evs = (await pool.query(`
      SELECT e.id, e.person_id, p.display_name AS person, at.slug AS activity, at.flow,
        TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI:SS AM') AS s,
        TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI:SS AM') AS e_t,
        e.deleted_at, e.closed_reason, e.confidence, e.source_message_ts,
        LEFT(COALESCE(e.description,''), 120) AS desc
      FROM v3.events e
      LEFT JOIN v3.persons p ON p.id = e.person_id
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      WHERE e.id = ANY($1::int[])
      ORDER BY e.id`, [[...eventIds]])).rows;
    for (const r of evs) {
      console.log(`\n  ev${r.id} ${r.person} (id=${r.person_id}) ${r.activity}/${r.flow} ${r.s}→${r.e_t || 'LIVE'}`);
      console.log(`    deleted=${r.deleted_at ? 'YES' : 'NO'} closed_reason=${r.closed_reason || '—'} conf=${r.confidence}`);
      console.log(`    source_ts=${r.source_message_ts}`);
      console.log(`    desc: "${r.desc}"`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 3. Estado atual de Bruno Sarmento (id=7) — events do dia');
  console.log('═══════════════════════════════════════════════════════════');
  const bs = (await pool.query(`
    SELECT e.id, at.slug, at.flow, e.deleted_at IS NOT NULL AS deleted,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS s,
      TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS e_t,
      e.source_message_ts
    FROM v3.events e
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE e.person_id = 7
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = '2026-05-29'
      AND at.slug IN ('lunch', 'break', 'production_line')
    ORDER BY e.started_at`)).rows;
  for (const r of bs) {
    console.log(`  ev${r.id} ${r.s}→${r.e_t || 'LIVE'} ${r.slug}/${r.flow}${r.deleted ? ' (DEL)' : ''} src=${r.source_message_ts}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 4. Estado atual de Vitor (id=4) — events do dia');
  console.log('═══════════════════════════════════════════════════════════');
  const vt = (await pool.query(`
    SELECT e.id, at.slug, at.flow, e.deleted_at IS NOT NULL AS deleted,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS s,
      TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS e_t,
      e.source_message_ts
    FROM v3.events e
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE e.person_id = 4
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = '2026-05-29'
      AND at.slug IN ('lunch', 'break', 'production_line')
    ORDER BY e.started_at`)).rows;
  for (const r of vt) {
    console.log(`  ev${r.id} ${r.s}→${r.e_t || 'LIVE'} ${r.slug}/${r.flow}${r.deleted ? ' (DEL)' : ''} src=${r.source_message_ts}`);
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
