'use strict';
// A2 — note bug investigation (read-only).
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  console.log('=== operator_notes table exists? recent rows ===');
  try {
    const r = await p.query(`SELECT id, operator_id, LEFT(text,60) AS text, source,
        linked_phase_instance_id, created_at
      FROM operator_notes ORDER BY id DESC LIMIT 10`);
    console.log('count recent:', r.rows.length);
    console.table(r.rows);
  } catch (e) { console.log('operator_notes ERROR:', e.message); }

  console.log('\n=== silent flags ===');
  const s = await p.query(`SELECT key,value FROM app_state WHERE key IN ('silent_mode','silent_text','silent_reactions')`);
  console.table(s.rows);

  console.log('\n=== silent_log recent note-ish entries ===');
  try {
    const sl = await p.query(`SELECT id, intended_action, kind, LEFT(intended_text,60) t, created_at
      FROM silent_log WHERE intended_text ILIKE '%anot%' OR intended_text ILIKE '%nota%'
      ORDER BY id DESC LIMIT 8`);
    console.table(sl.rows);
  } catch (e) { console.log('silent_log ERROR:', e.message); }

  console.log('\n=== messages parsed_type=note recent ===');
  const m = await p.query(`SELECT slack_ts, user_name, LEFT(text,50) t FROM messages
    WHERE parsed_type='note' ORDER BY slack_ts DESC LIMIT 5`);
  console.table(m.rows);

  console.log('\n=== admin_audit_log note actions ===');
  const a = await p.query(`SELECT action, count(*)::int n FROM admin_audit_log
    WHERE action ILIKE '%note%' GROUP BY action`);
  console.table(a.rows);
  await p.end();
})().catch((e) => { console.error('FATAL', e.message); p.end().catch(()=>{}); process.exit(1); });
