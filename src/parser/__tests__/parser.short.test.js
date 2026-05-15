'use strict';
/**
 * Short tag messages — "F Limpeza", "S limpeza", etc.
 * B13: messages < 10 chars must not be ignored if they carry a clear tag + content.
 */

const { parseMessage } = require('../index');

function msg(text, opts = {}) {
  return {
    ts: opts.ts || '1700000000.000000',
    user: opts.user || 'U08JC85HMNE',
    text,
    username: opts.username || 'vitor',
  };
}

describe('B13 — short tag messages', () => {
  test('"F Limpeza" → finish (taskType limpeza)', () => {
    const r = parseMessage(msg('F Limpeza'));
    expect(r).toBeTruthy();
    expect(r.type).toBe('finish');
  });

  test('"F: limpeza" → finish (lowercase, colon)', () => {
    const r = parseMessage(msg('F: limpeza'));
    expect(r.type).toBe('finish');
  });

  test('"S limpeza" → start (taskType limpeza)', () => {
    const r = parseMessage(msg('S limpeza'));
    expect(r.type).toBe('start');
    expect(r.taskType).toBe('limpeza');
  });

  test('"f limpeza" → finish (lowercase)', () => {
    const r = parseMessage(msg('f limpeza'));
    expect(r.type).toBe('finish');
  });

  test('"S Berberine" → start (short but valid)', () => {
    const r = parseMessage(msg('S Berberine'));
    expect(r.type).toBe('start');
    expect(r.supplement).toBe('Berberine');
  });

  test('"F NAC" → finish (very short)', () => {
    const r = parseMessage(msg('F NAC'));
    expect(r.type).toBe('finish');
    expect(r.supplement).toBe('NAC');
  });

  test('"ok" → not a tag (no usable content)', () => {
    const r = parseMessage(msg('ok'));
    // "ok" should NOT register as a tag — it has no body, no supplement, no task type.
    expect(['ignore', 'unknown']).toContain(r.type);
  });

  test('"estoque real" → ignore (known noise)', () => {
    const r = parseMessage(msg('estoque real'));
    expect(r.type).toBe('ignore');
  });

  test('"hi" (very short, no content) → not start/finish', () => {
    const r = parseMessage(msg('hi'));
    expect(['ignore', 'unknown']).toContain(r.type);
  });
});
