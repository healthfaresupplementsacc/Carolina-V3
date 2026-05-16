'use strict';
/**
 * BLOCO B / C4 — central per-type toggle gate in the slack client.
 *
 * postMessage/postToChannel take an optional msgType. When that type is
 * disabled in app_state, the call is suppressed and logged to silent_log
 * with kind='toggle:<type>' — exactly like silent_text. Untagged calls
 * are never gated; the admin channel is never silenced.
 */
process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';

const mockChatPostMessage = jest.fn();

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: mockChatPostMessage },
    reactions: { add: jest.fn() },
    files: { uploadV2: jest.fn() },
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

// kv-backed db: silent flags all OFF; per-type keys from `kv`.
function wire(kv = {}) {
  db.query = jest.fn().mockImplementation((sql, params) => {
    if (/SELECT key, value FROM app_state WHERE key IN/.test(sql)) {
      return Promise.resolve({ rows: [
        { key: 'silent_mode', value: 'false' },
        { key: 'silent_text', value: 'false' },
        { key: 'silent_reactions', value: 'false' },
      ] });
    }
    if (/SELECT value FROM app_state WHERE key = \$1/.test(sql)) {
      const v = kv[params[0]];
      return Promise.resolve({ rows: v == null ? [] : [{ value: v }] });
    }
    return Promise.resolve({ rows: [] }); // INSERT INTO silent_log etc.
  });
}

beforeEach(() => {
  mockChatPostMessage.mockReset();
  mockChatPostMessage.mockResolvedValue({ ts: '1700000000.000001' });
  slackClient.invalidateSilentCache();
});

describe('postMessage per-type gate', () => {
  test('suppressed when the type is disabled; logged kind=toggle:<type>', async () => {
    wire({ greeting_enabled: 'false' });
    const ts = await slackClient.postMessage('bom dia', null, 'greeting');
    expect(mockChatPostMessage).not.toHaveBeenCalled();
    expect(ts).toMatch(/^toggled-/);
    const logCall = db.query.mock.calls.find((c) => /INSERT INTO silent_log/.test(c[0]));
    expect(logCall).toBeTruthy();
    expect(logCall[1][1]).toBe('postMessage');
    expect(logCall[1][4]).toBe('toggle:greeting');
  });

  test('goes through when the type is enabled (default ON)', async () => {
    wire({});
    await slackClient.postMessage('bom dia', null, 'greeting');
    expect(mockChatPostMessage).toHaveBeenCalledTimes(1);
  });

  test('untagged call (no msgType) is never gated', async () => {
    wire({ greeting_enabled: 'false' });
    await slackClient.postMessage('mensagem qualquer');
    expect(mockChatPostMessage).toHaveBeenCalledTimes(1);
  });

  test('a disabled type does not affect a different enabled type', async () => {
    wire({ eod_enabled: 'false' });
    await slackClient.postMessage('check-in', null, 'urgency');
    expect(mockChatPostMessage).toHaveBeenCalledTimes(1);
  });
});

describe('postToChannel per-type gate', () => {
  test('admin/manager channel always goes through even when type disabled', async () => {
    wire({ break_enabled: 'false' });
    await slackClient.postToChannel(config.slack.managerChannelId, 'alerta', 'break');
    expect(mockChatPostMessage).toHaveBeenCalledTimes(1);
  });

  test('non-admin channel is suppressed when the type is disabled', async () => {
    wire({ break_enabled: 'false' });
    const ts = await slackClient.postToChannel('C09UNBXFRKK', 'voltei?', 'break');
    expect(mockChatPostMessage).not.toHaveBeenCalled();
    expect(ts).toMatch(/^toggled-/);
  });
});
