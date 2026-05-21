'use strict';
/**
 * HEALTHFARE V3 — FIX 2 (pós-shadow 21/mai) — aliases perigosos.
 *
 * BUG: o identifies_as 'S' da Simone (e 'V' do Vitor) em
 * shared_account_users colidia com os marcadores "S:"/"F:" (start/
 * finish). Mensagem do Vitor "S: Iniciando..." virava Simone.
 *
 * Este script:
 *  1. Reescreve identifies_as de cada pessoa: SÓ o nome (e variante
 *     de caixa) — sem iniciais soltas.
 *  2. Mescla aliases de produto faltantes: Vitamin B2 (vita b2,
 *     vitab2) e Akkermansia (akkemansia).
 * Idempotente. Auditado.
 *
 *   railway run ... node scripts/v3-fix-aliases.js
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

// identifies_as final por pessoa (espelha SHARED_USERS_SEED).
const IDENTIFIES = {
  Ana: ['Ana', 'ana'],
  'Bruno Sarmento': ['Bruno', 'Sarmento', 'bruno'],
  Vitor: ['Vitor', 'vitor'],
  Simone: ['Simone', 'simone'],
};

// aliases a GARANTIR em produtos (merge, dedup).
const PRODUCT_ALIASES = {
  'Vitamin B2': ['vita b2', 'vitab2'],
  Akkermansia: ['akkemansia'],
};

async function main() {
  const pool = makeV3Pool();
  const client = await pool.connect();
  try {
    console.log('==== V3 FIX 2 — aliases (identifies_as + produtos) ====');
    await client.query('BEGIN');

    // 1 ── identifies_as ──
    let suChanged = 0;
    for (const [name, ids] of Object.entries(IDENTIFIES)) {
      const before = (await client.query(
        `SELECT sau.id, sau.identifies_as FROM v3.shared_account_users sau
         JOIN v3.persons p ON p.id = sau.person_id
         WHERE p.display_name = $1 AND p.deleted_at IS NULL`, [name])).rows;
      const r = await client.query(
        `UPDATE v3.shared_account_users sau
           SET identifies_as = $1
         FROM v3.persons p
         WHERE p.id = sau.person_id AND p.display_name = $2 AND p.deleted_at IS NULL
           AND sau.identifies_as <> $1
         RETURNING sau.id`, [ids, name]);
      if (r.rowCount > 0) {
        suChanged += r.rowCount;
        await client.query(
          `INSERT INTO v3.audit_log (actor_type, action, target_type, before_data, after_data)
           VALUES ('system','fix2.identifies_as','shared_account_user',$1::jsonb,$2::jsonb)`,
          [JSON.stringify({ person: name, rows: before.map((b) => b.identifies_as) }),
            JSON.stringify({ person: name, identifies_as: ids, rows_updated: r.rowCount })]);
      }
      console.log(`  ${name}: identifies_as → [${ids.join(', ')}] (${r.rowCount} row(s))`);
    }

    // 2 ── aliases de produto ──
    let prodChanged = 0;
    for (const [canonical, add] of Object.entries(PRODUCT_ALIASES)) {
      const cur = (await client.query(
        'SELECT id, aliases FROM v3.products WHERE canonical_name = $1', [canonical])).rows[0];
      if (!cur) { console.log(`  ! produto "${canonical}" não existe — pulado`); continue; }
      const seen = new Set((cur.aliases || []).map((a) => String(a).toLowerCase().trim()));
      const merged = (cur.aliases || []).slice();
      let added = 0;
      for (const a of add) {
        const n = String(a).toLowerCase().trim();
        if (!seen.has(n)) { seen.add(n); merged.push(n); added++; }
      }
      if (added > 0) {
        await client.query('UPDATE v3.products SET aliases = $1 WHERE id = $2', [merged, cur.id]);
        await client.query(
          `INSERT INTO v3.audit_log (actor_type, action, target_type, target_id, before_data, after_data)
           VALUES ('system','fix2.product_aliases','product',$1,$2::jsonb,$3::jsonb)`,
          [cur.id, JSON.stringify({ aliases: cur.aliases }), JSON.stringify({ aliases: merged })]);
        prodChanged++;
      }
      console.log(`  "${canonical}": +${added} alias (total ${merged.length})`);
    }

    await client.query('COMMIT');
    console.log(`\n==== FIX 2 REPORT ====`);
    console.log(`shared_account_users atualizados: ${suChanged}`);
    console.log(`produtos com aliases mesclados:   ${prodChanged}`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* */ }
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

main();
