'use strict';
// FIX: Urolithin A (BR-2026-0231) estava fora do catálogo → metas e tarefas órfãs.
// Cria o produto, o lote, religa as tarefas de formulação e conserta as metas.
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function audit(c, action, targetType, targetId, meta) {
  try { await c.query("INSERT INTO v3.audit_log (actor_type, action, target_type, target_id, metadata) VALUES ('admin', $1, $2, $3, $4::jsonb)", [action, targetType, targetId, JSON.stringify(meta || {})]); } catch (e) {}
}
(async () => {
  // 1) PRODUTO Urolithin A
  let prod = (await pool.query("SELECT id FROM v3.products WHERE canonical_name ILIKE 'Urolithin A'")).rows[0];
  if (!prod) {
    try { prod = (await pool.query("INSERT INTO v3.products (canonical_name, aliases, active) VALUES ('Urolithin A', ARRAY['HF-UROL-1000','urolithin','urolithin a'], true) RETURNING id")).rows[0]; }
    catch (e) { prod = (await pool.query("INSERT INTO v3.products (canonical_name, active) VALUES ('Urolithin A', true) RETURNING id")).rows[0]; }
    await audit(pool, 'product.created_manual', 'product', prod.id, { name: 'Urolithin A', reason: 'estava só no EMS, não no catálogo local' });
    console.log('✓ Produto criado: Urolithin A (id', prod.id + ')');
  } else console.log('• Produto já existia: Urolithin A (id', prod.id + ')');
  const pid = prod.id;

  // 2) LOTE BR-2026-0231
  let batch = (await pool.query("SELECT id FROM v3.product_batches WHERE batch_number IN ('BR-2026-0231','0231') AND deleted_at IS NULL ORDER BY id DESC LIMIT 1")).rows[0];
  if (!batch) {
    batch = (await pool.query("INSERT INTO v3.product_batches (product_id, batch_number, started_at, status, origin, created_via) VALUES ($1, 'BR-2026-0231', NOW(), 'in_progress', 'admin_fix', 'manual') RETURNING id", [pid])).rows[0];
    await audit(pool, 'batch.created_manual', 'product_batch', batch.id, { batch_number: 'BR-2026-0231', product_id: pid });
    console.log('✓ Lote criado: BR-2026-0231 (id', batch.id + ')');
  } else {
    await pool.query("UPDATE v3.product_batches SET product_id=$1 WHERE id=$2 AND product_id IS NULL", [pid, batch.id]);
    console.log('• Lote já existia: BR-2026-0231 (id', batch.id + ') → produto vinculado');
  }
  const bid = batch.id;

  // 3) RELIGA as tarefas órfãs (lote digitado 0231, sem produto) ao lote
  const ev = await pool.query(
    `UPDATE v3.events SET product_batch_id=$1, updated_at=NOW()
     WHERE product_batch_id IS NULL AND deleted_at IS NULL
       AND (description ILIKE '%lote digitado: 0231%' OR description ILIKE '%lote digitado: BR-2026-0231%')
     RETURNING id, started_at`, [bid]);
  console.log('✓ Tarefas religadas ao lote:', ev.rowCount, ev.rows.length ? '→ ev ' + ev.rows.map((r) => r.id).join(', ') : '');
  await audit(pool, 'events.relinked_to_batch', 'product_batch', bid, { event_ids: ev.rows.map((r) => r.id), product: 'Urolithin A' });

  // 3b) ajusta o started_at do lote pro 1º evento (métrica de duração correta)
  if (ev.rowCount) {
    await pool.query("UPDATE v3.product_batches SET started_at = (SELECT MIN(started_at) FROM v3.events WHERE product_batch_id=$1 AND deleted_at IS NULL) WHERE id=$1", [bid]);
    console.log('  started_at do lote = 1º evento da formulação');
  }

  // 4) METAS: vincula produto + remove a duplicada (43 e 44 são idênticas → mantém 43)
  const g = await pool.query("UPDATE v3.production_goals SET product_id=$1, updated_at=NOW() WHERE batch_number IN ('0231','BR-2026-0231') AND product_id IS NULL AND deleted_at IS NULL RETURNING id", [pid]);
  console.log('✓ Metas vinculadas ao produto:', g.rows.map((r) => r.id).join(', ') || '(nenhuma)');
  const dup = await pool.query("UPDATE v3.production_goals SET deleted_at=NOW() WHERE id=44 AND deleted_at IS NULL RETURNING id");
  if (dup.rowCount) console.log('✓ Meta duplicada removida: goal 44 (mantida a 43)');

  // 5) resolve as notificações goal_no_product dessas metas
  try { const n = await pool.query("UPDATE v3.notifications SET status='resolved' WHERE type='goal_no_product' AND (payload->>'goal_id')::int IN (43,44) AND status='pending' RETURNING id"); console.log('✓ Notificações resolvidas:', n.rowCount); } catch (e) {}

  console.log('\nPRONTO. Busque "urolithin" ou "0231" no dashboard pra ver a formulação completa.');
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
