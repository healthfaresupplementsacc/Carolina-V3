'use strict';
// Único: cria notificação goal_no_product pras metas SEM produto que já existem
// (ex.: goals 43/44 batch 0231). Não duplica (checa se já tem notif pro goal).
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const orphans = await pool.query(
    `SELECT g.id, g.batch_number, g.expected_quantity, g.source
     FROM v3.production_goals g
     WHERE g.deleted_at IS NULL AND g.product_id IS NULL
       AND g.production_date > (NOW() AT TIME ZONE 'America/New_York')::date - 7`);
  let made = 0;
  for (const g of orphans.rows) {
    const exists = await pool.query(
      `SELECT 1 FROM v3.notifications WHERE type = 'goal_no_product' AND (payload->>'goal_id')::int = $1 LIMIT 1`, [g.id]);
    if (exists.rowCount) continue;
    await pool.query(
      `INSERT INTO v3.notifications (type, payload, status) VALUES ('goal_no_product', $1::jsonb, 'pending')`,
      [JSON.stringify({ goal_id: g.id, batch_number: g.batch_number, expected_quantity: g.expected_quantity, source: g.source,
        text: 'Meta sem produto identificado (lote ' + g.batch_number + ') — confirme qual suplemento.' })]);
    made++;
    console.log('flagged goal', g.id, 'batch', g.batch_number, 'exp', g.expected_quantity);
  }
  console.log('Metas órfãs:', orphans.rows.length, '· notificações criadas:', made);
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
