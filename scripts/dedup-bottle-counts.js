'use strict';
// Bruno 07-08: corrige contagens DUPLICADAS (double-submit) — mesmo lote, mesma
// pessoa, MESMO valor de bottles, dentro de X minutos = a mesma contagem lançada
// 2×. Mantém a PRIMEIRA, marca as repetições como superseded/deleted. Dry-run;
// APPLY=1 aplica. Só toca em duplicatas ÓBVIAS (mesma pessoa+valor+janela curta).
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const EDT = 'America/New_York';
const APPLY = process.env.APPLY === '1';
const WIN = parseInt(process.env.WIN_MIN, 10) || 5;
const DAYS = parseInt(process.env.DAYS, 10) || 20;
(async () => {
  // pares (mesma pessoa, mesmo lote, mesmo valor) com o 2º dentro de WIN min do 1º
  const dupes = await p.query(
    `SELECT b.id AS dup_id, a.id AS keep_id, b.bottles, pb.batch_number, rp.display_name AS who,
            to_char(a.created_at AT TIME ZONE '${EDT}','MM-DD HH24:MI') AS first_at,
            to_char(b.created_at AT TIME ZONE '${EDT}','MM-DD HH24:MI') AS dup_at
       FROM v3.production_counts a
       JOIN v3.production_counts b ON b.product_batch_id = a.product_batch_id
        AND b.reported_by_person_id IS NOT DISTINCT FROM a.reported_by_person_id
        AND b.bottles = a.bottles AND b.id > a.id
        AND b.created_at BETWEEN a.created_at AND a.created_at + (INTERVAL '1 minute' * ${WIN})
       JOIN v3.product_batches pb ON pb.id = a.product_batch_id
       LEFT JOIN v3.persons rp ON rp.id = a.reported_by_person_id
      WHERE a.kind='bottles' AND b.kind='bottles' AND a.deleted_at IS NULL AND b.deleted_at IS NULL
        AND a.superseded_by IS NULL AND b.superseded_by IS NULL
        AND a.created_at > NOW() - INTERVAL '${DAYS} days'
      ORDER BY pb.batch_number`);
  console.log('Duplicatas óbvias (mesma pessoa+lote+valor, ≤' + WIN + 'min) — últimos ' + DAYS + ' dias:');
  if (!dupes.rows.length) console.log('  (nenhuma)');
  const ids = [];
  for (const r of dupes.rows) {
    console.log(`  ${r.batch_number}  ${r.bottles} bottles  ${r.who || '?'}  1ª ${r.first_at} · DUP ${r.dup_at}  → apaga #${r.dup_id} (mantém #${r.keep_id})`);
    ids.push({ dup: r.dup_id, keep: r.keep_id });
  }
  if (!ids.length) { await p.end(); return; }
  if (!APPLY) { console.log('\n(dry-run — rode com APPLY=1)'); await p.end(); return; }
  for (const x of ids) {
    await p.query("UPDATE v3.production_counts SET superseded_by = $2, deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL", [x.dup, x.keep]);
  }
  console.log('\n✅ ' + ids.length + ' duplicata(s) removida(s) (superseded).');
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
