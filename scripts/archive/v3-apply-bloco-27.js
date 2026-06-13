'use strict';
/**
 * BLOCO 27/mai — apply writes autorizados pelo Bruno (texto cru).
 *
 *   item 1 — re-point 8 events de batch_id=13 (Graviola 0158 errado) → 18
 *            (Graviola "0150" correto) + soft-delete batch_id=13
 *   item 2 — migration 012 (line_changeover activity_type) + reclassifica
 *            ev224 (Bruno Sarmento "Linha"  → line_changeover, cowork=[4 Vitor])
 *            ev225 (Vitor "troca"           → line_changeover, cowork=[7 Bruno])
 *            ev224 mantém ended_at em 11:36 NY conforme Bruno autorizou
 *   item 4-simone — ev233 produto Aged Black Garlic + batch 0167 incoerente
 *            → re-point pro batch correto de Berberine 0167 (linha onde
 *            Vitor/Ana estavam no momento)
 *
 * Idempotente — cada operação checa estado antes (re-run não duplica).
 * Audita TUDO via EventService.correct / BatchService.reassignEvents / SQL
 * direto pra mutações fora dos services.
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { EventService } = require('../src/v3/services/EventService');
const { BatchService } = require('../src/v3/services/BatchService');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const eventService = new EventService({ db: pool });
  const batchService = new BatchService({ db: pool });

  console.log('═══════════════════════════════════════════════════');
  console.log(' 0. PRECHECK');
  console.log('═══════════════════════════════════════════════════');
  const now = await pool.query("SELECT now() AT TIME ZONE 'America/New_York' AS ny_now");
  console.log('  NY now:', now.rows[0].ny_now);

  // ──────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' ITEM 1 — batch 0158 Graviola/Licorice');
  console.log('═══════════════════════════════════════════════════');
  const batch13 = await pool.query('SELECT id, batch_number, product_id, deleted_at FROM v3.product_batches WHERE id = 13');
  if (!batch13.rows[0]) {
    console.log('  batch_id=13 não existe — skip');
  } else if (batch13.rows[0].deleted_at) {
    console.log('  batch_id=13 já está soft-deleted em', batch13.rows[0].deleted_at, '— skip (idempotente)');
  } else {
    // 1.a) reassignEvents 13 → 18
    const ev13Before = await pool.query("SELECT id FROM v3.events WHERE product_batch_id = 13 AND deleted_at IS NULL ORDER BY id");
    const idsBefore = ev13Before.rows.map((r) => r.id);
    console.log(`  events apontando batch_id=13 (antes): [${idsBefore.join(', ')}]`);
    if (idsBefore.length > 0) {
      const r = await batchService.reassignEvents(13, 18, 'admin');
      console.log(`  reassignEvents(13 → 18): ${r.reassigned.length} events movidos: [${r.reassigned.join(', ')}]`);
    }
    // 1.b) soft-delete batch_id=13
    await pool.query(`
      UPDATE v3.product_batches SET deleted_at = NOW() WHERE id = 13 AND deleted_at IS NULL`);
    await pool.query(`
      INSERT INTO v3.audit_log
        (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data, metadata)
      VALUES ('admin', NULL, 'batch.soft_deleted', 'batch', 13, $1::jsonb, NULL, $2::jsonb)`,
      [JSON.stringify(batch13.rows[0]),
       JSON.stringify({ reason: 'duplicate_0158_wrong_product', authorized_by: 'Bruno (texto cru 27/mai item 1)' })]);
    console.log('  batch_id=13 soft-deleted ✓');
  }
  // SMOKE
  const ev13After = await pool.query("SELECT COUNT(*)::int AS c FROM v3.events WHERE product_batch_id = 13 AND deleted_at IS NULL");
  const ev18After = await pool.query("SELECT COUNT(*)::int AS c FROM v3.events WHERE product_batch_id = 18 AND deleted_at IS NULL");
  console.log(`  smoke: events em batch_id=13 agora = ${ev13After.rows[0].c} | batch_id=18 = ${ev18After.rows[0].c}`);

  // ──────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' ITEM 2 — migration 012 line_changeover + reclassifica');
  console.log('═══════════════════════════════════════════════════');
  const m012 = fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '012_line_changeover.sql'), 'utf8');
  await pool.query(m012);
  const lc = await pool.query("SELECT id, slug, display_name, flow FROM v3.activity_types WHERE slug = 'line_changeover'");
  if (!lc.rows[0]) { console.error('  ERRO: line_changeover não foi criado'); await pool.end(); process.exit(2); }
  const lineChangeoverId = lc.rows[0].id;
  console.log(`  line_changeover activity_type criado: id=${lineChangeoverId} flow=${lc.rows[0].flow}`);

  // 2.a) ev225 Vitor → line_changeover + cowork=[7]
  const ev225Before = await pool.query("SELECT * FROM v3.events WHERE id = 225 AND deleted_at IS NULL");
  if (!ev225Before.rows[0]) console.log('  ev225 não existe ou já deletado — skip');
  else if (ev225Before.rows[0].activity_type_id === lineChangeoverId
           && Array.isArray(ev225Before.rows[0].cowork_with)
           && ev225Before.rows[0].cowork_with.includes(7)) {
    console.log('  ev225 já está em line_changeover + cowork=[7] — skip (idempotente)');
  } else {
    const r = await eventService.correct(225, {
      activity_type_id: lineChangeoverId,
      cowork_with: Array.from(new Set([...(ev225Before.rows[0].cowork_with || []), 7])),
    }, null, 'troca de linha 27/mai: reclassifica organization→line_changeover, cowork com Bruno Sarmento', 'admin');
    console.log(`  ev225 (Vitor troca) → activity_type_id=${r.activity_type_id}, cowork_with=[${r.cowork_with}]`);
  }

  // 2.b) ev224 Bruno → line_changeover + cowork=[4], mantém ended_at
  const ev224Before = await pool.query("SELECT * FROM v3.events WHERE id = 224 AND deleted_at IS NULL");
  if (!ev224Before.rows[0]) console.log('  ev224 não existe ou já deletado — skip');
  else if (ev224Before.rows[0].activity_type_id === lineChangeoverId
           && Array.isArray(ev224Before.rows[0].cowork_with)
           && ev224Before.rows[0].cowork_with.includes(4)) {
    console.log('  ev224 já está em line_changeover + cowork=[4] — skip (idempotente)');
  } else {
    const r = await eventService.correct(224, {
      activity_type_id: lineChangeoverId,
      cowork_with: Array.from(new Set([...(ev224Before.rows[0].cowork_with || []), 4])),
      // NÃO mexe em ended_at — Bruno explicitamente disse "mantém ended_at em 11:36"
    }, null, 'troca de linha 27/mai: Bruno Sarmento estava cowork na troca do Vitor (no-product → setup)', 'admin');
    console.log(`  ev224 (Bruno Linha) → activity_type_id=${r.activity_type_id}, cowork_with=[${r.cowork_with}]`);
  }

  // ──────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' ITEM 4 SIMONE — ev233 produto → Berberine 0167');
  console.log('═══════════════════════════════════════════════════');
  // Acha batch_id de Berberine 0167
  const berbBatch = await pool.query(`
    SELECT pb.id FROM v3.product_batches pb
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE pb.batch_number = 'BR-2026-0167' AND pr.canonical_name ILIKE 'Berberine%'
      AND pb.deleted_at IS NULL`);
  if (!berbBatch.rows[0]) {
    console.log('  batch Berberine BR-2026-0167 não encontrado — STOP item 4');
  } else {
    const targetBatchId = berbBatch.rows[0].id;
    console.log(`  target batch (Berberine 0167) = batch_id=${targetBatchId}`);
    const ev233Before = await pool.query("SELECT * FROM v3.events WHERE id = 233 AND deleted_at IS NULL");
    if (!ev233Before.rows[0]) console.log('  ev233 não existe ou deletado — skip');
    else if (ev233Before.rows[0].product_batch_id === targetBatchId) {
      console.log('  ev233 já aponta pro batch correto — skip (idempotente)');
    } else {
      const r = await eventService.correct(233, {
        product_batch_id: targetBatchId,
      }, null, 'item 4 27/mai: Simone production_line — produto inferido errado (Aged Black Garlic+0167 incoerente); linha real era Berberine 0167 (mesma que Vitor/Ana)', 'admin');
      console.log(`  ev233 product_batch_id: ${ev233Before.rows[0].product_batch_id} → ${r.product_batch_id} ✓`);
    }
  }

  // ──────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' SMOKE FINAL — events afetados');
  console.log('═══════════════════════════════════════════════════');
  const final = await pool.query(`
    SELECT e.id, p.display_name AS person, at.slug AS activity, at.id AS atid,
           e.cowork_with,
           pb.batch_number AS batch, pr.canonical_name AS product
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.id IN (224, 225, 233, 166, 171, 178, 186, 187, 191, 205, 207)
    ORDER BY e.id`);
  for (const r of final.rows) {
    console.log(`  ev${r.id} ${(r.person || '?').padEnd(15)} ${(r.activity || '?').padEnd(20)} (atid=${r.atid || '?'}) cw=[${r.cowork_with || []}]  ${r.product || '?'}/${r.batch || '?'}`);
  }

  const auditRecent = await pool.query(`
    SELECT action, COUNT(*)::int AS c
    FROM v3.audit_log
    WHERE created_at >= NOW() - interval '10 minutes'
      AND (metadata->>'authorized_by' LIKE '%27/mai%' OR metadata->>'from' IS NOT NULL OR action IN ('event.corrected', 'batch.events_reassigned', 'batch.soft_deleted'))
    GROUP BY action ORDER BY action`);
  console.log('\n  AUDIT rows recentes:');
  for (const r of auditRecent.rows) console.log(`    ${r.action}: ${r.c}`);

  await pool.end();
  console.log('\n✓ Writes do BLOCO 27/mai aplicados (idempotente).');
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
