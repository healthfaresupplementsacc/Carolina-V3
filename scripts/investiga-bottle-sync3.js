'use strict';
const { Pool } = require('pg');
const EDT = 'America/New_York';
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s) => pool.query(s).then((r) => r.rows).catch((e) => [{ ERRO: e.message }]);

  console.log('=== LEGADO public.production_counts (o que o /dashboard lê) — última atividade ===');
  console.log(JSON.stringify(await q(`SELECT COUNT(*)::int n, MAX(created_at) AS ultimo FROM production_counts`)));
  console.log('recentes (7d) no legado: ' + JSON.stringify(await q(`SELECT COUNT(*)::int n, COALESCE(SUM(count),0)::int total FROM production_counts WHERE created_at > NOW() - INTERVAL '7 days'`)));
  console.log('legado tasks recentes (7d): ' + JSON.stringify(await q(`SELECT COUNT(*)::int n, MAX(created_at) ultimo FROM tasks WHERE created_at > NOW() - INTERVAL '7 days'`)));

  console.log('\n=== V3 (o que o /op escreve) — última atividade ===');
  console.log('v3.production_counts: ' + JSON.stringify(await q(`SELECT COUNT(*)::int n, MAX(reported_at) ultimo FROM v3.production_counts WHERE reported_at > NOW() - INTERVAL '7 days'`)));

  console.log('\n=== os 53 production_line sem count: cowork vs solo? ===');
  console.log(JSON.stringify(await q(`
    SELECT
      (e.cowork_group_id IS NOT NULL) AS is_cowork,
      e.exception_no_count,
      (pc.id IS NOT NULL) AS tem_count,
      COUNT(*)::int n
    FROM v3.events e
    JOIN v3.activity_types at ON at.id=e.activity_type_id AND at.slug='production_line'
    LEFT JOIN v3.production_counts pc ON pc.source_event_id=e.id AND pc.deleted_at IS NULL
    WHERE e.deleted_at IS NULL AND e.ended_at IS NOT NULL AND e.ended_at > NOW() - INTERVAL '14 days'
    GROUP BY 1,2,3 ORDER BY 1,2,3`, )));

  console.log('\n=== /dashboard-v4 existe? (FASE 6 P6.1) ===');
  // só checa se a rota estática serve algo — informativo
  console.log('(checar wire.js: /dashboard e /dashboard-v4 são estáticos)');
  await pool.end();
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
