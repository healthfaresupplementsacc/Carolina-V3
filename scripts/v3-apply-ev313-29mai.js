'use strict';
/* Bruno OK em texto cru — PATCH ev313 Ana 29/mai entrando na linha do
   Vitor (Potassium 0170). Idempotente, audited via EventService.correct. */
const { Pool } = require('pg');
const { EventService } = require('../src/v3/services/EventService');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const eventService = new EventService({ db: pool });

  async function snap(id) {
    const r = await pool.query(`
      SELECT e.id, p.display_name AS person, at.slug AS activity,
        e.product_batch_id, pb.batch_number, pr.canonical_name AS product,
        e.cowork_with, e.confidence,
        TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS s,
        TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS e_t,
        e.deleted_at,
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
    ? `ev${s.id} ${s.person} ${s.activity} ${s.s}→${s.e_t || 'LIVE'} prod=${s.product || '—'}/${s.batch_number || '—'} cw=[${(s.cowork_with || []).join(',')}] conf=${s.confidence}${s.deleted_at ? ' (DEL)' : ''}`
    : 'NULL';

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' BEFORE — ev313 Ana 10:44 AM 29/mai');
  console.log('═══════════════════════════════════════════════════════════');
  const before = await snap(313);
  console.log('  ' + fmt(before));

  if (!before) { console.error('ev313 não existe'); await pool.end(); process.exit(1); }
  if (before.product_batch_id === 24 && (before.cowork_with || []).includes(4)) {
    console.log('\n  ✓ já patcheado — skip');
    await pool.end(); process.exit(0);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' PATCH ev313: batch=BR-2026-0170 Potassium · cw=[4] (Vitor) · uncertain · confidence=medium');
  console.log('═══════════════════════════════════════════════════════════');
  await eventService.correct(313, {
    product_batch_id: 24,
    cowork_with: [4],
    confidence: 'medium',
  }, null,
  'Bloco 29/mai Bug#2: Ana "S; linha de producao" 10:44 AM 40min após Vitor abrir Potassium (ev311). LLM não inferiu produto/cowork via EQUIPE. Inferência conforme regra 33 nova: product=Potassium Iodide BR-2026-0170 (batch_id=24), cowork=[Vitor person_id=4], confidence=medium (inferência via EQUIPE, não explícito na msg). Autorizado Bruno texto cru.',
  'admin');

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' AFTER');
  console.log('═══════════════════════════════════════════════════════════');
  const after = await snap(313);
  console.log('  ' + fmt(after));

  console.log('\n  --- AUDIT row ---');
  const audit = await pool.query(`
    SELECT id, action, actor_type, actor_person_id, created_at,
      metadata->>'note' AS note,
      jsonb_pretty(before_data) AS before, jsonb_pretty(after_data) AS after
    FROM v3.audit_log
    WHERE target_id = 313 AND action = 'event.corrected'
    ORDER BY created_at DESC LIMIT 1`);
  if (audit.rows[0]) {
    const a = audit.rows[0];
    console.log(`  audit#${a.id} ${a.action} actor=${a.actor_type}/${a.actor_person_id || 'NULL'} created=${a.created_at}`);
    console.log(`  note: "${(a.note || '').slice(0, 200)}"`);
    console.log(`  before (subset): ${(a.before || '').slice(0, 280)}`);
    console.log(`  after  (subset): ${(a.after  || '').slice(0, 280)}`);
  }

  await pool.end();
  console.log('\n✓ ev313 PATCHED.');
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
