'use strict';
// Limpa os eventos FANTASMA de hoje (Bruno 07-08):
//  (a) encapsulações criadas do FEEDBACK-LOOP (msg do próprio bot), source='slack';
//  (b) os 4 "Material prep" da Simone que vieram da nota "Entrada produtos (Return)".
// Soft-delete (deleted_at). Mostra o que vai apagar; APLICA se APPLY=1.
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const EDT = 'America/New_York';
const APPLY = process.env.APPLY === '1';
(async () => {
  // (a) eventos de hoje sourced de mensagem de BOT (feedback loop)
  const botSourced = await p.query(
    `SELECT e.id, at.slug, m.slack_user_id, LEFT(m.raw_text,80) tx
       FROM v3.events e JOIN v3.messages m ON m.slack_ts = split_part(e.source_message_ts,'#',1)
       JOIN v3.activity_types at ON at.id = e.activity_type_id
      WHERE e.source='slack' AND e.deleted_at IS NULL
        AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
        AND m.slack_user_id LIKE 'B%'`);
  // (b) os material_handling da nota de return da Simone
  const simone = await p.query(
    `SELECT e.id, at.slug FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
      WHERE split_part(e.source_message_ts,'#',1) = '1783548444.848129' AND e.deleted_at IS NULL`);
  const ids = [...botSourced.rows.map((r) => r.id), ...simone.rows.map((r) => r.id)];
  console.log('(a) feedback-loop (msg de bot):');
  botSourced.rows.forEach((r) => console.log(`   #${r.id} ${r.slug} ← bot ${r.slack_user_id}: ${JSON.stringify(r.tx)}`));
  console.log('(b) nota "Entrada produtos (Return)" da Simone:');
  simone.rows.forEach((r) => console.log(`   #${r.id} ${r.slug}`));
  console.log('\nTotal a apagar:', ids.length, ids.length ? ('[' + ids.join(', ') + ']') : '');
  if (!ids.length) { await p.end(); return; }
  if (!APPLY) { console.log('\n(dry-run — rode com APPLY=1 pra aplicar)'); await p.end(); return; }
  const r = await p.query(
    "UPDATE v3.events SET deleted_at = NOW(), updated_at = NOW() WHERE id = ANY($1::int[]) AND deleted_at IS NULL RETURNING id", [ids]);
  console.log('\n✅ soft-deletado:', r.rowCount, 'eventos.');
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
