'use strict';
/* Seed v3.task_targets a partir de analysis_output.json (Fase 2).
   Default = método 3 (híbrido); fallback = fallback_target_minutes; senão P50.
   Rodar após migration 028: railway run node scripts/v3-seed-task-targets.js
   Idempotente: só insere slug que ainda não tem target (não sobrescreve
   ajustes manuais do admin). */
const { Pool } = require('pg');
const fs = require('fs'); const path = require('path');
(async () => {
  const jsonPath = path.join(__dirname, '..', 'analysis_output.json');
  if (!fs.existsSync(jsonPath)) { console.error('! analysis_output.json ausente — rode src/analysis/compute-task-targets.js primeiro'); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let inserted = 0; let skipped = 0;
  for (const [slug, d] of Object.entries(data.by_slug)) {
    if (slug === 'unknown') continue;
    const target = d.method_3_target_minutes || d.fallback_target_minutes || d.p50;
    if (target == null || !(target > 0)) { console.log(`~ ${slug}: sem target calculável — pulado`); continue; }
    const r = await pool.query(
      `INSERT INTO v3.task_targets (slug, target_minutes, method_applied, notes)
       VALUES ($1, $2, 'method_3_hibrido', $3)
       ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [slug, Math.round(target), `seed Fase 2 (P25 best=${d.best_p25 ?? '?'}, P50=${d.p50 ?? '?'})`]);
    if (r.rowCount) { inserted++; } else { skipped++; }
  }
  console.log(`task_targets: ${inserted} inseridos, ${skipped} já existiam`);
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
