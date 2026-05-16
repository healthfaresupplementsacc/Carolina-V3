'use strict';
// OPERATOR-CRUD schema — operators gains is_active / is_temporary /
// expires_at / hired_at. Migration must be additive and preserve
// existing data (everyone active, permanent, hired_at backfilled), and
// keep is_active in lockstep with the canonical `active` column.
const fs = require('fs');
const path = require('path');
const dbsrc = fs.readFileSync(path.join(__dirname, '..', 'db', 'index.js'), 'utf8');

describe('OPERATOR-CRUD — schema migration', () => {
  test('adds the four columns, IF NOT EXISTS (idempotent/additive)', () => {
    expect(dbsrc).toMatch(/ALTER TABLE operators ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE/);
    expect(dbsrc).toMatch(/ALTER TABLE operators ADD COLUMN IF NOT EXISTS is_temporary BOOLEAN DEFAULT FALSE/);
    expect(dbsrc).toMatch(/ALTER TABLE operators ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ/);
    expect(dbsrc).toMatch(/ALTER TABLE operators ADD COLUMN IF NOT EXISTS hired_at TIMESTAMPTZ DEFAULT NOW\(\)/);
  });

  test('preserves existing data: is_active = active, helpers permanent, hired_at backfilled', () => {
    expect(dbsrc).toMatch(/UPDATE operators SET is_active = active\s*WHERE is_active IS DISTINCT FROM active/);
    expect(dbsrc).toMatch(/UPDATE operators SET is_temporary = FALSE WHERE is_temporary IS NULL/);
    expect(dbsrc).toMatch(/UPDATE operators SET hired_at = COALESCE\(hired_at, created_at, NOW\(\)\)/);
  });

  test('expiry index for the helper-expiry cron', () => {
    expect(dbsrc).toMatch(/CREATE INDEX IF NOT EXISTS idx_operators_expiry\s*ON operators \(expires_at\) WHERE is_temporary = TRUE AND is_active = TRUE/);
  });

  test('decision documented: active stays canonical, is_active mirrors it', () => {
    expect(dbsrc).toMatch(/the legacy active column stays the canonical/);
    expect(dbsrc).toMatch(/kept ALWAYS equal to active/);
  });
});
