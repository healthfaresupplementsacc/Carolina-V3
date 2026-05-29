'use strict';
/* Bruno OK em texto cru — bloco 28/mai noite Leva D writes. Idempotente, audited.

   Plano:
   1. Cria batch Potassium Iodide / BR-2026-0170 (product_id=57).
   2. PATCH 6 events da linha de Potassium:
      ev280 Vitor 12:11→12:45    batch=NEW                 cw=[] (mantém)
      ev281 Ana   12:23→14:57    batch=NEW   cw=[5,4]→[4]
      ev286 Simone 12:56→13:11   batch=NEW   cw=[]→[4,6]
      ev289 Vitor 13:30→16:32    batch=NEW   cw=[5,6]→[6]
      ev293 Simone 14:55→18:49   batch=NEW   cw=[4,6] (mantém)
      ev299 Ana   15:43→17:56    batch=NEW   cw=[]→[4,5]
   3. SOFT-DELETE ev298 (Ana 15:43→15:43, 0min, duplicata da msg630 "Voltei"). */
const { Pool } = require('pg');
const { BatchService } = require('../src/v3/services/BatchService');
const { EventService } = require('../src/v3/services/EventService');

const POTASSIUM_PRODUCT_ID = 57;
const NEW_BATCH_NUMBER     = 'BR-2026-0170';
const NEW_BATCH_START_ISO  = '2026-05-28T12:11:00';  // primeira msg de Potassium (msg606 Vitor)

const PATCHES = [
  { id: 280, cw: null,    note: 'Vitor primeiro start Potassium — msg606 "S: Iniciando linha de producao - Potassium"' },
  { id: 281, cw: [4],     note: 'Ana 12:23 — cw=[5] removido (Simone só começou 12:56, era inferência incorreta do LLM)' },
  { id: 286, cw: [4, 6],  note: 'Simone 12:56 — Vitor (4) e Ana (6) estavam na linha; cw faltando' },
  { id: 289, cw: [6],     note: 'Vitor 13:30 — cw=[5] removido (Simone fechou ev286 às 13:11), só Ana (6) presente' },
  { id: 293, cw: [4, 6],  note: 'Simone 14:55 — mantém cw=[Vitor,Ana] (já correto)' },
  { id: 299, cw: [4, 5],  note: 'Ana 15:43 — cw faltando: Vitor (4) e Simone (5) já estavam na linha' },
];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const batchService = new BatchService({ db: pool });
  const eventService = new EventService({ db: pool });

  async function snap(id) {
    const r = await pool.query(`
      SELECT
        e.id, e.person_id, p.display_name AS person,
        e.product_batch_id, pb.batch_number, pr.canonical_name AS product,
        e.cowork_with,
        e.deleted_at,
        TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS s,
        TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS e_t,
        LEFT(COALESCE(e.description,''), 80) AS desc
      FROM v3.events e
      LEFT JOIN v3.persons p ON p.id = e.person_id
      LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
      LEFT JOIN v3.products pr ON pr.id = pb.product_id
      WHERE e.id = $1`, [id]);
    return r.rows[0] || null;
  }
  const fmt = (s) => s
    ? `ev${s.id} ${s.s}→${s.e_t || 'LIVE'} ${s.person} prod=${s.product || '—'}/${s.batch_number || '—'} cw=[${(s.cowork_with || []).join(',')}]${s.deleted_at ? ' (DEL)' : ''}`
    : 'NULL';

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' BEFORE — snapshot dos 7 events');
  console.log('═══════════════════════════════════════════════════════════');
  for (const id of [280, 281, 286, 289, 293, 298, 299]) console.log('  ' + fmt(await snap(id)));

  // ═══════════════════ 1. CRIAR / OBTER BATCH ═══════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' STEP 1 — findOrCreateActive batch Potassium BR-2026-0170');
  console.log('═══════════════════════════════════════════════════════════');
  const batch = await batchService.findOrCreateActive(
    POTASSIUM_PRODUCT_ID, NEW_BATCH_NUMBER, NEW_BATCH_START_ISO,
    { actorType: 'admin', actorPersonId: null });
  console.log(`  batch_id=${batch.id} ${batch.batch_number} product_id=${batch.product_id} status=${batch.status} started_at=${batch.started_at}`);

  // ═══════════════════ 2. PATCH 6 events ═══════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' STEP 2 — PATCH 6 events com Potassium 0170 + cowork');
  console.log('═══════════════════════════════════════════════════════════');
  for (const p of PATCHES) {
    const before = await snap(p.id);
    if (!before) { console.log(`  ev${p.id} NÃO existe — skip`); continue; }
    if (before.deleted_at) { console.log(`  ev${p.id} já está deletado — skip`); continue; }
    const sameBatch = before.product_batch_id === batch.id;
    const sameCw = p.cw == null
      ? true
      : JSON.stringify((before.cowork_with || []).slice().sort()) === JSON.stringify((p.cw || []).slice().sort());
    if (sameBatch && sameCw) { console.log(`  ev${p.id} já está como esperado — skip`); continue; }
    const patch = { product_batch_id: batch.id };
    if (p.cw != null) patch.cowork_with = p.cw;
    const reason = `Bloco 28/mai noite Leva D: atribui Potassium BR-2026-0170 + ajusta cowork. ${p.note}. Autorizado Bruno texto cru.`;
    const r = await eventService.correct(p.id, patch, null, reason, 'admin');
    const after = await snap(p.id);
    console.log(`  ev${p.id}:`);
    console.log(`    BEFORE: ${fmt(before)}`);
    console.log(`    AFTER : ${fmt(after)}`);
    console.log(`    reason: "${p.note}"`);
  }

  // ═══════════════════ 3. SOFT-DELETE ev298 ═══════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' STEP 3 — SOFT-DELETE ev298 (Ana 15:43→15:43, duplicata 0min)');
  console.log('═══════════════════════════════════════════════════════════');
  const b298 = await snap(298);
  console.log('  BEFORE:', fmt(b298));
  if (b298 && b298.deleted_at) {
    console.log('  ev298 já está soft-deleted — skip');
  } else if (b298) {
    const r = await eventService.softDelete(298, null,
      'Bloco 28/mai noite Leva D: duplicata 0min — msg630 "Ana- Voltei" sem S/F e msg631 "Ana- S; linha de producao" criou ev299 imediatamente depois. ev298 é dup vazio. Autorizado Bruno texto cru.',
      'admin');
    const after = await snap(298);
    console.log('  AFTER :', fmt(after));
  }

  // ═══════════════════ AFTER FINAL ═══════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' AFTER — snapshot final');
  console.log('═══════════════════════════════════════════════════════════');
  for (const id of [280, 281, 286, 289, 293, 298, 299]) console.log('  ' + fmt(await snap(id)));

  // ═══════════════════ AUDIT COUNTS ═══════════════════
  const audits = await pool.query(`
    SELECT action, COUNT(*)::int AS c
    FROM v3.audit_log WHERE created_at >= NOW() - interval '5 minutes'
    GROUP BY action ORDER BY action`);
  console.log('\n  AUDIT rows nos últimos 5min:');
  for (const r of audits.rows) console.log(`    ${r.action}: ${r.c}`);

  await pool.end();
  console.log('\n✓ Leva D APLICADA.');
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
