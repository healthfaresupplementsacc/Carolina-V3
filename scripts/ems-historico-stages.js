'use strict';
/* A gente capturou horários de início de stage ONTEM? Olha o histórico do cache:
   quando começou a registrar, transições reais vs bulk, completados com duração. */
const { Pool } = require('pg');
const EDT = 'America/New_York';
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s) => pool.query(s).then((r) => r.rows).catch((e) => [{ ERRO: e.message }]);

  console.log('=== quando o cache começou a registrar (first_seen por hora) ===');
  console.log(JSON.stringify(await q(`
    SELECT to_char(first_seen_at AT TIME ZONE '${EDT}','MM-DD HH24h') hora, COUNT(*)::int n,
           COUNT(*) FILTER (WHERE machine IS NOT NULL)::int maquina,
           COUNT(*) FILTER (WHERE machine IS NULL)::int stage_sem_maq
    FROM v3.ems_activity_cache GROUP BY 1 ORDER BY 1`), null, 1));

  console.log('\n=== total de linhas no cache + intervalo ===');
  console.log(JSON.stringify(await q(`SELECT COUNT(*)::int total, MIN(first_seen_at) primeiro, MAX(first_seen_at) ultimo,
    COUNT(*) FILTER (WHERE sync_status='completed')::int completados FROM v3.ems_activity_cache`)));

  console.log('\n=== atividades COMPLETADAS ontem (com duração capturada por nós) ===');
  console.log(JSON.stringify(await q(`
    SELECT batch_number, stage, machine, employee_ems_name,
           to_char(first_seen_at AT TIME ZONE '${EDT}','MM-DD HH24:MI') inicio_nosso,
           to_char(ended_at AT TIME ZONE '${EDT}','MM-DD HH24:MI') fim_nosso, duration_seconds
    FROM v3.ems_activity_cache
    WHERE sync_status='completed' AND (ended_at AT TIME ZONE '${EDT}')::date >= (NOW() AT TIME ZONE '${EDT}')::date - 1
    ORDER BY ended_at DESC LIMIT 15`), null, 1));

  console.log('\n=== ATIVAS: first_seen é transição real ou "já estava lá"? (distintos timestamps) ===');
  console.log(JSON.stringify(await q(`SELECT to_char(first_seen_at,'MM-DD HH24:MI:SS') ts, COUNT(*)::int n FROM v3.ems_activity_cache WHERE sync_status='active' GROUP BY 1 ORDER BY 1`)));
  await pool.end();
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
