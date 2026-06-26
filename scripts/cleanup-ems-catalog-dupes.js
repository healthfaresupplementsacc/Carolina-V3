'use strict';
// Desativa (active=false, reversível) os produtos importados do EMS que são
// VARIANTES DE DOSE de produtos que já existiam ("Vitamin B2 400mg" vs "Vitamin B2"),
// sem nenhuma referência (lote/contagem/meta). Mantém os genuinamente novos (Urolithin A).
const { Pool } = require('pg');
const { normProductName } = require('../src/workers/ems-activity-sync');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function hasRefs(id) {
  const r = await pool.query(
    `SELECT (EXISTS(SELECT 1 FROM v3.production_counts WHERE product_id=$1)
          OR EXISTS(SELECT 1 FROM v3.production_goals WHERE product_id=$1 AND deleted_at IS NULL)
          OR EXISTS(SELECT 1 FROM v3.product_batches WHERE product_id=$1 AND deleted_at IS NULL)) AS r`, [id]);
  return r.rows[0].r;
}
(async () => {
  const all = (await pool.query(
    "SELECT id, canonical_name, aliases, (created_at > NOW() - INTERVAL '180 minutes') AS recent FROM v3.products WHERE COALESCE(active, true) = true"
  )).rows;
  const oldNorms = new Set();
  for (const p of all) if (!p.recent) { oldNorms.add(normProductName(p.canonical_name)); (p.aliases || []).forEach((a) => oldNorms.add(normProductName(a))); }
  const seen = new Set();
  let off = 0, kept = 0;
  for (const p of all.filter((x) => x.recent).sort((a, b) => a.id - b.id)) {
    const nn = normProductName(p.canonical_name);
    if (await hasRefs(p.id)) { seen.add(nn); kept++; continue; }
    if (oldNorms.has(nn) || seen.has(nn)) {
      await pool.query('UPDATE v3.products SET active = false WHERE id = $1', [p.id]);
      off++;
    } else { seen.add(nn); kept++; console.log('mantido (novo):', p.canonical_name); }
  }
  const total = (await pool.query('SELECT COUNT(*)::int n FROM v3.products WHERE COALESCE(active,true)=true')).rows[0].n;
  console.log('\nDesativados (variantes dup):', off, '· mantidos recentes:', kept, '· catálogo ativo agora:', total);
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
