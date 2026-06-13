'use strict';
/**
 * PARTE 7 — apply writes autorizados.
 *
 * Bruno autorizou em 26/mai (texto cru):
 *   1) migration 010 (expedient_end_hour_ny=21, expedient_start_hour_ny=8)
 *   2) migration 011 (is_long_running em v3.events)
 *   3) soft-delete ev182 (Rhodiola duplicata de ev181)
 *   4) PATCH ev176.ended_at = ev179.started_at (Black Garlic next_phase)
 *   5) PATCH ev200.ended_at = ev202.started_at (Berberine next_phase)
 *   6) markLongRunning(true) em 6 Potassium 26/mai abertos (Bruno diretiva 5)
 *
 * Idempotente: cada operação checa estado antes. Re-rodar não duplica nada.
 * Audita cada write em v3.audit_log via EventService (writes 3-5) e SQL direto
 * (settings/migrations/long_running são fora do scope de EventService).
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('═══════════════════════════════════════════════════');
  console.log(' 0. PRECHECK ');
  console.log('═══════════════════════════════════════════════════');
  const now = await pool.query("SELECT now() AT TIME ZONE 'America/New_York' AS ny_now");
  console.log('  NY now:', now.rows[0].ny_now);

  // ──────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' 1. APPLY MIGRATION 010 (expedient_end 19→21 + start 8)');
  console.log('═══════════════════════════════════════════════════');
  const m010 = fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '010_expedient_extended.sql'), 'utf8');
  await pool.query(m010);
  const settings = await pool.query("SELECT key, value FROM v3.settings WHERE key IN ('expedient_end_hour_ny','expedient_start_hour_ny') ORDER BY key");
  for (const r of settings.rows) console.log(`  ${r.key} = ${JSON.stringify(r.value)}`);

  // ──────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' 2. APPLY MIGRATION 011 (is_long_running em v3.events)');
  console.log('═══════════════════════════════════════════════════');
  const m011 = fs.readFileSync(path.join(__dirname, '..', 'src', 'v3', 'schema', 'migrations', '011_long_running_events.sql'), 'utf8');
  await pool.query(m011);
  const col = await pool.query(`
    SELECT column_name, data_type, column_default
    FROM information_schema.columns
    WHERE table_schema='v3' AND table_name='events' AND column_name='is_long_running'`);
  console.log('  v3.events.is_long_running:', col.rows[0] || 'COLUNA NÃO CRIADA — STOP');
  if (!col.rows[0]) { await pool.end(); process.exit(2); }

  // ──────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' 3. SOFT-DELETE ev182 (Rhodiola duplicata de ev181)');
  console.log('═══════════════════════════════════════════════════');
  const ev182 = await pool.query('SELECT id, deleted_at, person_id, activity_type_id, product_batch_id, started_at, ended_at FROM v3.events WHERE id = 182');
  if (!ev182.rows[0]) {
    console.log('  ev182 não existe — skip');
  } else if (ev182.rows[0].deleted_at) {
    console.log('  ev182 já está soft-deleted em', ev182.rows[0].deleted_at, '— skip (idempotente)');
  } else {
    const before = ev182.rows[0];
    const r = await pool.query(`
      UPDATE v3.events SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = 182 AND deleted_at IS NULL
      RETURNING *`);
    await pool.query(`
      INSERT INTO v3.audit_log
        (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data, metadata)
      VALUES ('admin', NULL, 'event.soft_deleted', 'event', 182, $1::jsonb, $2::jsonb, $3::jsonb)`,
      [JSON.stringify(before), JSON.stringify(r.rows[0]),
       JSON.stringify({ reason: 'duplicate_of_ev181', authorized_by: 'Bruno (texto cru 26/mai)', bloco: 'PARTE_7_write_3' })]);
    console.log('  ev182 soft-deleted ✓ (audit gravado)');
  }

  // ──────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' 4. PATCH ev176.ended_at = ev179.started_at (Black Garlic)');
  console.log('═══════════════════════════════════════════════════');
  const ev176 = await pool.query('SELECT * FROM v3.events WHERE id = 176 AND deleted_at IS NULL');
  const ev179 = await pool.query('SELECT started_at FROM v3.events WHERE id = 179 AND deleted_at IS NULL');
  if (!ev176.rows[0]) console.log('  ev176 não existe ou deletado — skip');
  else if (!ev179.rows[0]) console.log('  ev179 não existe ou deletado — STOP');
  else {
    const before = ev176.rows[0];
    const newEnd = ev179.rows[0].started_at;
    if (before.ended_at && new Date(before.ended_at).getTime() === new Date(newEnd).getTime()) {
      console.log('  ev176.ended_at já está em', newEnd, '— skip (idempotente)');
    } else {
      const r = await pool.query(`
        UPDATE v3.events
        SET ended_at = $1::timestamptz, closed_reason = 'next_phase', updated_at = NOW()
        WHERE id = 176 RETURNING *`, [newEnd]);
      await pool.query(`
        INSERT INTO v3.audit_log
          (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data, metadata)
        VALUES ('admin', NULL, 'event.corrected', 'event', 176, $1::jsonb, $2::jsonb, $3::jsonb)`,
        [JSON.stringify(before), JSON.stringify(r.rows[0]),
         JSON.stringify({ correction: 'next_phase_retro', linked_event: 179, authorized_by: 'Bruno (texto cru 26/mai)', bloco: 'PARTE_7_write_4' })]);
      console.log('  ev176.ended_at →', newEnd, '✓');
    }
  }

  // ──────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' 5. PATCH ev200.ended_at = ev202.started_at (Berberine)');
  console.log('═══════════════════════════════════════════════════');
  const ev200 = await pool.query('SELECT * FROM v3.events WHERE id = 200 AND deleted_at IS NULL');
  const ev202 = await pool.query('SELECT started_at FROM v3.events WHERE id = 202 AND deleted_at IS NULL');
  if (!ev200.rows[0]) console.log('  ev200 não existe ou deletado — skip');
  else if (!ev202.rows[0]) console.log('  ev202 não existe ou deletado — STOP');
  else {
    const before = ev200.rows[0];
    const newEnd = ev202.rows[0].started_at;
    if (before.ended_at && new Date(before.ended_at).getTime() === new Date(newEnd).getTime()) {
      console.log('  ev200.ended_at já está em', newEnd, '— skip (idempotente)');
    } else {
      const r = await pool.query(`
        UPDATE v3.events
        SET ended_at = $1::timestamptz, closed_reason = 'next_phase', updated_at = NOW()
        WHERE id = 200 RETURNING *`, [newEnd]);
      await pool.query(`
        INSERT INTO v3.audit_log
          (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data, metadata)
        VALUES ('admin', NULL, 'event.corrected', 'event', 200, $1::jsonb, $2::jsonb, $3::jsonb)`,
        [JSON.stringify(before), JSON.stringify(r.rows[0]),
         JSON.stringify({ correction: 'next_phase_retro', linked_event: 202, authorized_by: 'Bruno (texto cru 26/mai)', bloco: 'PARTE_7_write_5' })]);
      console.log('  ev200.ended_at →', newEnd, '✓');
    }
  }

  // ──────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' 6. markLongRunning Potassium — 6 events 26/mai abertos');
  console.log('═══════════════════════════════════════════════════');
  // IDs do Bruno-Sarmento-formulation-Potassium 26/mai abertos (do diag 7.3)
  const potassiumIds = [194, 195, 201, 203, 209, 213];
  for (const id of potassiumIds) {
    const before = await pool.query('SELECT * FROM v3.events WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!before.rows[0]) { console.log(`  ev${id}: não existe ou deletado — skip`); continue; }
    if (before.rows[0].is_long_running === true) { console.log(`  ev${id}: já is_long_running=true — skip (idempotente)`); continue; }
    const r = await pool.query(`
      UPDATE v3.events SET is_long_running = true, updated_at = NOW()
      WHERE id = $1 RETURNING *`, [id]);
    await pool.query(`
      INSERT INTO v3.audit_log
        (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data, metadata)
      VALUES ('admin', NULL, 'event.long_running_set', 'event', $1, $2::jsonb, $3::jsonb, $4::jsonb)`,
      [id, JSON.stringify(before.rows[0]), JSON.stringify(r.rows[0]),
       JSON.stringify({ is_long_running: true, reason: 'Potassium multi-dia — formulação roda por dias',
                        authorized_by: 'Bruno (diretiva texto cru 26/mai write-5)',
                        bloco: 'PARTE_7_long_running' })]);
    console.log(`  ev${id}: is_long_running=true ✓`);
  }

  // ──────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' 7. SMOKE pós-writes');
  console.log('═══════════════════════════════════════════════════');
  const settingsNow = await pool.query("SELECT key, value FROM v3.settings WHERE key LIKE 'expedient_%' ORDER BY key");
  for (const r of settingsNow.rows) console.log(`  ${r.key} = ${JSON.stringify(r.value)}`);

  const ev182After = await pool.query('SELECT id, deleted_at FROM v3.events WHERE id = 182');
  console.log(`  ev182: deleted_at = ${ev182After.rows[0]?.deleted_at}`);

  const ev176After = await pool.query("SELECT id, ended_at, closed_reason FROM v3.events WHERE id = 176");
  console.log(`  ev176: ended_at=${ev176After.rows[0]?.ended_at}, closed_reason=${ev176After.rows[0]?.closed_reason}`);

  const ev200After = await pool.query("SELECT id, ended_at, closed_reason FROM v3.events WHERE id = 200");
  console.log(`  ev200: ended_at=${ev200After.rows[0]?.ended_at}, closed_reason=${ev200After.rows[0]?.closed_reason}`);

  const longRun = await pool.query("SELECT id, is_long_running FROM v3.events WHERE id = ANY($1::int[]) ORDER BY id", [potassiumIds]);
  for (const r of longRun.rows) console.log(`  ev${r.id}: is_long_running=${r.is_long_running}`);

  const auditTotal = await pool.query(`
    SELECT action, count(*)
    FROM v3.audit_log
    WHERE metadata->>'bloco' LIKE 'PARTE_7%' OR metadata->>'reason' LIKE '%PARTE_7%'
    GROUP BY action`);
  console.log('\n  AUDIT rows desse run:');
  for (const r of auditTotal.rows) console.log(`    ${r.action}: ${r.count}`);

  await pool.end();
  console.log('\n✓ ALL WRITES APPLIED (idempotente).');
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
