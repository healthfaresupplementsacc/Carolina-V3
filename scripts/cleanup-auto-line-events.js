'use strict';
// Remove os events de LINHA DE PRODUÇÃO criados por auto check-in do EMS (errado —
// linha é manual). Soft-delete só os ABERTOS sem contagem (ex.: ev 1352). Reporta os fechados.
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const openR = await pool.query(
    `SELECT e.id, p.display_name, to_char(e.started_at AT TIME ZONE 'America/New_York','MM-DD HH24:MI') AS started
     FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id JOIN v3.persons p ON p.id = e.person_id
     WHERE e.source = 'ems_auto' AND at.slug = 'production_line' AND e.ended_at IS NULL AND e.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM v3.production_counts pc WHERE pc.source_event_id = e.id AND pc.deleted_at IS NULL)`);
  console.log('Abertos (auto-checkin de linha) a remover:', openR.rowCount);
  openR.rows.forEach((r) => console.log('  ev', r.id, '·', r.display_name, '·', r.started));
  const del = await pool.query(
    `UPDATE v3.events SET deleted_at = NOW(), closed_reason = 'ems_auto_line_invalid', updated_at = NOW()
     WHERE id = ANY($1::int[]) RETURNING id`, [openR.rows.map((r) => r.id)]);
  console.log('Removidos:', del.rowCount);
  const closed = await pool.query(
    `SELECT COUNT(*)::int n FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
     WHERE e.source = 'ems_auto' AND at.slug = 'production_line' AND e.ended_at IS NOT NULL AND e.deleted_at IS NULL`);
  console.log('Fechados históricos (mantidos, reporta):', closed.rows[0].n);
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
