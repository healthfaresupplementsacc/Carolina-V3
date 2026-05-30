'use strict';
/* DIAG read-only — ev332/ev333 Ana órfãos sem source_message_ts.
   Investiga origem via audit_log. */
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' AUDIT log de ev332 e ev333');
  console.log('═══════════════════════════════════════════════════════════');
  const audits = (await pool.query(`
    SELECT id, target_id, action, actor_type, actor_person_id, created_at,
      jsonb_pretty(before_data) AS before_d,
      jsonb_pretty(after_data) AS after_d,
      jsonb_pretty(metadata) AS meta
    FROM v3.audit_log
    WHERE target_id IN (332, 333) AND action LIKE 'event%'
    ORDER BY target_id, created_at`)).rows;
  for (const a of audits) {
    console.log(`\n  ev${a.target_id} audit#${a.id} ${a.action} actor=${a.actor_type}/${a.actor_person_id || 'NULL'}`);
    console.log(`    created: ${a.created_at}`);
    if (a.meta) console.log(`    meta: ${(a.meta || '').slice(0, 400)}`);
    if (a.before_d) console.log(`    before: ${(a.before_d || '').slice(0, 400)}`);
    if (a.after_d) console.log(`    after: ${(a.after_d || '').slice(0, 400)}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' Comparativo: started_at vs created_at vs updated_at');
  console.log('═══════════════════════════════════════════════════════════');
  const r = (await pool.query(`
    SELECT id, person_id, activity_type_id, product_batch_id,
      started_at, ended_at,
      created_at, updated_at,
      source_message_ts, closed_reason, confidence,
      cowork_with, description
    FROM v3.events WHERE id IN (332, 333)`)).rows;
  for (const e of r) {
    console.log(`\n  ev${e.id}:`);
    console.log(`    started_at:        ${e.started_at}`);
    console.log(`    ended_at:          ${e.ended_at}`);
    console.log(`    created_at:        ${e.created_at}`);
    console.log(`    updated_at:        ${e.updated_at}`);
    console.log(`    source_message_ts: ${e.source_message_ts || 'NULL'}`);
    console.log(`    closed_reason:     ${e.closed_reason || 'NULL'}`);
    console.log(`    confidence:        ${e.confidence}`);
    console.log(`    cowork_with:       ${JSON.stringify(e.cowork_with)}`);
    console.log(`    description:       "${e.description || ''}"`);
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
