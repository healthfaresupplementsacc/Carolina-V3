'use strict';
/**
 * BLOCO B / C3 — morning greeting job.
 *
 * runGreeting() reads its on/off flag, optional override text and the
 * per-day dedup marker from app_state, then posts via slack client
 * (which self-suppresses to silent_log when silent_text=ON).
 */
jest.mock('../db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  pool: { end: jest.fn() },
}));
jest.mock('../slack/client', () => ({
  postMessage: jest.fn().mockResolvedValue('ts1'),
  postToChannel: jest.fn(), postImage: jest.fn(),
  fetchMessages: jest.fn(), fetchRecentMessages: jest.fn(),
}));
jest.mock('../slack/poller', () => ({ poll: jest.fn(), backfill: jest.fn(), isBackfillDone: jest.fn() }));
jest.mock('../urgency', () => ({ checkUrgency: jest.fn() }));
jest.mock('../slack/dm-handler', () => ({ pollBossDMs: jest.fn(), pollManagerChannel: jest.fn() }));
jest.mock('node-cron', () => ({ schedule: jest.fn() }));

const db = require('../db');
const slackClient = require('../slack/client');
const sched = require('../scheduler');

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// app_state-backed store. get → SELECT value WHERE key; set → upsert.
function wireStore(state) {
  db.query = jest.fn().mockImplementation((sql, params) => {
    if (/SELECT value FROM app_state WHERE key = \$1/.test(sql)) {
      const v = state[params[0]];
      return Promise.resolve({ rows: v == null ? [] : [{ value: v }] });
    }
    if (/INSERT INTO app_state/.test(sql)) {
      state[params[0]] = params[1];
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => { jest.clearAllMocks(); });

describe('C3 — runGreeting', () => {
  test('posts a greeting and records the per-day marker when enabled', async () => {
    const state = {};
    wireStore(state);
    await sched.runGreeting();
    expect(slackClient.postMessage).toHaveBeenCalledTimes(1);
    expect(typeof slackClient.postMessage.mock.calls[0][0]).toBe('string');
    expect(slackClient.postMessage.mock.calls[0][0].length).toBeGreaterThan(0);
    expect(state.greeting_last_run).toBe(TODAY);
  });

  test('skips when greeting_enabled=false', async () => {
    wireStore({ greeting_enabled: 'false' });
    await sched.runGreeting();
    expect(slackClient.postMessage).not.toHaveBeenCalled();
  });

  test('skips when already sent today (dedup)', async () => {
    wireStore({ greeting_last_run: TODAY });
    await sched.runGreeting();
    expect(slackClient.postMessage).not.toHaveBeenCalled();
  });

  test('uses the override text verbatim when greeting_text is set', async () => {
    const state = { greeting_text: '  Bom dia equipe HealthFare!  ' };
    wireStore(state);
    await sched.runGreeting();
    expect(slackClient.postMessage).toHaveBeenCalledWith('Bom dia equipe HealthFare!', null, 'greeting');
    expect(state.greeting_last_run).toBe(TODAY);
  });

  test('a slack failure does not throw', async () => {
    wireStore({});
    slackClient.postMessage.mockRejectedValueOnce(new Error('slack down'));
    await expect(sched.runGreeting()).resolves.toBeUndefined();
  });

  test('C6 — skips on an inactive weekday', async () => {
    const wd = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
    wireStore({ active_weekdays: String((wd + 1) % 7) }); // today not included
    await sched.runGreeting();
    expect(slackClient.postMessage).not.toHaveBeenCalled();
  });

  test('C6 — startGreetingJob schedules from app_state greeting_time (default 08:00 ET)', async () => {
    const cron = require('node-cron');
    wireStore({});
    await sched.startGreetingJob();
    expect(cron.schedule).toHaveBeenCalledWith(
      '0 8 * * *', expect.any(Function), { timezone: 'America/New_York' });
  });

  test('C6 — startGreetingJob honours a configured time', async () => {
    const cron = require('node-cron');
    wireStore({ greeting_time: '06:45' });
    await sched.startGreetingJob();
    expect(cron.schedule).toHaveBeenCalledWith(
      '45 6 * * *', expect.any(Function), { timezone: 'America/New_York' });
  });

  test('C6 — rescheduleJobs re-creates greeting + EOD crons', async () => {
    const cron = require('node-cron');
    cron.schedule.mockClear();
    wireStore({ greeting_time: '07:00', eod_time: '18:30' });
    await sched.rescheduleJobs();
    const exprs = cron.schedule.mock.calls.map((c) => c[0]);
    expect(exprs).toContain('0 7 * * *');   // greeting
    expect(exprs).toContain('30 18 * * *'); // eod
  });
});
