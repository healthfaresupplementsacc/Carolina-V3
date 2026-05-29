'use strict';
/* Destrava fila pós-incidente Anthropic credit 29/mai.
   Limpa claimed_at + processing_error das msgs 721-736 → próximo
   tick do worker re-claima e processa. Bruno OK em texto cru. */
const { Pool } = require('pg');

const TARGET_RANGE = { min: 721, max: 736 };

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' BEFORE — status das msgs 721-736');
  console.log('═══════════════════════════════════════════════════════════');
  const before = (await pool.query(`
    SELECT id,
      TO_CHAR(to_timestamp(slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS ny_t,
      claimed_at IS NOT NULL AS has_claim,
      llm_processed_at IS NOT NULL AS has_proc,
      processing_error IS NOT NULL AS has_err,
      LEFT(raw_text, 60) AS txt
    FROM v3.messages
    WHERE id BETWEEN $1 AND $2
    ORDER BY id`, [TARGET_RANGE.min, TARGET_RANGE.max])).rows;
  for (const m of before) {
    console.log(`  msg${m.id} ${m.ny_t} claim=${m.has_claim ? 'Y' : 'N'} proc=${m.has_proc ? 'Y' : 'N'} err=${m.has_err ? 'Y' : 'N'} | ${m.txt}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' STEP — UPDATE claimed_at=NULL, processing_error=NULL');
  console.log(' (apenas onde llm_processed_at IS NULL — não toca em já-processadas)');
  console.log('═══════════════════════════════════════════════════════════');
  const r = await pool.query(`
    UPDATE v3.messages
    SET claimed_at = NULL, processing_error = NULL
    WHERE id BETWEEN $1 AND $2 AND llm_processed_at IS NULL
    RETURNING id`, [TARGET_RANGE.min, TARGET_RANGE.max]);
  console.log(`  ${r.rowCount} msgs limpas: [${r.rows.map((x) => x.id).join(', ')}]`);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' AFTER — status atualizado');
  console.log('═══════════════════════════════════════════════════════════');
  const after = (await pool.query(`
    SELECT id,
      claimed_at IS NOT NULL AS has_claim,
      llm_processed_at IS NOT NULL AS has_proc,
      processing_error IS NOT NULL AS has_err
    FROM v3.messages
    WHERE id BETWEEN $1 AND $2
    ORDER BY id`, [TARGET_RANGE.min, TARGET_RANGE.max])).rows;
  for (const m of after) {
    console.log(`  msg${m.id} claim=${m.has_claim ? 'Y' : 'N'} proc=${m.has_proc ? 'Y' : 'N'} err=${m.has_err ? 'Y' : 'N'}`);
  }

  console.log('\n✓ Fila destravada. Próximo tick do worker vai re-claim.');
  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
