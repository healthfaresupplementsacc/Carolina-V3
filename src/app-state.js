'use strict';
/**
 * app_state — the key/value config store (PostgreSQL table `app_state`).
 *
 * Generic get/set, plus a tiny in-process cache for `app_name`. The app
 * name is read on hot paths (every App Home render, every AI persona
 * build) so it must also be available synchronously without a DB round
 * trip on each call.
 *
 * BLOCO B / B1: app_name is editable via the Carolina config panel and
 * threaded into the App Home header and the Carolina persona. Other
 * BLOCO B commits reuse get()/set() for toggles, schedules and the
 * persona override.
 */
const db = require('./db');

const DEFAULT_APP_NAME = 'HealthFare Production';
const APP_NAME_TTL_MS = 60 * 1000;

let _appNameCache = DEFAULT_APP_NAME;
let _appNameLoadedAt = 0;

/** Generic read. Returns `fallback` when the key is absent or the read fails. */
async function get(key, fallback = null) {
  try {
    const r = await db.query('SELECT value FROM app_state WHERE key = $1', [key]);
    return r.rows[0] ? r.rows[0].value : fallback;
  } catch (_) {
    return fallback;
  }
}

/** Generic upsert. */
async function set(key, value) {
  await db.query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

/**
 * Read app_name from the DB and refresh the synchronous cache. Cheap to
 * call repeatedly — it only hits the DB once per TTL window.
 */
async function getAppName() {
  const now = Date.now();
  if (now - _appNameLoadedAt < APP_NAME_TTL_MS) return _appNameCache;
  const v = await get('app_name', DEFAULT_APP_NAME);
  _appNameCache = (v && String(v).trim()) || DEFAULT_APP_NAME;
  _appNameLoadedAt = now;
  return _appNameCache;
}

/** Last known app_name. Returns the default until the cache is warmed. */
function getAppNameSync() {
  return _appNameCache;
}

/** Persist a new app_name and refresh the cache immediately. */
async function setAppName(value) {
  const v = (value && String(value).trim()) || DEFAULT_APP_NAME;
  await set('app_name', v);
  _appNameCache = v;
  _appNameLoadedAt = Date.now();
  return v;
}

/** Force the next getAppName() to re-read from the DB. */
function invalidateAppNameCache() {
  _appNameLoadedAt = 0;
}

// ===== BLOCO B / C4 — per-message-type on/off toggles =====
// Each of the 7 panel toggles maps to an app_state key. Default ON
// (absent key → enabled) so existing behaviour is preserved until an
// admin explicitly turns something off. Unknown/untagged types are
// treated as enabled — the central client gate must never suppress a
// message it can't classify.
const MSG_TYPE_KEYS = {
  greeting: 'greeting_enabled',
  eod: 'eod_enabled',
  urgency: 'urgency_enabled',
  conflict: 'conflict_enabled',
  task: 'task_enabled',
  bottles: 'bottles_enabled',
  break: 'break_enabled',
};

async function isMsgEnabled(type) {
  const key = MSG_TYPE_KEYS[type];
  if (!key) return true; // unknown/untagged → enabled (safe default)
  const v = await get(key, 'true');
  return String(v) !== 'false';
}

async function getMsgToggles() {
  const out = {};
  for (const [type, key] of Object.entries(MSG_TYPE_KEYS)) {
    const v = await get(key, 'true');
    out[type] = String(v) !== 'false';
  }
  return out;
}

async function setMsgToggle(type, enabled) {
  const key = MSG_TYPE_KEYS[type];
  if (!key) throw new Error('tipo de mensagem inválido: ' + type);
  await set(key, enabled ? 'true' : 'false');
  return !!enabled;
}

module.exports = {
  get, set,
  getAppName, getAppNameSync, setAppName, invalidateAppNameCache,
  DEFAULT_APP_NAME,
  MSG_TYPE_KEYS, isMsgEnabled, getMsgToggles, setMsgToggle,
};
