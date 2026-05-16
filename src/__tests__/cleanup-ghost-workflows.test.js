'use strict';
// BUG GHOST — close stale ghost workflow_instances (idempotent,
// dry-run-able, audited ghost_cleanup, also runs in the 03:30 ET cron).
jest.mock('../db');
jest.mock('../admin/audit', () => ({ auditAction: jest.fn().mockResolvedValue() }));

const { auditAction } = require('../admin/audit');
const ghost = require('../../scripts/cleanup-ghost-workflows');
const fs = require('fs');
const path = require('path');

beforeEach(() => { jest.clearAllMocks(); });

function db(ghosts) {
  const calls = [];
  return {
    calls,
    query: jest.fn().mockImplementation((sql, p) => {
      calls.push({ sql, p });
      if (/SELECT wi\.id, wi\.product_name/.test(sql)) return Promise.resolve({ rows: ghosts });
      return Promise.resolve({ rows: [] });
    }),
  };
}

describe('BUG GHOST — detection SQL', () => {
  test('GHOST_SQL targets active >24h with no recently-active child', () => {
    expect(ghost.GHOST_SQL).toMatch(/status = 'active'/);
    expect(ghost.GHOST_SQL).toMatch(/started_at < NOW\(\) - INTERVAL '24 hours'/);
    expect(ghost.GHOST_SQL).toMatch(/NOT EXISTS[\s\S]*phase_instances pi[\s\S]*started_at > NOW\(\) - INTERVAL '24 hours'/);
  });
  test('findGhosts returns the rows', async () => {
    const d = db([{ id: 1 }, { id: 2 }]);
    expect(await ghost.findGhosts(d)).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe('BUG GHOST — dry-run vs apply', () => {
  test('dry-run: no UPDATE, no audit', async () => {
    const d = db([{ id: 5, product_name: 'X', started_at: 't' }]);
    const r = await ghost.cleanupGhostWorkflows({ apply: false, db: d });
    expect(r).toMatchObject({ count: 1, applied: false });
    expect(d.calls.some((c) => /UPDATE workflow_instances/.test(c.sql))).toBe(false);
    expect(auditAction).not.toHaveBeenCalled();
  });

  test('apply: closes each ghost (idempotent guard) + audits ghost_cleanup', async () => {
    const d = db([{ id: 5, product_name: 'X', started_at: 't' }, { id: 9 }]);
    const r = await ghost.cleanupGhostWorkflows({ apply: true, db: d, source: 'cron' });
    expect(r).toMatchObject({ count: 2, applied: true });
    const upd = d.calls.filter((c) => /UPDATE workflow_instances/.test(c.sql));
    expect(upd).toHaveLength(2);
    expect(upd[0].sql).toMatch(/SET status = 'closed'/);
    expect(upd[0].sql).toMatch(/ended_at = started_at \+ INTERVAL '5 minutes'/);
    expect(upd[0].sql).toMatch(/\[auto_cleanup_ghost\]/);
    expect(upd[0].sql).toMatch(/WHERE id = \$1 AND status = 'active'/); // idempotent
    expect(auditAction).toHaveBeenCalledTimes(2);
    expect(auditAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ghost_cleanup', entityType: 'workflow_instance', source: 'cron',
    }));
  });

  test('no ghosts → applied:false, no writes', async () => {
    const d = db([]);
    const r = await ghost.cleanupGhostWorkflows({ apply: true, db: d });
    expect(r).toMatchObject({ count: 0, applied: false });
    expect(d.calls.some((c) => /UPDATE/.test(c.sql))).toBe(false);
  });
});

describe('BUG GHOST — wired into the 03:30 ET daily cron', () => {
  test('scheduler.runDailyCleanup calls cleanupGhostWorkflows(apply:true)', () => {
    const sch = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
    expect(sch).toMatch(/cleanup-ghost-workflows/);
    expect(sch).toMatch(/cleanupGhostWorkflows\(\{ apply: true, db, source: 'cron' \}\)/);
    expect(sch).toMatch(/ghost-wf=\$\{ghosts\.count\}/);
  });
});
