'use strict';
/* BLOCO 27/mai — correções autorizadas pelo Bruno (texto cru):
   ok C1 C2 C3 C4 (opção B truncar ev244)

   C1 — ev235 activity_type_id 11→26 (facility_maintenance)
   C2 — ev231 is_long_running=true (Chromium 0168 multi-dia)
   C3 — ev242 lunch ended_at = 2026-05-27T18:27 + closed_reason
   C4a — CREATE machine_downtime Vitor 14:45→15:11 (admin)
   C4b — TRUNCATE ev244 started_at: 14:59 → 15:11

   Idempotente, audited, reversível. Mostra ANTES → DEPOIS de cada um. */
const { Pool } = require('pg');
const { EventService } = require('../src/v3/services/EventService');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const eventService = new EventService({ db: pool });

  // Helper: pega snapshot atual de um event (campos relevantes)
  async function snap(id) {
    const r = await pool.query(`
      SELECT id, person_id, activity_type_id, product_batch_id, started_at, ended_at,
             closed_reason, cowork_with, is_long_running,
             LEFT(COALESCE(description, ''), 60) AS desc_preview
      FROM v3.events WHERE id = $1`, [id]);
    return r.rows[0] || null;
  }

  console.log('═══════════════════ C1 — ev235 → facility_maintenance ═══════════════════');
  const c1Before = await snap(235);
  console.log('  BEFORE:', c1Before);
  if (c1Before && c1Before.activity_type_id === 26) {
    console.log('  já está em facility_maintenance — skip (idempotente)');
  } else if (c1Before) {
    const c1After = await eventService.correct(235, { activity_type_id: 26 },
      null, 'C1 27/mai: facility maintenance (filtro AC), NÃO repair/downtime de linha. Autorizado Bruno texto cru.', 'admin');
    console.log('  AFTER :', { id: c1After.id, activity_type_id: c1After.activity_type_id, desc_preview: String(c1After.description || '').slice(0, 60) });
  }

  console.log('\n═══════════════════ C2 — ev231 → is_long_running ═══════════════════');
  const c2Before = await snap(231);
  console.log('  BEFORE:', c2Before);
  if (c2Before && c2Before.is_long_running === true) {
    console.log('  já é long_running — skip (idempotente)');
  } else if (c2Before) {
    const c2After = await eventService.markLongRunning(231, true, {
      actorType: 'admin',
      reason: 'C2 27/mai: Chromium 0168 multi-dia (igual Potassium). Autorizado Bruno texto cru.',
    });
    console.log('  AFTER :', { id: c2After.id, is_long_running: c2After.is_long_running });
  }

  console.log('\n═══════════════════ C3 — ev242 (lunch) close retroativo ═══════════════════');
  const c3Before = await snap(242);
  console.log('  BEFORE:', c3Before);
  if (c3Before && c3Before.ended_at) {
    console.log('  ev242 já tem ended_at —', c3Before.ended_at, 'skip (idempotente)');
  } else if (c3Before) {
    const newEnd = '2026-05-27T18:27:00-04:00';
    const c3After = await eventService.correct(242, {
      ended_at: newEnd,
      closed_reason: 'meta_closed_by_fg_retro',
    }, null, 'C3 27/mai: F implícito de meta retroativo — Bruno postou S:linha 18:27 sem F do almoço. Lunch fechado em 18:27 (started_at do ev246). Autorizado Bruno texto cru.', 'admin');
    console.log('  AFTER :', { id: c3After.id, ended_at: c3After.ended_at, closed_reason: c3After.closed_reason });
  }

  console.log('\n═══════════════════ C4b — TRUNCATE ev244 (started_at 14:59 → 15:11) ═══════════════════');
  const c4bBefore = await snap(244);
  console.log('  BEFORE:', c4bBefore);
  const expectedNewStart = '2026-05-27T15:11:00-04:00';
  if (c4bBefore && c4bBefore.started_at &&
      new Date(c4bBefore.started_at).getTime() === new Date(expectedNewStart).getTime()) {
    console.log('  ev244 já está truncado pra 15:11 — skip (idempotente)');
  } else if (c4bBefore) {
    const c4bAfter = await eventService.correct(244, {
      started_at: expectedNewStart,
      description: 'Imprimindo Label, abastecendo linha de produção (pós-downtime de máquina selar 14:45-15:11). Truncado de 14:59→15:11 em 27/mai pela correção C4b: downtime separado em ev novo.',
    }, null, 'C4b 27/mai: truncate organization → começa 15:11 (após máquina voltar). Antes era 14:59-15:32 mas incluía o downtime real. Autorizado Bruno texto cru.', 'admin');
    console.log('  AFTER :', { id: c4bAfter.id, started_at: c4bAfter.started_at, ended_at: c4bAfter.ended_at });
  }

  console.log('\n═══════════════════ C4a — CREATE machine_downtime Vitor 14:45→15:11 ═══════════════════');
  // checa idempotência manual — procura por event já existente do tipo no horário
  const c4aExists = await pool.query(`
    SELECT id FROM v3.events
    WHERE person_id = 4 AND activity_type_id = 27 AND deleted_at IS NULL
      AND started_at = '2026-05-27T14:45:00-04:00'::timestamptz`);
  if (c4aExists.rows[0]) {
    console.log('  ev', c4aExists.rows[0].id, 'já existe (Vitor machine_downtime 14:45) — skip (idempotente)');
  } else {
    // pega slack_ts da msg532 pra anexar na description (link de origem)
    const msg = await pool.query("SELECT slack_ts, raw_text FROM v3.messages WHERE id = 532");
    const origTs = msg.rows[0] ? msg.rows[0].slack_ts : '(?)';
    const created = await eventService.upsert({
      person_id: 4,                                    // Vitor
      activity_type_id: 27,                            // machine_downtime
      product_batch_id: null,
      started_at: '2026-05-27T14:45:00-04:00',
      ended_at:   '2026-05-27T15:11:00-04:00',
      source_message_ts: null,                         // admin create — não usa ts pra idempotência
      confidence: 'high',
      cowork_with: [],
      description: `Pausa para ajuste máquina de selar — linha Berberine 0167 parou; reajustada 15:11. Criado retroativo (admin) em 27/mai a partir da msg532 (slack_ts=${origTs}) que não havia gerado event automaticamente. Autorizado Bruno texto cru.`,
      actor_type: 'admin',
      actor_person_id: null,
    });
    console.log('  CREATED ev', created.id, ': machine_downtime Vitor 14:45→15:11');
  }

  // ────────── SMOKE FINAL ──────────
  console.log('\n═══════════════════ SMOKE FINAL ═══════════════════');
  const finalIds = [235, 231, 242, 244];
  for (const id of finalIds) {
    console.log('  ev' + id + ':', await snap(id));
  }
  const newMD = await pool.query(`
    SELECT id, started_at, ended_at, person_id, activity_type_id
    FROM v3.events
    WHERE person_id = 4 AND activity_type_id = 27 AND deleted_at IS NULL
      AND started_at = '2026-05-27T14:45:00-04:00'::timestamptz`);
  console.log('  NEW machine_downtime:', newMD.rows[0] || 'NÃO ACHADO');

  const auditCount = await pool.query(`
    SELECT action, COUNT(*)::int AS c
    FROM v3.audit_log
    WHERE created_at >= NOW() - interval '5 minutes'
    GROUP BY action ORDER BY action`);
  console.log('\n  AUDIT rows nos últimos 5min:');
  for (const r of auditCount.rows) console.log(`    ${r.action}: ${r.c}`);

  await pool.end();
  console.log('\n✓ C1+C2+C3+C4 APLICADAS (idempotente, audited).');
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
