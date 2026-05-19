'use strict';
/**
 * FASE 1 P9 — retroactive operator cleanup (today + yesterday).
 *
 * Finds activities whose operator is probably WRONG — especially work
 * attributed to "Vitor" (account U08JC85HMNE) that an explicit "Bruno-"
 * prefix says was Bruno Sarmento (L-08). Uses the SAME unified
 * resolveOperator as the live pipeline (Part 2). CONSERVATIVE: only
 * proposes a fix when resolution came via an explicit name prefix
 * (src/dispatcher/retro-operator.shouldReassign).
 *
 * READ-ONLY by default. --apply ONLY after Bruno reviews the dry-run
 * (spec 9.2/9.3). Idempotent. Every change audited
 * operator.reassign_retroactive (a PERMANENT audit action).
 *
 *   railway run --service ProductionLineService node scripts/fase1-retro-operator.js          # dry-run
 *   railway run --service ProductionLineService node scripts/fase1-retro-operator.js --apply  # only with Bruno's OK
 */
const { Pool } = require('pg');
const APPLY = process.argv.includes('--apply');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const { resolveOperator } = require('../src/dispatcher/resolve-operator');
const { shouldReassign } = require('../src/dispatcher/retro-operator');
let auditAction; try { ({ auditAction } = require('../src/admin/audit')); } catch (_) {}

async function loadOperators() {
  const r = await pool.query(
    `SELECT id, name, COALESCE(aliases,'') AS aliases, role, slack_user_id,
            COALESCE(is_shared_account,FALSE) AS is_shared_account
       FROM operators WHERE active = TRUE OR is_active = TRUE`);
  return r.rows;
}

(async () => {
  console.log(`==== FASE1 RETRO-OPERATOR ${APPLY ? 'APPLY' : 'DRY-RUN'} ====\n`);
  const ops = await loadOperators();
  const opName = (id) => (ops.find((o) => o.id === id) || {}).name || `#${id}`;

  // Production-channel messages from today + yesterday (ET).
  const msgs = await pool.query(
    `SELECT m.slack_ts, m.user_id, m.user_name, m.text
       FROM messages m
      WHERE m.parsed_type <> 'admin_chat'
        AND (m.created_at AT TIME ZONE 'America/New_York')::date
            >= (NOW() AT TIME ZONE 'America/New_York')::date - INTERVAL '1 day'
      ORDER BY m.slack_ts ASC`);

  const recentMessages = async ({ accountUserId, epoch, currentSourceId }) => {
    const r = await pool.query(
      `SELECT text, slack_ts AS ts FROM messages
        WHERE user_id = $1 AND deleted_at IS NULL AND slack_ts <> $2
          AND slack_ts ~ '^[0-9.]+$'
          AND slack_ts::float8 BETWEEN $3 AND $4
        ORDER BY slack_ts::float8 ASC`,
      [accountUserId, String(currentSourceId || ''), epoch - 120, epoch + 120]);
    return r.rows;
  };

  const candidates = [];
  for (const m of msgs.rows) {
    const ts = m.slack_ts;
    const epoch = parseFloat(ts);
    const timestamp = Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : null;
    let resolved;
    try {
      resolved = await resolveOperator(
        { text: m.text, accountUserId: m.user_id, timestamp, sourceId: ts },
        { loadOperators: async () => ops, recentMessages });
    } catch (_) { continue; }
    if (resolved.via !== 'prefix' || !resolved.operatorId) continue;

    // Rows this message produced (canonical via dispatcher_index, then
    // legacy by slack_start_ts).
    const idx = await pool.query(
      `SELECT target_table, target_id FROM dispatcher_index WHERE source_id = $1`, [ts]);
    for (const row of idx.rows) {
      if (row.target_table === 'phase_instances') {
        const cur = await pool.query(
          `SELECT started_by_operator_id FROM phase_instances WHERE id = $1`, [row.target_id]);
        const curOp = cur.rows[0]?.started_by_operator_id ?? null;
        if (shouldReassign({ currentOperatorId: curOp, resolved })) {
          candidates.push({ kind: 'phase_instances', id: Number(row.target_id), ts,
            from: curOp, fromName: opName(curOp), to: resolved.operatorId,
            toName: resolved.operatorName, text: m.text.slice(0, 70) });
        }
      }
    }
    const lt = await pool.query(
      `SELECT id, operator FROM tasks
        WHERE slack_start_ts = $1 AND status <> 'deleted'`, [ts]);
    for (const t of lt.rows) {
      const curName = t.operator;
      if (curName && curName.toLowerCase() !== (resolved.operatorName || '').toLowerCase()) {
        candidates.push({ kind: 'tasks', id: t.id, ts, from: null, fromName: curName,
          to: resolved.operatorId, toName: resolved.operatorName, text: m.text.slice(0, 70) });
      }
    }
  }

  console.log(`Mensagens hoje+ontem: ${msgs.rows.length} · candidatos a reatribuição (só prefixo explícito): ${candidates.length}\n`);
  for (const c of candidates) {
    console.log(`  [${c.kind}#${c.id}] ts=${c.ts} "${c.text}"  ${c.fromName} → ${c.toName}`);
  }
  if (!candidates.length) { console.log('\n(nada a corrigir)'); await pool.end(); return; }

  if (!APPLY) {
    console.log('\nDRY-RUN — nada gravado. Bruno revisa esta lista e roda com --apply pra aplicar.');
    await pool.end(); return;
  }

  let applied = 0;
  for (const c of candidates) {
    await pool.query('BEGIN');
    try {
      if (c.kind === 'phase_instances') {
        await pool.query(
          `UPDATE phase_instances SET started_by_operator_id = $1, updated_at = NOW() WHERE id = $2`,
          [c.to, c.id]);
        await pool.query(
          `UPDATE operator_activity_log SET operator_id = $1, updated_at = NOW()
            WHERE phase_instance_id = $2 AND role = 'starter'`, [c.to, c.id]);
      } else if (c.kind === 'tasks') {
        await pool.query(`UPDATE tasks SET operator = $1, updated_at = NOW() WHERE id = $2`,
          [c.toName, c.id]);
      }
      await pool.query('COMMIT');
      applied++;
      if (auditAction) await auditAction({
        action: 'operator.reassign_retroactive', entityType: c.kind, entityId: c.id,
        before: { operator: c.fromName }, after: { operator: c.toName, via: 'prefix', source_ts: c.ts },
        source: 'fase1_retro_script',
      });
    } catch (e) { await pool.query('ROLLBACK'); console.error(`  ! ${c.kind}#${c.id} falhou: ${e.message}`); }
  }
  console.log(`\n>>> APLICADO + auditado: ${applied}/${candidates.length} reatribuições.`);
  await pool.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
