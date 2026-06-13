'use strict';
/* HEALTHFARE V3 — seed dos 3 admin_users (Fase 1 RBAC).
   PINs lidos de env vars (NUNCA no código/commit):
     ADMIN_PIN_BRUNO, ADMIN_PIN_THASSIO, ADMIN_PIN_HENRIQUE
   Rodar 1x após migration 025:
     railway run node scripts/v3-seed-admin-users.js
   Idempotente: pula quem já existe (por slack_user_id). PIN scrypt. */
const { Pool } = require('pg');
const opAuth = require('../src/lib/op-auth');

const ADMINS = [
  { env: 'ADMIN_PIN_BRUNO', name: 'Bruno Camp', role: 'owner', slack_user_id: 'U03URLL1D4L' },
  { env: 'ADMIN_PIN_THASSIO', name: 'Thassio', role: 'owner', slack_user_id: 'U03S46L2EUA' },
  { env: 'ADMIN_PIN_HENRIQUE', name: 'Henrique Monteiro', role: 'manager', slack_user_id: 'U085SDY3F4Z' },
];

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let created = 0; let skipped = 0;
  for (const a of ADMINS) {
    const pin = process.env[a.env];
    if (!pin || !/^\d{4,8}$/.test(pin)) { console.error(`! ${a.name}: env ${a.env} ausente/inválido — pulando`); continue; }
    const exists = await pool.query('SELECT id FROM v3.admin_users WHERE slack_user_id = $1', [a.slack_user_id]);
    if (exists.rowCount) { console.log(`= ${a.name}: já existe (id ${exists.rows[0].id})`); skipped++; continue; }
    const { pin_hash, pin_salt } = opAuth.hashPin(pin);
    const r = await pool.query(
      `INSERT INTO v3.admin_users (name, role, pin_hash, pin_salt, slack_user_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [a.name, a.role, pin_hash, pin_salt, a.slack_user_id]);
    await pool.query(
      `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
       VALUES ('system', NULL, 'admin_user.created', 'admin_user', $1, $2::jsonb)`,
      [r.rows[0].id, JSON.stringify({ name: a.name, role: a.role, via: 'seed_script' })]);
    console.log(`+ ${a.name} (${a.role}) criado — id ${r.rows[0].id}`);
    created++;
  }
  const total = await pool.query("SELECT role, count(*) n FROM v3.admin_users WHERE is_active GROUP BY role ORDER BY role");
  console.log('--- admin_users ativos: ' + total.rows.map((x) => `${x.role}=${x.n}`).join(', '));
  console.log(`criados: ${created}, pulados: ${skipped}`);
  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
