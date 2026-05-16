'use strict';
jest.mock('../db');
jest.mock('../slack/client');
const db = require('../db');
const express = require('express');

function app() {
  const a = express(); a.use(express.json());
  a.use('/api', require('../routes/workflow'));
  return a;
}
function req(method, url, body) {
  return new Promise((resolve) => {
    const http = require('http');
    const s = app().listen(0, () => {
      const port = s.address().port;
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({ hostname: '127.0.0.1', port, path: url, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
        (res) => { let c = ''; res.on('data', x => c += x); res.on('end', () => { s.close(); let b; try { b = JSON.parse(c); } catch { b = c; } resolve({ status: res.statusCode, body: b }); }); });
      r.on('error', () => { s.close(); resolve({ status: 0 }); });
      if (data) r.write(data); r.end();
    });
  });
}

beforeEach(() => { jest.clearAllMocks(); });

describe('A1 — POST /admin/operator-activity-log (retroactive entry)', () => {
  test('wrong PIN blocked', async () => {
    db.query = jest.fn();
    const r = await req('POST', '/api/admin/operator-activity-log', { pin: 'nope', operator_id: 5, activity_type: 'phase', started_at: '2026-05-16 10:00' });
    expect(r.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('correct PIN inserts + audits', async () => {
    const seen = [];
    db.query = jest.fn().mockImplementation((sql, p) => {
      seen.push(sql);
      if (/INSERT INTO operator_activity_log/.test(sql)) return Promise.resolve({ rows: [{ id: 42 }] });
      if (/SELECT \* FROM operator_activity_log WHERE id/.test(sql)) return Promise.resolve({ rows: [{ id: 42 }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await req('POST', '/api/admin/operator-activity-log', {
      pin: '510510', operator_id: 5, activity_type: 'break',
      started_at: '2026-05-16 12:00', ended_at: '2026-05-16 12:45',
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(42);
    expect(seen.some(s => /INSERT INTO operator_activity_log/.test(s))).toBe(true);
    expect(seen.some(s => /INSERT INTO admin_audit_log/.test(s))).toBe(true);
  });

  test('validates activity_type + required fields', async () => {
    db.query = jest.fn();
    let r = await req('POST', '/api/admin/operator-activity-log', { pin: '510510', operator_id: 5, activity_type: 'bogus', started_at: 'x' });
    expect(r.status).toBe(400);
    r = await req('POST', '/api/admin/operator-activity-log', { pin: '510510', activity_type: 'phase', started_at: 'x' });
    expect(r.status).toBe(400); // no operator_id
    r = await req('POST', '/api/admin/operator-activity-log', { pin: '510510', operator_id: 5, activity_type: 'phase' });
    expect(r.status).toBe(400); // no started_at
  });
});
