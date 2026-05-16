'use strict';
jest.mock('../db', () => ({
  cleanupStaleBreaks: jest.fn().mockResolvedValue([{ id: 1 }]),
  cleanupAuditLog: jest.fn().mockResolvedValue(4),
  query: jest.fn().mockResolvedValue({ rows: [] }),
  pool: { end: jest.fn() },
}));
jest.mock('../workflow/legacy-cleanup', () => ({
  cleanupLegacyOrphans: jest.fn().mockResolvedValue({
    phases_closed: 2, adhoc_closed: 1, workflows_closed: 0,
  }),
}));
jest.mock('../slack/poller', () => ({ poll: jest.fn(), backfill: jest.fn(), isBackfillDone: jest.fn() }));
jest.mock('../urgency', () => ({ checkUrgency: jest.fn() }));
jest.mock('../slack/dm-handler', () => ({ pollBossDMs: jest.fn(), pollManagerChannel: jest.fn() }));
jest.mock('node-cron', () => ({ schedule: jest.fn() }));

const db = require('../db');
const legacy = require('../workflow/legacy-cleanup');
const sched = require('../scheduler');

describe('P4 — daily cleanup job', () => {
  test('runs stale-break + audit-ttl + legacy-orphan cleanup', async () => {
    await sched.runDailyCleanup();
    expect(db.cleanupStaleBreaks).toHaveBeenCalled();
    expect(db.cleanupAuditLog).toHaveBeenCalled();
    expect(legacy.cleanupLegacyOrphans).toHaveBeenCalledWith({ dryRun: false, olderThanHours: 24 });
  });

  test('legacy-orphan failure does not crash the job', async () => {
    legacy.cleanupLegacyOrphans.mockRejectedValueOnce(new Error('boom'));
    await expect(sched.runDailyCleanup()).resolves.toBeUndefined();
    expect(db.cleanupAuditLog).toHaveBeenCalled();
  });
});
