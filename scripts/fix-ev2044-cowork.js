'use strict';
/* Bruno 07-10: repara o fantasma ev2044. Estado errado: Vitor "limpando desde
   09:00" solto. Correto: Vitor entrou na limpeza ABERTA do Bruno Sarmento (ev2038)
   como cowork, a partir do momento do aviso (18:17). Junta os dois num cowork_group.
   railway run --service ProductionLineService node scripts/fix-ev2044-cowork.js */
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const EDT = 'America/New_York';
const t = (x) => (x ? new Date(x).toLocaleString('en-US', { timeZone: EDT, hour12: false }) : '-');
const ANCHOR = 2038; // Bruno Sarmento cleaning (dono)
const PHANTOM = 2044; // Vitor cleaning fantasma (9am)

(async () => {
  const before = (await p.query(
    `SELECT id, person_id, started_at, ended_at, cowork_group_id, cowork_with FROM v3.events WHERE id = ANY($1)`,
    [[ANCHOR, PHANTOM]])).rows;
  console.log('ANTES:');
  before.forEach((e) => console.log('  ev' + e.id, 'p' + e.person_id, 'start', t(e.started_at), 'gid', e.cowork_group_id, 'cw', JSON.stringify(e.cowork_with)));

  const anchor = before.find((e) => e.id === ANCHOR);
  const phantom = before.find((e) => e.id === PHANTOM);
  if (!anchor || !phantom) { console.log('faltou ev — aborta'); await p.end(); return; }
  if (anchor.ended_at) console.log('AVISO: ev2038 já fechou; mesmo assim linko o grupo.');

  // hora do aviso = slack_ts da msg do admin
  const m = (await p.query(`SELECT slack_ts FROM v3.messages WHERE raw_text ILIKE '%Vitor esta na limpeza%' ORDER BY created_at DESC LIMIT 1`)).rows[0];
  const startExpr = m && m.slack_ts ? `to_timestamp(${parseFloat(m.slack_ts)})` : 'NOW()';

  await p.query('BEGIN');
  try {
    // 1) grupo: reusa o do âncora se tiver, senão cria
    let gid = anchor.cowork_group_id;
    if (!gid) {
      gid = (await p.query(`UPDATE v3.events SET cowork_group_id = gen_random_uuid(), updated_at = NOW() WHERE id = $1 RETURNING cowork_group_id`, [ANCHOR])).rows[0].cowork_group_id;
    }
    // 2) Bruno (âncora) passa a ter Vitor no cowork_with
    await p.query(
      `UPDATE v3.events SET cowork_with = ARRAY[$2]::int[], updated_at = NOW() WHERE id = $1`,
      [ANCHOR, phantom.person_id]);
    // 3) Vitor: entra no grupo, começa na hora do aviso, cowork_with = [Bruno]
    await p.query(
      `UPDATE v3.events SET cowork_group_id = $2::uuid, started_at = ${startExpr},
              cowork_with = ARRAY[$3]::int[], updated_at = NOW()
       WHERE id = $1`,
      [PHANTOM, gid, anchor.person_id]);
    await p.query('COMMIT');
    console.log('\ngid usado:', gid, '| start do Vitor:', startExpr);
  } catch (e) { await p.query('ROLLBACK'); throw e; }

  const after = (await p.query(
    `SELECT id, person_id, started_at, ended_at, cowork_group_id, cowork_with FROM v3.events WHERE id = ANY($1) ORDER BY id`,
    [[ANCHOR, PHANTOM]])).rows;
  console.log('\nDEPOIS:');
  after.forEach((e) => console.log('  ev' + e.id, 'p' + e.person_id, 'start', t(e.started_at), 'gid', e.cowork_group_id, 'cw', JSON.stringify(e.cowork_with)));
  console.log('');
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
