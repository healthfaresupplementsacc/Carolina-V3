'use strict';
/**
 * HEALTHFARE V3 — runner genérico de migration (psql não disponível local).
 *
 *   railway run ... node scripts/v3-run-migration.js --file=004_flows_and_phases.sql
 *
 * O arquivo .sql já traz BEGIN/COMMIT próprio. Idempotente quando a
 * migration usa IF NOT EXISTS / ON CONFLICT.
 */
const fs = require('fs');
const path = require('path');
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

function arg(name) {
  const m = process.argv.find((a) => a.startsWith('--' + name + '='));
  return m ? m.slice(name.length + 3) : null;
}

async function main() {
  const file = arg('file');
  if (!file) { console.error('uso: --file=004_flows_and_phases.sql'); process.exit(2); }
  const sqlPath = path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', file);
  if (!fs.existsSync(sqlPath)) { console.error('não existe:', sqlPath); process.exit(2); }
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const pool = makeV3Pool();
  try {
    console.log('==== rodando migration:', file, '====');
    await pool.query(sql);
    console.log('OK — migration aplicada.');
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
