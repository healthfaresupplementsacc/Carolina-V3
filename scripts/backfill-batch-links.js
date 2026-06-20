'use strict';
/* Backfill: events com lote na descrição mas SEM product_batch_id → resolve o lote
   (local → EMS) e LINKA produto+lote, limpa a nota "produto não identificado".
   DRY por padrão; APPLY=1 aplica. DAYS=2 (ontem+hoje). node scripts/backfill-batch-links.js */
const { Pool } = require('pg');
const { ems } = require('../src/v3/services/ems-api');
const EDT = 'America/New_York';
const APPLY = process.env.APPLY === '1';
const DAYS = parseInt(process.env.DAYS, 10) || 2;
const norm = (s) => String(s || '').toLowerCase().replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|iu|ml|ct|count|caps?|capsules?|softgels?|tablets?|servings?)\b/g, '').replace(/[^a-z0-9]+/g, '');
function flat(node) { if (Array.isArray(node)) return node.slice(); if (node && typeof node === 'object') { const o = []; for (const k of Object.keys(node)) if (Array.isArray(node[k])) node[k].forEach((b) => o.push(b)); return o; } return []; }
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s, p) => pool.query(s, p).then((r) => r.rows);
  const pipeline = ems.configured() ? await ems.pipeline().catch(() => null) : null;
  const emsBatches = pipeline ? ['pending_queue', 'formulation', 'production_line'].flatMap((g) => flat(pipeline[g])) : [];
  const products = await q('SELECT id, canonical_name, aliases FROM v3.products WHERE active = true');
  const productIdByName = (name) => { const t = norm(name); if (!t) return null; let h = products.find((p) => norm(p.canonical_name) === t); if (!h) h = products.find((p) => [p.canonical_name].concat(p.aliases || []).some((a) => norm(a) === t)); if (!h) h = products.find((p) => { const n = norm(p.canonical_name); return n && t.length >= 5 && (n.indexOf(t) >= 0 || t.indexOf(n) >= 0); }); return h ? h.id : null; };
  const emsInfo = (bn) => { const U = String(bn).toUpperCase(); const alt = U.indexOf('BR-2026-') === 0 ? U.slice(8) : 'BR-2026-' + U; const b = emsBatches.find((x) => { const v = String((x.batch_record_number || x.batch_number) || '').toUpperCase(); return v === U || v === alt; }); return b ? { name: (b.product && b.product.name) || (b.formula && b.formula.name) || null, target: b.target_qty_bottles != null ? b.target_qty_bottles : null } : null; };

  const evs = await q(`SELECT e.id, e.person_id, e.description FROM v3.events e
    WHERE e.deleted_at IS NULL AND e.product_batch_id IS NULL
      AND (e.started_at AT TIME ZONE '${EDT}')::date >= (NOW() AT TIME ZONE '${EDT}')::date - ${DAYS - 1}
      AND e.description ~ 'lote digitado: '`);
  console.log((APPLY ? 'APPLY' : 'DRY') + ' — ' + evs.length + ' events com lote sem produto (últimos ' + DAYS + ' dias)');
  let linked = 0, noprod = 0;
  for (const e of evs) {
    const m = (e.description || '').match(/lote digitado:\s*([A-Za-z0-9-]+)/);
    if (!m) continue;
    const bn = m[1];
    // já existe local?
    let row = (await q("SELECT id, product_id FROM v3.product_batches WHERE batch_number = $1 OR batch_number = 'BR-2026-' || $1 ORDER BY id DESC LIMIT 1", [bn]))[0];
    let batchId = (row && row.product_id) ? row.id : null;
    if (!batchId) {
      const info = emsInfo(bn); const pid = info ? productIdByName(info.name) : null;
      if (!pid) { noprod++; console.log('  ev' + e.id + ' ' + bn + ' → SEM produto (EMS: ' + (info ? info.name : 'não achou') + ')'); continue; }
      if (APPLY) {
        const notes = info && info.target != null ? 'EMS target: ' + info.target + ' bottles' : null;
        const ins = await q("INSERT INTO v3.product_batches (product_id, batch_number, started_at, status, origin, created_by_person_id, created_via, notes) VALUES ($1,$2,NOW(),'in_progress','ems_backfill',$3,'backfill',$4) RETURNING id", [pid, bn, e.person_id, notes]);
        batchId = ins[0].id;
      } else { batchId = -1; }
      console.log('  ev' + e.id + ' ' + bn + ' → ' + (emsInfo(bn) ? emsInfo(bn).name : '?') + ' (product ' + pid + ')');
    } else { console.log('  ev' + e.id + ' ' + bn + ' → lote local existente #' + batchId); }
    if (APPLY && batchId > 0) {
      const clean = (e.description || '').replace(/\s*\[lote digitado:[^\]]*\]/g, '').trim() || null;
      await q('UPDATE v3.events SET product_batch_id = $1, description = $2, updated_at = NOW() WHERE id = $3', [batchId, clean, e.id]);
    }
    linked++;
  }
  console.log('\nLINKADOS: ' + linked + ' | sem produto (não achou): ' + noprod + (APPLY ? '' : '  (DRY — rode com APPLY=1)'));
  await pool.end();
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
