'use strict';
// WIPE — controlled activity reset. Pins the EXACT delete list, the
// preserve list, child→parent order, the no-cascade DELETE, the audit,
// the transaction rollback, and the ADMIN_CONFIRMED interlock.
jest.mock('../admin/audit', () => ({ auditAction: jest.fn().mockResolvedValue() }));
const { auditAction } = require('../admin/audit');
const wipe = require('../../scripts/wipe-activity-data');
const fs = require('fs');
const path = require('path');

function fakeDb() {
  const calls = [];
  return {
    calls,
    query: jest.fn((sql, p) => {
      calls.push({ sql: String(sql).trim(), p });
      const s = String(sql);
      if (/FROM pg_tables/.test(s) && /tablename=\$1/.test(s)) return Promise.resolve({ rows: [{ ok: 1 }] });
      if (/FROM pg_tables/.test(s)) return Promise.resolve({ rows: [
        ...wipe.WIPE_TABLES.map((t) => ({ tablename: t })),
        ...wipe.PRESERVE_TABLES.map((t) => ({ tablename: t })),
        { tablename: 'task_aliases' }, { tablename: 'mystery_table' }, // genuinely unlisted
      ] });
      if (/COUNT\(\*\)::int n FROM app_state WHERE key/.test(s)) return Promise.resolve({ rows: [{ n: 1 }] });
      if (/COUNT\(\*\)::int n/.test(s)) return Promise.resolve({ rows: [{ n: 5 }] });
      if (/FROM operators ORDER BY role/.test(s)) return Promise.resolve({ rows: [
        { name: 'Bruno', role: 'owner', active: true, is_active: true, is_temporary: false },
      ] });
      if (/FROM workflow_templates/.test(s)) return Promise.resolve({ rows: [{ name: 'WF1' }] });
      if (/FROM phase_templates/.test(s)) return Promise.resolve({ rows: [{ name: 'PH1' }] });
      if (/FROM ad_hoc_tasks/.test(s)) return Promise.resolve({ rows: [{ name: 'AH1' }] });
      if (/^DELETE FROM/.test(s)) return Promise.resolve({ rowCount: 5 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
  };
}

describe('WIPE — list integrity (apaga vs preserva)', () => {
  test('WIPE_TABLES = spec set + admin-confirmed "100% limpo" extra, child→parent', () => {
    expect(wipe.WIPE_TABLES).toEqual([
      'operator_activity_log', 'production_counts', 'pauses',
      'phase_instances', 'ad_hoc_task_instances', 'workflow_instances',
      'urgency_notifications', 'tasks', 'operator_notes',
      'carolina_proposals', 'silent_log',
      'orders_sessions', 'formulation_sessions', 'messages', 'eod_snapshots',
    ]);
    // children strictly before their parents
    const idx = (t) => wipe.WIPE_TABLES.indexOf(t);
    expect(idx('operator_activity_log')).toBeLessThan(idx('phase_instances'));
    expect(idx('production_counts')).toBeLessThan(idx('tasks'));
    expect(idx('pauses')).toBeLessThan(idx('tasks'));
    expect(idx('phase_instances')).toBeLessThan(idx('workflow_instances'));
    expect(idx('urgency_notifications')).toBeLessThan(idx('tasks')); // FK -> tasks
  });
  test('manager_chat_history is an app_state KEY, not a table', () => {
    expect(wipe.WIPE_APP_STATE_KEYS).toEqual(['manager_chat_history']);
    expect(wipe.WIPE_TABLES).not.toContain('manager_chat_history');
    expect(wipe.WIPE_TABLES).not.toContain('app_state');
  });
  test('PRESERVE keeps operators/app_state/templates/catalog/variations/audit', () => {
    for (const t of ['operators', 'app_state', 'workflow_templates',
      'phase_templates', 'ad_hoc_tasks', 'supplement_catalog',
      'message_variations', 'admin_audit_log']) {
      expect(wipe.PRESERVE_TABLES).toContain(t);
    }
    // never wipe a preserved table
    for (const t of wipe.PRESERVE_TABLES) expect(wipe.WIPE_TABLES).not.toContain(t);
  });
});

describe('WIPE — dry-run report', () => {
  test('reports wipe/preserve/unlisted + operators + templates', async () => {
    const db = fakeDb();
    const r = await wipe.report(db);
    expect(Object.keys(r.wipe)).toEqual(wipe.WIPE_TABLES);
    expect(r.mch).toBe(1);
    expect(r.preserve.operators).toBe(5);
    expect(r.unlisted).toEqual({ task_aliases: 5, mystery_table: 5 }); // surfaced, NOT wiped
    expect(r.operators[0]).toMatchObject({ name: 'Bruno', role: 'owner' });
    expect(r.wfTemplates).toEqual(['WF1']);
  });
});

describe('WIPE — apply', () => {
  test('DELETEs each table in order, clears the app_state key, audits, tx-wrapped', async () => {
    const db = fakeDb();
    const deleted = await wipe.applyWipe(db, 'wipe_script', 'bruno');
    const order = db.calls.filter((c) => /^DELETE FROM/.test(c.sql))
      .map((c) => c.sql.match(/DELETE FROM "?([a-z_]+)"?/)[1]);
    expect(order.slice(0, wipe.WIPE_TABLES.length)).toEqual(wipe.WIPE_TABLES);
    expect(db.calls.some((c) => /DELETE FROM app_state WHERE key = ANY/.test(c.sql))).toBe(true);
    expect(db.calls.some((c) => c.sql === 'BEGIN')).toBe(true);
    expect(db.calls.some((c) => c.sql === 'COMMIT')).toBe(true);
    // no TRUNCATE / no CASCADE anywhere (precise, no surprise cascade)
    expect(db.calls.every((c) => !/TRUNCATE|CASCADE/i.test(c.sql))).toBe(true);
    expect(deleted.operator_activity_log).toBe(5);
    expect(auditAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'full_wipe_apply', entityType: 'database',
    }));
  });

  test('rolls back on error (no partial wipe)', async () => {
    const db = fakeDb();
    let n = 0;
    db.query = jest.fn((sql) => {
      const s = String(sql);
      if (s === 'BEGIN') return Promise.resolve({});
      if (/FROM pg_tables WHERE schemaname='public' AND tablename/.test(s)) return Promise.resolve({ rows: [{ ok: 1 }] });
      if (/^DELETE FROM/.test(s)) { if (++n === 3) return Promise.reject(new Error('boom')); return Promise.resolve({ rowCount: 1 }); }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    await expect(wipe.applyWipe(db, 'wipe_script', 'x')).rejects.toThrow('boom');
    expect(db.query).toHaveBeenCalledWith('ROLLBACK');
  });
});

describe('WIPE — safety interlocks documented in the script', () => {
  test('--apply refuses without ADMIN_CONFIRMED=TRUE; dry-run is default', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'wipe-activity-data.js'), 'utf8');
    expect(src).toMatch(/process\.env\.ADMIN_CONFIRMED !== 'TRUE'/);
    expect(src).toMatch(/RECUSADO: --apply exige ADMIN_CONFIRMED=TRUE/);
    expect(src).toMatch(/NÃO será apagada/); // unlisted tables surfaced, never auto-deleted
    // documents the no-cascade decision; the behavioural test above
    // proves no TRUNCATE/CASCADE SQL is ever executed.
    expect(src).toMatch(/NO TRUNCATE CASCADE/);
  });
});
