'use strict';
/**
 * Tag detection — accepts S/F/P/N with any separator (: ; / -) and at any position
 * (start or end). Covers B1, B2, B3 from carolina_master_doc Appendix B.
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

describe('B1 — tag at end with hyphen', () => {
  test('"Bruno- Green Tea-0098-S" → start, Green Tea 0098, operator Bruno', () => {
    // Bruno-worker posts from the shared Production Line account, not his owner account.
    const r = parseMessage(msg('Bruno- Green Tea-0098-S', {
      user: 'U0AU8N8FA00',
      username: 'production line',
    }));
    expect(r).toBeTruthy();
    expect(r.type).toBe('start');
    expect(r.supplement).toBe('Green Tea');
    expect(r.batch).toBe('0098');
    expect(r.operator).toBe('Bruno');
  });

  test('"Glutathione 0128 F" → finish, end-position S/F', () => {
    const r = parseMessage(msg('Glutathione 0128 F'));
    expect(r.type).toBe('finish');
    expect(r.supplement).toBe('Glutathione');
    expect(r.batch).toBe('0128');
  });

  test('"Berberine-0119-S" → start at end', () => {
    const r = parseMessage(msg('Berberine-0119-S'));
    expect(r.type).toBe('start');
    expect(r.supplement).toBe('Berberine');
    expect(r.batch).toBe('0119');
  });
});

describe('B2 — semicolon separator', () => {
  test('"S; revisao Glutathione" → start, taskType revisao', () => {
    const r = parseMessage(msg('S; revisao Glutathione'));
    expect(r.type).toBe('start');
    expect(r.supplement).toBe('Glutathione');
    expect(r.taskType).toBe('revisao');
  });

  test('"F; Berberine" → finish', () => {
    const r = parseMessage(msg('F; Berberine'));
    expect(r.type).toBe('finish');
    expect(r.supplement).toBe('Berberine');
  });

  test('"P; Graviola 0124 - 256" → count', () => {
    const r = parseMessage(msg('P; Graviola 0124 - 256'));
    expect(r.type).toBe('count');
    expect(r.supplement).toBe('Graviola');
    expect(r.count).toBe(256);
  });
});

describe('B3 — slash separator', () => {
  test('"F/ Berberine" → finish', () => {
    const r = parseMessage(msg('F/ Berberine'));
    expect(r.type).toBe('finish');
    expect(r.supplement).toBe('Berberine');
  });

  test('"S/ Saw Palmetto 0104" → start', () => {
    const r = parseMessage(msg('S/ Saw Palmetto 0104'));
    expect(r.type).toBe('start');
    expect(r.supplement).toBe('Saw Palmetto');
    expect(r.batch).toBe('0104');
  });
});

describe('separator/position matrix', () => {
  const cases = [
    // [input, expectedType, expectedSupplement]
    ['S: Berberine',     'start',  'Berberine'],
    ['S- Berberine',     'start',  'Berberine'],
    ['S; Berberine',     'start',  'Berberine'],
    ['S/ Berberine',     'start',  'Berberine'],
    ['S Berberine',      'start',  'Berberine'],
    ['s: berberine',     'start',  'Berberine'],
    ['F: Glutathione',   'finish', 'Glutathione'],
    ['F- Glutathione',   'finish', 'Glutathione'],
    ['F; Glutathione',   'finish', 'Glutathione'],
    ['F/ Glutathione',   'finish', 'Glutathione'],
  ];
  test.each(cases)('"%s" → %s + %s', (input, expectedType, expectedSupp) => {
    const r = parseMessage(msg(input));
    expect(r).toBeTruthy();
    expect(r.type).toBe(expectedType);
    expect(r.supplement).toBe(expectedSupp);
  });
});

describe('isolation — does NOT match S/F inside words', () => {
  test('"Saw Palmetto 0104" with no tag returns non-start (unknown or freetext)', () => {
    // No explicit tag; should not be 'start' from a fake "S" detection on "Saw"
    const r = parseMessage(msg('Saw Palmetto 0104'));
    if (r && r.type === 'start') {
      // If it parses as start, must be via freetext heuristic, not tag-letter trick
      expect(r.freetext).toBeTruthy();
    }
  });

  test('"Vamos comecar a Fenugreek" (free-text) is not a tag', () => {
    const r = parseMessage(msg('Vamos comecar a Fenugreek'));
    // Should be detected as freetext start, not as a tag-driven start
    if (r && r.type === 'start') {
      expect(r.freetext).toBeTruthy();
    }
  });
});

describe('operator prefix + tag at end', () => {
  test('"Ana - Green Tea 0098 S" works (operator stripped, tag at end)', () => {
    const r = parseMessage(msg('Ana - Green Tea 0098 S', {
      user: 'U0AU8N8FA00',
      username: 'production line',
    }));
    expect(r).toBeTruthy();
    expect(r.type).toBe('start');
    expect(r.supplement).toBe('Green Tea');
    expect(r.operator).toBe('Ana');
  });
});
