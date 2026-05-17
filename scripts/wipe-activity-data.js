'use strict';
/**
 * WIPE — controlled reset of day-to-day ACTIVITY data, keeping every
 * config / cadastro table intact.
 *
 * SAFETY:
 *  - --dry-run (default) only counts; never writes.
 *  - --apply requires the interlock  ADMIN_CONFIRMED=TRUE  in the env
 *    (PARTE 3: explicit admin confirmation). Without it, --apply refuses.
 *  - DELETE in strict child→parent order with an EXPLICIT table list —
 *    NO TRUNCATE CASCADE — so nothing outside the list is ever touched.
 *  - audits action='full_wipe_apply' (timestamp, admin, tables+counts).
 *
 * The spec's names mapped to real tables:
 *   notes                 -> operator_notes
 *   silent_log            -> silent_log (all rows; it's a day log)
 *   manager_chat_history  -> app_state key (deleted, not a table)
 *
 * Tables in the DB that are in NEITHER the wipe NOR the preserve list
 * are reported as "UNLISTED — confirm" in the dry-run and are NEVER
 * deleted automatically (the human decides at the confirmation gate).
 *
 * Usage:
 *   railway run --service ProductionLineService node scripts/wipe-activity-data.js
 *   ADMIN_CONFIRMED=TRUE railway run --service ProductionLineService \
 *       node scripts/wipe-activity-data.js --apply
 */

// Child → parent: anything with an inbound FK is deleted before its
// parent so plain DELETE never hits a constraint.
const WIPE_TABLES = [
  'operator_activity_log',  // -> pauses / phase_instances / ad_hoc_task_instances
  'production_counts',      // -> tasks
  'pauses',                 // -> tasks
  'phase_instances',        // -> workflow_instances
  'ad_hoc_task_instances',
  'workflow_instances',
  'urgency_notifications',  // -> tasks  (must precede tasks)
  'tasks',                  // legacy model
  'operator_notes',         // spec: "notes"
  'carolina_proposals',
  'silent_log',
  // admin-confirmed extension — "100% limpo": day-to-day activity the
  // spec didn't enumerate. All standalone (no inbound FKs).
  'orders_sessions',
  'formulation_sessions',
  'messages',
  'eod_snapshots',
];
const WIPE_APP_STATE_KEYS = ['manager_chat_history'];

// Must survive the wipe (config + cadastros + traceability).
const PRESERVE_TABLES = [
  'operators', 'workflow_templates', 'phase_templates', 'ad_hoc_tasks',
  'supplement_catalog', 'supplements', 'app_state', 'message_variations',
  'admin_audit_log',
];

async function tableExists(db, t) {
  const r = await db.query(
    `SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=$1`, [t]);
  return r.rows.length > 0;
}
async function count(db, t) {
  try { return parseInt((await db.query(`SELECT COUNT(*)::int n FROM "${t}"`)).rows[0].n, 10); }
  catch (_) { return null; }
}

async function report(db) {
  const all = (await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)
  ).rows.map((r) => r.tablename);

  const wipe = {};
  for (const t of WIPE_TABLES) if (all.includes(t)) wipe[t] = await count(db, t);
  const mch = parseInt((await db.query(
    `SELECT COUNT(*)::int n FROM app_state WHERE key = ANY($1)`, [WIPE_APP_STATE_KEYS])).rows[0].n, 10);

  const preserve = {};
  for (const t of PRESERVE_TABLES) if (all.includes(t)) preserve[t] = await count(db, t);

  const known = new Set([...WIPE_TABLES, ...PRESERVE_TABLES]);
  const unlisted = {};
  for (const t of all) if (!known.has(t)) unlisted[t] = await count(db, t);

  const operators = (await db.query(
    `SELECT name, COALESCE(role,'operator') role, active, is_active, is_temporary
     FROM operators ORDER BY role, name`)).rows;
  const wfTemplates = (await db.query(
    `SELECT name FROM workflow_templates ORDER BY name`)).rows.map((r) => r.name);
  const phTemplates = (await db.query(
    `SELECT name FROM phase_templates ORDER BY name`)).rows.map((r) => r.name);
  const ahTemplates = (await db.query(
    `SELECT name FROM ad_hoc_tasks ORDER BY name`)).rows.map((r) => r.name);

  return { wipe, mch, preserve, unlisted, operators, wfTemplates, phTemplates, ahTemplates };
}

async function applyWipe(db, source, adminId) {
  const deleted = {};
  // single transaction; explicit ordered DELETEs, no cascade.
  await db.query('BEGIN');
  try {
    for (const t of WIPE_TABLES) {
      if (!(await tableExists(db, t))) { deleted[t] = 0; continue; }
      const r = await db.query(`DELETE FROM "${t}"`);
      deleted[t] = r.rowCount || 0;
    }
    const mch = await db.query(
      `DELETE FROM app_state WHERE key = ANY($1)`, [WIPE_APP_STATE_KEYS]);
    deleted['app_state(manager_chat_history)'] = mch.rowCount || 0;
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
  // audit AFTER commit so the audit row itself survives the wipe.
  try {
    const { auditAction } = require('../src/admin/audit');
    await auditAction({
      action: 'full_wipe_apply', entityType: 'database', entityId: 'activity_reset',
      source: source || 'wipe_script',
      before: { admin_id: adminId || process.env.ADMIN_ID || 'cli', confirmed: true },
      after: { at: new Date().toISOString(), deleted },
    });
  } catch (_) { /* audit best-effort; never block */ }
  return deleted;
}

module.exports = { WIPE_TABLES, WIPE_APP_STATE_KEYS, PRESERVE_TABLES, report, applyWipe };

// ─── CLI ────────────────────────────────────────────────────────────────
if (require.main === module) {
  const apply = process.argv.includes('--apply');
  (async () => {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    try {
      const rep = await report(pool);
      const sum = (o) => Object.values(o).reduce((a, b) => a + (b || 0), 0);
      console.log('==== WIPE ' + (apply ? 'APPLY' : 'DRY-RUN') + ' ====');
      console.log('\n[APAGA] atividade do dia-a-dia:');
      for (const [t, n] of Object.entries(rep.wipe)) console.log(`  ${t}: ${n}`);
      console.log(`  app_state[manager_chat_history]: ${rep.mch}`);
      console.log(`  -> total linhas a apagar: ${sum(rep.wipe) + rep.mch}`);
      console.log('\n[PRESERVA] config + cadastros:');
      for (const [t, n] of Object.entries(rep.preserve)) console.log(`  ${t}: ${n}`);
      console.log('\n[NÃO LISTADA — confirmar manualmente, NÃO será apagada]:');
      const ul = Object.entries(rep.unlisted);
      if (ul.length === 0) console.log('  (nenhuma)');
      for (const [t, n] of ul) console.log(`  ${t}: ${n}`);
      console.log('\nOperadores que ficam:');
      for (const o of rep.operators) {
        console.log(`  ${o.name} · ${o.role} · ${o.active ? 'ativo' : 'inativo'}${o.is_temporary ? ' · helper' : ''}`);
      }
      console.log('\nTemplates que ficam:');
      console.log(`  workflows: ${rep.wfTemplates.join(', ') || '—'}`);
      console.log(`  phases   : ${rep.phTemplates.join(', ') || '—'}`);
      console.log(`  ad-hoc   : ${rep.ahTemplates.join(', ') || '—'}`);

      if (!apply) {
        console.log('\nDRY-RUN — nada apagado. Para aplicar:');
        console.log('  ADMIN_CONFIRMED=TRUE ... node scripts/wipe-activity-data.js --apply');
        return;
      }
      if (process.env.ADMIN_CONFIRMED !== 'TRUE') {
        console.error('\nRECUSADO: --apply exige ADMIN_CONFIRMED=TRUE no ambiente.');
        process.exitCode = 2;
        return;
      }
      console.log('\nADMIN_CONFIRMED=TRUE — aplicando...');
      const t0 = Date.now();
      const deleted = await applyWipe(pool, 'wipe_script', process.env.ADMIN_ID);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log('==== WIPE APLICADO ====');
      for (const [t, n] of Object.entries(deleted)) console.log(`  ${t}: -${n}`);
      console.log(`  tempo: ${secs}s`);
      const after = await report(pool);
      console.log('\nEstado final (deve ser 0):');
      for (const [t, n] of Object.entries(after.wipe)) console.log(`  ${t}: ${n}`);
      console.log(`  app_state[manager_chat_history]: ${after.mch}`);
    } catch (e) {
      console.error('FATAL wipe error:', e.message);
      process.exitCode = 1;
    } finally {
      await pool.end().catch(() => {});
    }
  })();
}
