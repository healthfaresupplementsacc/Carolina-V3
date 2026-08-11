'use strict';
/* Bruno 07-10: a limpeza do Vitor ficou FRAGMENTADA — ev2040 (0s, 17:02),
   ev2043 (1min, 18:17), ev2044 (aberto, começava 18:17) — com um buraco de 1h15
   entre a produção (fim 17:01) e a limpeza. Realidade: o Vitor entrou na limpeza
   do Bruno (ev2038) assim que ficou livre (~17:01) e ficou junto. Consolida:
   ev2044 passa a começar no fim da produção do Vitor (ev2037) e os fragmentos
   ev2040/ev2043 são absorvidos (soft-delete). Board: sem buraco, batchado.
   railway run --service ProductionLineService node scripts/fix-vitor-cleaning-consolidate.js */
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const EDT = 'America/New_York';
const t = (x) => (x ? new Date(x).toLocaleString('en-US', { timeZone: EDT, hour12: false }) : '-');
const SURVIVOR = 2044;               // Vitor cleaning aberto (no grupo do Bruno)
const FRAGMENTS = [2040, 2043];      // Vitor cleaning fragmentos
const LAST_TASK = 2037;              // Vitor production_line (fim = quando ficou livre)
const ADMIN = 1;                     // Bruno Camp

(async () => {
  const lastEnd = (await p.query('SELECT ended_at FROM v3.events WHERE id = $1', [LAST_TASK])).rows[0];
  if (!lastEnd || !lastEnd.ended_at) { console.log('ev2037 sem ended_at — aborta'); await p.end(); return; }
  const newStart = lastEnd.ended_at;

  const before = (await p.query(
    `SELECT id, person_id, started_at, ended_at, cowork_group_id, cowork_with, deleted_at FROM v3.events WHERE id = ANY($1) ORDER BY id`,
    [[SURVIVOR, ...FRAGMENTS]])).rows;
  console.log('ANTES:');
  before.forEach((e) => console.log('  ev' + e.id, 'start', t(e.started_at), 'end', t(e.ended_at), 'gid', (e.cowork_group_id || '').slice(0, 8), e.deleted_at ? 'DEL' : ''));

  await p.query('BEGIN');
  try {
    // 1) sobrevivente começa quando o Vitor ficou livre (fim da produção) → preenche o buraco
    await p.query('UPDATE v3.events SET started_at = $2, updated_at = NOW() WHERE id = $1', [SURVIVOR, newStart]);
    // 2) fragmentos absorvidos
    await p.query(
      `UPDATE v3.events SET deleted_at = NOW(), deleted_by = $2, updated_at = NOW()
        WHERE id = ANY($1) AND deleted_at IS NULL`, [FRAGMENTS, ADMIN]);
    await p.query('COMMIT');
  } catch (e) { await p.query('ROLLBACK'); throw e; }

  const after = (await p.query(
    `SELECT id, person_id, started_at, ended_at, cowork_group_id, cowork_with, deleted_at FROM v3.events WHERE id = ANY($1) ORDER BY id`,
    [[SURVIVOR, ...FRAGMENTS, 2038]])).rows;
  console.log('\nDEPOIS:');
  after.forEach((e) => console.log('  ev' + e.id, 'p' + e.person_id, 'start', t(e.started_at), 'end', t(e.ended_at), 'gid', (e.cowork_group_id || '').slice(0, 8), 'cw', JSON.stringify(e.cowork_with), e.deleted_at ? 'DELETED' : ''));
  console.log('\nVitor agora: limpeza', t(newStart), '→ aberto, no grupo do Bruno (sem buraco, batchado).');
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
