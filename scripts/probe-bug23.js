'use strict';
/* Verificação REAL (não-mockada) do match EMS↔local p/ Bug 2/3.
   railway run node scripts/probe-bug23.js */
const { Pool } = require('pg');
const { ems } = require('../src/v3/services/ems-api');
const norm = (s) => String(s || '').toLowerCase().replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|iu|ml|ct|count|caps?|capsules?|softgels?|tablets?|servings?)\b/g, '').replace(/[^a-z0-9]+/g, '');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s, p) => pool.query(s, p).then((r) => r.rows);

  // ── Bug 3: match rate REAL ──
  let emsP;
  try { emsP = await ems.products(); } catch (e) { console.log('  ems.products() THREW: ' + e.code + ' ' + e.message); emsP = null; }
  console.log('  diag: typeof=' + typeof emsP + ' isArray=' + Array.isArray(emsP) + ' keys=' + (emsP && !Array.isArray(emsP) ? Object.keys(emsP).join(',') : '-') + ' len=' + (Array.isArray(emsP) ? emsP.length : '-'));
  const arr = Array.isArray(emsP) ? emsP : (emsP && (emsP.data || emsP.products)) || [];
  const idx = arr.filter((p) => p && p.image_url).map((p) => ({ n: norm(p.name), url: p.image_url }));
  const locals = await q('SELECT id, canonical_name, aliases FROM v3.products WHERE active = true');
  let matched = 0; const misses = [];
  locals.forEach((lp) => {
    const cands = [norm(lp.canonical_name)].concat((lp.aliases || []).map(norm)).filter(Boolean);
    let hit = null;
    for (const c of cands) {
      hit = idx.find((e) => e.n === c) || idx.find((e) => e.n.indexOf(c) === 0 && c.length >= 4) || idx.find((e) => c.length >= 5 && (e.n.indexOf(c) >= 0 || c.indexOf(e.n) >= 0));
      if (hit) break;
    }
    if (hit) matched++; else misses.push(lp.canonical_name);
  });
  console.log(`=== Bug 3: imagens ===`);
  console.log(`  EMS products c/ imagem: ${idx.length} / ${arr.length}`);
  console.log(`  LOCAL products ativos: ${locals.length}`);
  console.log(`  MATCH: ${matched}/${locals.length} (${Math.round(matched / locals.length * 100)}%)`);
  console.log(`  sem imagem (${misses.length}): ${misses.slice(0, 25).join(', ')}`);

  // ── Bug 2: batches recentes p/ 3 produtos com histórico ──
  console.log('\n=== Bug 2: batches/recent (3 produtos) ===');
  const pids = await q(`SELECT DISTINCT pb.product_id, pr.canonical_name FROM v3.product_batches pb
                        JOIN v3.events e ON e.product_batch_id = pb.id AND e.deleted_at IS NULL
                        JOIN v3.products pr ON pr.id = pb.product_id
                        ORDER BY pr.canonical_name LIMIT 3`);
  for (const row of pids) {
    const batches = await q(
      `SELECT pb.batch_number, MAX(e.started_at) AS last_seen,
              (array_agg(p.display_name ORDER BY e.started_at DESC))[1] AS last_operator
       FROM v3.product_batches pb
       JOIN v3.events e ON e.product_batch_id = pb.id AND e.deleted_at IS NULL
       JOIN v3.persons p ON p.id = e.person_id
       WHERE pb.product_id = $1 AND pb.batch_number IS NOT NULL
       GROUP BY pb.batch_number ORDER BY MAX(e.started_at) DESC LIMIT 8`, [row.product_id]);
    console.log(`  ${row.canonical_name} (prod#${row.product_id}): ${batches.map((b) => b.batch_number + ' (' + b.last_operator + ')').join(', ') || '— nenhum'}`);
  }
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
