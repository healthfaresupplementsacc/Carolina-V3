'use strict';
// BUG IDENTIDADE — Carolina called Bruno "presidente" and didn't know
// the hierarchy. Pins: role lookup, the hierarchy seed, the prompt
// rules, the API role enum, and the admin dropdown.
jest.mock('../db');
const db = require('../db');
const at = require('../ai/admin-tools');
const fs = require('fs');
const path = require('path');

beforeEach(() => { jest.clearAllMocks(); });

const ROLE = { bruno: 'owner', 'bruno camp': 'owner', thassio: 'owner',
  'henrique monteiro': 'manager', ana: 'operator' };
function wire() {
  db.query = jest.fn((sql, p) => {
    if (/FROM operators\s+WHERE id = \$1/.test(sql)) {
      return Promise.resolve({ rows: [{ id: p[0], name: 'X', role: 'owner' }] });
    }
    if (/FROM operators/.test(sql)) {
      const r = ROLE[String(p[0]).toLowerCase()];
      return Promise.resolve({ rows: r ? [{ id: 1, name: p[0], role: r }] : [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('BUG IDENTIDADE — role lookup', () => {
  test('owners + manager + operator resolve to their role', async () => {
    wire();
    expect(await at.getOperatorRole('Bruno')).toBe('owner');
    expect(await at.getOperatorRole('Thassio')).toBe('owner');
    expect(await at.getOperatorRole('Henrique Monteiro')).toBe('manager');
    expect(await at.getOperatorRole('Ana')).toBe('operator');
    expect(await at.getOperatorRole('Ninguém')).toBeNull();
  });
  test('resolveOperator returns id+name+role', async () => {
    wire();
    const op = await at.resolveOperator('Thassio');
    expect(op).toMatchObject({ name: 'Thassio', role: 'owner' });
    expect(typeof op.id).toBe('number');
  });
});

describe('BUG IDENTIDADE — hierarchy seed migration', () => {
  test('db migrate seeds Thassio/Henrique + sets owner by Bruno slack id', () => {
    const dbsrc = fs.readFileSync(path.join(__dirname, '..', 'db', 'index.js'), 'utf8');
    expect(dbsrc).toMatch(/UPDATE operators SET role = 'owner'[\s\S]*slack_user_id = 'U03URLL1D4L'/);
    expect(dbsrc).toMatch(/'Thassio', *'U03S46L2EUA', *FALSE, *'owner'/);
    expect(dbsrc).toMatch(/'Henrique Monteiro', *'U085SDY3F4Z', *FALSE, *'manager'/);
    expect(dbsrc).toMatch(/SET role = 'operator'[\s\S]*role IS NULL OR btrim\(role\) = ''/);
  });
});

describe('BUG IDENTIDADE — prompt knows who runs the show', () => {
  test('hierarchy + obey + no "presidente" + dont volunteer', () => {
    const dm = fs.readFileSync(path.join(__dirname, '..', 'slack', 'dm-handler.js'), 'utf8');
    expect(dm).toMatch(/HIERARQUIA/);
    expect(dm).toMatch(/Bruno Camp e Thassio são os OWNERS/);
    expect(dm).toMatch(/Henrique Monteiro é o\s+MANAGER/);
    expect(dm).toMatch(/OBEDECE, sem questionar/);
    expect(dm).toMatch(/NUNCA\s+use "presidente", "chefe"/);
    expect(dm).toMatch(/Não mencione a hierarquia espontaneamente/);
  });
});

describe('BUG IDENTIDADE — API role is an enum', () => {
  jest.resetModules();
  jest.doMock('../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [{ id: 1 }] }) }));
  jest.doMock('../admin/audit', () => ({
    checkPin: () => true, auditAction: jest.fn().mockResolvedValue(),
    snapshotRow: jest.fn().mockResolvedValue({ id: 1 }),
  }));
  const express = require('express');
  const http = require('http');
  function req(method, url, body) {
    return new Promise((resolve) => {
      const app = express(); app.use(express.json());
      app.use('/api', require('../routes/api'));
      const s = app.listen(0, () => {
        const port = s.address().port; const data = body ? JSON.stringify(body) : null;
        const r = http.request({ hostname: '127.0.0.1', port, path: url, method,
          headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
          (res) => { let c = ''; res.on('data', d => c += d);
            res.on('end', () => { s.close(); let b; try { b = JSON.parse(c); } catch { b = c; } resolve({ status: res.statusCode, body: b }); }); });
        r.on('error', () => { s.close(); resolve({ status: 0 }); });
        if (data) r.write(data); r.end();
      });
    });
  }
  test('invalid role rejected (create + edit)', async () => {
    const c = await req('POST', '/api/admin/operator/create', { pin: '510510', name: 'X', role: 'king' });
    expect(c.status).toBe(400);
    const e = await req('PUT', '/api/admin/operator/1', { pin: '510510', role: 'boss' });
    expect(e.status).toBe(400);
  });
  test('valid role accepted', async () => {
    const c = await req('POST', '/api/admin/operator/create', { pin: '510510', name: 'Y', role: 'manager' });
    expect(c.status).toBe(200);
  });
});

describe('BUG IDENTIDADE — admin UI role dropdown', () => {
  test('/admin/operators renders a <select> for role (owner/manager/operator)', () => {
    const router = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'router.js'), 'utf8');
    expect(router).toMatch(/<select id="op-role-/);
    expect(router).toMatch(/<select id="new-op-role"/);
    expect(router).toMatch(/\['operator','manager','owner'\]/);
  });
});
