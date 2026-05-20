'use strict';
/**
 * HEALTHFARE V3 — FIX D (pós-backfill §2.13) — one-time prod.
 *
 * O backfill mostrou admins (Thassio, Henrique) sem slack_user_id em
 * v3.persons → o PersonResolver não conseguia reconhecê-los como
 * autores de admin_intervention pelo ID.
 *
 * Seta os IDs reais (idempotente — só escreve se mudou) e audita
 * cada mudança em v3.audit_log. Bruno Camp continua NULL (não tem
 * conta própria no canal — ver spec ITEM 1).
 *
 *   railway run ... node scripts/v3-fix-d.js
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

// display_name → slack_user_id real (confirmado pelo Bruno).
const ADMIN_IDS = [
  { display_name: 'Thassio',  role: 'owner',   slack_user_id: 'U03S46L2EUA' },
  { display_name: 'Henrique', role: 'manager', slack_user_id: 'U085SDY3F4Z' },
];

async function main() {
  const pool = makeV3Pool();
  try {
    console.log('==== V3 FIX D — slack_user_id dos admins ====');
    let changed = 0;
    let skipped = 0;

    for (const a of ADMIN_IDS) {
      const cur = await pool.query(
        'SELECT id, slack_user_id, role FROM v3.persons WHERE display_name = $1 AND deleted_at IS NULL',
        [a.display_name]);
      if (cur.rows.length === 0) {
        console.log(`  ! ${a.display_name}: NÃO encontrado em v3.persons — pulado`);
        continue;
      }
      if (cur.rows.length > 1) {
        console.log(`  ! ${a.display_name}: ${cur.rows.length} rows — ambíguo, pulado`);
        continue;
      }
      const row = cur.rows[0];
      if (row.slack_user_id === a.slack_user_id) {
        console.log(`  = ${a.display_name} (id ${row.id}): já está ${a.slack_user_id} — idempotente`);
        skipped++;
        continue;
      }
      // checa conflito com a UNIQUE parcial antes de escrever
      const conflict = await pool.query(
        'SELECT id, display_name FROM v3.persons WHERE slack_user_id = $1 AND id <> $2',
        [a.slack_user_id, row.id]);
      if (conflict.rows.length > 0) {
        console.log(`  ! ${a.display_name}: ${a.slack_user_id} já pertence a `
          + `'${conflict.rows[0].display_name}' (id ${conflict.rows[0].id}) — pulado`);
        continue;
      }
      await pool.query(
        'UPDATE v3.persons SET slack_user_id = $1, updated_at = NOW() WHERE id = $2',
        [a.slack_user_id, row.id]);
      await pool.query(
        `INSERT INTO v3.audit_log (actor_type, action, target_type, target_id, before_data, after_data, metadata)
         VALUES ('system', 'fix_d.admin_slack_id_set', 'person', $1, $2::jsonb, $3::jsonb, $4::jsonb)`,
        [row.id,
          JSON.stringify({ slack_user_id: row.slack_user_id }),
          JSON.stringify({ slack_user_id: a.slack_user_id }),
          JSON.stringify({ fix: 'D', display_name: a.display_name, role: a.role })]);
      console.log(`  + ${a.display_name} (id ${row.id}): ${row.slack_user_id || 'NULL'} → ${a.slack_user_id}`);
      changed++;
    }

    // confirma o estado final dos admins
    const admins = await pool.query(
      `SELECT display_name, role, slack_user_id FROM v3.persons
       WHERE role IN ('owner','manager') AND deleted_at IS NULL ORDER BY role, display_name`);
    console.log('\n==== FIX D REPORT ====');
    console.log(`alterados: ${changed} | já-corretos: ${skipped}`);
    console.log('admins em v3.persons:');
    for (const r of admins.rows) {
      console.log(`  ${r.role.padEnd(8)} ${r.display_name.padEnd(14)} ${r.slack_user_id || 'NULL'}`);
    }
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
