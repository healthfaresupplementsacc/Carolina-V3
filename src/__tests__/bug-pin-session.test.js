'use strict';
// BUG PIN — a 10-min admin unlock must be shared across the dashboard
// and EVERY /admin/* page (same localStorage 'hf_admin' {pin,ts}, TTL
// 600000, sliding) so the admin isn't re-prompted page to page.
jest.mock('../db');
const db = require('../db');
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');

function get(url) {
  return new Promise((resolve) => {
    const app = express();
    app.use('/', require('../dashboard/router'));
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get({ hostname: '127.0.0.1', port, path: url }, (res) => {
        let c = ''; res.on('data', (d) => { c += d; });
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: c }); });
      }).on('error', () => { server.close(); resolve({ status: 0, body: '' }); });
    });
  });
}
beforeEach(() => { jest.clearAllMocks(); db.query = jest.fn().mockResolvedValue({ rows: [] }); });

const ADMIN_PAGES = ['/admin', '/admin/audit', '/admin/silent-log',
  '/admin/carolina-config', '/admin/workflows', '/admin/ad-hoc-tasks'];

describe('BUG PIN — every /admin/* page shares the 10-min session', () => {
  for (const url of ADMIN_PAGES) {
    test(`${url}: hf_admin helper + auto-unlock present`, async () => {
      const r = await get(url);
      expect(r.status).toBe(200);
      expect(r.body).toContain("var K='hf_admin',T=600000");          // same key + 10-min TTL
      expect(r.body).toContain('window.hfAdminSave=function');
      expect(r.body).toContain('window.hfAdminClear=function');
      // auto-unlock: valid session → prefill pin + call the page unlock
      expect(r.body).toMatch(/var f=window\.unlock\|\|window\.unlockAdmin;if\(typeof f==='function'\)/);
      // manual unlock on this page persists the shared session
      // (pattern 1: "_pin = pin; try { hfAdminSave(pin) }" / pattern 2:
      //  "_pin=p; try{hfAdminSave(p)}"). Either way hfAdminSave is called
      // in the unlock success path.
      expect(r.body).toMatch(/hfAdminSave\(p(in)?\);/);
    });
  }
});

describe('BUG PIN — shared key/TTL matches the dashboard A2 session', () => {
  test('dashboard uses the same hf_admin key + 10-min window', () => {
    const tpl = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'template.js'), 'utf8');
    expect(tpl).toMatch(/localStorage\.setItem\('hf_admin'/);
    expect(tpl).toMatch(/ADMIN_SESSION_MS = 10 \* 60 \* 1000/);   // 600000 = same TTL
  });
  test('no admin page is missing the snippet (count == pages)', async () => {
    let withSnippet = 0;
    for (const u of ADMIN_PAGES) {
      const r = await get(u);
      if (r.body.includes("var K='hf_admin',T=600000")) withSnippet++;
    }
    expect(withSnippet).toBe(ADMIN_PAGES.length);
  });
});
