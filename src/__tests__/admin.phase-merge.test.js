'use strict';
jest.mock('../db');
jest.mock('../slack/client');
const db = require('../db');
const express = require('express');

function app() { const a = express(); a.use(express.json()); a.use('/api', require('../routes/workflow')); return a; }
function req(method, url, body) {
  return new Promise((resolve) => {
    const http = require('http');
    const s = app().listen(0, () => {
      const port = s.address().port; const data = body ? JSON.stringify(body) : null;
      const r = http.request({ hostname: '127.0.0.1', port, path: url, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
        (res) => { let c=''; res.on('data',x=>c+=x); res.on('end',()=>{ s.close(); let b; try{b=JSON.parse(c);}catch{b=c;} resolve({status:res.statusCode,body:b}); }); });
      r.on('error', () => { s.close(); resolve({ status: 0 }); });
      if (data) r.write(data); r.end();
    });
  });
}
beforeEach(() => { jest.clearAllMocks(); });

describe('W5 — phase_instances merge', () => {
  test('needs 2+ ids', async () => {
    db.query = jest.fn();
    const r = await req('POST', '/api/admin/phase-instances/merge', { pin: '510510', phase_ids: [1] });
    expect(r.status).toBe(400);
  });

  test('oldest survives; others soft-deleted; oal re-pointed; audited', async () => {
    const seen = [];
    db.query = jest.fn().mockImplementation((sql) => {
      seen.push(sql);
      if (/SELECT id, started_at, phase_name FROM phase_instances\s+WHERE id = ANY/.test(sql)) {
        return Promise.resolve({ rows: [
          { id: 10, started_at: '2026-05-16T10:00Z', phase_name: 'Mix' },
          { id: 11, started_at: '2026-05-16T11:00Z', phase_name: 'Mixagem' },
        ]});
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await req('POST', '/api/admin/phase-instances/merge', { pin: '510510', phase_ids: [11, 10] });
    expect(r.status).toBe(200);
    expect(r.body.survivor_id).toBe(10);   // oldest
    expect(r.body.merged_ids).toEqual([11]);
    expect(seen.some(s => /UPDATE operator_activity_log SET phase_instance_id/.test(s))).toBe(true);
    expect(seen.some(s => /UPDATE phase_instances\s+SET status = 'deleted'/.test(s))).toBe(true);
    expect(seen.some(s => /INSERT INTO task_aliases/.test(s))).toBe(true);
    expect(seen.some(s => /INSERT INTO admin_audit_log/.test(s))).toBe(true);
  });

  test('wrong PIN blocked', async () => {
    db.query = jest.fn();
    const r = await req('POST', '/api/admin/phase-instances/merge', { pin: 'x', phase_ids: [1, 2] });
    expect(r.status).toBe(403);
  });
});
