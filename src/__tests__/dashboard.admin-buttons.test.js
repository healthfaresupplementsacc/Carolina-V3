'use strict';
// Regression lock — the dashboard admin close/edit buttons on
// workflow/phase/ad-hoc cards were replaced (commit 7cdf271, G3) by a
// single per-card "Gerenciar → /admin/workflows" link. This pins:
//   1. cards have PIN-gated inline admin buttons (no PIN → none),
//   2. "Fase config" lives ONLY in the admin menu (not per card),
//   3. operators never see it (display:none + PIN show/hide).
const { generateDashboard } = require('../dashboard/template');

const HTML = generateDashboard();
// The renderOpenTasks / _card region (where task cards are built).
const cardRegion = HTML.slice(
  HTML.indexOf('function renderOpenTasks'),
  HTML.indexOf('function tickTimers')
);

describe('regression — ISA-88 card admin buttons are restored & PIN-gated', () => {
  test('card admin buttons require adminUnlocked (operators see none)', () => {
    // both branches of the per-card adminBtns are gated on adminUnlocked
    expect(cardRegion).toMatch(/adminBtns\s*=\s*\(adminUnlocked && !isWf\)/);
    expect(cardRegion).toMatch(/adminUnlocked && isWf && wfId/);
    // when not unlocked the ternary yields '' → no admin button markup
    expect(cardRegion).toMatch(/:\s*''\)/);
  });

  test('PIN-unlocked workflow/phase card exposes the full admin button set', () => {
    expect(cardRegion).toMatch(/wfEditName\("\$\{wfKind\}"/);   // editar nome
    expect(cardRegion).toMatch(/wfEditBottles\(\$\{wfId\}\)/);  // editar bottles
    expect(cardRegion).toMatch(/wfClose\("\$\{wfKind\}"/);      // fechar agora
    expect(cardRegion).toMatch(/wfCloseAt\("\$\{wfKind\}"/);    // fechar c/ horário
    expect(cardRegion).toMatch(/wfDelete\("\$\{wfKind\}"/);     // excluir
    expect(cardRegion).toMatch(/adminNote\(/);                  // nota interna 🛠
  });

  test('the per-card "Gerenciar → /admin/workflows" link is GONE from cards', () => {
    expect(cardRegion).not.toContain('/admin/workflows');
    expect(cardRegion).not.toMatch(/>Gerenciar</);
  });
});

describe('regression — "Fase config" lives only in the admin menu, PIN-gated', () => {
  test('exactly one /admin/workflows link, in the header as wf-config-link', () => {
    const occurrences = HTML.split('href="/admin/workflows"').length - 1;
    expect(occurrences).toBe(1);
    expect(HTML).toMatch(/id="wf-config-link"[^>]*href="\/admin\/workflows"/);
  });

  test('wf-config-link is hidden by default and toggled by PIN unlock', () => {
    const link = HTML.slice(HTML.indexOf('id="wf-config-link"'), HTML.indexOf('id="wf-config-link"') + 260);
    expect(link).toMatch(/display:none/);                 // hidden for operators
    expect(HTML).toMatch(/hide\('wf-config-link'\)/);     // hidden on lock
    expect(HTML).toMatch(/show\('wf-config-link', 'inline-block'\)/); // shown on unlock
  });
});

describe('Bug 1 — break/activity entries get PIN-gated admin edit', () => {
  const breakRegion = HTML.slice(
    HTML.indexOf('function renderTodayBreaks'),
    HTML.indexOf('function renderBreakBanner')
  );

  test('break rows expose edit-saída / edit-volta / excluir only when adminUnlocked', () => {
    expect(breakRegion).toMatch(/adminBtns\s*=\s*adminUnlocked/);     // gated
    expect(breakRegion).toMatch(/oalEditTime\(\$\{b\.id\},"started_at"/);
    expect(breakRegion).toMatch(/oalEditTime\(\$\{b\.id\},"ended_at"/);
    expect(breakRegion).toMatch(/oalDelete\(\$\{b\.id\}\)/);
    expect(breakRegion).toMatch(/:\s*''/);                            // operators → no buttons
  });

  test('oal helpers hit the existing PIN-audited operator-activity-log endpoint', () => {
    expect(HTML).toMatch(/async function oalEditTime[\s\S]*\/api\/admin\/operator-activity-log\/'\s*\+\s*id/);
    expect(HTML).toMatch(/async function oalEditTime[\s\S]*adminAction\(/);
    expect(HTML).toMatch(/async function oalDelete[\s\S]*method: 'DELETE'[\s\S]*operator-activity-log/);
  });
});

describe('Bug 2 — flexible time parse + retroactive edit', () => {
  // Extract _parseFlexTime from the served JS and evaluate it so the
  // real parsing matrix is exercised (it is regex-free on purpose to
  // stay safe inside the template literal).
  function extractFn(name) {
    const start = HTML.indexOf('function ' + name + '(');
    expect(start).toBeGreaterThan(-1);
    let i = HTML.indexOf('{', start), depth = 0, end = -1;
    for (; i < HTML.length; i++) {
      if (HTML[i] === '{') depth++;
      else if (HTML[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    // eslint-disable-next-line no-new-func
    return new Function(HTML.slice(start, end) + '; return ' + name + ';')();
  }
  const parse = extractFn('_parseFlexTime');
  const BASE = '2026-05-16T18:00:00Z'; // ET date 2026-05-16

  test.each([
    ['14:30', '14:30'], ['1430', '14:30'], ['14h30', '14:30'], ['14h', '14:00'],
    ['14', '14:00'], ['930', '09:30'], ['9', '09:00'], ['2pm', '14:00'],
    ['2 pm', '14:00'], ['12am', '00:00'],
  ])('"%s" → date 14:.. with HH:MM %s', (inp, hhmm) => {
    const out = parse(inp, BASE);
    expect(out).toMatch(/^2026-05-16 \d{2}:\d{2}$/);
    expect(out.slice(11)).toBe(hhmm);
  });

  test('full "AAAA-MM-DD HH:MM" passes through; junk → null', () => {
    expect(parse('2026-05-15 08:05', BASE)).toBe('2026-05-15 08:05');
    expect(parse('2026-05-15T08:05', BASE)).toBe('2026-05-15 08:05');
    expect(parse('', BASE)).toBeNull();
    expect(parse('abc', BASE)).toBeNull();
    expect(parse('99:99', BASE)).toBeNull();
  });

  test('oalEditTime opens the time modal and the save sends retroactive:true', () => {
    // BUG UI moved parsing into submitTimeModal (modal flow, no prompt()).
    const oal = HTML.slice(HTML.indexOf('async function oalEditTime'), HTML.indexOf('async function oalDelete'));
    expect(oal).toMatch(/openTimeModal\(\{/);
    expect(oal).toMatch(/retroactive: true/);
    expect(oal).toMatch(/\/api\/admin\/operator-activity-log\//);
    expect(HTML).toMatch(/submitTimeModal[\s\S]*_parseFlexTime\(t, d \+ 'T12:00:00'\)/);
  });
});

describe('regression — wf* helpers hit the existing PIN-audited endpoints', () => {
  test('helpers map to phase/ad-hoc instance endpoints + correct fields', () => {
    expect(HTML).toContain("path: 'ad-hoc-task-instances'");
    expect(HTML).toContain("path: 'phase-instances'");
    expect(HTML).toMatch(/wfEditBottles[\s\S]*final_bottle_count/);
    expect(HTML).toMatch(/wfClose[\s\S]*status: 'closed', ended_at: _nowEt\(\)/);
    expect(HTML).toMatch(/wfDelete[\s\S]*method: 'DELETE'/);
    // all go through adminAction, which enforces the PIN + admin gate
    expect(HTML).toMatch(/async function wfEditName[\s\S]*adminAction\(/);
    expect(HTML).toMatch(/async function wfCloseAt[\s\S]*adminAction\(/);
  });
});
