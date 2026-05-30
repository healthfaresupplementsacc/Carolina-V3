'use strict';
/* Bruno OK em texto cru — writes d/e/f retroativos pós-guard slack_ts (2be626f).
   TZ: ISO UTC explícito 'Z'. NY = EDT UTC-4 em 29/mai. */
const { Pool } = require('pg');
const { EventService } = require('../src/v3/services/EventService');

// d ev334: 17:31:50 → 17:32:00 (10sec, manutenção curta Chromium)
const D_EV334_START = '2026-05-29T21:31:50Z';
const D_EV334_END   = '2026-05-29T21:32:00Z';
// e ev335: 17:27:38 → 17:30:46 (msg724 S + msg725 F line_changeover)
const E_EV335_START = '2026-05-29T21:27:38Z';
const E_EV335_END   = '2026-05-29T21:30:46Z';
// f ev330 ended_at: 18:34 → 17:34:06 (msg727 F)
const F_EV330_END   = '2026-05-29T21:34:06Z';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const ev = new EventService({ db: pool });

  async function snap(id) {
    const r = await pool.query(`
      SELECT e.id, e.person_id, p.display_name AS person, at.slug, at.flow,
        TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS s,
        TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS e_t,
        e.deleted_at, e.closed_reason, e.confidence, e.cowork_with,
        pb.batch_number, pr.canonical_name AS product,
        LEFT(COALESCE(e.description,''), 100) AS desc
      FROM v3.events e
      LEFT JOIN v3.persons p ON p.id = e.person_id
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
      LEFT JOIN v3.products pr ON pr.id = pb.product_id
      WHERE e.id = $1`, [id]);
    return r.rows[0] || null;
  }
  const fmt = (s) => s
    ? `ev${s.id} ${s.person}(${s.person_id}) [${s.slug}] ${s.s}→${s.e_t || 'LIVE'} cw=${JSON.stringify(s.cowork_with)} closed=${s.closed_reason || '—'} conf=${s.confidence}${s.deleted_at ? ' (DEL)' : ''}`
    : 'NULL';

  // ═══════════════════ (d) PATCH ev334 ═══════════════════
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' (d) PATCH ev334 Bruno Sarmento Chromium downtime');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BEFORE:', fmt(await snap(334)));
  await ev.correct(334, {
    started_at: D_EV334_START,
    ended_at: D_EV334_END,
    closed_reason: 'manual',
  }, null,
  'Bloco 29/mai-noite Item 5(d): corrige TZ shift +1h do reprocesso (msg726 17:31:50 PM virou ev334 started_at 18:31:50). Restaura horário real do slack_ts. Ended em 17:32:00 (manutenção curta Chromium, dur 10s registra a interrupção). Autorizado Bruno texto cru.',
  'admin');
  console.log('  AFTER :', fmt(await snap(334)));

  // ═══════════════════ (e) PATCH ev335 ═══════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' (e) PATCH ev335 Bruno Sarmento line_changeover');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BEFORE:', fmt(await snap(335)));
  await ev.correct(335, {
    started_at: E_EV335_START,
    ended_at: E_EV335_END,
    closed_reason: 'manual',
  }, null,
  'Bloco 29/mai-noite Item 5(e): corrige TZ shift +1h20 do reprocesso. msg724 17:27:38 PM "S-Troca de linha" + msg725 17:30:46 PM "F-Pausa na troca". Restaura horários reais. Autorizado Bruno texto cru.',
  'admin');
  console.log('  AFTER :', fmt(await snap(335)));

  // ═══════════════════ (f) PATCH ev330 ═══════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' (f) PATCH ev330 Simone Akkermansia ended_at');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BEFORE:', fmt(await snap(330)));
  await ev.correct(330, {
    ended_at: F_EV330_END,
    closed_reason: 'manual',
  }, null,
  'Bloco 29/mai-noite Item 5(f): corrige TZ shift +1h em ended_at. msg727 17:34:06 PM "F::fazendo Akemansia manualmente" foi shift pra 18:34:06 pelo LLM. Restaura horário real. Autorizado Bruno texto cru.',
  'admin');
  console.log('  AFTER :', fmt(await snap(330)));

  const audits = await pool.query(`
    SELECT action, COUNT(*)::int AS c FROM v3.audit_log
    WHERE created_at >= NOW() - interval '3 minutes' GROUP BY action ORDER BY action`);
  console.log('\n  --- AUDIT últimos 3min ---');
  for (const r of audits.rows) console.log(`    ${r.action}: ${r.c}`);

  await pool.end();
  console.log('\n✓ Writes d/e/f APLICADOS.');
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
