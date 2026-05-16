'use strict';
// B1 — app_state helper: generic get/set + cached app_name.
jest.mock('../db');

describe('app-state', () => {
  let db, appState;
  beforeEach(() => {
    jest.resetModules();
    jest.mock('../db');
    db = require('../db');
    appState = require('../app-state');
  });

  test('getAppNameSync returns the default before the cache is warmed', () => {
    expect(appState.getAppNameSync()).toBe('HealthFare Production');
  });

  test('getAppName reads from app_state and refreshes the sync cache', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ value: 'Acme Labs' }] });
    const v = await appState.getAppName();
    expect(v).toBe('Acme Labs');
    expect(appState.getAppNameSync()).toBe('Acme Labs');
    expect(db.query).toHaveBeenCalledWith(
      'SELECT value FROM app_state WHERE key = $1', ['app_name']);
  });

  test('getAppName falls back to default when the key is absent', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    expect(await appState.getAppName()).toBe('HealthFare Production');
  });

  test('getAppName falls back to default when the DB throws', async () => {
    db.query = jest.fn().mockRejectedValue(new Error('db down'));
    expect(await appState.getAppName()).toBe('HealthFare Production');
  });

  test('getAppName caches within the TTL (one DB read for repeat calls)', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ value: 'Cached Co' }] });
    await appState.getAppName();
    await appState.getAppName();
    expect(db.query).toHaveBeenCalledTimes(1);
    appState.invalidateAppNameCache();
    await appState.getAppName();
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  test('setAppName upserts and refreshes the cache immediately', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const v = await appState.setAppName('  New Name  ');
    expect(v).toBe('New Name');
    expect(appState.getAppNameSync()).toBe('New Name');
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/INSERT INTO app_state/);
    expect(sql).toMatch(/ON CONFLICT \(key\) DO UPDATE/);
    expect(db.query.mock.calls[0][1]).toEqual(['app_name', 'New Name']);
  });

  test('setAppName blank value resets to default', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    expect(await appState.setAppName('   ')).toBe('HealthFare Production');
  });

  test('generic get/set round-trip', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ value: 'true' }] });
    expect(await appState.get('some_key', 'fb')).toBe('true');
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    expect(await appState.get('missing', 'fb')).toBe('fb');
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await appState.set('k', 'v');
    expect(db.query.mock.calls[0][1]).toEqual(['k', 'v']);
  });

  // ---- C4 message-type toggles ----
  function kvDb(kv) {
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/SELECT value FROM app_state WHERE key = \$1/.test(sql)) {
        const v = kv[params[0]];
        return Promise.resolve({ rows: v == null ? [] : [{ value: v }] });
      }
      if (/INSERT INTO app_state/.test(sql)) { kv[params[0]] = params[1]; return Promise.resolve({ rows: [] }); }
      return Promise.resolve({ rows: [] });
    });
  }

  test('isMsgEnabled defaults ON and reflects a false key', async () => {
    const kv = {}; kvDb(kv);
    expect(await appState.isMsgEnabled('greeting')).toBe(true);
    kv.eod_enabled = 'false';
    expect(await appState.isMsgEnabled('eod')).toBe(false);
  });

  test('isMsgEnabled returns true for unknown/untagged type (safe default)', async () => {
    kvDb({});
    expect(await appState.isMsgEnabled('something-untagged')).toBe(true);
    expect(await appState.isMsgEnabled(null)).toBe(true);
  });

  test('getMsgToggles returns all 7 with defaults', async () => {
    const kv = { urgency_enabled: 'false' }; kvDb(kv);
    const t = await appState.getMsgToggles();
    expect(Object.keys(t).sort()).toEqual(
      ['bottles','break','conflict','eod','greeting','task','urgency']);
    expect(t.urgency).toBe(false);
    expect(t.greeting).toBe(true);
  });

  test('setMsgToggle writes true/false and rejects bad type', async () => {
    const kv = {}; kvDb(kv);
    await appState.setMsgToggle('break', false);
    expect(kv.break_enabled).toBe('false');
    await appState.setMsgToggle('break', true);
    expect(kv.break_enabled).toBe('true');
    await expect(appState.setMsgToggle('nope', true)).rejects.toThrow(/inválido/);
  });
});
