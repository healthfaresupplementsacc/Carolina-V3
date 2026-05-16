'use strict';
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const a = await p.query("SELECT count(*)::int AS n FROM admin_audit_log WHERE action = 'legacy_cleanup'");
  const o = await p.query("SELECT count(*)::int AS n FROM phase_instances WHERE status = 'open' AND started_at < NOW() - INTERVAL '24 hours'");
  const c = await p.query("SELECT id, status, ended_at, notes FROM phase_instances WHERE notes LIKE '%auto_cleanup_legacy%' ORDER BY id DESC LIMIT 3");
  console.log('audit legacy_cleanup rows :', a.rows[0].n);
  console.log('phase_instances open >24h :', o.rows[0].n, '(expect 0)');
  console.log('cleaned phase rows:');
  console.table(c.rows);
  await p.end();
})().catch((e) => { console.error('FATAL:', e.message); p.end().catch(() => {}); process.exit(1); });
