'use strict';
/**
 * Manually exercises the /slack/events app_home_opened path with a
 * VALID signature, then independently calls views.publish to see if the
 * Slack app itself is configured (Home Tab + scopes).
 *
 * Run: railway run --service ProductionLineService node scripts/test-app-home.js
 */
const crypto = require('crypto');
const https = require('https');

const SECRET = process.env.SLACK_SIGNING_SECRET;
const TOKEN = process.env.SLACK_BOT_TOKEN;
const HOST = 'productionlineservice-production.up.railway.app';
// A real human Slack user id (not the bot). Use Vitor's known id.
const TEST_USER = process.env.TEST_SLACK_USER || 'U08JC85HMNE';

function post(host, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      hostname: host, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let c = ''; res.on('data', (d) => { c += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: c }));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

(async () => {
  console.log('SIGNING_SECRET present:', !!SECRET, '| BOT_TOKEN present:', !!TOKEN);

  // ── 1. Signed app_home_opened to our own endpoint ──
  const evt = JSON.stringify({
    type: 'event_callback',
    event: { type: 'app_home_opened', user: TEST_USER, tab: 'home' },
  });
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = 'v0=' + crypto.createHmac('sha256', SECRET).update(`v0:${ts}:${evt}`).digest('hex');
  const r1 = await post(HOST, '/slack/events', evt, {
    'X-Slack-Request-Timestamp': ts,
    'X-Slack-Signature': sig,
  });
  console.log(`\n[1] POST /slack/events (signed app_home_opened) → HTTP ${r1.status} ${r1.body}`);
  console.log('    (200 = our handler accepted it and is now calling views.publish async)');

  // ── 2. Direct views.publish to Slack — checks the APP config itself ──
  await new Promise((r) => setTimeout(r, 1500)); // let async handler attempt
  const view = JSON.stringify({
    type: 'home',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '✅ test view' } }],
  });
  const r2 = await post('slack.com', '/api/views.publish',
    JSON.stringify({ user_id: TEST_USER, view: JSON.parse(view) }),
    { 'Authorization': `Bearer ${TOKEN}` });
  let parsed; try { parsed = JSON.parse(r2.body); } catch { parsed = r2.body; }
  console.log(`\n[2] Direct views.publish to Slack API → HTTP ${r2.status}`);
  console.log('    ok:', parsed.ok, '| error:', parsed.error || '(none)',
              parsed.response_metadata ? JSON.stringify(parsed.response_metadata) : '');
  if (parsed.ok) {
    console.log('\n>>> Slack app IS configured. views.publish succeeded. The');
    console.log('    issue is Event Subscriptions not delivering app_home_opened.');
  } else if (parsed.error === 'not_allowed_token_type' || parsed.error === 'missing_scope') {
    console.log('\n>>> Slack app MISSING scope/Home Tab. Need to enable App Home');
    console.log('    + reinstall. error=' + parsed.error);
  } else {
    console.log('\n>>> views.publish failed: ' + parsed.error);
  }
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
