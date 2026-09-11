/* HEALTHFARE V4 — checagem de duração (Bruno 09-11): marcar como consertado. */
import { getPin } from './from-api.js';

export async function fixDurationFlag(eventId, note) {
  let r;
  try { r = await fetch('/api/v3/duration-check/event/' + eventId + '/fix', { method: 'POST', headers: { 'x-admin-pin': getPin(), 'content-type': 'application/json' }, body: JSON.stringify({ note: note || null }) }); }
  catch (e) { return { ok: false, error: new Error('sem conexão com a API') }; }
  const j = await r.json().catch(() => null);
  if (!r.ok) return { ok: false, error: new Error((j && j.error && j.error.message) || ('erro ' + r.status)) };
  return { ok: true, data: j.data };
}
