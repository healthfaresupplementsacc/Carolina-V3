/* HEALTHFARE V4 — jornada do lote (Bruno 09-10) — cliente de /api/v3/journey/*.
   Só leitura. Envelope { data } / { error:{code,message} }. */
import { getPin } from './from-api.js';

export async function getBatchJourney(batchId) {
  let r;
  try { r = await fetch('/api/v3/journey/batch/' + encodeURIComponent(batchId), { headers: { 'x-admin-pin': getPin() } }); }
  catch (e) { throw new Error('sem conexão com a API'); }
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  if (!r.ok) { const err = new Error((j && j.error && j.error.message) || ('erro ' + r.status)); err.code = j && j.error && j.error.code; throw err; }
  return j.data;
}

/* REGISTRO de uma Impressão de Labels (Bruno 09-12): cada impressão + resumo. */
export async function getLabelRecord(eventId) {
  let r;
  try { r = await fetch('/api/v3/journey/label-event/' + encodeURIComponent(eventId), { headers: { 'x-admin-pin': getPin() } }); }
  catch (e) { throw new Error('sem conexão com a API'); }
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  if (!r.ok) { const err = new Error((j && j.error && j.error.message) || ('erro ' + r.status)); err.code = j && j.error && j.error.code; throw err; }
  return j.data;
}
