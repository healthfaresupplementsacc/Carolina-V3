'use strict';
const { Pool } = require('pg');
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log('--- pessoas ativas ---');
  const ps = (await pool.query(`SELECT id, display_name, role, slack_user_id FROM v3.persons WHERE deleted_at IS NULL ORDER BY id`)).rows;
  for (const r of ps) console.log(`  id=${r.id} ${r.display_name} role=${r.role} slack=${r.slack_user_id || '-'}`);

  console.log('\n--- batches Potassium ---');
  const bs = (await pool.query(`
    SELECT pb.id, pb.batch_number, pb.status, pb.created_at
    FROM v3.product_batches pb JOIN v3.products pr ON pr.id = pb.product_id
    WHERE pr.canonical_name ILIKE '%potassium%' AND pb.deleted_at IS NULL
    ORDER BY pb.created_at DESC LIMIT 5`)).rows;
  if (bs.length === 0) console.log('  (nenhum batch Potassium ativo)');
  for (const r of bs) console.log(`  batch_id=${r.id} ${r.batch_number} status=${r.status} created=${r.created_at}`);

  console.log('\n--- msg646 (Thassio "to em reuniao") ---');
  const m = (await pool.query(`
    SELECT id, slack_user_id, events_created, events_updated,
      llm_result->>'categorization' AS cat,
      llm_result->>'uncertain' AS uncertain,
      llm_result->>'uncertainty_reason' AS reason,
      llm_result->'actions' AS actions
    FROM v3.messages WHERE id = 646`)).rows[0];
  if (m) {
    console.log(`  slack=${m.slack_user_id}`);
    console.log(`  categorization=${m.cat} uncertain=${m.uncertain}`);
    console.log(`  uncertainty_reason="${m.reason || ''}"`);
    console.log(`  events_created=${JSON.stringify(m.events_created)} events_updated=${JSON.stringify(m.events_updated)}`);
    console.log(`  actions=${JSON.stringify(m.actions)}`);
  }
  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
