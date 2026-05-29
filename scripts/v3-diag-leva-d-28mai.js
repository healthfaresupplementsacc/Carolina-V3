'use strict';
/* DIAG LEVA D (bloco 28/mai noite item 10) — read-only.

   10a. Investigar 4 events "linha de produção SEM produto" 28/mai:
        - Ana 12:23 PM → 2:57 PM
        - Simone 12:56 PM → 1:11 PM
        - Vitor 1:30 PM → 4:32 PM (Bruno disse: ele fechou como Potassium 4:32 PM)
        - Ana 3:43 PM → 5:56 PM
        → Quais batches Potassium estavam ativos? Qual deveria ser atribuído?
        → Quem estava em cowork? Qual o cowork correto?

   10b. Thassio (admin id=2) — entender como ev302 foi criado e identificar
        eventuais outras criações que escaparam do filtro. */
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const TODAY = '2026-05-28';

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' 10a. EVENTOS "linha de produção SEM produto" 28/mai');
  console.log('═══════════════════════════════════════════════════════════');
  const sem = (await pool.query(`
    SELECT e.id, p.display_name AS person, p.id AS person_id,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS s,
      TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS e_t,
      e.product_batch_id, e.cowork_with,
      e.source_message_ts,
      LEFT(COALESCE(e.description,''), 100) AS desc
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE at.slug = 'production_line'
      AND e.product_batch_id IS NULL
      AND e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1
    ORDER BY e.started_at`, [TODAY])).rows;
  for (const r of sem) {
    console.log(`  ev${r.id} ${r.person} ${r.s}→${r.e_t} cw=${JSON.stringify(r.cowork_with)} desc="${r.desc}"`);
    console.log(`    source_ts=${r.source_message_ts || 'NULL'}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 10a. BATCHES de POTASSIUM ativos no dia 28/mai');
  console.log('═══════════════════════════════════════════════════════════');
  const lotes = (await pool.query(`
    SELECT pb.id AS batch_id, pb.batch_number, pr.canonical_name AS product,
      MIN(e.started_at) AS first_event,
      MAX(COALESCE(e.ended_at, NOW())) AS last_event,
      COUNT(e.id) AS event_count,
      array_agg(DISTINCT e.person_id ORDER BY e.person_id) AS people
    FROM v3.product_batches pb
    JOIN v3.products pr ON pr.id = pb.product_id
    JOIN v3.events e ON e.product_batch_id = pb.id AND e.deleted_at IS NULL
    WHERE pr.canonical_name ILIKE '%potassium%'
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1
    GROUP BY pb.id, pb.batch_number, pr.canonical_name
    ORDER BY first_event`, [TODAY])).rows;
  for (const r of lotes) {
    console.log(`  batch_id=${r.batch_id} ${r.batch_number} ${r.product}`);
    console.log(`    first=${new Date(r.first_event).toISOString()} last=${new Date(r.last_event).toISOString()}`);
    console.log(`    ${r.event_count} events · pessoas=[${r.people.join(',')}]`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 10a. EVENTOS de Vitor production_line 28/mai (com produto)');
  console.log('═══════════════════════════════════════════════════════════');
  const v = (await pool.query(`
    SELECT e.id, at.slug, pb.batch_number, pr.canonical_name AS product,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS s,
      TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS e_t,
      e.cowork_with, LEFT(COALESCE(e.description, ''), 80) AS desc
    FROM v3.events e
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.person_id = 4 AND e.deleted_at IS NULL
      AND at.slug = 'production_line'
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1
    ORDER BY e.started_at`, [TODAY])).rows;
  for (const r of v) {
    console.log(`  ev${r.id} ${r.s}→${r.e_t} ${r.product || '(SEM)'}/${r.batch_number || '—'} cw=${JSON.stringify(r.cowork_with)}`);
    console.log(`    desc: "${r.desc}"`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 10a. MENSAGENS que viraram os 4 events (rastreio)');
  console.log('═══════════════════════════════════════════════════════════');
  const ids = sem.map((r) => r.source_message_ts).filter(Boolean);
  if (ids.length > 0) {
    const msgs = (await pool.query(`
      SELECT id, slack_user_id, slack_ts,
        TO_CHAR(to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_ts,
        LEFT(raw_text, 200) AS txt
      FROM v3.messages WHERE slack_ts = ANY($1::text[]) ORDER BY slack_ts::numeric`, [ids])).rows;
    for (const m of msgs) {
      console.log(`  msg${m.id} ${m.ny_ts} slack=${m.slack_user_id}`);
      console.log(`    "${m.txt}"`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 10b. ev302 Thassio — origem e timeline');
  console.log('═══════════════════════════════════════════════════════════');
  const ev302 = (await pool.query(`
    SELECT e.id, e.person_id, p.display_name AS person, p.role,
      at.slug AS activity, at.flow,
      e.started_at, e.ended_at, e.deleted_at, e.closed_reason,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS ny_start,
      TO_CHAR(e.ended_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS ny_end,
      e.source_message_ts, e.confidence,
      LEFT(COALESCE(e.description,''), 200) AS desc
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE e.id = 302`)).rows[0];
  if (!ev302) { console.log('  ev302 não existe'); }
  else {
    console.log(`  ev302 ${ev302.person} (id=${ev302.person_id}, role=${ev302.role})`);
    console.log(`    ${ev302.activity}/${ev302.flow} confidence=${ev302.confidence}`);
    console.log(`    ${ev302.ny_start} → ${ev302.ny_end || 'NULL'} deleted=${ev302.deleted_at ? 'YES' : 'NO'}`);
    console.log(`    closed_reason="${ev302.closed_reason || '—'}"`);
    console.log(`    source_ts=${ev302.source_message_ts || 'NULL'}`);
    console.log(`    desc: "${ev302.desc}"`);
    if (ev302.source_message_ts) {
      const m = (await pool.query(`
        SELECT id, slack_user_id, slack_ts, raw_text
        FROM v3.messages WHERE slack_ts = $1`, [ev302.source_message_ts])).rows[0];
      if (m) console.log(`    msg origem: msg${m.id} from=${m.slack_user_id} text="${(m.raw_text || '').slice(0, 200)}"`);
    }
  }
  const audit302 = (await pool.query(`
    SELECT id, action, actor_type, actor_person_id, created_at,
      metadata->>'reason' AS reason
    FROM v3.audit_log
    WHERE target_id = 302 AND action LIKE 'event%'
    ORDER BY created_at`)).rows;
  console.log(`  ev302 audit_log (${audit302.length} entries):`);
  for (const a of audit302) console.log(`    audit#${a.id} ${a.created_at} ${a.action} actor=${a.actor_type}/${a.actor_person_id || 'NULL'} reason="${a.reason || ''}"`);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 10b. OUTROS events admins criados ANTES de hoje (varredura)');
  console.log('═══════════════════════════════════════════════════════════');
  const adminIds = (await pool.query(`SELECT id FROM v3.persons WHERE role IN ('owner','manager') AND deleted_at IS NULL`)).rows.map((r) => r.id);
  const oldAdminEvs = (await pool.query(`
    SELECT e.id, p.display_name AS person, at.slug, at.flow,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS ny_start,
      e.deleted_at IS NOT NULL AS deleted
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE e.person_id = ANY($1::int[])
      AND (e.started_at AT TIME ZONE 'America/New_York')::date < $2::date
    ORDER BY e.started_at DESC LIMIT 20`, [adminIds, TODAY])).rows;
  if (oldAdminEvs.length === 0) console.log('  ✓ nenhum event histórico em admin');
  for (const r of oldAdminEvs) {
    console.log(`  ev${r.id} ${r.person} ${r.slug}/${r.flow} ${r.ny_start} ${r.deleted ? '(DEL)' : ''}`);
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
