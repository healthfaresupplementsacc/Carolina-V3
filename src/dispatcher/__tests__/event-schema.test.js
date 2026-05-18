'use strict';
const {
  makeEvent,
  validateEvent,
  isFinishLike,
  isStartLike,
  EVENT_TYPES,
  SOURCE_TYPES,
} = require('../event-schema');

describe('EventoCanônico — makeEvent', () => {
  test('fills defaults: timestamp ISO, metadata {}, raw_text ""', () => {
    const ev = makeEvent({ source_id: 'x', source_type: 'parser', type: 'note' });
    expect(ev.metadata).toEqual({});
    expect(ev.raw_text).toBe('');
    expect(Number.isNaN(Date.parse(ev.timestamp))).toBe(false);
    expect(ev.supplement).toBeNull();
    expect(ev.target_phase_id).toBeNull();
  });

  test('operator_id null/undefined → null; number coerced', () => {
    expect(makeEvent({}).operator_id).toBeNull();
    expect(makeEvent({ operator_id: null }).operator_id).toBeNull();
    expect(makeEvent({ operator_id: '7' }).operator_id).toBe(7);
  });

  test('source_id stringified; raw_text stringified', () => {
    const ev = makeEvent({ source_id: 1779112687.0009, raw_text: 123 });
    expect(typeof ev.source_id).toBe('string');
    expect(typeof ev.raw_text).toBe('string');
  });
});

describe('EventoCanônico — validateEvent', () => {
  const base = {
    source_id: '1779112687.0009',
    source_type: 'parser',
    type: 'start',
    timestamp: new Date().toISOString(),
  };

  test('valid event with resolved operator → ok', () => {
    expect(validateEvent(makeEvent({ ...base, operator_id: 3 })).ok).toBe(true);
  });

  test('operator_id === null is VALID (ambiguous, not a schema error)', () => {
    const r = validateEvent(makeEvent({ ...base, operator_id: null }));
    expect(r.ok).toBe(true);
  });

  test('missing source_id → error', () => {
    const r = validateEvent(makeEvent({ ...base, source_id: undefined }));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/source_id/);
  });

  test('unknown type → error', () => {
    const r = validateEvent(makeEvent({ ...base, type: 'frobnicate' }));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/type/);
  });

  test('unknown source_type → error', () => {
    const r = validateEvent(makeEvent({ ...base, source_type: 'telepathy' }));
    expect(r.ok).toBe(false);
  });

  test('operator_id 0 / negative → error', () => {
    expect(validateEvent(makeEvent({ ...base, operator_id: 0 })).ok).toBe(false);
    expect(validateEvent(makeEvent({ ...base, operator_id: -3 })).ok).toBe(false);
  });

  test('non-ISO timestamp → error', () => {
    const ev = makeEvent({ ...base });
    ev.timestamp = 'yesterday';
    expect(validateEvent(ev).ok).toBe(false);
  });
});

describe('type predicates', () => {
  test('isFinishLike', () => {
    expect(isFinishLike('finish')).toBe(true);
    expect(isFinishLike('break_end')).toBe(true);
    expect(isFinishLike('start')).toBe(false);
  });
  test('isStartLike', () => {
    expect(isStartLike('start')).toBe(true);
    expect(isStartLike('helping_start')).toBe(true);
    expect(isStartLike('finish')).toBe(false);
  });
  test('enums frozen + complete', () => {
    expect(EVENT_TYPES).toContain('ad_hoc_finish');
    expect(SOURCE_TYPES).toEqual(['parser', 'app_home', 'carolina_tool']);
    expect(Object.isFrozen(EVENT_TYPES)).toBe(true);
  });
});
