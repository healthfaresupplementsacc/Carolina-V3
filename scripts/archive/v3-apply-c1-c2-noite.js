'use strict';
/* Bruno OK: ok C1 C2 — aplica em prod.
   C1: ev257 activity_type_id NULL → 28 (material_handling)
   C2: ev252 is_long_running=true (Lithium encapsulation multi-dia possível)
   Idempotente, audited, reversível. */
const { Pool } = require('pg');
const { EventService } = require('../src/v3/services/EventService');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const eventService = new EventService({ db: pool });

  async function snap(id) {
    const r = await pool.query(`
      SELECT
        e.id, e.person_id, e.activity_type_id, e.is_long_running, e.closed_reason,
        at.slug AS activity, at.display_name AS act_display,
        TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_start,
        TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_end,
        pr.canonical_name AS product, pb.batch_number AS batch,
        LEFT(COALESCE(e.description,''), 100) AS desc
      FROM v3.events e
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
      LEFT JOIN v3.products pr ON pr.id = pb.product_id
      WHERE e.id = $1`, [id]);
    return r.rows[0] || null;
  }

  // ───── C1 — ev257 → material_handling ─────
  console.log('═══════════════════════════════════════════════════');
  console.log(' C1 — ev257 → material_handling (id=28)');
  console.log('═══════════════════════════════════════════════════');
  const c1Before = await snap(257);
  console.log('BEFORE:', c1Before);
  if (c1Before && c1Before.activity_type_id === 28) {
    console.log('  já está em material_handling — skip (idempotente)');
  } else if (c1Before) {
    const r = await eventService.correct(257,
      { activity_type_id: 28 },
      null,
      'C1 27/mai-noite: regra 30 (material_handling). ev criado pela regra 24 com type=NULL pois activity_type não existia no catálogo. Agora classifica retroativo. Autorizado Bruno texto cru.',
      'admin');
    console.log('AFTER :', {
      id: r.id, activity_type_id: r.activity_type_id,
      desc_preview: String(r.description || '').slice(0, 80),
    });
  }

  // ───── C2 — ev252 → is_long_running=true ─────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' C2 — ev252 Lithium encapsulation → is_long_running=true');
  console.log('═══════════════════════════════════════════════════');
  const c2Before = await snap(252);
  console.log('BEFORE:', c2Before);
  if (c2Before && c2Before.is_long_running === true) {
    console.log('  já é long_running — skip (idempotente)');
  } else if (c2Before) {
    const r = await eventService.markLongRunning(252, true, {
      actorType: 'admin',
      reason: 'C2 27/mai-noite: Lithium 0166 encapsulação — última msg 3:39 PM com contagem parcial (FBA>500, WH>150). Sem F explícito ainda; multi-dia possível. Autorizado Bruno texto cru.',
    });
    console.log('AFTER :', {
      id: r.id, is_long_running: r.is_long_running,
    });
  }

  // ───── SMOKE final ─────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' SMOKE FINAL');
  console.log('═══════════════════════════════════════════════════');
  console.log('ev257:', await snap(257));
  console.log('ev252:', await snap(252));
  // checa long_running totals (Potassium + Chromium + Lithium)
  const longRun = await pool.query(`
    SELECT e.id, p.display_name AS person, at.slug, pr.canonical_name AS product, pb.batch_number AS batch
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.is_long_running = true AND e.deleted_at IS NULL AND e.ended_at IS NULL
    ORDER BY e.id`);
  console.log('\nTODOS events long_running abertos AGORA:');
  for (const r of longRun.rows) {
    console.log(`  ev${r.id} ${r.person} ${r.slug} ${r.product || '—'}/${r.batch || '—'}`);
  }

  const auditRecent = await pool.query(`
    SELECT action, COUNT(*)::int AS c
    FROM v3.audit_log
    WHERE created_at >= NOW() - interval '5 minutes'
    GROUP BY action ORDER BY action`);
  console.log('\nAUDIT rows nos últimos 5min:');
  for (const r of auditRecent.rows) console.log(`  ${r.action}: ${r.c}`);

  await pool.end();
  console.log('\n✓ C1 + C2 APLICADAS.');
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
