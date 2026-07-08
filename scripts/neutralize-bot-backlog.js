'use strict';
// Bruno 07-08: o fix do feedback-loop é forward-only. Mensagens do PRÓPRIO BOT
// que já foram ingeridas ANTES do deploy seguem com llm_processed_at NULL → o
// Observer ainda ia processá-las e criar eventos fantasma. Neutraliza o backlog:
// marca as msgs de bot não-processadas como processadas (com tag), sem tocar em
// mensagem humana. Dry-run por padrão; APPLY=1 aplica.
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const APPLY = process.env.APPLY === '1';
(async () => {
  const pend = await p.query(
    "SELECT slack_user_id, COUNT(*)::int n FROM v3.messages WHERE llm_processed_at IS NULL AND slack_user_id LIKE 'B%' GROUP BY 1");
  console.log('Mensagens de BOT pendentes (llm_processed_at NULL, autor B...):');
  let total = 0; pend.rows.forEach((r) => { console.log(`   ${r.slack_user_id}: ${r.n}`); total += r.n; });
  console.log('Total:', total);
  if (!total) { await p.end(); return; }
  if (!APPLY) { console.log('\n(dry-run — rode com APPLY=1)'); await p.end(); return; }
  const r = await p.query(
    "UPDATE v3.messages SET llm_processed_at = NOW(), processing_error = 'bot_self_backfill' WHERE llm_processed_at IS NULL AND slack_user_id LIKE 'B%' RETURNING slack_ts");
  console.log('\n✅ neutralizadas:', r.rowCount, 'mensagens de bot (não viram mais evento).');
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
