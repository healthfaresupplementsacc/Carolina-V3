'use strict';
/* Bruno OK em texto cru — bloco 29/mai noite. Idempotente, audited.

   Plano:
   1. SOFT-DELETE ev316 (dur=0, dup de re-processamento)
   2. SOFT-DELETE ev317 (dur=0, dup #a0 fechado pelo auto-close)
   3. PATCH ev318:
      - activity_type_id: 24 (marketplace_prep) → 22 (dc_shipment)
      - ended_at: 14:37 PM → 12:16 PM NY (per msg695 F)
      - confidence: high → medium
      - description: consolidada (fechamento + FNSKU + nota histórica)
      - product_batch_id: deixa NULL (2 Black Garlic batches ativos,
        Bruno edita pela tela depois se quiser) */
const { Pool } = require('pg');
const { EventService } = require('../src/v3/services/EventService');

const NEW_ENDED_AT_ISO = '2026-05-29T12:16:00';   // 12:16 PM NY do msg695 F
const CONSOLIDATED_DESC =
  'Fechamento das caixas para envio e troca FNSKU do Black Garlic '
  + '(preparação FBA). Consolidado retroativo via msg683 S + msg695 F. '
  + 'LLM havia segmentado em 3 events (ev316/317 zerados pelo auto-close '
  + 'fg→fg + ev318 marketplace_prep até 14:37 fechado por meta) — admin '
  + 'consolidou em UM dc_shipment 11:29→12:16. Bloco 29/mai noite #1.';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const eventService = new EventService({ db: pool });

  async function snap(id) {
    const r = await pool.query(`
      SELECT e.id, p.display_name AS person, at.slug AS activity,
        at.id AS activity_type_id, e.product_batch_id, pb.batch_number,
        pr.canonical_name AS product, e.cowork_with, e.confidence,
        TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS s,
        TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS e_t,
        e.deleted_at, e.closed_reason,
        LEFT(COALESCE(e.description,''), 130) AS desc
      FROM v3.events e
      LEFT JOIN v3.persons p ON p.id = e.person_id
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
      LEFT JOIN v3.products pr ON pr.id = pb.product_id
      WHERE e.id = $1`, [id]);
    return r.rows[0] || null;
  }
  const fmt = (s) => s
    ? `ev${s.id} ${s.person} [${s.activity}/at${s.activity_type_id}] ${s.s}→${s.e_t || 'LIVE'} prod=${s.product || '—'}/${s.batch_number || '—'} conf=${s.confidence}${s.deleted_at ? ' (DEL)' : ''} closed_reason=${s.closed_reason || '—'}`
    : 'NULL';

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' BEFORE — ev316 / ev317 / ev318');
  console.log('═══════════════════════════════════════════════════════════');
  for (const id of [316, 317, 318]) console.log('  ' + fmt(await snap(id)));

  // ═══════════════════ STEP 1 — soft-delete ev316 ═══════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' STEP 1 — SOFT-DELETE ev316 (dur=0 dup re-processamento)');
  console.log('═══════════════════════════════════════════════════════════');
  const b316 = await snap(316);
  if (b316 && b316.deleted_at) console.log('  ev316 já deletado — skip');
  else if (b316) {
    await eventService.softDelete(316, null,
      'Bloco 29/mai noite #1: dup com dur=0 da msg683. Primeira tentativa do LLM criou ev316 (single box_closing); segunda tentativa (re-process com suffixes) criou ev317 (#a0) cujo started_at idêntico ao ev316 disparou auto-close fg→fg → ev316.ended_at = started_at → dur=0. Soft-delete. Autorizado Bruno texto cru.',
      'admin');
    console.log('  ev316 SOFT-DELETED');
  }

  // ═══════════════════ STEP 2 — soft-delete ev317 ═══════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' STEP 2 — SOFT-DELETE ev317 (dur=0 dup #a0)');
  console.log('═══════════════════════════════════════════════════════════');
  const b317 = await snap(317);
  if (b317 && b317.deleted_at) console.log('  ev317 já deletado — skip');
  else if (b317) {
    await eventService.softDelete(317, null,
      'Bloco 29/mai noite #1: dup com dur=0 — ev317 (#a0) criado no mesmo started_at que ev318 (#a1); auto-close fg→fg de ev318 zerou ev317. Soft-delete. Autorizado Bruno texto cru.',
      'admin');
    console.log('  ev317 SOFT-DELETED');
  }

  // ═══════════════════ STEP 3 — PATCH ev318 ═══════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' STEP 3 — PATCH ev318 → dc_shipment + ended 12:16 PM + desc consolidada');
  console.log('═══════════════════════════════════════════════════════════');
  const b318 = await snap(318);
  if (!b318 || b318.deleted_at) console.log('  ev318 indisponível — skip');
  else {
    await eventService.correct(318, {
      activity_type_id: 22,             // dc_shipment
      ended_at: NEW_ENDED_AT_ISO,
      confidence: 'medium',
      description: CONSOLIDATED_DESC,
    }, null,
    'Bloco 29/mai noite #1: consolida fechamento das caixas + FNSKU em UM dc_shipment 11:29→12:16 PM (per msg683 S + msg695 F). Ajusta activity 24 (marketplace_prep) → 22 (dc_shipment) conforme regra 28 (FBA/WFS = dc_shipment), encurta ended_at 14:37 → 12:16, confidence high → medium. Autorizado Bruno texto cru.',
    'admin');
    console.log('  ev318 PATCHED');
  }

  // ═══════════════════ AFTER + AUDIT ═══════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' AFTER — snapshot final');
  console.log('═══════════════════════════════════════════════════════════');
  for (const id of [316, 317, 318]) console.log('  ' + fmt(await snap(id)));

  const audits = await pool.query(`
    SELECT action, COUNT(*)::int AS c FROM v3.audit_log
    WHERE created_at >= NOW() - interval '3 minutes' GROUP BY action ORDER BY action`);
  console.log('\n  AUDIT rows nos últimos 3min:');
  for (const r of audits.rows) console.log(`    ${r.action}: ${r.c}`);

  await pool.end();
  console.log('\n✓ Bloco 29/mai noite #1 APLICADO.');
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
