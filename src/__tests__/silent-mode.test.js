'use strict';
/**
 * URGENT kill switch tests.
 *
 * Behavior under test:
 *   - When app_state.silent_mode = 'true', postMessage / postImage /
 *     addReaction / postToChannel(productionChannel) do NOT hit Slack;
 *     instead a row goes into silent_log.
 *   - postToChannel(managerChannelId) ALWAYS goes through, even silent.
 *   - When the flag is 'false', behavior is normal.
 *   - process.env.CAROLINA_SILENT is used as fallback when DB lookup fails.
 *   - POST /admin/silent-toggle flips the flag and audits.
 */

process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';

const mockChatPostMessage = jest.fn();
const mockReactionsAdd    = jest.fn();
const mockFilesUploadV2   = jest.fn();

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: mockChatPostMessage },
    reactions: { add: mockReactionsAdd },
    files: { uploadV2: mockFilesUploadV2 },
    conversations: {
      history: jest.fn().mockResolvedValue({ messages: [] }),
      info: jest.fn().mockResolvedValue({}),
      open: jest.fn().mockResolvedValue({ channel: { id: 'D1' } }),
    },
  })),
}));

jest.mock('../db');

const db = require('../db');
const config = require('../config');
const slackClient = require('../slack/client');

function setSilent(value /* 'true' | 'false' | throw */) {
  db.query = jest.fn().mockImplementation((sql, params) => {
    if (/SELECT value FROM app_state WHERE key = 'silent_mode'/.test(sql)) {
      if (value === 'throw') return Promise.reject(new Error('DB down'));
      return Promise.resolve({ rows: [{ value }] });
    }
    // For INSERT INTO silent_log and any other write, succeed silently.
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  mockChatPostMessage.mockReset();
  mockChatPostMessage.mockResolvedValue({ ts: '1700000000.000001' });
  mockReactionsAdd.mockReset();
  mockReactionsAdd.mockResolvedValue({ ok: true });
  mockFilesUploadV2.mockReset();
  mockFilesUploadV2.mockResolvedValue({ ok: true });
  slackClient.invalidateSilentCache();
});

describe('silent_mode = true → production posts are suppressed', () => {
  beforeEach(() => setSilent('true'));

  test('postMessage logs to silent_log and does NOT call chat.postMessage', async () => {
    const ts = await slackClient.postMessage('alô pessoal');
    expect(mockChatPostMessage).not.toHaveBeenCalled();
    expect(ts).toMatch(/^silent-/);
    const logCall = db.query.mock.calls.find((c) => /INSERT INTO silent_log/.test(c[0]));
    expect(logCall).toBeTruthy();
    expect(logCall[1]).toEqual([config.slack.channelId, 'postMessage', 'alô pessoal', null]);
  });

  test('addReaction logs and skips reactions.add', async () => {
    await slackClient.addReaction('1700000000.000005');
    expect(mockReactionsAdd).not.toHaveBeenCalled();
    const logCall = db.query.mock.calls.find((c) => /INSERT INTO silent_log/.test(c[0]));
    expect(logCall).toBeTruthy();
    expect(logCall[1][1]).toBe('addReaction');
    expect(logCall[1][3]).toBe('1700000000.000005');
  });

  test('postImage logs and skips uploadV2', async () => {
    const r = await slackClient.postImage({ title: 'EOD', comment: 'x', imageBuffer: Buffer.from('xx'), filename: 'eod.png' });
    expect(mockFilesUploadV2).not.toHaveBeenCalled();
    expect(r.silent).toBe(true);
    const logCall = db.query.mock.calls.find((c) => /INSERT INTO silent_log/.test(c[0]));
    expect(logCall[1][1]).toBe('postImage');
  });

  test('postToChannel to PRODUCTION channel is suppressed', async () => {
    const ts = await slackClient.postToChannel(config.slack.channelId, 'broadcast');
    expect(mockChatPostMessage).not.toHaveBeenCalled();
    expect(ts).toMatch(/^silent-/);
  });

  test('postToChannel to MANAGER channel ALWAYS goes through', async () => {
    const ts = await slackClient.postToChannel(config.slack.managerChannelId, 'admin only');
    expect(mockChatPostMessage).toHaveBeenCalledTimes(1);
    const call = mockChatPostMessage.mock.calls[0][0];
    expect(call.channel).toBe(config.slack.managerChannelId);
    expect(call.text).toBe('admin only');
    expect(ts).toBe('1700000000.000001');
    const logCall = db.query.mock.calls.find((c) => /INSERT INTO silent_log/.test(c[0]));
    expect(logCall).toBeFalsy();
  });
});

describe('silent_mode = false → behavior is normal', () => {
  beforeEach(() => setSilent('false'));

  test('postMessage calls Slack and does not log', async () => {
    const ts = await slackClient.postMessage('alô');
    expect(mockChatPostMessage).toHaveBeenCalledTimes(1);
    expect(ts).toBe('1700000000.000001');
    const logCall = db.query.mock.calls.find((c) => /INSERT INTO silent_log/.test(c[0]));
    expect(logCall).toBeFalsy();
  });

  test('addReaction calls Slack', async () => {
    await slackClient.addReaction('1700000000.000005');
    expect(mockReactionsAdd).toHaveBeenCalledTimes(1);
  });
});

describe('Env-var fallback when DB lookup fails', () => {
  test('CAROLINA_SILENT=true silences postMessage even if DB throws', async () => {
    const originalEnv = process.env.CAROLINA_SILENT;
    process.env.CAROLINA_SILENT = 'true';
    setSilent('throw');
    await slackClient.postMessage('test');
    expect(mockChatPostMessage).not.toHaveBeenCalled();
    if (originalEnv === undefined) delete process.env.CAROLINA_SILENT;
    else process.env.CAROLINA_SILENT = originalEnv;
  });
});

describe('POST /admin/silent-toggle flips the flag + audits', () => {
  test('explicit value=on sets silent_mode to true', async () => {
    const express = require('express');
    const http = require('http');
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT value FROM app_state WHERE key = 'silent_mode'/.test(sql)) {
        return Promise.resolve({ rows: [{ value: 'false' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const app = express();
    app.use(express.json());
    app.use('/api', require('../routes/api'));

    const r = await new Promise((resolve) => {
      const server = app.listen(0, () => {
        const port = server.address().port;
        const data = JSON.stringify({ pin: '510510', value: 'on' });
        const req = http.request({
          hostname: '127.0.0.1', port, path: '/api/admin/silent-toggle', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
          let body = ''; res.on('data', (c) => { body += c; });
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(body) }); });
        });
        req.write(data); req.end();
      });
    });

    expect(r.status).toBe(200);
    expect(r.body.silent_mode).toBe(true);
    const upsert = db.query.mock.calls.find((c) =>
      /INSERT INTO app_state[\s\S]+'silent_mode'/.test(c[0])
    );
    expect(upsert).toBeTruthy();
    expect(upsert[1][0]).toBe('true');
    const audit = db.query.mock.calls.find((c) =>
      /INSERT INTO admin_audit_log/.test(c[0]) && c[1][1] === 'silent_mode.toggle'
    );
    expect(audit).toBeTruthy();
  });
});
