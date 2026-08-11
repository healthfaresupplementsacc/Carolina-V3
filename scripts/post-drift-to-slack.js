'use strict';
/*
 * post-drift-to-slack.js — reads the newest docs/DRIFT-*.md and DMs the result to Bruno.
 *
 * NO database, NO writes to prod. Only reads a local file and calls the Slack Web API.
 * Bruno's Slack user id is resolved the same way the rest of the project does it:
 * `config.slack.brunoUserId` (env BRUNO_USER_ID, default U03URLL1D4L) — see src/config.js:13.
 * SLACK_BOT_TOKEN comes from the existing env config.
 *
 * A Slack failure NEVER kills the script (wrapped in try/catch); failures are appended
 * to drift-log.txt.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const LOG = path.join(ROOT, 'drift-log.txt');

function logLine(s) {
  const line = '[' + new Date().toISOString() + '] post-drift-to-slack: ' + s + '\n';
  try { fs.appendFileSync(LOG, line); } catch (_) { /* nothing more we can do */ }
  process.stdout.write(line);
}

function newestDriftFile() {
  if (!fs.existsSync(DOCS)) return null;
  const files = fs.readdirSync(DOCS)
    .filter((f) => /^DRIFT-\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort(); // lexicographic sort works for yyyy-MM-dd
  return files.length ? path.join(DOCS, files[files.length - 1]) : null;
}

(async () => {
  const file = newestDriftFile();
  if (!file) { logLine('no docs/DRIFT-*.md file found — nothing to post.'); return; }

  const raw = fs.readFileSync(file, 'utf8').trim();
  const base = path.basename(file);
  const noDrift = raw.toLowerCase() === 'no drift';

  // Resolve Bruno's Slack id the project's way (no DB).
  let brunoId = 'U03URLL1D4L';
  try {
    const config = require(path.join(ROOT, 'src', 'config'));
    brunoId = (config.slack && config.slack.brunoUserId) || brunoId;
  } catch (e) { logLine('could not load src/config.js for brunoUserId, using default: ' + e.message); }

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) { logLine('SLACK_BOT_TOKEN not set — cannot post. (drift file: ' + base + ', noDrift=' + noDrift + ')'); return; }

  const text = noDrift
    ? ':white_check_mark: Drift check (' + base.replace(/^DRIFT-|\.md$/g, '') + '): *no drift*. ARCHITECTURE.md matches what runs.'
    : ':rotating_light: *Architecture drift detected* (' + base + '):\n\n' + raw.slice(0, 3500) + (raw.length > 3500 ? '\n…(truncated, see ' + base + ')' : '');

  try {
    const { WebClient } = require('@slack/web-api');
    const web = new WebClient(token);
    // DM: open a conversation with Bruno, then post to that channel.
    const conv = await web.conversations.open({ users: brunoId });
    const channel = conv && conv.channel && conv.channel.id;
    if (!channel) throw new Error('conversations.open returned no channel id');
    const res = await web.chat.postMessage({ channel, text, unfurl_links: false, unfurl_media: false });
    logLine('posted to Bruno DM (' + brunoId + '), ts=' + (res && res.ts) + ', noDrift=' + noDrift + ', file=' + base);
  } catch (e) {
    // Slack failure must never kill the script.
    logLine('SLACK POST FAILED (non-fatal): ' + e.message + ' — file=' + base);
  }
})().catch((e) => {
  // Absolute last-resort guard so the process exits 0-ish and logs.
  logLine('unexpected error (non-fatal): ' + (e && e.message));
});
