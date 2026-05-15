'use strict';
/**
 * Kill switch tests — partial silent mode (text vs reactions).
 *
 * Flags in app_state:
 *   silent_mode      master (when true, both kinds suppressed)
 *   silent_text      blocks postMessage/postToChannel/postImage
 *   silent_reactions blocks addReaction
 *
 * isSilent(kind) returns true if master OR the matching sub-flag is on.
 * Admin chat (managerChannelId) is always allowed through.
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

// Build mock that returns the desired flag state.
function setFlags({ master = 'false', text = 'false', reactions = 'false', throwOnSelect = false } = {}) {
  db.query = jest.fn().mockImplementation((sql, params) => {
    if (/SELECT key, value FROM app_state WHERE key IN/.test(sql)) {
      if (throwOnSelect) return Promise.reject(new Error('DB down'));
      const rows = [];
      if (master    !== undefined) rows.push({ key: 'silent_mode',      value: master });
      if (text      !== undefined) rows.push({ key: 'silent_text',      value: text });
      if (reactions !== undefined) rows.push({ key: 'silent_reactions', value: reactions });
      return Promise.resolve({ rows });
    }
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

describe('partial silent — text=ON, reactions=OFF', () => {
  beforeEach(() => setFlags({ master: 'false', text: 'true', reactions: 'false' }));

  test('postMessage suppressed, logs silent_log with kind=text', async () => {
    const ts = await slackClient.postMessage('alô pessoal');
    expect(mockChatPostMessage).not.toHaveBeenCalled();
    expect(ts).toMatch(/^silent-/);
    const logCall = db.query.mock.calls.find((c) => /INSERT INTO silent_log/.test(c[0]));
    expect(logCall).toBeTruthy();
    // params order: channel, action, text, threadTs, kind
    expect(logCall[1][1]).toBe('postMessage');
    expect(logCall[1][4]).toBe('text');
  });

  test('addReaction GOES THROUGH because reactions=OFF', async () => {
    await slackClient.addReaction('1700000000.000005');
    expect(mockReactionsAdd).toHaveBeenCalledTimes(1);
    const logCall = db.query.mock.calls.find((c) => /INSERT INTO silent_log/.test(c[0]));
    expect(logCall).toBeFalsy();
  });

  test('postImage suppressed (kind=text)', async () => {
    const r = await slackClient.postImage({ title: 'EOD', imageBuffer: Buffer.from('x'), filename: 'x.png' });
    expect(mockFilesUploadV2).not.toHaveBeenCalled();
    expect(r.silent).toBe(true);
    const logCall = db.query.mock.calls.find((c) => /INSERT INTO silent_log/.test(c[0]));
    expect(logCall[1][1]).toBe('postImage');
    expect(logCall[1][4]).toBe('text');
  });
});

describe('partial silent — text=OFF, reactions=ON', () => {
  beforeEach(() => setFlags({ master: 'false', text: 'false', reactions: 'true' }));

  test('postMessage goes through', async () => {
    await slackClient.postMessage('alô');
    expect(mockChatPostMessage).toHaveBeenCalledTimes(1);
  });

  test('addReaction suppressed, logs kind=reaction', async () => {
    await slackClient.addReaction('1700000000.000005');
    expect(mockReactionsAdd).not.toHaveBeenCalled();
    const logCall = db.query.mock.calls.find((c) => /INSERT INTO silent_log/.test(c[0]));
    expect(logCall[1][1]).toBe('addReaction');
    expect(logCall[1][4]).toBe('reaction');
  });
});

describe('master flag still works (backward compat)', () => {
  beforeEach(() => setFlags({ master: 'true', text: 'false', reactions: 'false' }));

  test('master=true → BOTH suppressed regardless of sub-flags', async () => {
    await slackClient.postMessage('x');
    await slackClient.addReaction('1700000000.000001');
    expect(mockChatPostMessage).not.toHaveBeenCalled();
    expect(mockReactionsAdd).not.toHaveBeenCalled();
  });
});

describe('both flags off → all goes through', () => {
  beforeEach(() => setFlags({ master: 'false', text: 'false', reactions: 'false' }));

  test('postMessage', async () => {
    await slackClient.postMessage('x');
    expect(mockChatPostMessage).toHaveBeenCalledTimes(1);
  });

  test('addReaction', async () => {
    await slackClient.addReaction('1700000000.000005');
    expect(mockReactionsAdd).toHaveBeenCalledTimes(1);
  });

  test('postToChannel to admin channel always goes', async () => {
    await slackClient.postToChannel(config.slack.managerChannelId, 'admin only');
    expect(mockChatPostMessage).toHaveBeenCalledTimes(1);
  });
});

describe('Env-var fallback', () => {
  test('CAROLINA_SILENT=true silences when DB throws (master fallback)', async () => {
    const originalEnv = process.env.CAROLINA_SILENT;
    process.env.CAROLINA_SILENT = 'true';
    setFlags({ throwOnSelect: true });
    await slackClient.postMessage('test');
    expect(mockChatPostMessage).not.toHaveBeenCalled();
    if (originalEnv === undefined) delete process.env.CAROLINA_SILENT;
    else process.env.CAROLINA_SILENT = originalEnv;
  });
});

describe('POST /admin/silent-toggle accepts kind', () => {
  function http(method, url, body) {
    return new Promise((resolve) => {
      const express = require('express');
      const httpMod = require('http');
      const app = express();
      app.use(express.json());
      app.use('/api', require('../routes/api'));
      const server = app.listen(0, () => {
        const port = server.address().port;
        const data = body ? JSON.stringify(body) : null;
        const req = httpMod.request({
          hostname: '127.0.0.1', port, path: url, method,
          headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        }, (res) => {
          let chunks = ''; res.on('data', (c) => { chunks += c; });
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(chunks) }); });
        });
        if (data) req.write(data); req.end();
      });
    });
  }

  function flagDbMock({ silent_mode = 'false', silent_text = 'false', silent_reactions = 'false' } = {}) {
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/SELECT key, value FROM app_state WHERE key IN/.test(sql)) {
        return Promise.resolve({ rows: [
          { key: 'silent_mode',      value: silent_mode },
          { key: 'silent_text',      value: silent_text },
          { key: 'silent_reactions', value: silent_reactions },
        ]});
      }
      return Promise.resolve({ rows: [] });
    });
  }

  test('kind=text + value=on flips silent_text only', async () => {
    flagDbMock();
    const r = await http('POST', '/api/admin/silent-toggle', { pin: '510510', kind: 'text', value: 'on' });
    expect(r.status).toBe(200);
    expect(r.body.silent_text).toBe(true);
    expect(r.body.silent_reactions).toBe(false);

    const upsert = db.query.mock.calls.find((c) =>
      /INSERT INTO app_state/.test(c[0]) && c[1]?.[0] === 'silent_text'
    );
    expect(upsert).toBeTruthy();
    expect(upsert[1][1]).toBe('true');
  });

  test('kind=reactions + value=off flips silent_reactions only', async () => {
    flagDbMock({ silent_reactions: 'true' });
    const r = await http('POST', '/api/admin/silent-toggle', { pin: '510510', kind: 'reactions', value: 'off' });
    expect(r.status).toBe(200);
    expect(r.body.silent_reactions).toBe(false);

    const upsert = db.query.mock.calls.find((c) =>
      /INSERT INTO app_state/.test(c[0]) && c[1]?.[0] === 'silent_reactions'
    );
    expect(upsert).toBeTruthy();
    expect(upsert[1][1]).toBe('false');
  });

  test('kind=all sets BOTH sub-flags and master off', async () => {
    flagDbMock();
    const r = await http('POST', '/api/admin/silent-toggle', { pin: '510510', kind: 'all', value: 'on' });
    expect(r.status).toBe(200);
    expect(r.body.silent_text).toBe(true);
    expect(r.body.silent_reactions).toBe(true);
    expect(r.body.silent_master).toBe(false);
  });

  test('kind=master (backward compat) flips silent_mode', async () => {
    flagDbMock();
    const r = await http('POST', '/api/admin/silent-toggle', { pin: '510510', kind: 'master', value: 'on' });
    expect(r.status).toBe(200);
    expect(r.body.silent_master).toBe(true);
  });

  test('no kind → default master (backward compat)', async () => {
    flagDbMock();
    const r = await http('POST', '/api/admin/silent-toggle', { pin: '510510', value: 'on' });
    expect(r.status).toBe(200);
    expect(r.body.silent_master).toBe(true);
  });

  test('invalid kind → 400', async () => {
    flagDbMock();
    const r = await http('POST', '/api/admin/silent-toggle', { pin: '510510', kind: 'foo', value: 'on' });
    expect(r.status).toBe(400);
  });
});
