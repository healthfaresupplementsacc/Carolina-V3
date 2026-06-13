'use strict';
/** Verifica se buildSnapshot() retorna dado fresco AGORA. Read-only. */
const { Pool } = require('pg');
const { buildRepos, buildSnapshot } = require('../src/v3/data/router');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const repos = buildRepos(pool);
  const date = '2026-05-25';
  const t0 = Date.now();
  const snap = await buildSnapshot(date, repos);
  const t1 = Date.now();
  console.log(`buildSnapshot('${date}') executou em ${t1 - t0}ms`);
  console.log('worker_health:');
  console.log('   alive          :', snap.worker_health.alive);
  console.log('   queue          :', snap.worker_health.queue);
  console.log('   errors         :', snap.worker_health.errors);
  console.log('   last_processed :', snap.worker_health.last_processed_at);
  console.log('   tick_age_sec   :', snap.worker_health.tick_age_sec);
  console.log('   mode           :', snap.worker_health.mode);
  console.log('timeline.people  :', snap.timeline.people.length, 'pessoas');
  for (const p of snap.timeline.people) {
    console.log(`   ${p.display_name}: ${p.events.length} events, idle=${p.idle_seconds}s, unreported=${p.unreported_seconds}s`);
  }
  console.log('cards.production:', snap.cards.production.length, 'lotes');
  console.log('cards.pp.total_seconds:', snap.cards.pp.total_seconds);
  console.log('cards.atencao:', snap.cards.atencao);
  console.log('metrics_summary:', snap.metrics_summary);
  console.log('open_events:', snap.open_events.length);
  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
