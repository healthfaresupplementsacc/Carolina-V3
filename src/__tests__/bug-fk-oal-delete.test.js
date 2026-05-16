'use strict';
// BUG FK — deleting a duplicated break failed with
// "violates foreign key constraint operator_activity_log_came_back_from_id_fkey":
// operator_activity_log self-references (a "volta" row -> came_back_from_id,
// a "saída" row -> left_for_id). The DELETE endpoint now untethers those
// rows first, records them in the audit, and maps any residual FK error
// to a friendly message instead of raw Postgres text.
jest.mock('../db');
jest.mock('../admin/audit', () => ({
  checkPin: jest.fn(() => true),
  snapshotRow: jest.fn(() => Promise.resolve({ id: 10, activity_type: 'break' })),
  auditAction: jest.fn(() => Promise.resolve()),
}));
const db = require('../db');
const { auditAction } = require('../admin/audit');
const express = require('express');
const http = require('http');

function request(method, url) {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api', require('../routes/workflow'));
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method }, (res) => {
        let c = ''; res.on('data', (d) => { c += d; });
        res.on('end', () => { server.close(); let b; try { b = JSON.parse(c); } catch { b = c; } resolve({ status: res.statusCode, body: b }); });
      });
      req.on('error', () => { server.close(); resolve({ status: 0, body: null }); });
      req.end();
    });
  });
}
beforeEach(() => { jest.clearAllMocks(); });

describe('BUG FK — DELETE untethers self-references then deletes', () => {
  test('NULLs came_back_from_id + left_for_id, deletes, audits untethered rows', async () => {
    const sqls = [];
    db.query = jest.fn((sql, p) => {
      sqls.push({ sql: sql.replace(/\s+/g, ' ').trim(), p });
      if (/UPDATE operator_activity_log SET came_back_from_id = NULL/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 11 }] }); // the "volta" row
      }
      if (/UPDATE operator_activity_log SET left_for_id = NULL/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 9 }] });  // the "saída" row
      }
      return Promise.resolve({ rows: [] });
    });

    const r = await request('DELETE', '/api/admin/operator-activity-log/10?pin=510510');

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, untethered: { came_back_from: [11], left_for: [9] } });

    // order: untether BOTH links, THEN delete
    const cbIdx = sqls.findIndex((s) => /came_back_from_id = NULL/.test(s.sql));
    const lfIdx = sqls.findIndex((s) => /left_for_id = NULL/.test(s.sql));
    const delIdx = sqls.findIndex((s) => /^DELETE FROM operator_activity_log/.test(s.sql));
    expect(cbIdx).toBeGreaterThan(-1);
    expect(lfIdx).toBeGreaterThan(-1);
    expect(delIdx).toBeGreaterThan(Math.max(cbIdx, lfIdx));
    expect(sqls[cbIdx].sql).toMatch(/WHERE came_back_from_id = \$1 RETURNING id/);
    expect(sqls[lfIdx].sql).toMatch(/WHERE left_for_id = \$1 RETURNING id/);

    // audit oal.delete keeps before + records the untethered rows
    expect(auditAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'oal.delete', entityType: 'operator_activity_log', entityId: 10,
      after: { deleted: true, untethered: { came_back_from: [11], left_for: [9] } },
    }));
  });

  test('residual FK violation → friendly 409, never raw Postgres text', async () => {
    db.query = jest.fn((sql) => {
      if (/UPDATE operator_activity_log SET/.test(sql)) return Promise.resolve({ rows: [] });
      if (/^DELETE FROM operator_activity_log/.test(sql)) {
        const e = new Error('update or delete on table "operator_activity_log" violates foreign key constraint "operator_activity_log_came_back_from_id_fkey"');
        e.code = '23503';
        return Promise.reject(e);
      }
      return Promise.resolve({ rows: [] });
    });

    const r = await request('DELETE', '/api/admin/operator-activity-log/10?pin=510510');

    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/não consegui excluir/i);
    expect(r.body.error).not.toMatch(/foreign key|constraint|operator_activity_log_came_back/i);
  });
});
