'use strict';
/* Bruno OK em texto cru — PATCH ev305 fim de expediente.
   ev305 Bruno Sarmento end_of_day 6:46 PM ficou LIVE; fim de expediente
   é carimbo instantâneo (regra 32 bloco 28/mai noite).
   Idempotente, audited via EventService.correct. */
const { Pool } = require('pg');
const { EventService } = require('../src/v3/services/EventService');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const eventService = new EventService({ db: pool });

  async function snap(id) {
    const r = await pool.query(`
      SELECT e.id, p.display_name AS person, at.slug AS activity,
        e.started_at, e.ended_at, e.closed_reason,
        TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS ny_start,
        TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS ny_end,
        EXTRACT(EPOCH FROM (COALESCE(e.ended_at, NOW()) - e.started_at))::int AS dur_sec,
        LEFT(COALESCE(e.description,''), 100) AS desc
      FROM v3.events e
      LEFT JOIN v3.persons p ON p.id = e.person_id
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      WHERE e.id = $1`, [id]);
    return r.rows[0] || null;
  }
  const fmt = (s) => s
    ? `ev${s.id} ${s.person} ${s.activity} ${s.ny_start}→${s.ny_end || 'LIVE'} closed_reason=${s.closed_reason || 'NULL'} dur=${Math.floor(s.dur_sec / 3600)}h${Math.floor((s.dur_sec % 3600) / 60)}m`
    : 'NULL';

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' BEFORE');
  console.log('═══════════════════════════════════════════════════════════');
  const before = await snap(305);
  console.log('  ' + fmt(before));
  if (!before) { console.error('ev305 não existe'); await pool.end(); process.exit(1); }

  // Idempotência
  const sameEnded = before.ended_at && new Date(before.ended_at).getTime() === new Date(before.started_at).getTime();
  const sameReason = before.closed_reason === 'end_of_day';
  if (sameEnded && sameReason) {
    console.log('\n  ✓ ev305 já está como esperado — skip');
    await pool.end();
    process.exit(0);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' STEP — PATCH ev305 ended_at=started_at + closed_reason=end_of_day');
  console.log('═══════════════════════════════════════════════════════════');
  await eventService.correct(305,
    { ended_at: before.started_at, closed_reason: 'end_of_day' },
    null,
    'Bloco 28/mai noite #32: fim de expediente é carimbo instantâneo. ev305 ficou LIVE 4h41m porque a regra ainda não existia quando foi criado. PATCH ended_at=started_at (6:46 PM NY) + closed_reason=end_of_day. Sistema agora trata end_of_day como evento instantâneo na criação (EventService _isEndOfDay) e dashboard usa esse horário pra calcular tempo ativo. Autorizado Bruno texto cru.',
    'admin');

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' AFTER');
  console.log('═══════════════════════════════════════════════════════════');
  const after = await snap(305);
  console.log('  ' + fmt(after));

  const audit = await pool.query(`
    SELECT action, COUNT(*)::int AS c
    FROM v3.audit_log WHERE created_at >= NOW() - interval '2 minutes'
    GROUP BY action ORDER BY action`);
  console.log('\n  AUDIT rows nos últimos 2min:');
  for (const r of audit.rows) console.log(`    ${r.action}: ${r.c}`);

  await pool.end();
  console.log('\n✓ ev305 PATCHED.');
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
