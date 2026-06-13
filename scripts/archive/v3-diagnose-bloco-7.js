'use strict';
/**
 * PARTE 7 — diagnóstico read-only.
 * Investiga em prod:
 *   1) Formulações sobrepostas do Bruno (Potassium, Black Garlic, Rhodiola)
 *      que violam a regra sequencial nova (mesmo prod+batch+pessoa)
 *   2) ev 166 (25/mai) — "Graviola 0158" mas batch 0158 cadastrado como Licorice?
 *   3) Card fantasma de produção batch_id=null (~12h)
 *   4) Invalid_events (duração negativa) — quais são
 *
 * SÓ SELECT. Nenhum write. Saída legível pra reportar pro Bruno.
 */
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('═══════════════════════════════════════════════════');
  console.log(' PARTE 7.1 — FORMULAÇÕES SOBREPOSTAS DO BRUNO');
  console.log('═══════════════════════════════════════════════════');
  // Lista events bg do Bruno Sarmento (formulation/mixing/encapsulation)
  // de 25-26/mai com batch_id, ordenados por started_at. Marca overlaps do
  // MESMO (product_batch_id) por essa pessoa.
  const r1 = await pool.query(`
    SELECT e.id, e.person_id, p.display_name AS person,
           at.slug AS activity, e.product_batch_id,
           pb.batch_number, pr.canonical_name AS product,
           (e.started_at AT TIME ZONE 'America/New_York') AS ny_start,
           (e.ended_at   AT TIME ZONE 'America/New_York') AS ny_end,
           e.ended_at, e.closed_reason
    FROM v3.events e
    LEFT JOIN v3.persons p           ON p.id = e.person_id
    LEFT JOIN v3.activity_types at   ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb  ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr         ON pr.id = pb.product_id
    WHERE e.deleted_at IS NULL
      AND p.display_name = 'Bruno Sarmento'
      AND at.is_background = true
      AND (e.started_at AT TIME ZONE 'America/New_York')::date IN ('2026-05-25','2026-05-26')
    ORDER BY e.started_at`);
  console.log(' Bruno Sarmento — events bg de 25-26/mai (' + r1.rows.length + '):');
  // Identifica overlaps: 2 events com mesmo (batch_id) sobrepostos no tempo
  const byBatch = new Map();
  for (const ev of r1.rows) {
    const k = String(ev.product_batch_id || '∅');
    if (!byBatch.has(k)) byBatch.set(k, []);
    byBatch.get(k).push(ev);
  }
  for (const ev of r1.rows) {
    const isOpen = !ev.ended_at;
    const start = ev.ny_start.toISOString().slice(0, 16);
    const end = ev.ny_end ? ev.ny_end.toISOString().slice(0, 16) : 'OPEN';
    console.log(`   ev${ev.id} ${start} → ${end} | ${ev.activity} | batch=${ev.product_batch_id || '∅'} (${ev.batch_number || '-'}) ${ev.product || '-'}`);
  }
  // Overlap analysis
  console.log('\n OVERLAP (mesmo batch_id, intervalo se cruza):');
  for (const [k, evs] of byBatch.entries()) {
    if (evs.length < 2) continue;
    for (let i = 0; i < evs.length - 1; i++) {
      for (let j = i + 1; j < evs.length; j++) {
        const a = evs[i], b = evs[j];
        const aEnd = a.ny_end || new Date(Date.now());
        const bStart = b.ny_start;
        if (new Date(aEnd) > new Date(bStart)) {
          console.log(`   batch=${k}: ev${a.id} (até ${a.ny_end ? a.ny_end.toISOString().slice(0,16) : 'OPEN'}) cruza ev${b.id} (de ${b.ny_start.toISOString().slice(0,16)})`);
        }
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log(' PARTE 7.2 — ev 166 (Graviola 0158?)');
  console.log('═══════════════════════════════════════════════════');
  const r2 = await pool.query(`
    SELECT e.id, e.person_id, p.display_name AS person,
           at.slug AS activity, e.product_batch_id,
           pb.id AS batch_real_id, pb.batch_number,
           pr.canonical_name AS product_in_batch,
           (e.started_at AT TIME ZONE 'America/New_York') AS ny_start,
           e.description, e.source_message_ts,
           m.raw_text AS source_text
    FROM v3.events e
    LEFT JOIN v3.persons p          ON p.id = e.person_id
    LEFT JOIN v3.activity_types at  ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr        ON pr.id = pb.product_id
    LEFT JOIN v3.messages m         ON m.slack_ts = e.source_message_ts
    WHERE e.id = 166 AND e.deleted_at IS NULL`);
  if (!r2.rows[0]) console.log('  (ev 166 não existe ou está deletado)');
  else {
    const ev = r2.rows[0];
    console.log(`  ev 166: ${ev.person} · ${ev.activity}`);
    console.log(`  product_batch_id: ${ev.product_batch_id} (DB real product: ${ev.product_in_batch}, batch_number: ${ev.batch_number})`);
    console.log(`  msg raw: "${(ev.source_text || '').slice(0,140)}"`);
    console.log(`  description: ${ev.description}`);
  }
  // Lookup do batch 0158 — qual produto está cadastrado?
  console.log('\n  Batch 0158 — quem é no v3.product_batches?');
  const r2b = await pool.query(`
    SELECT pb.id, pb.batch_number, pb.product_id, pr.canonical_name, pb.started_at, pb.status
    FROM v3.product_batches pb
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE pb.batch_number IN ('0158','BR-2026-0158','BR-0158') OR pb.batch_number LIKE '%0158%'
    ORDER BY pb.id`);
  for (const b of r2b.rows) {
    console.log(`   batch_id=${b.id} number='${b.batch_number}' product=${b.canonical_name} status=${b.status}`);
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log(' PARTE 7.3 — events BG com batch_id=null (formulação solta)');
  console.log('═══════════════════════════════════════════════════');
  const r3 = await pool.query(`
    SELECT e.id, p.display_name AS person, at.slug AS activity,
           (e.started_at AT TIME ZONE 'America/New_York') AS ny_start,
           (e.ended_at   AT TIME ZONE 'America/New_York') AS ny_end,
           e.description, e.source_message_ts,
           m.raw_text AS source_text,
           EXTRACT(EPOCH FROM (COALESCE(e.ended_at, NOW()) - e.started_at))/3600 AS hours
    FROM v3.events e
    LEFT JOIN v3.persons p          ON p.id = e.person_id
    LEFT JOIN v3.activity_types at  ON at.id = e.activity_type_id
    LEFT JOIN v3.messages m         ON m.slack_ts = e.source_message_ts
    WHERE e.deleted_at IS NULL
      AND at.is_background = true
      AND e.product_batch_id IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date IN ('2026-05-25','2026-05-26')
    ORDER BY e.started_at`);
  console.log(`  ${r3.rows.length} event(s) bg sem batch:`);
  let totalHrs = 0;
  for (const ev of r3.rows) {
    totalHrs += Number(ev.hours);
    console.log(`   ev${ev.id} ${ev.person} ${ev.activity} ${ev.ny_start.toISOString().slice(0,16)} → ${ev.ny_end ? ev.ny_end.toISOString().slice(0,16) : 'OPEN'} (${Number(ev.hours).toFixed(2)}h)`);
    console.log(`        msg: "${(ev.source_text || '').slice(0,100)}"`);
  }
  console.log(`  total horas no card-fantasma: ${totalHrs.toFixed(2)}h`);

  console.log('\n═══════════════════════════════════════════════════');
  console.log(' PARTE 7.4 — invalid_events (duração negativa/zero)');
  console.log('═══════════════════════════════════════════════════');
  const r4 = await pool.query(`
    SELECT e.id, p.display_name AS person, at.slug AS activity,
           pb.batch_number, pr.canonical_name AS product,
           (e.started_at AT TIME ZONE 'America/New_York') AS ny_start,
           (e.ended_at   AT TIME ZONE 'America/New_York') AS ny_end,
           e.ended_at,
           EXTRACT(EPOCH FROM (e.ended_at - e.started_at)) AS dur_sec,
           e.closed_reason, e.source_message_ts
    FROM v3.events e
    LEFT JOIN v3.persons p          ON p.id = e.person_id
    LEFT JOIN v3.activity_types at  ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr        ON pr.id = pb.product_id
    WHERE e.deleted_at IS NULL
      AND e.ended_at IS NOT NULL
      AND e.ended_at <= e.started_at
      AND (e.started_at AT TIME ZONE 'America/New_York')::date IN ('2026-05-25','2026-05-26')
    ORDER BY e.started_at`);
  console.log(`  ${r4.rows.length} invalid_event(s):`);
  for (const ev of r4.rows) {
    console.log(`   ev${ev.id} ${ev.person} ${ev.activity} batch=${ev.batch_number || '-'} (${ev.product || '-'})`);
    console.log(`        start=${ev.ny_start.toISOString()} end=${ev.ny_end ? ev.ny_end.toISOString() : 'null'} (dur=${ev.dur_sec}s) reason=${ev.closed_reason}`);
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
