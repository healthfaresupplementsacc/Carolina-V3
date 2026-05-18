'use strict';
/**
 * EMERGÊNCIA — limpa as phase_instances FANTASMA criadas hoje pelo bug
 * do default "Linha de Produção" (RC-A).
 *
 * Assinatura EXATA da corrupção (conservadora — só o que é
 * inequivocamente fantasma):
 *   phase_name = 'Linha de Produção'
 *   AND workflow_instances.product_name IS NULL   (sem suplemento)
 *   AND (pi.batch_number IS NULL AND wi.batch_number IS NULL)
 *   AND criada hoje (ET)
 *   AND status <> 'deleted'
 * Phases COM suplemento/batch (produção real) NÃO são tocadas.
 *
 * NÃO faz hard-delete: marca status='deleted' + nota, e fecha o oal
 * aberto ligado. Audita action='operator.cleanup_fantasma_atividade'.
 *
 * SEGURANÇA: --dry-run default; --apply exige ADMIN_CONFIRMED=TRUE
 * (mesma trava do wipe). Rodar SÓ depois do deploy do fix RC-A
 * (senão regenera no próximo poll).
 *
 * Uso:
 *   railway run --service ProductionLineService node scripts/cleanup-fantasma-hoje.js
 *   ADMIN_CONFIRMED=TRUE railway run ... node scripts/cleanup-fantasma-hoje.js --apply
 */

const FANTASMA_SQL = `
  SELECT pi.id, pi.workflow_instance_id, o.name AS starter,
         to_char(pi.started_at AT TIME ZONE 'America/New_York','HH24:MI') AS st
  FROM phase_instances pi
  JOIN workflow_instances wi ON wi.id = pi.workflow_instance_id
  LEFT JOIN operators o ON o.id = pi.started_by_operator_id
  WHERE pi.phase_name = 'Linha de Produção'
    AND wi.product_name IS NULL
    AND pi.batch_number IS NULL AND wi.batch_number IS NULL
    AND (pi.started_at AT TIME ZONE 'America/New_York')::date
        = (NOW() AT TIME ZONE 'America/New_York')::date
    AND pi.status <> 'deleted'
  ORDER BY pi.started_at`;

async function findFantasmas(db) {
  return (await db.query(FANTASMA_SQL)).rows;
}

async function cleanupFantasmas({ apply = false, db, source = 'script' } = {}) {
  db = db || require('../src/db');
  const rows = await findFantasmas(db);
  if (!apply || rows.length === 0) return { count: rows.length, rows, applied: false };

  let auditAction;
  try { ({ auditAction } = require('../src/admin/audit')); } catch (_) { auditAction = null; }

  await db.query('BEGIN');
  try {
    for (const r of rows) {
      // fecha o oal aberto ligado a essa phase (não deixa operador preso)
      await db.query(
        `UPDATE operator_activity_log
         SET ended_at = COALESCE(ended_at, NOW()),
             duration_seconds = COALESCE(duration_seconds, 0), updated_at = NOW()
         WHERE phase_instance_id = $1 AND ended_at IS NULL`, [r.id]);
      await db.query(
        `UPDATE phase_instances
         SET status = 'deleted',
             notes = COALESCE(notes,'') || ' [fantasma_auto_cleanup ' || NOW()::text || ']',
             updated_at = NOW()
         WHERE id = $1 AND status <> 'deleted'`, [r.id]);
      if (auditAction) {
        try {
          await auditAction({
            action: 'operator.cleanup_fantasma_atividade',
            entityType: 'phase_instance', entityId: r.id, source,
            before: { starter: r.starter, started: r.st, reason: 'phantom Linha de Produção (RC-A)' },
            after: { status: 'deleted' },
          });
        } catch (_) {}
      }
    }
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  return { count: rows.length, rows, applied: true };
}

module.exports = { FANTASMA_SQL, findFantasmas, cleanupFantasmas };

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  (async () => {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      const rep = await cleanupFantasmas({ apply: false, db: pool });
      console.log('==== CLEANUP FANTASMA ' + (apply ? 'APPLY' : 'DRY-RUN') + ' ====');
      console.log(`phantom phase_instances de hoje: ${rep.count}`);
      for (const r of rep.rows) console.log(`  #${r.id} starter=${r.starter} ${r.st}`);
      if (!apply) { console.log('\nDRY-RUN. Para aplicar (após deploy do fix):\n  ADMIN_CONFIRMED=TRUE ... node scripts/cleanup-fantasma-hoje.js --apply'); return; }
      if (process.env.ADMIN_CONFIRMED !== 'TRUE') { console.error('\nRECUSADO: --apply exige ADMIN_CONFIRMED=TRUE.'); process.exitCode = 2; return; }
      const r = await cleanupFantasmas({ apply: true, db: pool, source: 'script' });
      console.log(`\nAPLICADO — ${r.count} phantom(s) marcadas status='deleted' + oal fechado + auditado.`);
    } catch (e) { console.error('FATAL:', e.message); process.exitCode = 1; }
    finally { await pool.end().catch(() => {}); }
  })();
}
