'use strict';
/**
 * Define expected_seconds dos 3 backgrounds (valores iniciais do Bruno).
 * Via CatalogService (porta-única, auditado). Editável depois pelo mesmo
 * PATCH /api/v3/data/catalog/activity-types/:id.
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');
const { CatalogService } = require('../src/v3/services/CatalogService');

const TARGETS = [
  { slug: 'encapsulation', expected_seconds: 10800 }, // 3h
  { slug: 'formulation',   expected_seconds: 7200 },  // 2h
  { slug: 'mixing',        expected_seconds: 3600 },  // 1h
];

(async () => {
  const p = makeV3Pool();
  try {
    const svc = new CatalogService({ db: p });
    for (const t of TARGETS) {
      const before = (await p.query(
        "SELECT id, slug, display_name, is_background, expected_seconds FROM v3.activity_types WHERE slug = $1",
        [t.slug])).rows[0];
      if (!before) { console.log(`⚠ ${t.slug}: não encontrado, pula`); continue; }
      const after = await svc.updateActivityType(before.id,
        { expected_seconds: t.expected_seconds },
        null,                           // by_person_id (admin sem pessoa)
        'admin');                       // actor_type
      console.log(`✓ ${t.slug} (id=${before.id}): expected_seconds ${before.expected_seconds} → ${after.expected_seconds} (is_background=${after.is_background})`);
    }

    // confirmação: as 3 com os valores definidos
    const r = await p.query(
      "SELECT id, slug, display_name, is_background, expected_seconds FROM v3.activity_types WHERE slug IN ('encapsulation','formulation','mixing') ORDER BY slug");
    console.log('\n=== estado final ===');
    for (const row of r.rows) {
      console.log(`  ${row.slug} (id=${row.id}): is_background=${row.is_background}, expected_seconds=${row.expected_seconds}s (~${Math.round(row.expected_seconds/3600*10)/10}h)`);
    }

    // audit das 3 mudanças
    const aud = await p.query(
      `SELECT id, created_at, actor_type, action, target_id, metadata
       FROM v3.audit_log
       WHERE target_type='activity_type' AND action='activity_type.updated'
         AND created_at > NOW() - INTERVAL '5 minutes'
       ORDER BY created_at`);
    console.log(`\n=== audit_log das 3 edições (últimos 5 min): ${aud.rows.length} entry(s) ===`);
    for (const a of aud.rows) {
      console.log(`  audit ${a.id} ${a.created_at.toISOString()} ${a.actor_type} target=${a.target_id}`);
    }
  } catch (e) { console.error('ERRO:', e.message); console.error(e.stack); process.exitCode = 1; }
  finally { await p.end(); }
})();
