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

// ===== BLOCO B / C7 — editable persona (IDENTITY / PERSONALITY) =====
// Only the IDENTITY and PERSONALITY blocks are admin-editable. The
// PROD_RULES / ADMIN_RULES guardrails live in code and are ALWAYS
// appended by persona.buildPersona — they can never be removed here, so
// Carolina can never be made to admit she's an AI on the floor.
// Synchronous cache (persona is built on every AI call, hot path).
let _personaCache = { identity: null, personality: null };
let _personaLoadedAt = 0;
const PERSONA_TTL_MS = 60 * 1000;

async function getPersonaOverrides() {
  const now = Date.now();
  if (now - _personaLoadedAt < PERSONA_TTL_MS) return _personaCache;
  const identity = await get('persona_identity', null);
  const personality = await get('persona_personality', null);
  _personaCache = {
    identity: (identity && String(identity).trim()) ? String(identity) : null,
    personality: (personality && String(personality).trim()) ? String(personality) : null,
  };
  _personaLoadedAt = now;
  return _personaCache;
}
function getPersonaSync() { return _personaCache; }
async function setPersonaField(field, value) {
  if (field !== 'identity' && field !== 'personality') {
    throw new Error('campo de persona inválido: ' + field);
  }
  const key = field === 'identity' ? 'persona_identity' : 'persona_personality';
  const v = String(value == null ? '' : value).trim();
  if (!v) {
    await db.query('DELETE FROM app_state WHERE key = $1', [key]); // revert to code default
    _personaCache = { ..._personaCache, [field]: null };
  } else {
    await set(key, v);
    _personaCache = { ..._personaCache, [field]: v };
  }
  _personaLoadedAt = Date.now();
  return _personaCache[field];
}
function invalidatePersonaCache() { _personaLoadedAt = 0; }

// ===== BLOCO B / C6 — schedules & windows =====
// Defaults preserve the pre-C6 behaviour: greeting 08:00 ET, EOD 19:00
// ET (current config.eod.hourEdt), pending window 20 min, every weekday.
const SCHEDULE_DEFAULTS = {
  greeting_time: '08:00',
  eod_time: '19:00',
  pending_window_minutes: 20,
  active_weekdays: [0, 1, 2, 3, 4, 5, 6], // 0=Sun .. 6=Sat (JS getDay)
};

function _validTime(s) {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s || '').trim());
}

/** "HH:MM" → cron "M H * * *". Falls back to the given default on junk. */
function timeToCron(hhmm, fallback = '08:00') {
  const t = _validTime(hhmm) ? String(hhmm).trim() : fallback;
  const [h, m] = t.split(':');
  return `${parseInt(m, 10)} ${parseInt(h, 10)} * * *`;
}

async function getGreetingTime() {
  const v = await get('greeting_time', SCHEDULE_DEFAULTS.greeting_time);
  return _validTime(v) ? String(v).trim() : SCHEDULE_DEFAULTS.greeting_time;
}
async function getEodTime() {
  const v = await get('eod_time', SCHEDULE_DEFAULTS.eod_time);
  return _validTime(v) ? String(v).trim() : SCHEDULE_DEFAULTS.eod_time;
}
async function getPendingWindowMinutes() {
  const n = parseInt(await get('pending_window_minutes', SCHEDULE_DEFAULTS.pending_window_minutes), 10);
  if (!Number.isFinite(n)) return SCHEDULE_DEFAULTS.pending_window_minutes;
  return Math.min(240, Math.max(1, n));
}
async function getActiveWeekdays() {
  const raw = await get('active_weekdays', null);
  if (!raw) return SCHEDULE_DEFAULTS.active_weekdays.slice();
  const arr = String(raw).split(',')
    .map((x) => parseInt(x, 10))
    .filter((x) => Number.isInteger(x) && x >= 0 && x <= 6);
  return arr.length ? arr : SCHEDULE_DEFAULTS.active_weekdays.slice();
}
/** Is today (in ET) an active weekday? Used by greeting/EOD jobs. */
async function isActiveToday(tz = 'America/New_York') {
  const days = await getActiveWeekdays();
  const wd = new Date(new Date().toLocaleString('en-US', { timeZone: tz })).getDay();
  return days.includes(wd);
}
async function getSchedule() {
  return {
    greeting_time: await getGreetingTime(),
    eod_time: await getEodTime(),
    pending_window_minutes: await getPendingWindowMinutes(),
    active_weekdays: await getActiveWeekdays(),
  };
}

// ===== BUG AMPM — clock display format (12h AM/PM default | 24h) =====
// Florida admins use AM/PM; 24h confused them. DB stays UTC; this only
// flips DISPLAY. Read on hot paths (every Carolina context, every
// dashboard payload) so it gets the same sync-cache treatment as
// app_name/persona.
const TIME_FORMAT_DEFAULT = '12h';
let _timeFmtCache = TIME_FORMAT_DEFAULT;
let _timeFmtLoadedAt = 0;
const TIME_FORMAT_TTL_MS = 60 * 1000;

function _normTimeFormat(v) {
  return String(v) === '24h' ? '24h' : '12h';
}
async function getTimeFormat() {
  const now = Date.now();
  if (now - _timeFmtLoadedAt < TIME_FORMAT_TTL_MS) return _timeFmtCache;
  _timeFmtCache = _normTimeFormat(await get('time_format', TIME_FORMAT_DEFAULT));
  _timeFmtLoadedAt = now;
  return _timeFmtCache;
}
function getTimeFormatSync() { return _timeFmtCache; }
async function setTimeFormat(value) {
  const v = _normTimeFormat(value);
  await set('time_format', v);
  _timeFmtCache = v;
  _timeFmtLoadedAt = Date.now();
  return v;
}
function invalidateTimeFormatCache() { _timeFmtLoadedAt = 0; }

module.exports = {
  get, set,
  getAppName, getAppNameSync, setAppName, invalidateAppNameCache,
  DEFAULT_APP_NAME,
  MSG_TYPE_KEYS, isMsgEnabled, getMsgToggles, setMsgToggle,
  SCHEDULE_DEFAULTS, timeToCron,
  getGreetingTime, getEodTime, getPendingWindowMinutes,
  getActiveWeekdays, isActiveToday, getSchedule,
  getPersonaOverrides, getPersonaSync, setPersonaField, invalidatePersonaCache,
  TIME_FORMAT_DEFAULT, getTimeFormat, getTimeFormatSync, setTimeFormat,
  invalidateTimeFormatCache,
};
