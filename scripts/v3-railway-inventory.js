'use strict';
/** Inventário Railway/DB. Read-only. Lista tabelas, tamanhos, contagens. */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');
(async () => {
  const p = makeV3Pool();
  try {
    const v2 = (await p.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)).rows;
    const v3 = (await p.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='v3' AND table_type='BASE TABLE' ORDER BY table_name`)).rows;

    console.log('=== schema public (V2 legado): ' + v2.length + ' tabelas ===');
    for (const t of v2) console.log('  ' + t.table_name);

    console.log('\n=== schema v3 (cérebro V3): ' + v3.length + ' tabelas ===');
    for (const t of v3) console.log('  ' + t.table_name);

    const sizes = (await p.query(
      `SELECT schemaname, relname,
              pg_size_pretty(pg_total_relation_size(schemaname || '.' || relname)) AS sz,
              pg_total_relation_size(schemaname || '.' || relname) AS sz_b,
              n_live_tup AS rows
       FROM pg_stat_user_tables
       WHERE schemaname IN ('public', 'v3')
       ORDER BY sz_b DESC LIMIT 20`)).rows;
    console.log('\n=== top 20 tabelas por tamanho (schema/relname tamanho rows) ===');
    for (const r of sizes) {
      console.log(`  ${r.schemaname.padEnd(8)} ${r.relname.padEnd(36)} ${String(r.sz).padStart(10)}  ${String(r.rows).padStart(8)} rows`);
    }

    const tot = (await p.query(
      `SELECT pg_size_pretty(SUM(pg_total_relation_size(schemaname || '.' || relname))::bigint) AS total,
              schemaname FROM pg_stat_user_tables WHERE schemaname IN ('public','v3')
       GROUP BY schemaname ORDER BY schemaname`)).rows;
    console.log('\n=== tamanho total por schema ===');
    for (const r of tot) console.log(`  ${r.schemaname}: ${r.total}`);

    const dbSize = await p.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS sz');
    console.log(`\nbanco inteiro: ${dbSize.rows[0].sz}`);

    // mensagens v3 (carga típica do Observer)
    const msgs = await p.query(
      `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE llm_processed_at IS NOT NULL)::int processed,
              COUNT(*) FILTER (WHERE llm_processed_at IS NULL)::int pending,
              MIN(created_at) first, MAX(created_at) last FROM v3.messages`);
    console.log('\n=== v3.messages (carga do Observer) ===');
    console.log(JSON.stringify(msgs.rows[0], null, 2));

    // events
    const evs = await p.query(
      `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE deleted_at IS NULL)::int active,
              COUNT(*) FILTER (WHERE ended_at IS NULL AND deleted_at IS NULL)::int open FROM v3.events`);
    console.log('\n=== v3.events ===');
    console.log(JSON.stringify(evs.rows[0], null, 2));
  } catch (e) { console.error('ERRO:', e.message); process.exitCode = 1; }
  finally { await p.end(); }
})();
