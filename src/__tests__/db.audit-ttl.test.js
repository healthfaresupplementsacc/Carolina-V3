'use strict';
jest.mock('pg', () => {
  const mPool = { query: jest.fn(), on: jest.fn(), end: jest.fn() };
  return { Pool: jest.fn(() => mPool) };
});
const { Pool } = require('pg');
const mockPool = new Pool();
const db = require('../db');

beforeEach(() => { mockPool.query.mockReset(); });

describe('L2 — admin_audit_log TTL', () => {
  test('deletes 15+ day rows excluding permanent actions', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const n = await db.cleanupAuditLog();
    expect(n).toBe(3);
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM admin_audit_log/);
    expect(sql).toMatch(/created_at < NOW\(\) - INTERVAL '15 days'/);
    expect(sql).toMatch(/action <> ALL\(\$1::text\[\]\)/);
    // permanent list passed as param
    expect(params[0]).toEqual(db.AUDIT_PERMANENT_ACTIONS);
    expect(params[0]).toContain('legacy_cleanup');
    expect(params[0]).toContain('task.merge');
    expect(params[0]).toContain('supplement.delete');
  });

  test('error is swallowed → returns 0', async () => {
    mockPool.query.mockRejectedValue(new Error('db down'));
    expect(await db.cleanupAuditLog()).toBe(0);
  });

  test('permanent-actions list is frozen-ish (key actions present)', () => {
    for (const a of ['legacy_cleanup', 'workflow_template.delete',
      'phase_template.delete', 'operator.deactivate', 'supplement.delete',
      'task.merge', 'phase_instance.merge']) {
      expect(db.AUDIT_PERMANENT_ACTIONS).toContain(a);
    }
  });
});
