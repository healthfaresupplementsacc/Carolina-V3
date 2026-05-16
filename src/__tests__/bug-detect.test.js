'use strict';
// BUG DETECT — every boot logged "column admin_approved does not exist":
// detect.js supplementsPending() queried supplement_catalog.admin_approved
// which never existed. DECISION: add the column (DEFAULT TRUE) rather
// than delete the query (catalog presence already == approved), and
// record that decision in admin_audit_log.
const fs = require('fs');
const path = require('path');
const dbsrc = fs.readFileSync(path.join(__dirname, '..', 'db', 'index.js'), 'utf8');
const detectsrc = fs.readFileSync(path.join(__dirname, '..', 'ai', 'detect.js'), 'utf8');

describe('BUG DETECT — migration adds the column + audits the decision', () => {
  test('ALTER TABLE adds admin_approved BOOLEAN DEFAULT TRUE', () => {
    expect(dbsrc).toMatch(/ALTER TABLE supplement_catalog\s+ADD COLUMN IF NOT EXISTS admin_approved BOOLEAN DEFAULT TRUE/);
  });

  test('decision is recorded in admin_audit_log, idempotently', () => {
    expect(dbsrc).toMatch(/INSERT INTO admin_audit_log[\s\S]*'schema\.decision', 'supplement_catalog', 'admin_approved'/);
    expect(dbsrc).toMatch(/WHERE NOT EXISTS \(\s*SELECT 1 FROM admin_audit_log\s*WHERE action = 'schema\.decision' AND entity_id = 'admin_approved'/);
  });

  test('the decision-audit INSERT runs AFTER admin_audit_log is created (no boot failure)', () => {
    const createIdx = dbsrc.indexOf('CREATE TABLE IF NOT EXISTS admin_audit_log');
    const insertIdx = dbsrc.indexOf("'schema.decision', 'supplement_catalog'");
    expect(createIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(createIdx);
  });
});

describe('BUG DETECT — detect.js query now valid (kept, not deleted)', () => {
  test('supplementsPending still selects supplement_catalog.admin_approved', () => {
    expect(detectsrc).toMatch(/FROM supplement_catalog\s+WHERE admin_approved = FALSE/);
  });

  test('supplementsPending maps rows without throwing (column now exists)', async () => {
    jest.resetModules();
    jest.doMock('../db', () => ({
      query: jest.fn().mockResolvedValue({ rows: [{ canonical_name: 'Berberine' }] }),
    }));
    const detect = require('../ai/detect');
    const out = await detect.supplementsPending();
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      proposalType: 'approve_supplement', targetEntityId: 'Berberine',
    });
  });

  test('default TRUE → real catalog has 0 pending (no spurious reminders)', async () => {
    jest.resetModules();
    jest.doMock('../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
    const detect = require('../ai/detect');
    expect(await detect.supplementsPending()).toEqual([]);
  });
});
