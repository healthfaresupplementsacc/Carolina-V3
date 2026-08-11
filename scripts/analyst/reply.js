'use strict';
/**
 * ANALISTA DE DADOS — postar RESPOSTA no Slack (Bruno 07-28).
 *
 * EU (Claude Code) uso isto pra responder a pergunta do admin depois de analisar os
 * dados. Posta como thread na mensagem original (não polui o canal) OU no topo se
 * não passar thread_ts.
 *
 * Uso:  railway run node scripts/analyst/reply.js <channel> <thread_ts|-> "<texto>"
 *   thread_ts = '-' → posta no topo. O texto vem por argv (aspas) ou stdin.
 */

const TOK = process.env.SLACK_BOT_TOKEN;

async function main() {
  const [channel, threadArg] = process.argv.slice(2);
  let text = process.argv.slice(4).join(' ');
  if (!text) { text = require('fs').readFileSync(0, 'utf8'); }   // stdin fallback
  if (!TOK) { process.stderr.write('SEM SLACK_BOT_TOKEN\n'); process.exit(1); }
  if (!channel || !text) { process.stderr.write('uso: reply.js <channel> <thread_ts|-> "<texto>"\n'); process.exit(1); }
  const body = {
    channel,
    text,
    unfurl_links: false, unfurl_media: false,
    username: 'HealthFare Tracker (Análise)',
  };
  if (threadArg && threadArg !== '-') body.thread_ts = threadArg;
  const r = await (await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOK, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  process.stdout.write(r.ok ? ('OK ts=' + r.ts + '\n') : ('ERRO: ' + r.error + '\n'));
  if (!r.ok) process.exit(1);
}

main().catch((e) => { process.stderr.write('FATAL: ' + e.message + '\n'); process.exit(1); });
