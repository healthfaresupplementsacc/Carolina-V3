'use strict';
/**
 * FASE 0 (consolidação) — "Bruno" id=2 → "Bruno Sarmento" (preserva
 * histórico) e desativa o id=353 vazio (criado por engano). id=3 e
 * id=333 NÃO mudam. Idempotente. READ-ONLY salvo --apply.
 *
 *   railway run ... node scripts/fase0-consolidate.js          # dry-run
 *   railway run ... node scripts/fase0-consolidate.js --apply
 */
const { Pool } = require('pg');
const APPLY = process.argv.includes('--apply');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let auditAction; try { ({ auditAction } = require('../src/admin/audit')); } catch (_) {}

async function counts(id, name) {
  const q = async (s, a) => (await p.query(s, a)).rows[0].n;
  return {
    oal: await q('SELECT COUNT(*)::int n FROM operator_activity_log WHERE operator_id=$1', [id]),
    phase: await q('SELECT COUNT(*)::int n FROM phase_instances WHERE started_by_operator_id=$1', [id]),
    tasks: await q('SELECT COUNT(*)::int n FROM tasks WHERE operator=$1', [name]),
    pauses: await q('SELECT COUNT(*)::int n FROM pauses WHERE operator=$1', [name]),
  };
}
const sum = (c) => c.oal + c.phase + c.tasks + c.pauses;

(async () => {
  console.log(`==== FASE0 CONSOLIDATE ${APPLY ? 'APPLY' : 'DRY-RUN'} ====\n`);
  const o2 = (await p.query('SELECT * FROM operators WHERE id=2')).rows[0];
  const o353 = (await p.query('SELECT * FROM operators WHERE id=353')).rows[0];
  if (!o2) { console.log('id=2 não existe — nada a fazer.'); await p.end(); return; }
  const c2 = await counts(2, o2.name);
  const c353 = o353 ? await counts(353, o353.name) : null;
  console.log(`id=2  name="${o2.name}" role=${o2.role} slack=${o2.slack_user_id} active=${o2.active}/${o2.is_active}  hist={oal:${c2.oal},phase:${c2.phase},tasks:${c2.tasks},pauses:${c2.pauses}}`);
  console.log(`id=353 ${o353 ? `name="${o353.name}" active=${o353.active}/${o353.is_active} hist={oal:${c353.oal},phase:${c353.phase},tasks:${c353.tasks},pauses:${c353.pauses}}` : '(não existe)'}`);

  // Salvaguardas
  if (o353 && sum(c353) > 0) {
    console.log('\n!! ABORT: id=353 NÃO está vazio (tem histórico). Não desativo às cegas. Revisar manualmente.');
    await p.end(); return;
  }
  if (o2.name === 'Bruno Sarmento' && (!o353 || (o353.active === false && o353.is_active === false))) {
    console.log('\n(idempotente) já consolidado: id=2 = "Bruno Sarmento" e id=353 inativo. Nada a fazer.');
    await p.end(); return;
  }
  console.log('\nPLANO:');
  console.log('  - id=353: rename → "Bruno Sarmento [dup vazio fase0]" + active/is_active=false (libera o nome UNIQUE)');
  console.log('  - id=2 : rename "Bruno" → "Bruno Sarmento" (preserva os ' + sum(c2) + ' registros históricos)');
  console.log('  - id=3 e id=333: INALTERADOS');
  if (!APPLY) { console.log('\nDRY-RUN — nada gravado.'); await p.end(); return; }

  await p.query('BEGIN');
  try {
    if (o353) {
      await p.query(
        `UPDATE operators SET name='Bruno Sarmento [dup vazio fase0]',
                active=FALSE, is_active=FALSE, updated_at=NOW() WHERE id=353`);
    }
    await p.query(
      `UPDATE operators SET name='Bruno Sarmento', updated_at=NOW() WHERE id=2`);
    await p.query('COMMIT');
  } catch (e) { await p.query('ROLLBACK'); throw e; }

  if (auditAction) {
    await auditAction({
      action: 'operator.rename', entityType: 'operator', entityId: 2,
      source: 'fase0_cleanup',
      before: { name: o2.name }, after: { name: 'Bruno Sarmento', preserved: c2 },
    });
    if (o353) await auditAction({
      action: 'operator.deactivate', entityType: 'operator', entityId: 353,
      source: 'fase0_cleanup',
      before: { name: o353.name, active: o353.active },
      after: { active: false, is_active: false, motivo: 'duplicado_vazio' },
    });
  }
  console.log('\n>>> APLICADO + auditado (operator.rename id=2, operator.deactivate id=353).');

  const fin = await p.query(
    `SELECT id,name,role,slack_user_id,active FROM operators
     WHERE active OR is_active OR id IN (333,353) ORDER BY role, name`);
  console.log('\n==== OPERATORS (final) ====');
  console.table(fin.rows);
  await p.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
