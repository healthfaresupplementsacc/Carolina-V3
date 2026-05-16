'use strict';
// BUG UI — admin time edits use a proper modal (date + flexible time,
// AM/PM 12h OR 24h), never prompt(); always saved in ET; past & future.
const { generateDashboard } = require('../dashboard/template');
const HTML = generateDashboard();

describe('BUG UI — time picker modal markup', () => {
  test('a #time-modal with date input + flexible time input exists', () => {
    expect(HTML).toContain('id="time-modal"');
    expect(HTML).toMatch(/<input type="date" id="tm-date"/);
    expect(HTML).toMatch(/<input type="text" id="tm-time"/);
    // placeholder advertises AM/PM (12h) first + 24h
    expect(HTML).toMatch(/9:41am[^"]*9pm[^"]*21:41[^"]*1430/);
    expect(HTML).toMatch(/Fuso: hor[áa]rio do leste \(ET\)/);
    // closes on backdrop click like the other modals
    expect(HTML).toMatch(/\['pin-modal','edit-modal','time-modal'\]/);
  });
});

describe('BUG UI — modal logic replaces prompt()', () => {
  test('openTimeModal/closeTimeModal/submitTimeModal defined', () => {
    expect(HTML).toMatch(/function openTimeModal\(opts\)/);
    expect(HTML).toMatch(/function closeTimeModal\(\)/);
    expect(HTML).toMatch(/function submitTimeModal\(\)/);
    // submit parses via the flexible parser and keeps an ET string
    expect(HTML).toMatch(/submitTimeModal[\s\S]*_parseFlexTime\(t, d \+ 'T12:00:00'\)/);
    expect(HTML).toMatch(/var val = d \+ ' ' \+ v\.slice\(11\)/);
  });

  test('oalEditTime + wfCloseAt use the modal, not prompt()', () => {
    const oal = HTML.slice(HTML.indexOf('async function oalEditTime'), HTML.indexOf('async function oalDelete'));
    expect(oal).toMatch(/openTimeModal\(\{/);
    expect(oal).not.toMatch(/prompt\(/);
    expect(oal).toMatch(/retroactive: true/);
    const wf = HTML.slice(HTML.indexOf('async function wfCloseAt'), HTML.indexOf('async function wfDelete'));
    expect(wf).toMatch(/openTimeModal\(\{/);
    expect(wf).not.toMatch(/prompt\(/);
    expect(wf).toMatch(/passado ou futuro/);
  });
});

describe('BUG UI — flexible parser handles AM/PM and 24h (no 9am/9pm confusion)', () => {
  function extractFn(name) {
    const start = HTML.indexOf('function ' + name + '(');
    let i = HTML.indexOf('{', start), depth = 0, end = -1;
    for (; i < HTML.length; i++) {
      if (HTML[i] === '{') depth++;
      else if (HTML[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    // eslint-disable-next-line no-new-func
    return new Function(HTML.slice(start, end) + '; return ' + name + ';')();
  }
  const parse = extractFn('_parseFlexTime');
  const BASE = '2026-05-16T12:00:00';
  test.each([
    ['9am', '09:00'], ['9pm', '21:00'], ['9:41am', '09:41'], ['9:41 AM', '09:41'],
    ['21:41', '21:41'], ['1430', '14:30'], ['12am', '00:00'], ['12pm', '12:00'],
  ])('"%s" → %s (AM/PM distinct from 24h)', (inp, hhmm) => {
    expect(parse(inp, BASE).slice(11)).toBe(hhmm);
  });
});
