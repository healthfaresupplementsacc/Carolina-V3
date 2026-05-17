'use strict';
/**
 * WIPE — full logical backup of the production database.
 *
 * pg_dump is not available in this environment, so this produces a
 * restore-able .sql by letting PostgreSQL itself quote every value
 * (quote_nullable(col::text)) — a single-quoted literal is untyped and
 * is coerced to the column type on INSERT, so timestamptz / jsonb /
 * arrays / numerics all round-trip correctly.
 *
 * Output: <tmp>/wipe-backup-<UTC timestamp>.sql  (+ .manifest.json)
 * Reports byte size and SHA-256 for integrity / restore.
 *
 * Restore procedure (documented in the final report):
 *   1. create an empty DB
 *   2. run the app once so db.migrate() builds the schema
 *   3. psql < wipe-backup-<ts>.sql      (data only; FK-safe order)
 *
 * Usage:  railway run --service ProductionLineService node scripts/backup-prod-db.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// FK-aware-ish order: parents before children so a straight psql replay
// works without deferring constraints. Tables not listed are appended
// after (config/catalog tables have no inbound FKs from each other).
const ORDER_HINT = [
  'operators', 'workflow_templates', 'phase_templates', 'ad_hoc_tasks',
  'supplement_catalog', 'app_state', 'message_variations', 'migrations',
  'schema_migrations', 'messages', 'tasks', 'orders_sessions',
  'workflow_instances', 'phase_instances', 'ad_hoc_task_instances',
  'pauses', 'operator_activity_log', 'production_counts', 'notes',
  'carolina_proposals', 'silent_log', 'admin_audit_log', 'task_alias',
  'eod_snapshots',
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('FATAL: DATABASE_URL not set (run via railway run).'); process.exit(2); }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = fs.existsSync('/home/claude') ? '/home/claude'
    : (fs.existsSync('/tmp') ? '/tmp' : os.tmpdir());
  const outFile = path.join(outDir, `wipe-backup-${ts}.sql`);
  const manFile = `${outFile}.manifest.json`;
  const ws = fs.createWriteStream(outFile, { encoding: 'utf8' });
  const manifest = { created_at: new Date().toISOString(), file: outFile, tables: {} };

  try {
    const t = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
    const all = t.rows.map((r) => r.tablename);
    const ordered = ORDER_HINT.filter((x) => all.includes(x))
      .concat(all.filter((x) => !ORDER_HINT.includes(x)));

    ws.write(`-- HealthFare production logical backup\n-- created_at: ${manifest.created_at}\n`);
    ws.write(`-- method: server-side quote_nullable(col::text); data only\n`);
    ws.write(`-- restore: empty DB -> app migrate() -> psql < this file\n`);
    ws.write(`BEGIN;\nSET session_replication_role = replica;\n\n`);

    let totalRows = 0;
    for (const tbl of ordered) {
      const cols = (await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
        [tbl])).rows.map((r) => r.column_name);
      if (cols.length === 0) continue;
      const colList = cols.map((c) => `"${c}"`).join(', ');
      const valExpr = cols.map((c) => `quote_nullable("${c}"::text)`).join(` || ', ' || `);
      const stmt = `SELECT 'INSERT INTO "${tbl}" (${colList.replace(/'/g, "''")}) VALUES (' || ${valExpr} || ');' AS s FROM "${tbl}"`;
      const rows = (await pool.query(stmt)).rows;
      ws.write(`\n-- ${tbl} (${rows.length} rows)\n`);
      for (const r of rows) ws.write(r.s + '\n');
      manifest.tables[tbl] = rows.length;
      totalRows += rows.length;
    }
    ws.write(`\nSET session_replication_role = DEFAULT;\nCOMMIT;\n`);
    await new Promise((res, rej) => ws.end((e) => (e ? rej(e) : res())));

    const buf = fs.readFileSync(outFile);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    manifest.bytes = buf.length;
    manifest.total_rows = totalRows;
    manifest.sha256 = sha;
    fs.writeFileSync(manFile, JSON.stringify(manifest, null, 2));

    console.log('==== BACKUP OK ====');
    console.log('file       :', outFile);
    console.log('manifest   :', manFile);
    console.log('size_bytes :', buf.length, `(${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
    console.log('total_rows :', totalRows);
    console.log('sha256     :', sha);
    console.log('tables     :', JSON.stringify(manifest.tables));
    if (buf.length < 100) { console.error('FATAL: backup suspiciously small'); process.exit(3); }
  } catch (e) {
    console.error('FATAL backup error:', e.message);
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
