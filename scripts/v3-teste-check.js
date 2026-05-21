'use strict';
// Procura a mensagem de teste nas duas tabelas + mostra o topo de cada. Read-only.
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

(async () => {
  const p = makeV3Pool();
  try {
    console.log('AGORA UTC:', new Date().toISOString());

    const v3 = (await p.query(
      'SELECT id, slack_ts, created_at, LEFT(raw_text,45) txt FROM v3.messages ORDER BY id DESC LIMIT 4')).rows;
    console.log('\nv3.messages — topo:');
    for (const r of v3) console.log(`  id=${r.id} ${r.created_at.toISOString()} "${(r.txt || '').replace(/\n/g, ' ')}"`);

    const lg = (await p.query(
      'SELECT slack_ts, created_at, LEFT(text,45) txt FROM public.messages ORDER BY created_at DESC LIMIT 5')).rows;
    console.log('\npublic.messages (legado) — topo:');
    for (const r of lg) console.log(`  ${r.created_at.toISOString()} "${String(r.txt || '').replace(/\n/g, ' ')}"`);

    const tv3 = (await p.query("SELECT slack_ts, raw_text FROM v3.messages WHERE raw_text ILIKE '%teste%'")).rows;
    const tlg = (await p.query("SELECT slack_ts, text FROM public.messages WHERE text ILIKE '%teste%'")).rows;
    console.log(`\n"teste" em v3.messages: ${tv3.length}`);
    for (const r of tv3) console.log(`  ${r.slack_ts} :: "${r.raw_text}"`);
    console.log(`"teste" em public.messages (legado): ${tlg.length}`);
    for (const r of tlg) console.log(`  ${r.slack_ts} :: "${r.text}"`);
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    await p.end().catch(() => {});
  }
})();
