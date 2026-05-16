'use strict';
// BUG UX — the scattered header admin buttons (Admin / Audit / Carolina /
// Fase config / 🔇 Texto / ✅ Reactions) are consolidated into ONE
// PIN-gated "🛠 Admin" dropdown. Operators (no PIN) see nothing; the
// dropdown opens only after admin unlock; no duplicate admin entry points.
const { generateDashboard } = require('../dashboard/template');
const HTML = generateDashboard();

// The single menu wrapper region (button + dropdown list).
const menu = HTML.slice(
  HTML.indexOf('id="admin-menu"'),
  HTML.indexOf('id="admin-menu"') + 2600
);

describe('BUG UX — single consolidated admin menu', () => {
  test('exactly one #admin-menu wrapper, hidden by default (operators see nothing)', () => {
    expect(HTML.split('id="admin-menu"').length - 1).toBe(1);
    const wrap = HTML.slice(HTML.indexOf('id="admin-menu"'), HTML.indexOf('id="admin-menu"') + 80);
    expect(wrap).toMatch(/display:none/); // not visible until PIN unlock
  });

  test('a 🛠 Admin toggle button drives toggleAdminMenu()', () => {
    expect(menu).toMatch(/id="admin-menu-btn"[^>]*onclick="toggleAdminMenu\(\)"/);
    expect(menu).toContain('🛠 Admin');
  });

  test('the dropdown list is a single element, closed by default', () => {
    expect(HTML.split('id="admin-menu-list"').length - 1).toBe(1);
    const list = HTML.slice(HTML.indexOf('id="admin-menu-list"'), HTML.indexOf('id="admin-menu-list"') + 90);
    expect(list).toMatch(/display:none/);
  });

  test('every admin destination now lives inside the one dropdown', () => {
    // links
    expect(menu).toMatch(/id="audit-link"[^>]*href="\/admin\/audit"/);
    expect(menu).toMatch(/id="carolina-link"[^>]*href="\/admin\/carolina-config"/);
    expect(menu).toMatch(/id="wf-config-link"[^>]*href="\/admin\/workflows"/);
    expect(menu).toMatch(/id="admin-link"[^>]*href="\/admin"/);
    // Carolina silence toggles kept (ids preserved for toggleSilent)
    expect(menu).toMatch(/id="silent-text-btn"[^>]*onclick="toggleSilent\('text'\)"/);
    expect(menu).toMatch(/id="silent-reactions-btn"[^>]*onclick="toggleSilent\('reactions'\)"/);
    expect(menu).toMatch(/id="silent-text-state"/);
    expect(menu).toMatch(/id="silent-reactions-state"/);
    // explicit "sair do admin" entry inside the menu
    expect(menu).toMatch(/onclick="toggleAdmin\(\)"[^>]*>🔓 Sair do admin/);
  });

  test('the old always-visible scattered "⚙️ Admin" archive link is gone', () => {
    expect(HTML).not.toContain('class="admin-link"');
    expect(HTML).not.toMatch(/href="\/admin"[^>]*class="admin-link"/);
  });
});

describe('BUG UX — menu logic + PIN gating', () => {
  test('toggleAdminMenu() defined and flips the dropdown open/closed', () => {
    expect(HTML).toMatch(/function toggleAdminMenu\(\)/);
    expect(HTML).toMatch(/admin-menu-list'[\s\S]{0,120}display\s*===\s*'flex'\s*\)\s*\?\s*'none'\s*:\s*'flex'/);
  });

  test('clicking outside the menu closes the dropdown', () => {
    expect(HTML).toMatch(/document\.addEventListener\('click'[\s\S]{0,260}!m\.contains\(e\.target\)[\s\S]{0,40}display = 'none'/);
  });

  test('PIN unlock reveals the menu; lock hides it (single wrapper toggled)', () => {
    const unlock = HTML.slice(HTML.indexOf('function _applyUnlockedUI'), HTML.indexOf('function _persistAdmin'));
    expect(unlock).toMatch(/show\('admin-menu', 'inline-block'\)/);
    const lock = HTML.slice(HTML.indexOf('function _applyLockedUI'), HTML.indexOf('function _applyUnlockedUI'));
    expect(lock).toMatch(/hide\('admin-menu'\)/);
    expect(lock).toMatch(/hide\('admin-menu-list'\)/); // dropdown also force-closed on lock
  });
});
