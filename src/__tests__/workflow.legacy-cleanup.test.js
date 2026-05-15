'use strict';
jest.mock('../db');
const db = require('../db');
const { cleanupLegacyOrphans } = require('../workflow/legacy-cleanup');

beforeEach(() => { jest.clearAllMocks(); });

describe('Bug 3 — legacy orphan cleanup', () => {
  test('dryRun returns counts without writing', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, workflow_instance_id, started_at FROM phase_instances/.test(sql)) {
        return Promise.resolve({ rows: [
          { id: 1, workflow_instance_id: 10, started_at: '2026-05-13T10:00Z' },
          { id: 2, workflow_instance_id: 10, started_at: '2026-05-13T11:00Z' },
        ]});
      }
      if (/SELECT id, started_at FROM ad_hoc_task_instances/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 5, started_at: '2026-05-13T09:00Z' }] });
      }
      if (/SELECT id, status FROM phase_instances\s+WHERE workflow_instance_id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 1, status: 'open' }, { id: 2, status: 'open' }] });
      }
      if (/SELECT status FROM workflow_instances WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ status: 'active' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await cleanupLegacyOrphans({ dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.phases_to_close).toBe(2);
    expect(r.adhoc_to_close).toBe(1);
    expect(r.workflows_to_close).toBe(1);
    // No UPDATE/INSERT issued in dry run
    const writes = db.query.mock.calls.filter((c) => /UPDATE |INSERT INTO/.test(c[0]));
    expect(writes.length).toBe(0);
  });

  test('apply closes phases + adhoc + parent workflow, writes audit rows', async () => {
    const writes = [];
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/UPDATE |INSERT INTO/.test(sql)) writes.push({ sql: sql.slice(0, 50), params });
      if (/SELECT id, workflow_instance_id, started_at FROM phase_instances/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 1, workflow_instance_id: 10, started_at: '2026-05-13T10:00Z' }] });
      }
      if (/SELECT id, started_at FROM ad_hoc_task_instances/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 5, started_at: '2026-05-13T09:00Z' }] });
      }
      if (/SELECT status FROM phase_instances\s+WHERE workflow_instance_id/.test(sql)) {
        return Promise.resolve({ rows: [{ status: 'closed' }] }); // all closed after our update
      }
      if (/UPDATE workflow_instances[\s\S]+RETURNING id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 10 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await cleanupLegacyOrphans({ dryRun: false });
    expect(r.phases_closed).toBe(1);
    expect(r.adhoc_closed).toBe(1);
    expect(r.workflows_closed).toBe(1);

    const phaseUpd = writes.find((w) => /UPDATE phase_instances/.test(w.sql));
    expect(phaseUpd).toBeTruthy();
    const audits = writes.filter((w) => /INSERT INTO admin_audit_log/.test(w.sql));
    // 1 phase + 1 adhoc + 1 workflow = 3 audit rows
    expect(audits.length).toBe(3);
    // action='legacy_cleanup' is a SQL literal, not a param; params[0] is entity_id
    for (const a of audits) expect(a.sql).toMatch(/INSERT INTO admin_audit_log/);
  });

  test('apply does NOT close workflow if a phase remains open', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, workflow_instance_id, started_at FROM phase_instances/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 1, workflow_instance_id: 10, started_at: '2026-05-13T10:00Z' }] });
      }
      if (/SELECT id, started_at FROM ad_hoc_task_instances/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/SELECT status FROM phase_instances\s+WHERE workflow_instance_id/.test(sql)) {
        // one still open (a newer phase not in cutoff)
        return Promise.resolve({ rows: [{ status: 'closed' }, { status: 'open' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await cleanupLegacyOrphans({ dryRun: false });
    expect(r.phases_closed).toBe(1);
    expect(r.workflows_closed).toBe(0);
  });

  test('nothing to do → all zeros', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await cleanupLegacyOrphans({ dryRun: false });
    expect(r).toEqual({ dryRun: false, phases_closed: 0, adhoc_closed: 0, workflows_closed: 0 });
  });
});
