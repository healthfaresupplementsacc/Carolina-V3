'use strict';
const { Pool } = require('pg');
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('═══ ev252 — status atual Lithium encapsulation ═══');
  const ev252 = await pool.query(`
    SELECT e.id, p.display_name AS person, at.slug AS activity,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_start,
      TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_end,
      e.is_long_running, e.closed_reason,
      pr.canonical_name AS product, pb.batch_number AS batch,
      LEFT(COALESCE(e.description,''), 120) AS desc
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.id = 252`);
  console.log(' ', ev252.rows[0]);

  console.log('\n═══ MSGs sobre Lithium DEPOIS de ev252 started_at (3:33 PM hoje) ═══');
  const lit = await pool.query(`
    SELECT m.id,
      TO_CHAR(to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_ts,
      p.display_name AS author,
      m.events_created, m.events_updated,
      LEFT(m.raw_text, 160) AS txt
    FROM v3.messages m
    LEFT JOIN v3.persons p ON p.id = m.person_id
    WHERE (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = '2026-05-27'
      AND m.raw_text ILIKE '%lithium%'
      AND m.slack_ts::numeric > (SELECT EXTRACT(epoch FROM started_at) FROM v3.events WHERE id = 252)
    ORDER BY m.slack_ts::numeric`);
  if (lit.rows.length === 0) console.log('  (nenhuma msg sobre Lithium após 3:33 PM hoje)');
  for (const r of lit.rows) {
    console.log(`  msg${r.id} ${r.ny_ts} ${r.author || '?'} ev:[${r.events_created || []}+${r.events_updated || []}] "${r.txt}"`);
  }

  console.log('\n═══ TODOS events de hoje com "caminhão" / "descarga" / "carga" / "encher" / "entrega" ═══');
  const carga = await pool.query(`
    SELECT e.id, p.display_name AS person, at.slug AS activity, at.id AS at_id,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_start,
      TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_end,
      e.activity_type_id,
      LEFT(COALESCE(e.description,''), 140) AS desc
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE (e.started_at AT TIME ZONE 'America/New_York')::date = '2026-05-27'
      AND e.deleted_at IS NULL
      AND (e.description ILIKE '%caminh%' OR e.description ILIKE '%descarga%' OR e.description ILIKE '%descarreg%'
           OR e.description ILIKE '%entrega%' OR e.description ILIKE '%encher%'
           OR e.description ILIKE '%receb%material%' OR e.description ILIKE '%carregamento%')
    ORDER BY e.started_at`);
  for (const r of carga.rows) {
    console.log(`  ev${r.id} ${r.ny_start}→${r.ny_end || 'LIVE'} ${r.person} activity=${r.activity || 'NULL (id ' + r.activity_type_id + ')'} "${r.desc}"`);
  }

  console.log('\n═══ MSGS de hoje com "caminhão" / "descarga" / "carga" / "encher" / "entrega" ═══');
  const cargaMsgs = await pool.query(`
    SELECT m.id,
      TO_CHAR(to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_ts,
      p.display_name AS author,
      m.events_created, m.events_updated,
      LEFT(m.raw_text, 180) AS txt
    FROM v3.messages m
    LEFT JOIN v3.persons p ON p.id = m.person_id
    WHERE (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = '2026-05-27'
      AND (m.raw_text ILIKE '%caminh%' OR m.raw_text ILIKE '%descarga%' OR m.raw_text ILIKE '%descarreg%'
           OR m.raw_text ILIKE '%entrega%' OR m.raw_text ILIKE '%encher%'
           OR m.raw_text ILIKE '%receb%material%' OR m.raw_text ILIKE '%carregamento%')
    ORDER BY m.slack_ts::numeric`);
  for (const r of cargaMsgs.rows) {
    console.log(`  msg${r.id} ${r.ny_ts} ${r.author || '?'} ev:[${r.events_created || []}+${r.events_updated || []}] "${r.txt}"`);
  }

  // Pra contexto sobre regra futura: histórico de outros dias com "caminhão"
  console.log('\n═══ Eventos HISTÓRICOS (qualquer data) com "caminhão" — frequência ═══');
  const histCarga = await pool.query(`
    SELECT
      (e.started_at AT TIME ZONE 'America/New_York')::date AS day,
      COUNT(*)::int AS c
    FROM v3.events e
    WHERE e.deleted_at IS NULL
      AND (e.description ILIKE '%caminh%' OR e.description ILIKE '%descarreg%' OR e.description ILIKE '%encher%')
    GROUP BY day ORDER BY day DESC LIMIT 10`);
  if (histCarga.rows.length === 0) console.log('  (zero events históricos)');
  for (const r of histCarga.rows) console.log(`  ${r.day.toISOString().slice(0,10)}: ${r.c} events`);

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
