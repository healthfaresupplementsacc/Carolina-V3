'use strict';
/* Os grupos cowork production_line recentes gravaram bottle count? (read-only) */
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s, p) => pool.query(s, p).then((r) => r.rows);
  console.log('=== production_line events recentes: count? last_finisher? quando? ===');
  const rows = await q(`
    SELECT e.id, e.cowork_group_id, e.cowork_is_last_finisher AS last, e.closed_reason,
           e.started_at AT TIME ZONE 'America/New_York' AS started_edt,
           e.ended_at AT TIME ZONE 'America/New_York' AS ended_edt,
           e.exception_no_count AS exc,
           (SELECT COUNT(*)::int FROM v3.production_counts pc WHERE pc.source_event_id = e.id) AS counts
    FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE at.slug = 'production_line' AND e.deleted_at IS NULL
    ORDER BY e.started_at DESC LIMIT 14`);
  rows.forEach((r) => console.log(
    `  ev#${r.id} grp=${(r.cowork_group_id || '-').toString().slice(0, 8)} last=${r.last} exc=${r.exc} counts=${r.counts} reason=${r.closed_reason || '-'} ended=${r.ended_edt ? r.ended_edt.toISOString().slice(11, 16) : 'OPEN'} ${r.counts === 0 && !r.exc && r.closed_reason === 'operator_page' && !r.last ? ' <-- /end SEM count!' : ''}`));
  console.log('\n=== counts por grupo cowork (cada grupo deveria ter 1 count no total) ===');
  const grp = await q(`
    SELECT e.cowork_group_id AS grp, COUNT(DISTINCT e.id)::int AS members,
           COALESCE(SUM((SELECT COUNT(*) FROM v3.production_counts pc WHERE pc.source_event_id = e.id)),0)::int AS counts,
           BOOL_OR(e.exception_no_count) AS any_exc
    FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE at.slug = 'production_line' AND e.cowork_group_id IS NOT NULL AND e.deleted_at IS NULL
    GROUP BY e.cowork_group_id ORDER BY MAX(e.started_at) DESC LIMIT 8`);
  grp.forEach((g) => console.log(`  grp=${g.grp.slice(0, 8)} members=${g.members} counts=${g.counts} exception=${g.any_exc} ${g.counts === 0 && !g.any_exc ? '  <-- SEM CONTAGEM!' : ''}`));
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
