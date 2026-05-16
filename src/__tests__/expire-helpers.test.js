'use strict';
// OPERATOR-CRUD (PARTE D) — temporary helpers auto-expire: a helper
// past its expires_at is soft-deactivated (never deleted), audited
// operator.expired, idempotent, wired into the 03:30 ET daily cron.
jest.mock('../db');
jest.mock('../admin/audit', () => ({ auditAction: jest.fn().mockResolvedValue() }));
const { auditAction } = require('../admin/audit');
const exp = require('../../scripts/expire-helpers');
const fs = require('fs');
const path = require('path');

beforeEach(() => { jest.clearAllMocks(); });

function db(helpers) {
  const calls = [];
  return {
    calls,
    query: jest.fn((sql, p) => {
      calls.push({ sql, p });
      if (/FROM operators\s+WHERE is_temporary = TRUE/.test(sql)) return Promise.resolve({ rows: helpers });
      return Promise.resolve({ rows: [] });
    }),
  };
}

describe('OPERATOR-CRUD — expire-helpers detection SQL', () => {
  test('targets temporary, still-active helpers past expires_at', () => {
    expect(exp.EXPIRED_SQL).toMatch(/is_temporary = TRUE/);
    expect(exp.EXPIRED_SQL).toMatch(/is_active = TRUE/);
    expect(exp.EXPIRED_SQL).toMatch(/expires_at IS NOT NULL/);
    expect(exp.EXPIRED_SQL).toMatch(/expires_at < NOW\(\)/);
  });
  test('findExpiredHelpers returns the rows', async () => {
    const d = db([{ id: 1, name: 'Tmp' }]);
    expect(await exp.findExpiredHelpers(d)).toEqual([{ id: 1, name: 'Tmp' }]);
  });
});

describe('OPERATOR-CRUD — dry-run vs apply', () => {
  test('dry-run: no UPDATE, no audit', async () => {
    const d = db([{ id: 5, name: 'Maria', expires_at: 't' }]);
    const r = await exp.expireHelpers({ apply: false, db: d });
    expect(r).toMatchObject({ count: 1, applied: false });
    expect(d.calls.some((c) => /UPDATE operators/.test(c.sql))).toBe(false);
    expect(auditAction).not.toHaveBeenCalled();
  });

  test('apply: soft-deactivates (never deletes) + audits operator.expired', async () => {
    const d = db([{ id: 5, name: 'Maria', expires_at: 't' }, { id: 9, name: 'Zé' }]);
    const r = await exp.expireHelpers({ apply: true, db: d, source: 'cron' });
    expect(r).toMatchObject({ count: 2, applied: true });
    const upd = d.calls.filter((c) => /UPDATE operators/.test(c.sql));
    expect(upd).toHaveLength(2);
    expect(upd[0].sql).toMatch(/SET active = FALSE, is_active = FALSE/);
    expect(upd[0].sql).toMatch(/WHERE id = \$1 AND is_temporary = TRUE AND is_active = TRUE/); // idempotent guard
    expect(d.calls.some((c) => /DELETE FROM operators/.test(c.sql))).toBe(false); // never hard-delete
    expect(auditAction).toHaveBeenCalledTimes(2);
    expect(auditAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'operator.expired', entityType: 'operator', source: 'cron',
    }));
  });

  test('no expired helpers → applied:false, no writes', async () => {
    const d = db([]);
    const r = await exp.expireHelpers({ apply: true, db: d });
    expect(r).toMatchObject({ count: 0, applied: false });
    expect(d.calls.some((c) => /UPDATE/.test(c.sql))).toBe(false);
  });
});

describe('OPERATOR-CRUD — wired into the 03:30 ET daily cron', () => {
  test('scheduler.runDailyCleanup calls expireHelpers(apply:true) + logs count', () => {
    const sch = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
    expect(sch).toMatch(/expire-helpers/);
    expect(sch).toMatch(/expireHelpers\(\{ apply: true, db, source: 'cron' \}\)/);
    expect(sch).toMatch(/expired-helpers=\$\{helpers\.count\}/);
  });
});
