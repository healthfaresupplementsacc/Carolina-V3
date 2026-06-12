'use strict';
/* Aplica migration 018 — Operator Page (persons PIN, operator_sessions,
   events.source, superseded_by, CHECK audit ampliado, op_notes, notifications).
   Idempotente. Rodar: railway run --service ProductionLineService node scripts/v3-apply-migration-018.js */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '018_operator_page.sql'), 'utf8');
  await pool.query(sql);

  const cols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='v3' AND table_name='persons'
      AND column_name IN ('pin_hash','pin_salt','auto_logoff_seconds','last_page_login_at','is_admin_operator','count_exempt')
    ORDER BY column_name`);
  console.log('persons colunas novas: ' + cols.rows.map((r) => r.column_name).join(', '));

  for (const t of ['operator_sessions', 'op_notes', 'notifications']) {
    const r = await pool.query("SELECT to_regclass('v3.' || $1) AS x", [t]);
    console.log('v3.' + t + ': ' + (r.rows[0].x ? 'OK' : 'AUSENTE!'));
  }

  const ev = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='v3' AND table_name='events' AND column_name IN ('source','superseded_by_event_id')`);
  console.log('events colunas novas: ' + ev.rows.map((r) => r.column_name).join(', '));

  const src = await pool.query("SELECT source, COUNT(*)::int n FROM v3.events GROUP BY source ORDER BY n DESC");
  console.log('events.source backfill: ' + src.rows.map((r) => r.source + '=' + r.n).join(', '));

  const chk = await pool.query(`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conname='audit_log_actor_type_check'`);
  console.log('CHECK audit: ' + (chk.rows[0] ? chk.rows[0].def.slice(0, 160) : 'AUSENTE!'));

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
