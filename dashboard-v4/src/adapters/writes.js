/* HEALTHFARE V4 — write helpers (E5).
   Wraps apiPatch/Post/Delete pra:
     - Converter shape do V4 (op='p<id>', activity=slug, product='b<id>',
       started_min minutos) → shape do backend (person_id, activity_type_id,
       product_batch_id, started_at ISO).
     - Centralizar handling de erro (return { ok, data, error }).
     - Auditado via PIN (x-admin-pin); todo write grava em v3.audit_log
       no servidor (actor='admin').
   Read-mostly path (snapshot/poll) continua igual via from-api.js.
*/
import { apiPatch, apiPost, apiDelete } from './from-api.js';
import nyTime from '../utils/ny-time.cjs';

/* Resolve referências do shape V4 pro shape backend. */
function resolveRefs(ev, hfdata, date) {
  const op = (hfdata.operators || []).find((o) => o.id === ev.op);
  const act = ev.activity ? (hfdata.activities || {})[ev.activity] : null;
  const prod = ev.product ? (hfdata.products || {})[ev.product] : null;
  return {
    person_id: op ? op._person_id : null,
    activity_type_id: act ? act._id : null,
    product_batch_id: prod ? prod._batch_id : null,
    cowork_with: (ev.cowork || []).map((opId) => {
      const o = (hfdata.operators || []).find((x) => x.id === opId);
      return o ? o._person_id : null;
    }).filter((x) => x != null),
    started_at: nyTime.minutesToNyIso(date, ev.started_min),
    ended_at: ev.ended_min == null ? null : nyTime.minutesToNyIso(date, ev.ended_min),
  };
}

function wrap(promise) {
  return promise.then(
    (j) => ({ ok: true, data: j.data }),
    (e) => ({ ok: false, error: e }),
  );
}

/* ── EVENTS ─────────────────────────────────────────────── */

export function patchEvent(id, changes, note, byPersonId) {
  return wrap(apiPatch('/events/' + id, { changes, by_person_id: byPersonId || null, note: note || null }));
}

export function createEvent(payload) {
  return wrap(apiPost('/events', payload));
}

export function deleteEvent(id, reason, byPersonId) {
  return wrap(apiDelete('/events/' + id, { reason: reason || null, by_person_id: byPersonId || null }));
}

export function restoreEvent(id, byPersonId) {
  return wrap(apiPost('/events/' + id + '/restore', { by_person_id: byPersonId || null }));
}

export function mergeEvents(eventIds, byPersonId) {
  return wrap(apiPost('/events/merge', { event_ids: eventIds, by_person_id: byPersonId || null }));
}

export function splitEvent(id, splitAtIso, byPersonId) {
  return wrap(apiPost('/events/' + id + '/split', { split_at: splitAtIso, by_person_id: byPersonId || null }));
}

/* High-level: PATCH evento a partir de objeto V4 + hfdata + date. */
export async function patchEventFromV4(event, originalEvent, hfdata, date, note) {
  // Constrói só os campos QUE MUDARAM
  const cur = resolveRefs(event, hfdata, date);
  const orig = resolveRefs(originalEvent, hfdata, date);
  const changes = {};
  for (const k of ['person_id', 'activity_type_id', 'product_batch_id', 'started_at', 'ended_at']) {
    if (cur[k] !== orig[k]) changes[k] = cur[k];
  }
  if (JSON.stringify(cur.cowork_with.slice().sort()) !== JSON.stringify(orig.cowork_with.slice().sort())) {
    changes.cowork_with = cur.cowork_with;
  }
  if ((event.description || '') !== (originalEvent.description || '')) changes.description = event.description;
  if ((event.qty || null) !== (originalEvent.qty || null)) changes.quantity = event.qty;
  if ((event.unit || null) !== (originalEvent.unit || null)) changes.quantity_unit = event.unit;
  if ((event.confidence || 'high') !== (originalEvent.confidence || 'high')) changes.confidence = event.confidence;
  if (Object.keys(changes).length === 0) {
    return { ok: true, data: { _noop: true } };
  }
  return patchEvent(event.id, changes, note);
}

/* High-level: cria evento a partir de objeto V4. */
export async function createEventFromV4(event, hfdata, date) {
  const refs = resolveRefs(event, hfdata, date);
  if (!refs.person_id) return { ok: false, error: new Error('pessoa obrigatória') };
  if (!refs.started_at) return { ok: false, error: new Error('horário de início obrigatório') };
  return createEvent({
    person_id: refs.person_id,
    activity_type_id: refs.activity_type_id,
    product_batch_id: refs.product_batch_id,
    started_at: refs.started_at,
    ended_at: refs.ended_at,
    cowork_with: refs.cowork_with,
    description: event.description || null,
    confidence: event.confidence || 'high',
    quantity: event.qty != null ? event.qty : null,
    quantity_unit: event.unit || null,
  });
}

/* Cria event retroativo num GAP (E5 #4: justificar gap = criar tarefa). */
export async function createEventInGap(gap, opId, hfdata, date, opts = {}) {
  const op = (hfdata.operators || []).find((o) => o.id === opId);
  if (!op) return { ok: false, error: new Error('operador inválido') };
  // Mapeia categoria de justificativa pro slug do catálogo
  const slugByReason = {
    almoco: 'lunch',
    pausa: 'break',
    limpeza: 'cleaning',
    transicao: 'organization',
    outro: null,
  };
  const slug = slugByReason[opts.reasonCat || 'outro'];
  const act = slug ? (hfdata.activities || {})[slug] : null;
  return createEvent({
    person_id: op._person_id,
    activity_type_id: act ? act._id : null,
    started_at: nyTime.minutesToNyIso(date, gap.start),
    ended_at: nyTime.minutesToNyIso(date, gap.end),
    description: opts.note || `Gap preenchido (${opts.reasonCat || 'outro'}): ${opts.note || '(sem nota)'}`,
    confidence: 'high',
    cowork_with: [],
  });
}

/* ── GOALS ──────────────────────────────────────────────── */
export function createGoal(payload) { return wrap(apiPost('/goals', payload)); }
export function patchGoal(id, changes, byPersonId, note) {
  return wrap(apiPatch('/goals/' + id, { changes, by_person_id: byPersonId || null, note: note || null }));
}
export function deleteGoal(id, reason, byPersonId) {
  return wrap(apiDelete('/goals/' + id, { reason: reason || null, by_person_id: byPersonId || null }));
}

/* ── COUNTS ─────────────────────────────────────────────── */
export function patchCount(id, newBottles, byPersonId, note) {
  return wrap(apiPatch('/counts/' + id, { new_bottles: newBottles, by_person_id: byPersonId || null, note: note || null }));
}
export function deleteCount(id, reason, byPersonId) {
  return wrap(apiDelete('/counts/' + id, { reason: reason || null, by_person_id: byPersonId || null }));
}
export function confirmCount(id, decision, byPersonId) {
  return wrap(apiPost('/counts/' + id + '/confirm', { decision, by_person_id: byPersonId || null }));
}

/* ── DEADLINES ──────────────────────────────────────────── */
export function createDeadline(payload) { return wrap(apiPost('/deadlines', payload)); }
export function patchDeadline(id, changes) { return wrap(apiPatch('/deadlines/' + id, { changes })); }
export function deleteDeadline(id) { return wrap(apiDelete('/deadlines/' + id, {})); }
