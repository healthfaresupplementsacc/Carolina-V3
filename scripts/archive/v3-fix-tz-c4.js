'use strict';
/* Fix TZ pro C4 — corrige os 4h de adiantamento causado por offset -04:00.
   Sistema armazena timestamps em "wall-NY-as-UTC" (string sem offset). */
const { Pool } = require('pg');
const { EventService } = require('../src/v3/services/EventService');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const eventService = new EventService({ db: pool });

  async function snap(id) {
    const r = await pool.query(`
      SELECT id, person_id, activity_type_id,
             started_at, ended_at, closed_reason
      FROM v3.events WHERE id = $1`, [id]);
    return r.rows[0] || null;
  }

  console.log('═══ ev244 — re-patch started_at (4h shift) ═══');
  console.log('BEFORE:', await snap(244));
  const r244 = await eventService.correct(244,
    { started_at: '2026-05-27T15:11:00.000Z' },
    null,
    'fix-tz C4b: convention wall-NY-as-UTC (sem offset). Antes 19:11Z (4h adiantado pelo -04:00). Agora 15:11Z = 15:11 NY display correto.',
    'admin');
  console.log('AFTER :', { id: r244.id, started_at: r244.started_at, ended_at: r244.ended_at });

  console.log('\n═══ ev255 — re-patch started_at + ended_at ═══');
  console.log('BEFORE:', await snap(255));
  // Patch single call pra evitar guard de duração negativa entre patches
  const r255 = await eventService.correct(255,
    {
      started_at: '2026-05-27T14:45:00.000Z',
      ended_at:   '2026-05-27T15:11:00.000Z',
    },
    null,
    'fix-tz C4a: convention wall-NY-as-UTC. Antes 18:45→19:11 (4h adiantado pelo -04:00). Agora 14:45→15:11 NY display correto.',
    'admin');
  console.log('AFTER :', { id: r255.id, started_at: r255.started_at, ended_at: r255.ended_at });

  console.log('\n═══ SMOKE final ═══');
  for (const id of [231, 235, 242, 244, 255]) {
    const s = await snap(id);
    console.log(`  ev${id} ${s ? s.started_at.toISOString() + '→' + (s.ended_at ? s.ended_at.toISOString() : 'LIVE') : '(?)'} reason=${s ? s.closed_reason : '?'}`);
  }

  await pool.end();
  console.log('\n✓ TZ corrigida em ev244 + ev255.');
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
