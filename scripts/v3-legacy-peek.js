'use strict';
// Olha as mensagens recentes capturadas pelo LEGADO (public.messages) — read-only.
// Serve pra saber se uma mensagem foi postada no canal mesmo (legado pollou)
// quando ela não aparece em v3.messages (webhook não entregou).
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

(async () => {
  const p = makeV3Pool();
  try {
    // descobre as colunas da tabela legada
    const cols = (await p.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='messages' ORDER BY ordinal_position`)).rows
      .map((r) => r.column_name);
    console.log('public.messages colunas:', cols.join(', '));

    const tsCol = cols.includes('slack_ts') ? 'slack_ts' : (cols.includes('ts') ? 'ts' : cols[0]);
    const textCol = cols.includes('text') ? 'text' : (cols.includes('raw_text') ? 'raw_text' : null);
    const timeCol = cols.includes('created_at') ? 'created_at'
      : (cols.includes('timestamp') ? 'timestamp' : (cols.includes('message_ts') ? 'message_ts' : tsCol));

    const recent = (await p.query(
      `SELECT ${tsCol} ts, ${textCol ? textCol : "''"} txt, ${timeCol} t
       FROM public.messages ORDER BY ${timeCol} DESC LIMIT 12`)).rows;
    console.log(`\núltimas 12 mensagens no LEGADO (public.messages, por ${timeCol}):`);
    for (const r of recent) {
      console.log(`  ts=${r.ts} t=${r.t instanceof Date ? r.t.toISOString() : r.t}`);
      console.log(`     "${String(r.txt || '').replace(/\n/g, ' ').slice(0, 70)}"`);
    }

    const total = (await p.query('SELECT COUNT(*) c FROM public.messages')).rows[0].c;
    console.log('\ntotal public.messages:', total);
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    await p.end().catch(() => {});
  }
})();
