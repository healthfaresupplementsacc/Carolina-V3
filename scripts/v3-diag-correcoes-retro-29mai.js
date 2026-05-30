'use strict';
/* DIAG read-only — estado atual dos events que precisam de correção retroativa. */
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  async function snap(id) {
    const r = await pool.query(`
      SELECT e.id, e.person_id, p.display_name AS person, at.slug, at.flow,
        TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS s_ny,
        TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS e_ny,
        e.started_at, e.ended_at, e.deleted_at, e.closed_reason, e.confidence,
        pb.batch_number, pr.canonical_name AS product, e.cowork_with,
        LEFT(COALESCE(e.description,''), 100) AS desc
      FROM v3.events e
      LEFT JOIN v3.persons p ON p.id = e.person_id
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
      LEFT JOIN v3.products pr ON pr.id = pb.product_id
      WHERE e.id = $1`, [id]);
    return r.rows[0] || null;
  }
  const fmt = (s) => s
    ? `ev${s.id} ${s.person}(${s.person_id}) [${s.slug}/${s.flow}] ${s.s_ny}→${s.e_ny || 'LIVE'}\n     prod=${s.product || '—'}/${s.batch_number || '—'} closed=${s.closed_reason || '—'} cw=${JSON.stringify(s.cowork_with)} conf=${s.confidence}${s.deleted_at ? ' (DEL)' : ''}\n     desc: "${s.desc}"`
    : 'NULL';

  console.log('═══ (a) ev326 lunch Vitor — corrigir 16:57 → 16:08:38 (F real msg714) ═══');
  console.log('  ' + fmt(await snap(326)));

  console.log('\n═══ (b) ev306 Simone impressão — corrigir 11:13 → 09:53 (F explícito msg667) ═══');
  console.log('  ' + fmt(await snap(306)));

  console.log('\n═══ (c) Akkermansia manual Simone — CRIAR retroativo 10:54→11:02 ═══');
  console.log('  (não existe — msg676 S + msg678 F sumiram pré-incidente)');

  console.log('\n═══ (d) ev334 Bruno Sarmento Chromium downtime — TZ shift +1h (msg726 17:31) ═══');
  console.log('  ' + fmt(await snap(334)));

  console.log('\n═══ (e) ev335 Bruno Sarmento line_changeover — TZ shift +1h20 (msg724 17:27) ═══');
  console.log('  ' + fmt(await snap(335)));

  console.log('\n═══ (f) ev330 Simone Akkermansia ended_at = 18:34 — devia ser 17:34 (msg727) ═══');
  console.log('  ' + fmt(await snap(330)));

  console.log('\n═══ (g) ev332/333 Ana ÓRFÃOS — sem source_message_ts; admin creation? ═══');
  console.log('  ' + fmt(await snap(332)));
  console.log('  ' + fmt(await snap(333)));

  console.log('\n═══ (h) machine_downtime msg722 4:18-4:52 PM (Carolina não criou) ═══');
  console.log('  (não existe — caso item 6 TODO; criar retroativo via patch direto)');

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
