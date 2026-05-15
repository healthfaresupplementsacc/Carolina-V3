'use strict';
const { WebClient } = require('@slack/web-api');
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const channel = process.env.SLACK_CHANNEL_ID || 'C09UNBXFRKK';

// Refactor window:
//   apply-partial-silent.js completed at 2026-05-15T15:11:06Z
//   /api/dashboard with silentText=true confirmed live by ~15:14Z
// Look at Slack messages from a wide envelope around it.
const FROM = '1778858000';  // ≈ 15:00 UTC
const TO   = '1778859400';  // ≈ 15:23 UTC

(async () => {
  // Bot user (Carolina) — anything FROM the bot in the channel between FROM and TO
  const result = await slack.conversations.history({
    channel,
    oldest: FROM,
    latest: TO,
    inclusive: true,
    limit: 200,
  });
  const msgs = (result.messages || []).filter((m) => m.bot_id || m.username === 'Carolina');
  console.log(`Carolina/bot messages in [${FROM}, ${TO}]:`, msgs.length);
  for (const m of msgs) {
    const when = new Date(parseFloat(m.ts) * 1000).toISOString();
    console.log(`  ts=${m.ts} (${when})`);
    console.log(`     username: ${m.username || m.bot_id}`);
    console.log(`     text: ${(m.text || '').slice(0, 200).replace(/\n/g, ' ')}`);
  }
})().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
