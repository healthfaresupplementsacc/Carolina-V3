/* HEALTHFARE V4 — checagem de duração (Bruno 09-11): marcar como consertado. */
import { getPin } from './from-api.js';

export async function getExpectations() {
  const r = await fetch('/api/v3/duration-check/expectations', { headers: { 'x-admin-pin': getPin() } });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && j.error && j.error.message) || ('erro ' + r.status));
  return j.data;
}

export async function getHistory(slug, productId, limit, exclude) {
  const q = new URLSearchParams({ slug, limit: String(limit || 8) }); if (productId != null) q.set('product_id', String(productId)); if (exclude) q.set('exclude', String(exclude));
  const r = await fetch('/api/v3/duration-check/history?' + q.toString(), { headers: { 'x-admin-pin': getPin() } });
  const j = await r.json().catch(() => null); if (!r.ok) throw new Error((j && j.error && j.error.message) || ('erro ' + r.status)); return j.data;
}
export async function getSettings() {
  const r = await fetch('/api/v3/duration-check/settings', { headers: { 'x-admin-pin': getPin() } });
  const j = await r.json().catch(() => null); if (!r.ok) throw new Error((j && j.error && j.error.message) || ('erro ' + r.status)); return j.data;
}
export async function setSettings(patch) {
  const r = await fetch('/api/v3/duration-check/settings', { method: 'POST', headers: { 'x-admin-pin': getPin(), 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  const j = await r.json().catch(() => null); if (!r.ok) throw new Error((j && j.error && j.error.message) || ('erro ' + r.status)); return j.data;
}

export async function fixDurationFlag(eventId, note) {
  let r;
  try { r = await fetch('/api/v3/duration-check/event/' + eventId + '/fix', { method: 'POST', headers: { 'x-admin-pin': getPin(), 'content-type': 'application/json' }, body: JSON.stringify({ note: note || null }) }); }
  catch (e) { return { ok: false, error: new Error('sem conexão com a API') }; }
  const j = await r.json().catch(() => null);
  if (!r.ok) return { ok: false, error: new Error((j && j.error && j.error.message) || ('erro ' + r.status)) };
  return { ok: true, data: j.data };
}
