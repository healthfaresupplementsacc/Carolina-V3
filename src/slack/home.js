'use strict';
/**
 * Entrega 3 — App Home renderer. Block Kit views are built here and
 * published via views.publish. Filled in commit 6.2.
 */
const config = require('../config');

let _client = null;
function client() {
  if (!_client) {
    const { WebClient } = require('@slack/web-api');
    _client = new WebClient(config.slack.token);
  }
  return _client;
}

// Placeholder — replaced by the full Block Kit builder in 6.2.
async function buildHomeView() {
  return {
    type: 'home',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '*Carolina — HealthFare Production*' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'App Home carregando…' }] },
    ],
  };
}

async function publishHome(slackUserId) {
  if (!slackUserId) return;
  try {
    const view = await buildHomeView(slackUserId);
    await client().views.publish({ user_id: slackUserId, view });
  } catch (err) {
    console.error('[Home] publish error:', err.message);
  }
}

module.exports = { buildHomeView, publishHome };
