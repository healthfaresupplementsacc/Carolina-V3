'use strict';
/* Varredura completa 27/mai — read-only.
   (1) abertos sem F | duplicados | uncertain
   (2) Simone gap 11:52-12:45 — busca resposta dela depois
   (3) gaps >= 30min por pessoa ainda não preenchidos                   */
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const D = '2026-05-27';

  console.log('\n══════════════════════════════════════════════════');
  console.log(' 1A. EVENTS ABERTOS sem F (agora)');
  console.log('══════════════════════════════════════════════════');
  const open = await pool.query(`
    SELECT e.id, p.display_name AS person, at.slug AS activity, at.category, at.is_background,
           e.started_at AT TIME ZONE 'America/New_York' AS ny_start,
           e.is_long_running,
           pr.canonical_name AS product, pb.batch_number AS batch,
           e.cowork_with,
           LEFT(COALESCE(e.description, ''), 80) AS desc
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.ended_at IS NULL AND e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1::date
    ORDER BY p.display_name, e.started_at`, [D]);
  for (const r of open.rows) {
    const flag = r.category === 'meta' ? '[META]' : r.is_background ? '[bg]' : '[fg]';
    const lr = r.is_long_running ? ' [LONG]' : '';
    console.log(`  ev${r.id} ${(r.person || '?').padEnd(15)} ${flag}${lr} ${(r.activity || '?').padEnd(22)} ${r.ny_start.toISOString().slice(11,16)} ${r.product || '—'}/${r.batch || '—'} cw=[${r.cowork_with}] "${r.desc}"`);
  }
  console.log(`  TOTAL: ${open.rows.length} open`);

  console.log('\n══════════════════════════════════════════════════');
  console.log(' 1B. DUPLICADOS / REDUNDANTES');
  console.log('══════════════════════════════════════════════════');
  const dup = await pool.query(`
    SELECT source_message_ts, array_agg(id ORDER BY id) AS ids, count(*) AS c
    FROM v3.events
    WHERE deleted_at IS NULL AND source_message_ts IS NOT NULL
      AND (started_at AT TIME ZONE 'America/New_York')::date = $1::date
    GROUP BY source_message_ts HAVING count(*) > 1
    ORDER BY source_message_ts`, [D]);
  if (dup.rows.length === 0) console.log('  (sem duplicatas por source_message_ts)');
  for (const r of dup.rows) console.log(`  ts=${r.source_message_ts} → ${r.c} events: [${r.ids}]`);

  console.log('\n  Mesma pessoa + mesma atividade + mesmo produto/batch em <5min (redundância suspeita):');
  const redund = await pool.query(`
    WITH ord AS (
      SELECT e.id, e.person_id, e.activity_type_id, e.product_batch_id, e.started_at,
             p.display_name AS person, at.slug AS activity,
             pb.batch_number AS batch,
             LAG(e.id) OVER w AS prev_id,
             LAG(e.started_at) OVER w AS prev_start
      FROM v3.events e
      LEFT JOIN v3.persons p ON p.id = e.person_id
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
      WHERE e.deleted_at IS NULL
        AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1::date
      WINDOW w AS (PARTITION BY e.person_id, e.activity_type_id, e.product_batch_id ORDER BY e.started_at)
    )
    SELECT id, prev_id, person, activity, batch,
           started_at AT TIME ZONE 'America/New_York' AS ny_start,
           prev_start AT TIME ZONE 'America/New_York' AS ny_prev,
           EXTRACT(epoch FROM (started_at - prev_start))/60 AS gap_min
    FROM ord
    WHERE prev_id IS NOT NULL AND (started_at - prev_start) < interval '5 minutes'
    ORDER BY started_at`, [D]);
  if (redund.rows.length === 0) console.log('    (sem redundância em <5min)');
  for (const r of redund.rows) {
    console.log(`    ev${r.id} & ev${r.prev_id} ${(r.person || '?').padEnd(15)} ${r.activity}/${r.batch || '—'} | ${r.ny_prev.toISOString().slice(11,16)} → ${r.ny_start.toISOString().slice(11,16)} (gap ${Math.round(r.gap_min)}min)`);
  }

  console.log('\n══════════════════════════════════════════════════');
  console.log(' 1C. UNCERTAIN cases hoje');
  console.log('══════════════════════════════════════════════════');
  const unc = await pool.query(`
    SELECT m.id,
           to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York' AS ny_ts,
           p.display_name AS author,
           (m.llm_result->>'uncertain')::boolean AS uncertain,
           m.llm_result->>'uncertainty_reason' AS reason,
           m.llm_result->>'confidence_overall' AS conf,
           m.events_created, m.events_updated,
           LEFT(m.raw_text, 110) AS txt
    FROM v3.messages m
    LEFT JOIN v3.persons p ON p.id = m.person_id
    WHERE (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = $1::date
      AND ((m.llm_result->>'uncertain')::boolean = true
           OR m.llm_result->>'confidence_overall' IN ('low','unconfirmed'))
    ORDER BY m.slack_ts::numeric`, [D]);
  if (unc.rows.length === 0) console.log('  (sem uncertain)');
  for (const r of unc.rows) {
    console.log(`  msg${r.id} ${r.ny_ts.toISOString().slice(11,16)} ${(r.author || '?').padEnd(15)} conf=${r.conf || '?'} unc=${r.uncertain ? 'TRUE' : 'false'}`);
    console.log(`    reason: "${r.reason || '(sem reason)'}"`);
    console.log(`    events: [${r.events_created || []}+${r.events_updated || []}]`);
    console.log(`    txt: "${r.txt}"`);
  }

  console.log('\n══════════════════════════════════════════════════');
  console.log(' 2. Simone gap 11:52→12:45 — resposta dela depois?');
  console.log('══════════════════════════════════════════════════');
  // person_id=5 = Simone
  console.log('  Msgs DA Simone hoje DEPOIS de 12:45 NY (qualquer texto):');
  const simoneMsgs = await pool.query(`
    SELECT m.id,
           to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York' AS ny_ts,
           m.events_created, m.events_updated,
           LEFT(m.raw_text, 160) AS txt
    FROM v3.messages m
    WHERE m.person_id = 5
      AND (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = $1::date
      AND to_timestamp(m.slack_ts::numeric) > ($1::date + time '12:45') AT TIME ZONE 'America/New_York'
    ORDER BY m.slack_ts::numeric`, [D]);
  if (simoneMsgs.rows.length === 0) console.log('    (sem mensagens da Simone após 12:45)');
  for (const r of simoneMsgs.rows) {
    console.log(`    msg${r.id} ${r.ny_ts.toISOString().slice(11,16)} ev:[${r.events_created || []}+${r.events_updated || []}] "${r.txt}"`);
  }

  // Mensagens MENCIONANDO Simone e/ou o horário 11:52-12:45
  console.log('\n  Msgs MENCIONANDO Simone ou o gap 11:52-12:45 hoje:');
  const aboutSimone = await pool.query(`
    SELECT m.id, to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York' AS ny_ts,
           p.display_name AS author, LEFT(m.raw_text, 160) AS txt
    FROM v3.messages m
    LEFT JOIN v3.persons p ON p.id = m.person_id
    WHERE (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = $1::date
      AND m.person_id != 5
      AND (m.raw_text ILIKE '%Simone%' OR m.raw_text ILIKE '%11:52%' OR m.raw_text ILIKE '%11h52%'
           OR m.raw_text ILIKE '%12:45%' OR m.raw_text ILIKE '%12h45%'
           OR m.raw_text ILIKE '%S:%' OR m.raw_text ILIKE '%U07FG34TMPF%')
    ORDER BY m.slack_ts::numeric`, [D]);
  if (aboutSimone.rows.length === 0) console.log('    (sem mensagens mencionando Simone/gap)');
  for (const r of aboutSimone.rows) {
    console.log(`    msg${r.id} ${r.ny_ts.toISOString().slice(11,16)} ${(r.author || '?').padEnd(15)} "${r.txt}"`);
  }

  console.log('\n══════════════════════════════════════════════════');
  console.log(' 3. GAPS >= 30min por pessoa (entre fg events consecutivos)');
  console.log('══════════════════════════════════════════════════');
  // Pega fg events do dia, ordena por started_at por pessoa, calcula gaps
  const fgEvents = await pool.query(`
    SELECT e.id, e.person_id, p.display_name AS person, at.slug AS activity,
           e.started_at, e.ended_at,
           e.started_at AT TIME ZONE 'America/New_York' AS ny_start,
           e.ended_at   AT TIME ZONE 'America/New_York' AS ny_end
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1::date
      AND COALESCE(at.is_background, false) = false   -- só foreground
      AND COALESCE(at.category, '') != 'meta'         -- ignora break/lunch
    ORDER BY e.person_id, e.started_at`, [D]);

  // Agrupa por pessoa, computa gaps
  const byPerson = {};
  for (const e of fgEvents.rows) {
    (byPerson[e.person_id] = byPerson[e.person_id] || []).push(e);
  }
  for (const personId of Object.keys(byPerson)) {
    const list = byPerson[personId];
    const personName = list[0].person;
    console.log(`\n  ${personName}:`);
    let count = 0;
    for (let i = 0; i < list.length - 1; i++) {
      const ev = list[i];
      const next = list[i + 1];
      const evEnd = ev.ended_at ? new Date(ev.ended_at).getTime() : null;
      const nextStart = new Date(next.started_at).getTime();
      if (!evEnd) continue;          // pula se evento atual ainda LIVE
      const gapMin = (nextStart - evEnd) / 60000;
      if (gapMin < 30) continue;
      const endNy = ev.ny_end.toISOString().slice(11,16);
      const startNy = next.ny_start.toISOString().slice(11,16);
      console.log(`    gap ${endNy} → ${startNy} (${Math.round(gapMin)}min): após ev${ev.id} (${ev.activity}), antes ev${next.id} (${next.activity})`);
      count++;
    }
    if (count === 0) console.log('    (sem gaps >= 30min)');
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
