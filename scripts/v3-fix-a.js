'use strict';
/**
 * HEALTHFARE V3 — FIX A (pós-backfill §2.13) — one-time prod.
 *
 * 1. Roda migration 003 (v3.messages.claimed_at) — idempotente
 *    (ADD COLUMN IF NOT EXISTS).
 * 2. Limpa os processing_error fantasma: rows com processing_error
 *    E llm_processed_at preenchidos ao mesmo tempo — artefato da
 *    dupla-processamento (tick re-pegava mensagem lenta; a 2ª passada
 *    finalizava com sucesso mas a 1ª já tinha gravado o erro).
 *    O _finalize agora zera processing_error no sucesso; estas são
 *    rows anteriores ao fix.
 *
 *   railway run ... node scripts/v3-fix-a.js
 */
const fs = require('fs');
const path = require('path');
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

async function main() {
  const pool = makeV3Pool();
  try {
    console.log('==== V3 FIX A — claim no DB + limpa fantasmas ====');

    // 1 ── migration 003 ──────────────────────────────────────
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '003_messages_claimed_at.sql'),
      'utf8');
    await pool.query(sql);
    console.log('migration 003: v3.messages.claimed_at OK (idempotente)');

    // 2 ── conta os fantasmas ANTES ───────────────────────────
    const before = await pool.query(
      `SELECT COUNT(*) c FROM v3.messages
       WHERE processing_error IS NOT NULL AND llm_processed_at IS NOT NULL`);
    const phantom = parseInt(before.rows[0].c, 10);

    // 3 ── limpa ──────────────────────────────────────────────
    const cleaned = await pool.query(
      `UPDATE v3.messages SET processing_error = NULL
       WHERE processing_error IS NOT NULL AND llm_processed_at IS NOT NULL
       RETURNING id`);

    // 4 ── erros REAIS que sobraram (processed_at NULL) ───────
    const realErr = await pool.query(
      `SELECT COUNT(*) c FROM v3.messages
       WHERE processing_error IS NOT NULL AND llm_processed_at IS NULL`);

    console.log('\n==== FIX A REPORT ====');
    console.log(`fantasmas detectados:     ${phantom}`);
    console.log(`processing_error limpos:  ${cleaned.rowCount}`);
    console.log(`erros REAIS restantes:    ${realErr.rows[0].c} (processing_error com llm_processed_at NULL)`);
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
