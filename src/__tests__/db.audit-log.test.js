'use strict';
/**
 * Entrega 2 commit 1: confirm the migration creates admin_audit_log,
 * task_aliases, and adds deleted_at to soft-deletable tables.
 *
 * Pure SQL-shape check via pg.Pool mock — no real DB needed.
 */

jest.mock('pg', () => {
  const mPool = { query: jest.fn(), on: jest.fn(), end: jest.fn() };
  return { Pool: jest.fn(() => mPool) };
});

const { Pool } = require('pg');
const mockPool = new Pool();
const db = require('../db');

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [] });
});

describe('Entrega 2 migration — new tables', () => {
  test('migrate() creates admin_audit_log with required columns', async () => {
    await db.migrate();
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS admin_audit_log/);
    expect(sql).toMatch(/admin_user VARCHAR/);
    expect(sql).toMatch(/action VARCHAR\(80\) NOT NULL/);
    expect(sql).toMatch(/entity_type VARCHAR\(50\) NOT NULL/);
    expect(sql).toMatch(/entity_id VARCHAR/);
    expect(sql).toMatch(/before_data JSONB/);
    expect(sql).toMatch(/after_data JSONB/);
    expect(sql).toMatch(/source VARCHAR/);
    expect(sql).toMatch(/request_meta JSONB/);
    expect(sql).toMatch(/created_at TIMESTAMPTZ DEFAULT NOW\(\)/);
  });

  test('migrate() creates indexes on admin_audit_log', async () => {
    await db.migrate();
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toMatch(/idx_audit_log_created_at\b/);
    expect(sql).toMatch(/idx_audit_log_entity\b/);
    expect(sql).toMatch(/idx_audit_log_action\b/);
  });

  test('migrate() creates task_aliases with UNIQUE constraint', async () => {
    await db.migrate();
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS task_aliases/);
    expect(sql).toMatch(/canonical_term VARCHAR/);
    expect(sql).toMatch(/alias_term VARCHAR/);
    expect(sql).toMatch(/UNIQUE \(canonical_term, alias_term\)/);
    expect(sql).toMatch(/idx_task_aliases_alias/);
  });

  test('migrate() adds deleted_at to all soft-deletable tables', async () => {
    await db.migrate();
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toMatch(/ALTER TABLE pauses\s+ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ/);
    expect(sql).toMatch(/ALTER TABLE orders_sessions\s+ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ/);
    expect(sql).toMatch(/ALTER TABLE production_counts\s+ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ/);
    expect(sql).toMatch(/ALTER TABLE formulation_sessions\s+ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ/);
  });

  test('migrate() creates partial indexes for deleted_at IS NULL', async () => {
    await db.migrate();
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toMatch(/idx_pauses_active.*deleted_at IS NULL/);
    expect(sql).toMatch(/idx_orders_active.*deleted_at IS NULL/);
    expect(sql).toMatch(/idx_counts_active.*deleted_at IS NULL/);
  });

  test('migrate() is idempotent (uses IF NOT EXISTS everywhere)', async () => {
    await db.migrate();
    const sql = mockPool.query.mock.calls[0][0];
    // Every CREATE TABLE and CREATE INDEX uses IF NOT EXISTS
    const createTables = sql.match(/CREATE TABLE [^;]+/g) || [];
    for (const t of createTables) {
      expect(t).toMatch(/IF NOT EXISTS/);
    }
    const createIndexes = sql.match(/CREATE INDEX [^;]+/g) || [];
    for (const i of createIndexes) {
      expect(i).toMatch(/IF NOT EXISTS/);
    }
  });
});
