'use strict';
/**
 * Import do "HealthFare Supplement Catalog (Updated 08.04.2026)" (Bruno 08-04).
 * NDJSON (workbook exportado) → v3.product_catalog + v3.raw_material_coas.
 * Idempotente: upsert por catalog_name / (material, lot) — re-rodar é seguro.
 * Match catalog→v3.products por nome normalizado; NUNCA sobrescreve um match
 * manual ('manual' fica). Aplica migração 066 antes (CREATE IF NOT EXISTS).
 *   railway run --service ProductionLineService node scripts/import-supplement-catalog.js
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const FILE = process.env.CATALOG_FILE
  || path.join(__dirname, '..', 'HealthFare Supplement Catalog (Updated 08.04.2026).ndjson');

const norm = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b\d+(\.\d+)?\s*(mg|mcg|iu|g|caps?|capsules?|ct|count|bottles?)\b/g, ' ')
  .replace(/\(.*?\)/g, ' ')
  .replace(/\bc\d\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

const day = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
};

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  // migração 066 (idempotente)
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '066_product_catalog.sql'), 'utf8'));

  const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const table = (name) => lines.find((l) => l.kind === 'table' && l.sheet === name);
  const cat = table('Catálogo'); const sf = table('Supplement Facts'); const coa = table('COAs Matéria-Prima');
  if (!cat || !sf) { console.error('abas Catálogo/Supplement Facts não achadas'); process.exit(1); }

  // Supplement Facts por nome (header na linha idx 3)
  const sfByName = new Map();
  for (const row of sf.values.slice(4)) {
    if (!row || !row[0]) continue;
    sfByName.set(String(row[0]).trim(), {
      active_ingredients: row[4] || null, facts_transcript: row[5] || null,
      other_ingredients: row[6] || null, directions: row[7] || null,
    });
  }

  // produtos pra match
  const prods = (await pool.query('SELECT id, canonical_name, aliases FROM v3.products')).rows;
  const byNorm = new Map();
  for (const p of prods) {
    byNorm.set(norm(p.canonical_name), p.id);
    for (const a of (p.aliases || [])) if (norm(a)) byNorm.set(norm(a), p.id);
  }
  const findProduct = (name, family) => {
    const n = norm(name);
    if (byNorm.has(n)) return { id: byNorm.get(n), kind: 'normalized' };
    const nf = norm(family);
    if (nf && byNorm.has(nf)) return { id: byNorm.get(nf), kind: 'normalized' };
    // containment (>=5 chars) — mesma régua do resto do sistema
    for (const [k, id] of byNorm) {
      if (k.length >= 5 && (n.includes(k) || k.includes(n))) return { id, kind: 'normalized' };
    }
    return null;
  };

  let up = 0, matched = 0, hold = 0;
  for (const row of cat.values.slice(4)) {
    if (!row || !row[1]) continue;
    const [family, name, statusRaw, content, serving, servings, potency, validade, lote,
      confVal, confLote, srcFacts, srcVal, obs] = row;
    const st = /hold/i.test(String(statusRaw)) ? 'hold'
      : /multipack/i.test(String(statusRaw)) ? 'multipack' : 'active';
    if (st === 'hold') hold++;
    const facts = sfByName.get(String(name).trim()) || {};
    const m = findProduct(name, family);
    if (m) matched++;
    await pool.query(
      `INSERT INTO v3.product_catalog
         (catalog_name, family, status, content_desc, serving_size, servings_per_container,
          potency, expiry_date, batch_number, expiry_confidence, batch_confidence,
          active_ingredients, facts_transcript, other_ingredients, directions,
          facts_source, expiry_source, notes, product_id, match_kind, imported_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW())
       ON CONFLICT (catalog_name) DO UPDATE SET
         family=$2, status=$3, content_desc=$4, serving_size=$5, servings_per_container=$6,
         potency=$7, expiry_date=$8, batch_number=$9, expiry_confidence=$10, batch_confidence=$11,
         active_ingredients=$12, facts_transcript=$13, other_ingredients=$14, directions=$15,
         facts_source=$16, expiry_source=$17, notes=$18, imported_at=NOW(),
         -- match manual NUNCA é sobrescrito; senão atualiza a sugestão
         product_id = CASE WHEN v3.product_catalog.match_kind = 'manual'
                           THEN v3.product_catalog.product_id ELSE $19 END,
         match_kind = CASE WHEN v3.product_catalog.match_kind = 'manual'
                           THEN 'manual' ELSE $20 END`,
      [String(name).trim(), family || null, st, content || null, serving || null,
        Number.isFinite(Number(servings)) ? Number(servings) : null,
        potency || null, day(validade), lote || null, confVal || null, confLote || null,
        facts.active_ingredients, facts.facts_transcript, facts.other_ingredients, facts.directions,
        srcFacts || null, srcVal || null, obs || null,
        m ? m.id : null, m ? m.kind : null]);
    up++;
  }

  let coas = 0;
  if (coa) {
    for (const row of coa.values.slice(4)) {
      if (!row || !row[0]) continue;
      await pool.query(
        `INSERT INTO v3.raw_material_coas (material, lot, mfg_date, expiry_date, source, notes, imported_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (material, lot) DO UPDATE SET
           mfg_date=$3, expiry_date=$4, source=$5, notes=$6, imported_at=NOW()`,
        [String(row[0]).trim(), row[1] != null ? String(row[1]).trim() : '', day(row[2]), day(row[3]), row[4] || null, row[5] || null]);
      coas++;
    }
  }

  const tot = (await pool.query(`SELECT COUNT(*)::int n, COUNT(product_id)::int matched,
      COUNT(*) FILTER (WHERE status='hold')::int hold,
      COUNT(expiry_date)::int with_expiry FROM v3.product_catalog`)).rows[0];
  console.log(`catálogo: ${up} upserts → tabela tem ${tot.n} (matched: ${tot.matched}, hold: ${tot.hold}, c/ validade: ${tot.with_expiry})`);
  console.log(`COAs matéria-prima: ${coas} upserts`);
  const unmatched = (await pool.query(
    `SELECT catalog_name FROM v3.product_catalog WHERE product_id IS NULL ORDER BY catalog_name`)).rows;
  if (unmatched.length) console.log('SEM match (' + unmatched.length + '):', unmatched.map((r) => r.catalog_name).join(' | '));
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
