'use strict';
const { WebClient } = require('@slack/web-api');
const config = require('../config');

let _client = null;

function getClient() {
  if (!_client) {
    if (!config.slack.token) throw new Error('SLACK_BOT_TOKEN not set');
    _client = new WebClient(config.slack.token);
  }
  return _client;
}

// ─── URGENT kill switch ──────────────────────────────────────────────────
// When silent_mode is on, all outbound posts to the PRODUCTION channel are
// suppressed and recorded in silent_log. Admin chat (managerChannelId) is
// always allowed through — Carolina has to keep talking to Bruno.
//
// Source of truth: app_state row key='silent_mode' value='true'|'false'.
// Fallback when DB unreachable or no row: process.env.CAROLINA_SILENT.
// 5s in-process cache so a busy poll cycle doesn't hammer the DB.

let _silentCache = { value: false, expiresAt: 0 };
function invalidateSilentCache() { _silentCache.expiresAt = 0; }

async function isSilent() {
  const now = Date.now();
  if (now < _silentCache.expiresAt) return _silentCache.value;
  let val = false;
  try {
    const db = require('../db');
    const r = await db.query("SELECT value FROM app_state WHERE key = 'silent_mode'");
    if (r.rows.length > 0) {
      val = r.rows[0].value === 'true';
    } else {
      val = process.env.CAROLINA_SILENT === 'true';
    }
  } catch (err) {
    // DB unreachable — fall back to env var so the kill switch still works.
    val = process.env.CAROLINA_SILENT === 'true';
  }
  _silentCache = { value: val, expiresAt: now + 5000 };
  return val;
}

function isAdminChannel(channelId) {
  return channelId === config.slack.managerChannelId;
}

async function logSilent(channelId, action, text, threadTs) {
  try {
    const db = require('../db');
    await db.query(
      `INSERT INTO silent_log (intended_channel, intended_action, intended_text, would_have_replied_to_ts)
       VALUES ($1, $2, $3, $4)`,
      [channelId || null, action, text || null, threadTs || null]
    );
  } catch (err) {
    console.error('[Silent] log insert failed:', err.message);
  }
}

/**
 * Fetch messages from the channel, oldest first, starting after `since` timestamp.
 */
async function fetchMessages(since, limit = 200) {
  const client = getClient();
  const messages = [];
  let cursor;

  do {
    const params = {
      channel: config.slack.channelId,
      limit: Math.min(limit, 200),
      oldest: since,
      inclusive: false,
    };
    if (cursor) params.cursor = cursor;

    const result = await client.conversations.history(params);
    if (result.messages) {
      // API returns newest first; we want oldest first for processing
      messages.push(...result.messages.reverse());
    }
    cursor = result.response_metadata?.next_cursor;
  } while (cursor && messages.length < limit);

  return messages;
}

/**
 * Fetch the most recent N messages (no `oldest` filter). Used by the edit
 * detector to compare current Slack state vs DB and reprocess edited messages.
 */
async function fetchRecentMessages(limit = 50) {
  const client = getClient();
  const result = await client.conversations.history({
    channel: config.slack.channelId,
    limit: Math.min(limit, 200),
  });
  return result.messages ? result.messages.reverse() : [];
}

/**
 * Post a message to the production channel as Carolina.
 * Suppressed when silent_mode is on — call is logged to silent_log instead.
 */
async function postMessage(text, threadTs = null) {
  if (await isSilent()) {
    console.log('[Silent mode] Would have posted:', String(text).slice(0, 200));
    await logSilent(config.slack.channelId, 'postMessage', text, threadTs);
    return 'silent-' + Date.now();
  }
  const client = getClient();
  const params = {
    channel: config.slack.channelId,
    text,
    username: 'Carolina',
  };
  if (threadTs) params.thread_ts = threadTs;

  const result = await client.chat.postMessage(params);
  return result.ts;
}

/**
 * Post a message to a specific channel (e.g. manager channel for internal alerts).
 * Silent mode only suppresses posts to the production channel — the admin /
 * manager channel always goes through, so Bruno keeps seeing notifications.
 */
async function postToChannel(channelId, text) {
  if (!isAdminChannel(channelId) && await isSilent()) {
    console.log('[Silent mode] Would have posted to', channelId, ':', String(text).slice(0, 200));
    await logSilent(channelId, 'postToChannel', text, null);
    return 'silent-' + Date.now();
  }
  const client = getClient();
  const result = await client.chat.postMessage({
    channel: channelId,
    text,
    username: 'Carolina',
  });
  return result.ts;
}

/**
 * Post a message with image attachment (for EOD summary).
 * Same silent-mode suppression as postMessage.
 */
async function postImage({ title, comment, imageBuffer, filename }) {
  if (await isSilent()) {
    console.log('[Silent mode] Would have posted image:', title || filename || '(eod)');
    await logSilent(config.slack.channelId, 'postImage', `[image] ${title || ''} — ${comment || ''}`, null);
    return { silent: true, ts: 'silent-' + Date.now() };
  }
  const client = getClient();
  const result = await client.files.uploadV2({
    channel_id: config.slack.channelId,
    file: imageBuffer,
    filename: filename || 'eod-summary.png',
    title: title || 'Resumo do dia',
    initial_comment: comment || '',
  });
  return result;
}

/**
 * Send a DM to a user.
 */
async function sendDM(userId, text) {
  const client = getClient();
  // Open DM channel
  const dm = await client.conversations.open({ users: userId });
  const channelId = dm.channel.id;
  return client.chat.postMessage({ channel: channelId, text, username: 'Carolina' });
}

/**
 * Fetch channel info (for verifying connection).
 */
async function getChannelInfo() {
  const client = getClient();
  return client.conversations.info({ channel: config.slack.channelId });
}

/**
 * Add a ✅ reaction to a message to signal the system read it.
 * Suppressed in silent mode (no visual confirmation on the channel either).
 */
async function addReaction(ts) {
  if (await isSilent()) {
    await logSilent(config.slack.channelId, 'addReaction', null, ts);
    return;
  }
  try {
    const client = getClient();
    await client.reactions.add({
      channel: config.slack.channelId,
      name: 'white_check_mark',
      timestamp: ts,
    });
  } catch (err) {
    // already_reacted is expected if Henrique (or us) already added it
    if (err.data?.error !== 'already_reacted') {
      console.error('[Slack] addReaction error:', err.message);
    }
  }
}

module.exports = {
  fetchMessages, fetchRecentMessages, postMessage, postToChannel, postImage,
  sendDM, getChannelInfo, addReaction,
  // kill switch
  isSilent, invalidateSilentCache,
};
