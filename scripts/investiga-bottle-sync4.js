'use strict';
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s) => pool.query(s).then((r) => r.rows).catch((e) => [{ ERRO: e.message }]);
  console.log('=== closed_reason dos production_line SOLO sem count (14d) ===');
  console.log(JSON.stringify(await q(`
    SELECT COALESCE(e.closed_reason,'(null)') closed_reason, e.source, COUNT(*)::int n
    FROM v3.events e
    JOIN v3.activity_types at ON at.id=e.activity_type_id AND at.slug='production_line'
    LEFT JOIN v3.production_counts pc ON pc.source_event_id=e.id AND pc.deleted_at IS NULL
    WHERE e.deleted_at IS NULL AND e.ended_at IS NOT NULL AND e.cowork_group_id IS NULL
      AND e.exception_no_count = false AND pc.id IS NULL
      AND e.ended_at > NOW() - INTERVAL '14 days'
    GROUP BY 1,2 ORDER BY n DESC`, )));
  console.log('\n=== amostra desses events (id, source, closed_reason, started, ended) ===');
  console.log(JSON.stringify(await q(`
    SELECT e.id, e.source, e.closed_reason, p.display_name,
           to_char(e.started_at,'MM-DD HH24:MI') st, to_char(e.ended_at,'MM-DD HH24:MI') en
    FROM v3.events e
    JOIN v3.activity_types at ON at.id=e.activity_type_id AND at.slug='production_line'
    JOIN v3.persons p ON p.id=e.person_id
    LEFT JOIN v3.production_counts pc ON pc.source_event_id=e.id AND pc.deleted_at IS NULL
    WHERE e.deleted_at IS NULL AND e.ended_at IS NOT NULL AND e.cowork_group_id IS NULL
      AND e.exception_no_count = false AND pc.id IS NULL AND e.ended_at > NOW() - INTERVAL '14 days'
    ORDER BY e.ended_at DESC LIMIT 12`, )));
  await pool.end();
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
