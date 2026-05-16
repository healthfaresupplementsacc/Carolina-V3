'use strict';
// BUG LIVE-DURATION — "Simone em break há 1h03m" was frozen until a
// refresh. A generic [data-started-at] ticker now counts ongoing
// entries up with no fetch; removed DOM nodes drop out automatically.
const { generateDashboard } = require('../dashboard/template');
const HTML = generateDashboard();

function extractFn(name) {
  const start = HTML.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  let i = HTML.indexOf('{', start), depth = 0, end = -1;
  for (; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return HTML.slice(start, end);
}

// tickLiveDurations depends on formatDuration — build both into one fn.
function buildTicker(fakeDoc, nowMs) {
  const src = extractFn('formatDuration') + '\n' + extractFn('tickLiveDurations')
    + '; return tickLiveDurations;';
  const RealDate = Date;
  const DateStub = function (...a) { return new RealDate(...a); };
  DateStub.now = () => nowMs.value;
  DateStub.parse = RealDate.parse;
  // eslint-disable-next-line no-new-func
  return new Function('document', 'Date', 'isNaN', src)(fakeDoc, DateStub, Number.isNaN);
}
function el(startedAt, prefix) {
  return {
    _a: { 'data-started-at': startedAt, 'data-dur-prefix': prefix || '' },
    textContent: '',
    getAttribute(k) { return this._a[k]; },
  };
}

describe('BUG LIVE-DURATION — tickLiveDurations counts up without fetch', () => {
  const START = '2026-05-16T17:00:00.000Z';

  test('+2 simulated minutes → duration is +2 minutes', () => {
    const node = el(START, 'há ');
    const now = { value: Date.parse(START) + 63 * 60 * 1000 }; // 1h03m in
    const doc = { querySelectorAll: () => [node] };
    const tick = buildTicker(doc, now);

    tick();
    expect(node.textContent).toBe('há 1:03:00');

    now.value += 2 * 60 * 1000; // advance 2 min, no re-render/fetch
    tick();
    expect(node.textContent).toBe('há 1:05:00');
  });

  test('removed element (querySelectorAll empty) → no throw, nothing to clean', () => {
    const tick = buildTicker({ querySelectorAll: () => [] }, { value: Date.now() });
    expect(() => tick()).not.toThrow();
  });

  test('invalid data-started-at is skipped, not crashed', () => {
    const bad = el('not-a-date', '');
    bad.textContent = 'KEEP';
    const tick = buildTicker({ querySelectorAll: () => [bad] }, { value: Date.now() });
    expect(() => tick()).not.toThrow();
    expect(bad.textContent).toBe('KEEP');
  });

  test('no prefix → bare duration', () => {
    const node = el('2026-05-16T17:00:00.000Z', '');
    const now = { value: Date.parse('2026-05-16T17:00:00.000Z') + 45 * 1000 };
    const tick = buildTicker({ querySelectorAll: () => [node] }, now);
    tick();
    expect(node.textContent).toBe('00:45');
  });
});

describe('BUG LIVE-DURATION — wired into the dashboard', () => {
  test('tickLiveDurations exists and runs on a 60s interval (+ the 1s tick)', () => {
    expect(HTML).toMatch(/function tickLiveDurations\(\)/);
    expect(HTML).toMatch(/tickTimers\(\); updateBreakTime\(\); tickLiveDurations\(\);/);
    expect(HTML).toMatch(/if \(!_viewingDate\) tickLiveDurations\(\);\s*\n\}, 60000\)/);
  });
  test('open break rows render a live-dur element with data-started-at', () => {
    expect(HTML).toMatch(/class="live-dur" data-started-at="\$\{escHtml\(String\(b\.started_at/);
    expect(HTML).toMatch(/data-dur-prefix="há "/);
  });
});
