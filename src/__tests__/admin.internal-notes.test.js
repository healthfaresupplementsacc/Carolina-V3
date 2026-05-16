'use strict';
jest.mock('../db');
jest.mock('../slack/client');
const db = require('../db');
const express = require('express');
const fs = require('fs');
const path = require('path');

function mk(routerPath) {
  const a = express(); a.use(express.json());
  a.use('/api', require(routerPath));
  return a;
}
function req(routerPath, method, url, body) {
  return new Promise((resolve) => {
    const http = require('http');
    const s = mk(routerPath).listen(0, () => {
      const port = s.address().port;
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({ hostname: '127.0.0.1', port, path: url, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
        (res) => { let c=''; res.on('data',x=>c+=x); res.on('end',()=>{ s.close(); let b; try{b=JSON.parse(c);}catch{b=c;} resolve({status:res.statusCode,body:b}); }); });
      r.on('error', () => { s.close(); resolve({ status: 0 }); });
      if (data) r.write(data); r.end();
    });
  });
}

beforeEach(() => { jest.clearAllMocks(); });

describe('A3 — admin internal notes', () => {
  test('POST wrong PIN blocked', async () => {
    db.query = jest.fn();
    const r = await req('../routes/workflow', 'POST', '/api/admin/admin-note',
      { pin: 'x', entity_type: 'phase_instance', entity_id: 5, text: 'hi' });
    expect(r.status).toBe(403);
  });

  test('POST sets admin_notes + audits', async () => {
    const seen = [];
    db.query = jest.fn().mockImplementation((sql) => {
      seen.push(sql);
      if (/SELECT admin_notes FROM phase_instances/.test(sql)) return Promise.resolve({ rows: [{ admin_notes: null }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await req('../routes/workflow', 'POST', '/api/admin/admin-note',
      { pin: '510510', entity_type: 'phase_instance', entity_id: 5, text: 'máquina solta' });
    expect(r.status).toBe(200);
    expect(seen.some(s => /UPDATE phase_instances SET admin_notes/.test(s))).toBe(true);
    expect(seen.some(s => /INSERT INTO admin_audit_log/.test(s))).toBe(true);
  });

  test('invalid entity_type rejected', async () => {
    db.query = jest.fn();
    const r = await req('../routes/workflow', 'POST', '/api/admin/admin-note',
      { pin: '510510', entity_type: 'tasks', entity_id: 1, text: 'x' });
    expect(r.status).toBe(400);
  });

  test('GET requires PIN, returns text', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ admin_notes: 'segredo' }] });
    const bad = await req('../routes/workflow', 'GET', '/api/admin/admin-note?entity_type=phase_instance&entity_id=5');
    expect(bad.status).toBe(403);
    const ok = await req('../routes/workflow', 'GET', '/api/admin/admin-note?pin=510510&entity_type=phase_instance&entity_id=5');
    expect(ok.status).toBe(200);
    expect(ok.body.text).toBe('segredo');
  });

  test('no leak — dashboard union query never SELECTs admin_notes', () => {
    const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'api.js'), 'utf8');
    // the workflow union block in /api/dashboard must not pull admin_notes
    const unionBlock = apiSrc.slice(
      apiSrc.indexOf('Bug 4 — UNION'),
      apiSrc.indexOf('openTasksEst.push(')
    );
    expect(unionBlock).not.toMatch(/admin_notes/);
  });
});
