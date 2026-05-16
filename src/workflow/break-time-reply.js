'use strict';
/**
 * B4 — operator answers Carolina's "que horas vc saiu?" (F6 untracked
 * break). Parse the reply as a time; on garbage, retry politely up to
 * 2 times, then give up (started_at=NULL, '[horário não recuperado]',
 * admin notice).
 *
 * State lives in app_state key `brk_time_<operatorId>` =
 *   { pauseId, oalId, attempts, day }  (JSON)
 */

const db = require('./../db');

function key(operatorId) { return `brk_time_${operatorId}`; }

/**
 * Parse a human time reply → { h, m } or null.
 * Accepts: "14:30" "14h30" "14 30" "1430" "14h" "14" "2:05 pm" "2pm"
 */
function parseTimeReply(text) {
  if (!text) return null;
  const t = String(text).trim().toLowerCase();
  // reject obvious non-answers fast
  if (!/\d/.test(t)) return null;
  const pm = /\bpm\b|\bda tarde\b|\bda noite\b/.test(t);
  const am = /\bam\b|\bda manh[ãa]\b/.test(t);
  let h = null, m = 0;
  let mtc;
  if ((mtc = t.match(/\b(\d{1,2})\s*[:h]\s*(\d{2})\b/))) { h = +mtc[1]; m = +mtc[2]; }
  else if ((mtc = t.match(/\b(\d{1,2})\s+(\d{2})\b/)))    { h = +mtc[1]; m = +mtc[2]; }
  else if ((mtc = t.match(/\b(\d{3,4})\b/))) {
    const n = mtc[1];
    if (n.length === 3) { h = +n.slice(0, 1); m = +n.slice(1); }
    else { h = +n.slice(0, 2); m = +n.slice(2); }
  } else if ((mtc = t.match(/\b(\d{1,2})\s*h?\b/))) { h = +mtc[1]; m = 0; }
  if (h == null || Number.isNaN(h) || Number.isNaN(m)) return null;
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

async function setPending(operatorId, data) {
  await db.query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key(operatorId), JSON.stringify(data)]
  );
}
async function getPending(operatorId) {
  const r = await db.query(`SELECT value FROM app_state WHERE key = $1`, [key(operatorId)]);
  if (!r.rows[0]) return null;
  try { return JSON.parse(r.rows[0].value); } catch { return null; }
}
async function clearPending(operatorId) {
  await db.query(`DELETE FROM app_state WHERE key = $1`, [key(operatorId)]);
}

/**
 * Handle a reply while a break-time question is pending for this
 * operator. Returns one of:
 *   { handled:false }                       — no pending question
 *   { handled:true, outcome:'resolved', when } — time parsed & applied
 *   { handled:true, outcome:'retry', attempts } — ask again
 *   { handled:true, outcome:'gaveup' }      — 2 fails, NULL + admin
 */
async function handleReply(operatorId, text, nowIso = null) {
  const pend = await getPending(operatorId);
  if (!pend) return { handled: false };

  const parsed = parseTimeReply(text);
  if (parsed) {
    // Build a timestamp on the pending day (ET) at h:m.
    const day = pend.day || new Date().toISOString().slice(0, 10);
    const whenLocal = `${day} ${String(parsed.h).padStart(2, '0')}:${String(parsed.m).padStart(2, '0')}:00`;
    if (pend.pauseId) {
      await db.query(
        `UPDATE pauses
         SET started_at = ($1::timestamp AT TIME ZONE 'America/New_York'),
             reason = '[horário recuperado via resposta]'
         WHERE id = $2`,
        [whenLocal, pend.pauseId]
      );
    }
    if (pend.oalId) {
      await db.query(
        `UPDATE operator_activity_log
         SET started_at = ($1::timestamp AT TIME ZONE 'America/New_York'),
             duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM
               (ended_at - ($1::timestamp AT TIME ZONE 'America/New_York')))::int),
             updated_at = NOW()
         WHERE id = $2`,
        [whenLocal, pend.oalId]
      );
    }
    await clearPending(operatorId);
    return { handled: true, outcome: 'resolved', when: whenLocal };
  }

  // Invalid answer.
  const attempts = (pend.attempts || 0) + 1;
  if (attempts >= 2) {
    if (pend.pauseId) {
      await db.query(
        `UPDATE pauses SET started_at = NULL,
           reason = '[horário não recuperado]'
         WHERE id = $1`,
        [pend.pauseId]
      );
    }
    await clearPending(operatorId);
    return { handled: true, outcome: 'gaveup' };
  }
  await setPending(operatorId, { ...pend, attempts });
  return { handled: true, outcome: 'retry', attempts };
}

module.exports = {
  parseTimeReply, handleReply, setPending, getPending, clearPending, key,
};
