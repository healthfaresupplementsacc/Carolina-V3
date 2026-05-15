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
 * Post a message to the production channel as Carolina.
 */
async function postMessage(text, threadTs = null) {
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
 */
async function postToChannel(channelId, text) {
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
 */
async function postImage({ title, comment, imageBuffer, filename }) {
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
 */
async function addReaction(ts) {
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

module.exports = { fetchMessages, postMessage, postToChannel, postImage, sendDM, getChannelInfo, addReaction };
