'use strict';
/* O EMS dá quando ENTROU no stage? Não direto. Mas a gente carimba first_seen_at
   por (batch:stage) no ems_activity_cache. Compara: first_seen_at (nossa obs) vs
   started_at (in_use_since/created_at do EMS). */
const { Pool } = require('pg');
const now = Date.now();
const ago = (d) => { if (!d) return '—'; const h = (now - new Date(d).getTime()) / 3600000; return h < 1 ? Math.round(h * 60) + 'min' : h.toFixed(1) + 'h'; };
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s) => pool.query(s).then((r) => r.rows);
  console.log('AGORA ' + new Date(now).toISOString());
  console.log('\n=== ems_activity_cache: stage atual + quando NÓS vimos entrar (first_seen_at) ===');
  const rows = await q(`
    SELECT batch_number, stage, machine, sync_status,
           first_seen_at, last_synced_at, started_at, ems_key
    FROM v3.ems_activity_cache
    WHERE sync_status = 'active'
    ORDER BY first_seen_at DESC NULLS LAST LIMIT 20`);
  rows.forEach((r) => {
    console.log(`\n${r.batch_number} [${r.stage}]${r.machine ? ' @' + r.machine : ' (sem máquina)'} key=${r.ems_key}`);
    console.log(`  NOSSA obs: first_seen=${r.first_seen_at ? new Date(r.first_seen_at).toISOString() : '—'} (há ${ago(r.first_seen_at)})  last_sync há ${ago(r.last_synced_at)}`);
    console.log(`  EMS started_at(in_use/created)=${r.started_at ? new Date(r.started_at).toISOString() : '—'} (há ${ago(r.started_at)})`);
  });
  console.log('\ntotal rows ativas no cache: ' + rows.length);
  // quantas têm first_seen RECENTE (transição pega ao vivo) vs antigo (já estava lá)
  const stats = await q(`SELECT
    COUNT(*) FILTER (WHERE first_seen_at > NOW() - INTERVAL '12 hours')::int AS recentes_12h,
    COUNT(*)::int AS total
    FROM v3.ems_activity_cache WHERE sync_status='active'`);
  console.log('first_seen nas últimas 12h (transições pegas ao vivo): ' + JSON.stringify(stats[0]));
  await pool.end();
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
