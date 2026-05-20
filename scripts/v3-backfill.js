'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.13 — backfill one-time.
 *
 * Puxa as mensagens do canal de produção a partir de --since e
 * insere em v3.messages (llm_processed_at=NULL → o Observer worker
 * processa em SHADOW: zero reaction/post/DM).
 *
 * Idempotente: slack_ts UNIQUE + ON CONFLICT DO NOTHING — re-rodar
 * não duplica. NÃO liga o webhook — o backfill é isolado do
 * tempo-real.
 *
 *   railway run ... node scripts/v3-backfill.js --since="2026-05-20T08:00:00-04:00"
 */
const { WebClient } = require('@slack/web-api');
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

function arg(name, def) {
  const m = process.argv.find((a) => a.startsWith('--' + name + '='));
  return m ? m.slice(name.length + 3) : def;
}

async function main() {
  const channel = process.env.V3_PRODUCTION_CHANNEL || 'C09UNBXFRKK';
  const since = arg('since', null);
  if (!since) {
    console.error('uso: node scripts/v3-backfill.js --since="2026-05-20T08:00:00-04:00"');
    process.exit(2);
  }
  const sinceMs = new Date(since).getTime();
  if (!Number.isFinite(sinceMs)) { console.error('--since inválido: ' + since); process.exit(2); }
  const oldest = String(Math.floor(sinceMs / 1000));

  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  const pool = makeV3Pool();
  let pulled = 0;
  let inserted = 0;
  let cursor;

  try {
    console.log(`==== V3 BACKFILL — canal ${channel}, desde ${since} ====`);

    // 1 ── puxa do Slack (paginado) e insere em v3.messages ──
    do {
      const resp = await slack.conversations.history({ channel, oldest, limit: 200, cursor });
      for (const m of (resp.messages || [])) {
        if (m.subtype && m.subtype !== 'bot_message') continue; // ignora joins, etc.
        pulled++;
        const r = await pool.query(
          `INSERT INTO v3.messages (slack_ts, slack_channel_id, slack_user_id, raw_text, created_at)
           VALUES ($1, $2, $3, $4, to_timestamp($5))
           ON CONFLICT (slack_ts) DO NOTHING`,
          [m.ts, channel, m.user || m.bot_id || 'unknown', m.text || '', parseFloat(m.ts)]);
        if (r.rowCount > 0) inserted++;
      }
      cursor = resp.response_metadata && resp.response_metadata.next_cursor;
    } while (cursor);
    console.log(`Puxadas: ${pulled} | inseridas novas: ${inserted} (resto já existia — idempotente)`);

    // 2 ── espera o Observer worker drenar a fila (até ~5 min) ──
    let waited = 0;
    let pending = 1;
    while (pending > 0 && waited < 300) {
      await new Promise((res) => setTimeout(res, 5000));
      waited += 5;
      const q = await pool.query(
        'SELECT COUNT(*) c FROM v3.messages WHERE llm_processed_at IS NULL AND created_at >= $1::timestamptz',
        [since]);
      pending = parseInt(q.rows[0].c, 10);
      console.log(`  ...worker drenando: ${pending} na fila (${waited}s)`);
    }

    // 3 ── relatório ──
    const proc = await pool.query(
      `SELECT COUNT(*) c, COALESCE(SUM((llm_result->>'cost_estimate_usd')::numeric), 0) cost
       FROM v3.messages
       WHERE llm_processed_at IS NOT NULL AND created_at >= $1::timestamptz`, [since]);
    const ev = await pool.query(
      'SELECT COUNT(*) c FROM v3.events WHERE created_at >= $1::timestamptz', [since]);
    console.log('\n==== BACKFILL REPORT ====');
    console.log(`mensagens puxadas:        ${pulled}`);
    console.log(`mensagens inseridas:      ${inserted}`);
    console.log(`processadas pelo worker:  ${proc.rows[0].c}`);
    console.log(`events criados:           ${ev.rows[0].c}`);
    console.log(`custo LLM estimado:       $${Number(proc.rows[0].cost).toFixed(4)}`);
    if (pending > 0) {
      console.log(`\nATENÇÃO: ${pending} ainda na fila — confira /api/admin/v3/health`);
    }
    console.log('\nWebhook NÃO foi ligado — backfill é isolado do tempo-real.');
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
