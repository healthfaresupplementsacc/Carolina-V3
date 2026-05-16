'use strict';
// G1 B1/B2/B5 production investigation (read-only).
const { Pool } = require('pg');
const parser = require('../src/parser');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  console.log('=== B2: catalog load — is "benfotiamine" in the parser catalog? ===');
  const supps = parser.listSupplements();
  console.log('catalog size:', supps.length);
  const benfo = supps.find((s) => /benfotiamine/i.test(s.canonical) || /benfotiamine/i.test(s.aliases));
  console.log('benfotiamine entry:', JSON.stringify(benfo));
  const matchTest = parser.extractSupplement('benfotiamine');
  console.log('parser.extractSupplement("benfotiamine"):', matchTest);
  // simulate the options matcher
  const opts = require('../src/slack/options');
  const m = opts.matchSupplements('benfotiamine');
  console.log('options.matchSupplements("benfotiamine"):', JSON.stringify(m.slice(0, 5)));
  const m2 = opts.matchSupplements('benfo');
  console.log('options.matchSupplements("benfo"):', JSON.stringify(m2.slice(0, 5)));
  const m3 = opts.matchSupplements('Benfotiamine');
  console.log('options.matchSupplements("Benfotiamine"):', JSON.stringify(m3.slice(0, 5)));

  console.log('\n=== B5: Simone breaks — open vs closed in oal + pauses ===');
  const sim = await p.query(`SELECT id, name FROM operators WHERE name ILIKE '%simone%'`);
  console.table(sim.rows);
  const simId = sim.rows[0]?.id;
  if (simId) {
    const oal = await p.query(
      `SELECT id, activity_type, started_at, ended_at, pause_id
       FROM operator_activity_log
       WHERE operator_id = $1 AND activity_type = 'break'
       ORDER BY id DESC LIMIT 5`, [simId]);
    console.log('Simone break oal rows:');
    console.table(oal.rows);
    const pauses = await p.query(
      `SELECT id, operator, started_at, ended_at, ended_reason, deleted_at
       FROM pauses WHERE operator ILIKE '%simone%'
       ORDER BY id DESC LIMIT 5`);
    console.log('Simone pauses rows:');
    console.table(pauses.rows);
  }

  console.log('\n=== B1: dashboard vs operator-panel vs home consistency ===');
  const openWf = await p.query(`SELECT count(*)::int n FROM workflow_instances WHERE status='active' AND ended_at IS NULL`);
  const openPh = await p.query(`SELECT count(*)::int n FROM phase_instances WHERE status='open' AND ended_at IS NULL`);
  const openAh = await p.query(`SELECT count(*)::int n FROM ad_hoc_task_instances WHERE status='open' AND ended_at IS NULL`);
  console.log('active workflow_instances:', openWf.rows[0].n);
  console.log('open phase_instances:', openPh.rows[0].n);
  console.log('open ad_hoc_task_instances:', openAh.rows[0].n);

  await p.end();
})().catch((e) => { console.error('FATAL', e.message); p.end().catch(()=>{}); process.exit(1); });
