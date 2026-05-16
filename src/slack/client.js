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

// ─── URGENT kill switch (partial) ────────────────────────────────────────
// silent_mode (master) → blocks BOTH text and reactions when true.
// silent_text          → blocks postMessage / postToChannel / postImage.
// silent_reactions     → blocks addReaction.
//
// isSilent(kind) where kind ∈ {'text','reactions'} returns true if EITHER
// the master flag is on OR the relevant sub-flag is on. Admin chat
// (managerChannelId) is always allowed through.
//
// Source of truth: app_state rows. Fallback when DB unreachable:
// process.env.CAROLINA_SILENT (master kill switch).
// 5s in-process cache so a busy poll cycle doesn't hammer the DB.

let _silentCache = { flags: null, expiresAt: 0 };
function invalidateSilentCache() { _silentCache.expiresAt = 0; }

async function _readSilentFlags() {
  const now = Date.now();
  if (_silentCache.flags && now < _silentCache.expiresAt) return _silentCache.flags;
  let master = false, text = false, reactions = false;
  try {
    const db = require('../db');
    const r = await db.query(
      "SELECT key, value FROM app_state WHERE key IN ('silent_mode','silent_text','silent_reactions')"
    );
    const m = Object.fromEntries(r.rows.map((row) => [row.key, row.value]));
    master    = m.silent_mode      === 'true';
    text      = m.silent_text      === 'true';
    reactions = m.silent_reactions === 'true';
    if (r.rows.length === 0) {
      master = process.env.CAROLINA_SILENT === 'true';
    }
  } catch (err) {
    master = process.env.CAROLINA_SILENT === 'true';
  }
  _silentCache = { flags: { master, text, reactions }, expiresAt: now + 5000 };
  return _silentCache.flags;
}

async function isSilent(kind) {
  const flags = await _readSilentFlags();
  if (flags.master) return true;
  if (kind === 'text')      return flags.text;
  if (kind === 'reactions') return flags.reactions;
  // Unknown kind → conservative: behave like text channel.
  return flags.text;
}

function isAdminChannel(channelId) {
  return channelId === config.slack.managerChannelId;
}

async function logSilent(channelId, action, text, threadTs, kind) {
  try {
    const db = require('../db');
    await db.query(
      `INSERT INTO silent_log (intended_channel, intended_action, intended_text, would_have_replied_to_ts, kind)
       VALUES ($1, $2, $3, $4, $5)`,
      [channelId || null, action, text || null, threadTs || null, kind || null]
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
async function postMessage(text, threadTs = null, msgType = null) {
  // BLOCO B / C4 — per-type toggle. Suppressed messages are logged to
  // silent_log (kind='toggle:<type>') just like silent_text. Untagged
  // calls (msgType=null) are never gated here.
  if (msgType && !(await require('../app-state').isMsgEnabled(msgType))) {
    console.log(`[Msg toggle:${msgType}] suppressed:`, String(text).slice(0, 200));
    await logSilent(config.slack.channelId, 'postMessage', text, threadTs, 'toggle:' + msgType);
    return 'toggled-' + Date.now();
  }
  if (await isSilent('text')) {
    console.log('[Silent text] Would have posted:', String(text).slice(0, 200));
    await logSilent(config.slack.channelId, 'postMessage', text, threadTs, 'text');
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
async function postToChannel(channelId, text, msgType = null) {
  // Admin/manager channel always goes through (toggles, like silent_text,
  // never silence the admin). Otherwise honour the per-type toggle.
  if (!isAdminChannel(channelId) && msgType
      && !(await require('../app-state').isMsgEnabled(msgType))) {
    console.log(`[Msg toggle:${msgType}] suppressed to`, channelId, ':', String(text).slice(0, 200));
    await logSilent(channelId, 'postToChannel', text, null, 'toggle:' + msgType);
    return 'toggled-' + Date.now();
  }
  if (!isAdminChannel(channelId) && await isSilent('text')) {
    console.log('[Silent text] Would have posted to', channelId, ':', String(text).slice(0, 200));
    await logSilent(channelId, 'postToChannel', text, null, 'text');
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
  if (await isSilent('text')) {
    console.log('[Silent text] Would have posted image:', title || filename || '(eod)');
    await logSilent(config.slack.channelId, 'postImage', `[image] ${title || ''} — ${comment || ''}`, null, 'text');
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
  if (await isSilent('reactions')) {
    await logSilent(config.slack.channelId, 'addReaction', null, ts, 'reaction');
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
