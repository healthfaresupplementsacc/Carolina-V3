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
});
