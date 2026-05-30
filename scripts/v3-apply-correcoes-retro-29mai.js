'use strict';
/* Bruno OK em texto cru — bloco 29/mai-noite Item 5 correções retroativas.
   Aplica grupo A (a, b, c) + grupo C (h). Pula grupo B (d/e/f — TZ shift
   é bug a investigar separado).

   TZ: NY 29/mai = EDT (UTC-4). ISO UTC explícito ('...Z') pra evitar
   bug histórico do ev318.

   Writes:
   (a) PATCH ev326 lunch Vitor: ended_at 16:57→16:08:38 PM NY, closed_reason='manual'
   (b) PATCH ev306 Simone orders: ended_at 11:13→09:53:15 NY, closed_reason='manual'
   (c) CREATE Akkermansia manual Simone: 10:54:51→11:02:13 NY (8min, batch_id=9)
   (h) CREATE machine_downtime: Vitor 16:18→16:52 PM NY, cw=[6,7], batch=24 */
const { Pool } = require('pg');
const { EventService } = require('../src/v3/services/EventService');

// Constantes — TZ explícito Z
const A_EV326_END   = '2026-05-29T20:08:38Z';  // 16:08:38 PM NY
const B_EV306_END   = '2026-05-29T13:53:15Z';  // 09:53:15 NY
const C_AKK_START   = '2026-05-29T14:54:51Z';  // 10:54:51 NY (msg676)
const C_AKK_END     = '2026-05-29T15:02:13Z';  // 11:02:13 NY (msg678)
const H_DT_START    = '2026-05-29T20:18:00Z';  // 16:18:00 PM NY
const H_DT_END      = '2026-05-29T20:52:00Z';  // 16:52:00 PM NY

const ACTIVITY_PRODUCTION_LINE = 5;
const ACTIVITY_MACHINE_DOWNTIME = 27;
const PRODUCT_AKKERMANSIA = 18;
const BATCH_AKKERMANSIA_01 = 9;       // batch_id=9 "01" in_progress
const BATCH_POTASSIUM_0170 = 24;

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const ev = new EventService({ db: pool });

  async function snap(id) {
    const r = await pool.query(`
      SELECT e.id, e.person_id, p.display_name AS person, at.slug, at.flow,
        TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS s,
        TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS e_t,
        e.deleted_at IS NOT NULL AS deleted, e.closed_reason, e.confidence,
        pb.batch_number, pr.canonical_name AS product, e.cowork_with,
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
    ? `ev${s.id} ${s.person}(${s.person_id}) [${s.slug}/${s.flow}] ${s.s}→${s.e_t || 'LIVE'} prod=${s.product || '—'}/${s.batch_number || '—'} cw=${JSON.stringify(s.cowork_with)} closed=${s.closed_reason || '—'} conf=${s.confidence}${s.deleted ? ' (DEL)' : ''}`
    : 'NULL';

  // ═══════════════════ (a) PATCH ev326 ═══════════════════
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' (a) PATCH ev326 lunch Vitor — ended_at 16:57→16:08:38 PM');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BEFORE:', fmt(await snap(326)));
  await ev.correct(326, {
    ended_at: A_EV326_END,
    closed_reason: 'manual',
  }, null,
  'Bloco 29/mai-noite Item 5(a): F explícito msg714 16:08:38 PM "F: Finalizado Almoco". Ontem fechei em 16:57 (next_event) sem ver o F real — regra 35 nova corrigirá isso pro futuro. Autorizado Bruno texto cru.',
  'admin');
  console.log('  AFTER :', fmt(await snap(326)));

  // ═══════════════════ (b) PATCH ev306 ═══════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' (b) PATCH ev306 Simone orders — ended_at 11:13→09:53:15');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BEFORE:', fmt(await snap(306)));
  await ev.correct(306, {
    ended_at: B_EV306_END,
    closed_reason: 'manual',
  }, null,
  'Bloco 29/mai-noite Item 5(b): F explícito msg667 09:53:15 "F:impressao das ordens" foi perdido pelo auto-close next_event (1h20 depois). Regra 35 nova previne isso. Autorizado Bruno texto cru.',
  'admin');
  console.log('  AFTER :', fmt(await snap(306)));

  // ═══════════════════ (c) CREATE Akkermansia manual ═══════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' (c) CREATE Akkermansia manual Simone 10:54→11:02');
  console.log('═══════════════════════════════════════════════════════════');
  // Idempotência: checa se já existe Simone production_line Akkermansia 10:54 hoje
  const existsC = await pool.query(`
    SELECT id FROM v3.events
    WHERE person_id = 5 AND product_batch_id = ${BATCH_AKKERMANSIA_01}
      AND deleted_at IS NULL
      AND (started_at AT TIME ZONE 'America/New_York')::date = '2026-05-29'
      AND TO_CHAR(started_at AT TIME ZONE 'America/New_York', 'HH24:MI') = '10:54'`);
  if (existsC.rows[0]) {
    console.log(`  ev${existsC.rows[0].id} já existe — skip CREATE`);
  } else {
    const created = await ev.upsert({
      person_id: 5,
      activity_type_id: ACTIVITY_PRODUCTION_LINE,
      product_batch_id: BATCH_AKKERMANSIA_01,
      started_at: C_AKK_START,
      ended_at: C_AKK_END,
      source_message_ts: null,           // criação retroativa admin, sem idempotência por source
      confidence: 'medium',
      cowork_with: [],
      quantity: 2,
      quantity_unit: 'bottle',
      description: 'Akkermansia manual — 2 garrafas (msg676 10:54 "S:fazendo 02 Akkermansia manualmente" + msg678 11:02 "F:" — LLM classificou mas emitiu actions=[] pré-fix regra 36). Criado retroativo via admin. Autorizado Bruno texto cru.',
      actor_type: 'admin',
      actor_person_id: null,
    });
    console.log(`  CREATED ev${created.id}: ${fmt(await snap(created.id))}`);
  }

  // ═══════════════════ (h) CREATE machine_downtime ═══════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' (h) CREATE machine_downtime Vitor 16:18→16:52 PM Potassium');
  console.log('═══════════════════════════════════════════════════════════');
  const existsH = await pool.query(`
    SELECT id FROM v3.events
    WHERE activity_type_id = ${ACTIVITY_MACHINE_DOWNTIME}
      AND product_batch_id = ${BATCH_POTASSIUM_0170}
      AND deleted_at IS NULL
      AND (started_at AT TIME ZONE 'America/New_York')::date = '2026-05-29'
      AND TO_CHAR(started_at AT TIME ZONE 'America/New_York', 'HH24:MI') = '16:18'`);
  if (existsH.rows[0]) {
    console.log(`  ev${existsH.rows[0].id} já existe — skip CREATE`);
  } else {
    const created = await ev.upsert({
      person_id: 4,                       // Vitor (era operador da linha)
      activity_type_id: ACTIVITY_MACHINE_DOWNTIME,
      product_batch_id: BATCH_POTASSIUM_0170,
      started_at: H_DT_START,
      ended_at: H_DT_END,
      source_message_ts: null,
      confidence: 'medium',
      cowork_with: [6, 7],                // Ana + Bruno Sarmento
      description: 'Maquinário Potassium parou 4:18-4:52 PM (msg722 16:00 Bruno Camp via @Carolina). Linha afetada — Ana mudou pra counting (ev332) e Bruno Sarmento manteve encapsulação bg. Carolina recebeu @ menção e respondeu "Anotado" (msg723) mas não criou event (caso TODO comandos admin Slack). Criado retroativo via admin. Autorizado Bruno texto cru.',
      actor_type: 'admin',
      actor_person_id: null,
    });
    console.log(`  CREATED ev${created.id}: ${fmt(await snap(created.id))}`);
  }

  // ═══════════════════ AUDIT counts ═══════════════════
  const audits = await pool.query(`
    SELECT action, COUNT(*)::int AS c FROM v3.audit_log
    WHERE created_at >= NOW() - interval '3 minutes' GROUP BY action ORDER BY action`);
  console.log('\n  --- AUDIT últimos 3min ---');
  for (const r of audits.rows) console.log(`    ${r.action}: ${r.c}`);

  await pool.end();
  console.log('\n✓ Item 5 (a/b/c/h) APLICADOS.');
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
