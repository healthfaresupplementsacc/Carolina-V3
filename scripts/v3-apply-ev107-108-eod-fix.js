'use strict';
/* Bruno OK em texto cru — fix retroativo de end_of_day pré-bloco 30/mai.
   ev107 Vitor + ev108 Bruno Sarmento foram fechados no dia seguinte por
   meta_closed_by_fg (bug antigo). Restaura carimbo instantâneo
   (ended_at = started_at) via correct() forceEodPatch=true. */
const { Pool } = require('pg');
const { EventService } = require('../src/v3/services/EventService');

const EV107_STARTED_UTC = '2026-05-22T00:08:43Z';  // 20:08:43 NY EDT 21/mai
const EV108_STARTED_UTC = '2026-05-22T00:32:59Z';  // 20:32:59 NY EDT 21/mai

const REASON = 'Vítima do bug antigo meta_closed_by_fg pré-fix bloco 30/mai. '
  + 'end_of_day arrastado pro dia seguinte (17h+ / 20h+ inflado). Reverter '
  + 'pro carimbo instantâneo conforme invariant da regra 32. Autorizado '
  + 'Bruno texto cru bloco 30/mai noite.';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const ev = new EventService({ db: pool });

  async function snap(id) {
    const r = await pool.query(`
      SELECT e.id, p.display_name AS person, at.slug,
        e.started_at, e.ended_at,
        TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS s_ny,
        TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS e_ny,
        e.closed_reason, e.deleted_at IS NOT NULL AS deleted,
        EXTRACT(EPOCH FROM (COALESCE(e.ended_at, e.started_at) - e.started_at))::int AS dur_sec
      FROM v3.events e
      LEFT JOIN v3.persons p ON p.id = e.person_id
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      WHERE e.id = $1`, [id]);
    return r.rows[0] || null;
  }
  const fmt = (s) => s
    ? `ev${s.id} ${s.person} [${s.slug}] started=${s.s_ny}NY ended=${s.e_ny || 'NULL'}NY dur=${s.dur_sec}s closed=${s.closed_reason || '—'}${s.deleted ? ' (DEL)' : ''}`
    : 'NULL';

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' BEFORE');
  console.log('═══════════════════════════════════════════════════════════');
  for (const id of [107, 108]) console.log('  ' + fmt(await snap(id)));

  // ev107 Vitor
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' PATCH ev107 Vitor: ended_at = started_at (00:08:43 UTC)');
  console.log('═══════════════════════════════════════════════════════════');
  await ev.correct(107, { ended_at: EV107_STARTED_UTC }, null, REASON, 'admin');
  console.log('  ' + fmt(await snap(107)));

  // ev108 Bruno Sarmento
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' PATCH ev108 Bruno Sarmento: ended_at = started_at (00:32:59 UTC)');
  console.log('═══════════════════════════════════════════════════════════');
  await ev.correct(108, { ended_at: EV108_STARTED_UTC }, null, REASON, 'admin');
  console.log('  ' + fmt(await snap(108)));

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' AFTER');
  console.log('═══════════════════════════════════════════════════════════');
  for (const id of [107, 108]) console.log('  ' + fmt(await snap(id)));

  const audits = await pool.query(`
    SELECT action, COUNT(*)::int AS c FROM v3.audit_log
    WHERE created_at >= NOW() - interval '2 minutes' GROUP BY action ORDER BY action`);
  console.log('\n  --- AUDIT últimos 2min ---');
  for (const r of audits.rows) console.log(`    ${r.action}: ${r.c}`);

  await pool.end();
  console.log('\n✓ ev107/ev108 RESTAURADOS pro carimbo instantâneo.');
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
