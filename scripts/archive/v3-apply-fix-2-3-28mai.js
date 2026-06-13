'use strict';
/* Bruno OK em texto cru — aplica em prod, idempotente, audited.

   FIX 2 (2 events retroativos da Simone):
     ev_A: order_printing 10:09 AM → 11:27 AM, qty=129, person=5 (Simone)
     ev_C: orders         11:27 AM → 12:01 PM,           person=5 (Simone)

   FIX 3:
     ev280: PATCH person_id 7→4 (Vitor)
     ev284: DELETE (soft) — duplicata lunch errada
     ev268: NADA (deixa como está) */
const { Pool } = require('pg');
const { EventService } = require('../src/v3/services/EventService');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const eventService = new EventService({ db: pool });

  async function snap(id) {
    const r = await pool.query(`
      SELECT
        e.id, e.person_id, e.activity_type_id, e.product_batch_id,
        e.deleted_at, e.closed_reason,
        TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS ny_start,
        TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS ny_end,
        at.slug AS activity, p.display_name AS person,
        LEFT(COALESCE(e.description,''), 80) AS desc
      FROM v3.events e
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      LEFT JOIN v3.persons p ON p.id = e.person_id
      WHERE e.id = $1`, [id]);
    return r.rows[0] || null;
  }

  // Pega timestamps EXATOS das msgs 587/596/601 (slack_ts) pra usar como
  // started_at/ended_at — preserva precisão e fica auditável.
  async function msgTs(id) {
    const r = await pool.query(`
      SELECT slack_ts, to_timestamp(slack_ts::numeric)::text AS iso
      FROM v3.messages WHERE id = $1`, [id]);
    return r.rows[0];
  }
  const m587 = await msgTs(587);  // 10:09 AM
  const m596 = await msgTs(596);  // 11:27 AM
  const m601 = await msgTs(601);  // 12:01 PM
  console.log('Timestamps origem das msgs:');
  console.log('  msg587:', m587);
  console.log('  msg596:', m596);
  console.log('  msg601:', m601);

  // ═══════════════════ FIX 2 ev_A ═══════════════════
  console.log('\n══════════════════════════════════════════════════');
  console.log(' FIX 2 ev_A — order_printing Simone 10:09→11:27 AM');
  console.log('══════════════════════════════════════════════════');
  // Idempotência: checa se já existe event Simone order_printing 28/mai
  const existsA = await pool.query(`
    SELECT id FROM v3.events
    WHERE person_id = 5 AND activity_type_id = 19 AND deleted_at IS NULL
      AND (started_at AT TIME ZONE 'America/New_York')::date = '2026-05-28'`);
  if (existsA.rows[0]) {
    console.log(`  ev${existsA.rows[0].id} já existe (Simone order_printing 28/mai) — skip`);
  } else {
    const created = await eventService.upsert({
      person_id: 5,
      activity_type_id: 19,                       // order_printing
      product_batch_id: null,
      started_at: m587.iso,                       // 10:09 AM (slack_ts msg587)
      ended_at:   m596.iso,                       // 11:27 AM (slack_ts msg596)
      source_message_ts: null,                    // admin retro create — não usa idempotência
      confidence: 'high',
      cowork_with: [],
      quantity: 129,
      quantity_unit: 'order',
      description: 'Impressão de ordens — 129 ordens (inclui 1ª e 2ª impressão; criado retroativo, msg587/596 não geraram event automático).',
      actor_type: 'admin',
      actor_person_id: null,
    });
    console.log(`  ev${created.id} CREATED:`);
    console.log('  ', await snap(created.id));
  }

  // ═══════════════════ FIX 2 ev_C ═══════════════════
  console.log('\n══════════════════════════════════════════════════');
  console.log(' FIX 2 ev_C — orders Simone 11:27 AM → 12:01 PM');
  console.log('══════════════════════════════════════════════════');
  const existsC = await pool.query(`
    SELECT id FROM v3.events
    WHERE person_id = 5 AND activity_type_id = 15 AND deleted_at IS NULL
      AND (started_at AT TIME ZONE 'America/New_York')::date = '2026-05-28'`);
  if (existsC.rows[0]) {
    console.log(`  ev${existsC.rows[0].id} já existe (Simone orders 28/mai) — skip`);
  } else {
    const created = await eventService.upsert({
      person_id: 5,
      activity_type_id: 15,                       // orders
      product_batch_id: null,
      started_at: m596.iso,                       // 11:27 AM (= fim do ev_A)
      ended_at:   m601.iso,                       // 12:01 PM (slack_ts msg601)
      source_message_ts: null,
      confidence: 'high',
      cowork_with: [],
      description: 'Finalização das ordens (criado retroativo a partir de msg601).',
      actor_type: 'admin',
      actor_person_id: null,
    });
    console.log(`  ev${created.id} CREATED:`);
    console.log('  ', await snap(created.id));
  }

  // ═══════════════════ FIX 3 ev280 ═══════════════════
  console.log('\n══════════════════════════════════════════════════');
  console.log(' FIX 3 — ev280 REATRIBUIR person_id 7→4 (Vitor)');
  console.log('══════════════════════════════════════════════════');
  const b280 = await snap(280);
  console.log('BEFORE:', b280);
  if (b280 && b280.person_id === 4) {
    console.log('  já atribuído ao Vitor — skip');
  } else if (b280 && b280.deleted_at) {
    console.log('  ev280 já está deletado — skip');
  } else if (b280) {
    const r = await eventService.correct(280,
      { person_id: 4 },
      null,
      'FIX 3 28/mai: msg606 "S: Iniciando linha de producao - Potassium" sem assinatura -Bruno, veio do account do Vitor (U08JC85HMNE). Era do Vitor (acabou Rhodiola 11:06, ia começar próxima linha). Autorizado Bruno texto cru.',
      'admin');
    console.log('AFTER :', { id: r.id, person_id: r.person_id });
  }

  // ═══════════════════ FIX 3 ev284 ═══════════════════
  console.log('\n══════════════════════════════════════════════════');
  console.log(' FIX 3 — ev284 SOFT-DELETE (lunch duplicata errada)');
  console.log('══════════════════════════════════════════════════');
  const b284 = await snap(284);
  console.log('BEFORE:', b284);
  if (b284 && b284.deleted_at) {
    console.log('  ev284 já está soft-deleted — skip');
  } else if (b284) {
    const r = await eventService.softDelete(284, null,
      'FIX 3 28/mai: lunch duplicata errada — msg610 sem assinatura, era do Vitor. Lunch real do Vitor é ev285, lunch real do Bruno é ev290. Autorizado Bruno texto cru.',
      'admin');
    console.log('AFTER :', { id: r.id, deleted_at: r.deleted_at });
  }

  // ═══════════════════ SMOKE FINAL ═══════════════════
  console.log('\n══════════════════════════════════════════════════');
  console.log(' SMOKE FINAL');
  console.log('══════════════════════════════════════════════════');
  for (const id of [280, 284]) {
    console.log(`  ev${id}:`, await snap(id));
  }
  // Lista events Simone 28/mai pós-fix
  console.log('\n  Events Simone 28/mai (pós-fix):');
  const simAll = await pool.query(`
    SELECT e.id, at.slug,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_start,
      TO_CHAR(e.ended_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_end,
      e.quantity, e.quantity_unit
    FROM v3.events e
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE e.person_id = 5 AND e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = '2026-05-28'
    ORDER BY e.started_at`);
  for (const r of simAll.rows) {
    console.log(`    ev${r.id} ${r.ny_start}→${r.ny_end || 'LIVE'} ${r.slug} ${r.quantity ? `(${r.quantity} ${r.quantity_unit})` : ''}`);
  }

  // Audit count recente
  const auditRecent = await pool.query(`
    SELECT action, COUNT(*)::int AS c
    FROM v3.audit_log WHERE created_at >= NOW() - interval '5 minutes'
    GROUP BY action ORDER BY action`);
  console.log('\n  AUDIT rows nos últimos 5min:');
  for (const r of auditRecent.rows) console.log(`    ${r.action}: ${r.c}`);

  await pool.end();
  console.log('\n✓ FIX 2 + FIX 3 APLICADAS.');
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
