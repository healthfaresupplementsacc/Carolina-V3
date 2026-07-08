'use strict';
// Simone: 3 "Material prep" que ela diz não ter feito + encapsulação duplicada hoje.
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const EDT = 'America/New_York';
(async () => {
  console.log('=== "Material prep" é qual activity_type? ===');
  const at = await p.query("SELECT id, slug, display_name, is_background FROM v3.activity_types WHERE display_name ILIKE '%material%' OR display_name ILIKE '%prep%' OR slug ILIKE '%material%'");
  for (const r of at.rows) console.log(`  #${r.id} slug=${r.slug} "${r.display_name}" bg=${r.is_background}`);

  const sim = (await p.query("SELECT id, display_name FROM v3.persons WHERE display_name ILIKE 'Simone%' AND deleted_at IS NULL")).rows;
  console.log('\n=== Simone person(s):', sim.map((x) => `#${x.id} ${x.display_name}`).join(', '));
  const sid = sim.map((x) => x.id);

  console.log('\n=== Eventos de HOJE da Simone (todos, com SOURCE) ===');
  const ev = await p.query(
    `SELECT e.id, at.slug, at.display_name AS act, pr.canonical_name AS product, pb.batch_number,
            to_char(e.started_at AT TIME ZONE '${EDT}','HH24:MI:SS') AS ini,
            to_char(e.ended_at AT TIME ZONE '${EDT}','HH24:MI:SS') AS fim,
            e.source, e.bg_handoff_from_person_id AS hoff, e.is_long_running AS bg,
            to_char(e.created_at AT TIME ZONE '${EDT}','HH24:MI:SS') AS criado, e.closed_reason
       FROM v3.events e JOIN v3.activity_types at ON at.id=e.activity_type_id
       LEFT JOIN v3.product_batches pb ON pb.id=e.product_batch_id
       LEFT JOIN v3.products pr ON pr.id=pb.product_id
      WHERE e.person_id = ANY($1::int[]) AND e.deleted_at IS NULL
        AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
      ORDER BY e.created_at`, [sid]);
  for (const r of ev.rows) console.log(`  #${r.id} ${r.slug.padEnd(16)} ${(r.product||r.batch_number||'-').padEnd(18)} ${r.ini}→${r.fim||'aberto'} src=${r.source} ${r.bg?'[bg]':''}${r.hoff?(' hoff='+r.hoff):''} criado ${r.criado}${r.closed_reason?(' close='+r.closed_reason):''}`);

  console.log('\n=== ENCAPSULAÇÃO hoje (TODOS) — procurar duplicatas (mesma pessoa+lote sobrepostas) ===');
  const enc = await p.query(
    `SELECT e.id, pr2.display_name AS quem, pb.batch_number, pr.canonical_name AS product,
            to_char(e.started_at AT TIME ZONE '${EDT}','HH24:MI:SS') AS ini,
            to_char(e.ended_at AT TIME ZONE '${EDT}','HH24:MI:SS') AS fim, e.source,
            e.bg_handoff_from_person_id AS hoff, to_char(e.created_at AT TIME ZONE '${EDT}','HH24:MI:SS') AS criado, e.closed_reason
       FROM v3.events e JOIN v3.activity_types at ON at.id=e.activity_type_id
       JOIN v3.persons pr2 ON pr2.id=e.person_id
       LEFT JOIN v3.product_batches pb ON pb.id=e.product_batch_id
       LEFT JOIN v3.products pr ON pr.id=pb.product_id
      WHERE at.slug='encapsulation' AND e.deleted_at IS NULL
        AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
      ORDER BY pb.batch_number, e.started_at`, []);
  for (const r of enc.rows) console.log(`  #${r.id} ${(r.quem||'?').padEnd(14)} ${(r.product||r.batch_number||'-').padEnd(16)} ${r.ini}→${r.fim||'aberto'} src=${r.source}${r.hoff?(' hoff='+r.hoff):''} criado ${r.criado}${r.closed_reason?(' '+r.closed_reason):''}`);
  console.log('\n  total encapsulação hoje:', enc.rowCount);
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
