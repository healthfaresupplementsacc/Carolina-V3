'use strict';
// CLEANUP único: conserta events ems_auto com started_at no futuro / invertido
// (causado por timeline.formulation.started_at corrompido no EMS). Põe o início =
// created_at (momento real da detecção), garantindo started_at <= ended_at.
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const before = await pool.query(
    `SELECT id, to_char(started_at AT TIME ZONE 'America/New_York','MM-DD HH24:MI') AS start_ny,
            to_char(ended_at AT TIME ZONE 'America/New_York','MM-DD HH24:MI') AS end_ny
     FROM v3.events
     WHERE source = 'ems_auto' AND deleted_at IS NULL
       AND (started_at > NOW() OR (ended_at IS NOT NULL AND ended_at < started_at))
     ORDER BY id`);
  console.log('Vão ser corrigidos:', JSON.stringify(before.rows, null, 2));
  const upd = await pool.query(
    `UPDATE v3.events
        SET started_at = LEAST(created_at, COALESCE(ended_at, created_at)), updated_at = NOW()
      WHERE source = 'ems_auto' AND deleted_at IS NULL
        AND (started_at > NOW() OR (ended_at IS NOT NULL AND ended_at < started_at))
      RETURNING id`);
  console.log('Corrigidos:', upd.rowCount, 'events →', upd.rows.map((r) => r.id).join(', '));
  const after = await pool.query(
    `SELECT COUNT(*)::int AS n FROM v3.events
      WHERE source = 'ems_auto' AND deleted_at IS NULL
        AND (started_at > NOW() OR (ended_at IS NOT NULL AND ended_at < started_at))`);
  console.log('Restantes futuro/invertido:', after.rows[0].n);
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
