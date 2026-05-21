'use strict';
/**
 * Diagnóstico do webhook V3: usa a API do Slack (read-only) pra
 * confirmar (a) identidade do bot, (b) se o bot está no canal de
 * produção, (c) se a mensagem de teste existe no canal.
 *
 *   railway run ... node scripts/v3-slack-diag.js
 */
const { WebClient } = require('@slack/web-api');

(async () => {
  const channel = process.env.V3_PRODUCTION_CHANNEL || 'C09UNBXFRKK';
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  try {
    const auth = await slack.auth.test();
    console.log('auth.test → bot user:', auth.user_id, '| team:', auth.team, '| url:', auth.url);

    const info = await slack.conversations.info({ channel });
    const c = info.channel || {};
    console.log(`\nconversations.info(${channel}):`);
    console.log('  name:', c.name, '| is_member:', c.is_member,
      '| is_private:', c.is_private, '| is_archived:', c.is_archived);

    const hist = await slack.conversations.history({ channel, limit: 8 });
    console.log(`\nconversations.history — últimas ${(hist.messages || []).length} mensagens:`);
    for (const m of (hist.messages || [])) {
      const when = new Date(parseFloat(m.ts) * 1000).toISOString();
      console.log(`  ts=${m.ts} (${when}) user=${m.user || m.bot_id || '?'} sub=${m.subtype || '-'}`);
      console.log(`     "${String(m.text || '').replace(/\n/g, ' ').slice(0, 70)}"`);
    }
    const teste = (hist.messages || []).find((m) => /teste v3 ao vivo/i.test(m.text || ''));
    console.log('\n"teste v3 ao vivo" no histórico do canal:', teste ? 'SIM (ts=' + teste.ts + ')' : 'NÃO nas últimas 8');
  } catch (e) {
    console.error('FATAL:', e.message, e.data ? JSON.stringify(e.data) : '');
    process.exitCode = 1;
  }
})();
