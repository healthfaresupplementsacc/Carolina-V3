'use strict';
/* Backfill target_bottles + units_per_bottle nos lotes LOCAIS a partir do EMS.
   DRY por padrão; APPLY=1 aplica. node scripts/backfill-targets.js */
const { Pool } = require('pg');
const { ems } = require('../src/v3/services/ems-api');
const APPLY = process.env.APPLY === '1';
function flat(n){if(Array.isArray(n))return n.slice();if(n&&typeof n==='object'){const o=[];for(const k of Object.keys(n))if(Array.isArray(n[k]))n[k].forEach(b=>o.push(b));return o;}return[];}
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const pl = ems.configured() ? await ems.pipeline().catch(() => null) : null;
  const batches = pl ? ['pending_queue','formulation','production_line'].flatMap(g=>flat(pl[g])) : [];
  const byNum = {};
  batches.forEach((b) => { const k = String((b.batch_record_number||b.batch_number)||'').toUpperCase(); if (k) byNum[k] = { target: b.target_qty_bottles, upb: b.formula && b.formula.units_per_bottle }; });
  const local = (await pool.query("SELECT id, batch_number FROM v3.product_batches WHERE deleted_at IS NULL AND (target_bottles IS NULL OR units_per_bottle IS NULL)")).rows;
  let n = 0;
  for (const lb of local) {
    const info = byNum[String(lb.batch_number).toUpperCase()]; if (!info) continue;
    if (info.target == null && info.upb == null) continue;
    console.log('  ' + lb.batch_number + ' → target=' + info.target + ' upb=' + info.upb);
    if (APPLY) await pool.query('UPDATE v3.product_batches SET target_bottles=COALESCE($2,target_bottles), units_per_bottle=COALESCE($3,units_per_bottle), updated_at=NOW() WHERE id=$1', [lb.id, info.target != null ? info.target : null, info.upb != null ? info.upb : null]);
    n++;
  }
  console.log((APPLY ? 'APPLY' : 'DRY') + ' — ' + n + ' lotes atualizados de ' + local.length + ' sem target/upb');
  await pool.end();
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
