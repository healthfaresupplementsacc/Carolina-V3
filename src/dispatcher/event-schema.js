'use strict';
/**
 * FASE 1 — EventoCanônico.
 *
 * The single normalized shape every source (channel parser, App Home
 * wizards, Carolina tools) converts its input into BEFORE touching the
 * data model. The canonical dispatcher (canonical-dispatcher.js) is the
 * only writer; it consumes EventoCanônico and upserts ISA-88 idempotently
 * by `source_id`.
 *
 * Design rules (doc 10.7):
 *   1. 1 evento → 1 source_id → 1 row (upsert idempotente).
 *   2. operator_id === null means AMBIGUOUS — the dispatcher persists what
 *      it can and Carolina asks in the admin chat. NEVER guessed.
 *   3. A non-classifiable message is NEVER discarded → type 'note'.
 *
 * Shape (doc spec 1.1):
 *   {
 *     source_id, source_type, type, operator_id,
 *     workflow_template, phase_template, supplement, batch, ad_hoc_task,
 *     target_phase_id, timestamp, raw_text, metadata
 *   }
 */

const SOURCE_TYPES = Object.freeze(['parser', 'app_home', 'carolina_tool']);

const EVENT_TYPES = Object.freeze([
  'start',
  'finish',
  'count',
  'note',
  'break_start',
  'break_end',
  'helping_start',
  'helping_end',
  'ad_hoc_start',
  'ad_hoc_finish',
]);

// Types that mutate a workflow/phase the dispatcher must locate (vs. open).
const FINISH_LIKE = Object.freeze(['finish', 'ad_hoc_finish', 'break_end', 'helping_end']);
const START_LIKE = Object.freeze(['start', 'ad_hoc_start', 'break_start', 'helping_start']);

/**
 * Build a fully-formed EventoCanônico. Missing optional fields default to
 * null / {} so the dispatcher never has to defensively probe for keys.
 *
 * `source_id` and `type` are required and validated. `timestamp` defaults
 * to now (ISO). `raw_text` defaults to ''.
 */
function makeEvent(input = {}) {
  const ev = {
    source_id: input.source_id != null ? String(input.source_id) : null,
    source_type: input.source_type || null,
    type: input.type || null,
    operator_id:
      input.operator_id === null || input.operator_id === undefined
        ? null
        : Number(input.operator_id),
    workflow_template: input.workflow_template || null,
    phase_template: input.phase_template || null,
    supplement: input.supplement || null,
    batch: input.batch || null,
    ad_hoc_task: input.ad_hoc_task || null,
    target_phase_id:
      input.target_phase_id === null || input.target_phase_id === undefined
        ? null
        : Number(input.target_phase_id),
    timestamp: input.timestamp || new Date().toISOString(),
    raw_text: input.raw_text == null ? '' : String(input.raw_text),
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
  };
  return ev;
}

/**
 * Validate an EventoCanônico. Returns { ok: true } or
 * { ok: false, errors: [...] }. Never throws.
 *
 * operator_id === null is VALID (ambiguous → admin chat). It is the
 * caller/dispatcher's job to route the disambiguation, not a schema error.
 */
function validateEvent(ev) {
  const errors = [];
  if (!ev || typeof ev !== 'object') {
    return { ok: false, errors: ['event is not an object'] };
  }
  if (!ev.source_id || typeof ev.source_id !== 'string' || !ev.source_id.trim()) {
    errors.push('source_id required (slack_ts | wizard_event_id | tool_call_id)');
  }
  if (!SOURCE_TYPES.includes(ev.source_type)) {
    errors.push(`source_type must be one of ${SOURCE_TYPES.join('|')}`);
  }
  if (!EVENT_TYPES.includes(ev.type)) {
    errors.push(`type must be one of ${EVENT_TYPES.join('|')}`);
  }
  if (
    ev.operator_id !== null &&
    !(Number.isFinite(ev.operator_id) && ev.operator_id > 0)
  ) {
    errors.push('operator_id must be a positive number or null (ambiguous)');
  }
  if (
    ev.target_phase_id !== null &&
    !(Number.isFinite(ev.target_phase_id) && ev.target_phase_id > 0)
  ) {
    errors.push('target_phase_id must be a positive number or null');
  }
  if (typeof ev.timestamp !== 'string' || Number.isNaN(Date.parse(ev.timestamp))) {
    errors.push('timestamp must be an ISO date string');
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

function isFinishLike(type) {
  return FINISH_LIKE.includes(type);
}
function isStartLike(type) {
  return START_LIKE.includes(type);
}

module.exports = {
  SOURCE_TYPES,
  EVENT_TYPES,
  FINISH_LIKE,
  START_LIKE,
  makeEvent,
  validateEvent,
  isFinishLike,
  isStartLike,
};
