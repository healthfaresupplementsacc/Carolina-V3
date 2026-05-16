'use strict';
// BUG AMPM — clock times must render 12h AM/PM by default (Florida
// admins), with an opt-in 24h "military" toggle. DB stays timestamptz
// (UTC); only the DISPLAY changes; always ET. Pins the shared helper,
// the app_state toggle, the carolina-config endpoint, the client
// mirror, and that the rendering points use the helper.
const fs = require('fs');
const path = require('path');
const { formatTime, is24h } = require('../utils/time');

// 21:24Z = 17:24 ET → "5:24 PM"; 13:30Z = 09:30 ET → "9:30 AM".
const T_1724 = '2026-05-16T21:24:00.000Z';
const T_0930 = '2026-05-16T13:30:00.000Z';

describe('BUG AMPM — src/utils/time.formatTime', () => {
  test('default is 12h AM/PM, in ET', () => {
    expect(formatTime(T_1724)).toBe('5:24 PM');
    expect(formatTime(T_0930)).toBe('9:30 AM');
  });
  test('24h opt-in renders military (leading-zero hour)', () => {
    expect(formatTime(T_1724, { format: '24h' })).toBe('17:24');
    expect(formatTime(T_0930, { format: '24h' })).toBe('09:30');
    expect(formatTime(T_1724, { format24: true })).toBe('17:24');
  });
  test('noon / midnight / bad input', () => {
    expect(formatTime('2026-05-16T16:00:00.000Z')).toBe('12:00 PM'); // noon ET
    expect(formatTime('2026-05-16T04:00:00.000Z')).toBe('12:00 AM'); // midnight ET
    expect(formatTime(null)).toBe('--');
    expect(formatTime('garbage')).toBe('--');
    expect(formatTime(null, { empty: '—' })).toBe('—');
  });
  test('no narrow-no-break space leaks before AM/PM', () => {
    expect(formatTime(T_1724)).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });
  test('is24h helper', () => {
    expect(is24h({ format: '24h' })).toBe(true);
    expect(is24h({ format24: true })).toBe(true);
    expect(is24h({ format: '12h' })).toBe(false);
    expect(is24h()).toBe(false);
  });
});

describe('BUG AMPM — app_state.time_format toggle (default 12h, sync cache)', () => {
  jest.resetModules();
  jest.doMock('../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
  const appState = require('../app-state');

  test('default is 12h when key absent', async () => {
    expect(await appState.getTimeFormat()).toBe('12h');
    expect(appState.TIME_FORMAT_DEFAULT).toBe('12h');
  });
  test('setTimeFormat persists, normalizes junk, refreshes sync cache', async () => {
    expect(await appState.setTimeFormat('24h')).toBe('24h');
    expect(appState.getTimeFormatSync()).toBe('24h');
    expect(await appState.setTimeFormat('lol')).toBe('12h'); // junk → 12h
    expect(appState.getTimeFormatSync()).toBe('12h');
  });
});

describe('BUG AMPM — carolina-config endpoint', () => {
  jest.resetModules();
  jest.doMock('../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
  jest.doMock('../admin/audit', () => ({
    checkPin: () => true,
    auditAction: jest.fn().mockResolvedValue(),
    snapshotRow: jest.fn().mockResolvedValue(null),
  }));
  const express = require('express');
  const http = require('http');
  const { auditAction } = require('../admin/audit');

  function req(method, url, body) {
    return new Promise((resolve) => {
      const app = express(); app.use(express.json());
      app.use('/api', require('../routes/api'));
      const s = app.listen(0, () => {
        const port = s.address().port;
        const data = body ? JSON.stringify(body) : null;
        const r = http.request({ hostname: '127.0.0.1', port, path: url, method,
          headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
          (res) => { let c = ''; res.on('data', (d) => { c += d; });
            res.on('end', () => { s.close(); let b; try { b = JSON.parse(c); } catch { b = c; } resolve({ status: res.statusCode, body: b }); }); });
        r.on('error', () => { s.close(); resolve({ status: 0 }); });
        if (data) r.write(data); r.end();
      });
    });
  }

  test('GET snapshot includes time_format', async () => {
    const r = await req('GET', '/api/admin/carolina-config?pin=510510');
    expect(r.status).toBe(200);
    expect(['12h', '24h']).toContain(r.body.time_format);
  });
  test('POST /time-format validates + audits', async () => {
    const bad = await req('POST', '/api/admin/carolina-config/time-format', { pin: '510510', format: 'xx' });
    expect(bad.status).toBe(400);
    const ok = await req('POST', '/api/admin/carolina-config/time-format', { pin: '510510', format: '24h' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, time_format: '24h' });
    expect(auditAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'carolina_config.time_format', entityType: 'app_state',
    }));
  });
});

describe('BUG AMPM — dashboard client mirror', () => {
  const { generateDashboard } = require('../dashboard/template');
  const HTML = generateDashboard();

  // Extract the client formatTime() and run it with a controllable
  // _timeFormat, like the served browser code would.
  function clientFormatTime(tf) {
    const start = HTML.indexOf('function formatTime(ts)');
    let i = HTML.indexOf('{', start), depth = 0, end = -1;
    for (; i < HTML.length; i++) {
      if (HTML[i] === '{') depth++;
      else if (HTML[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    // eslint-disable-next-line no-new-func
    return new Function('_timeFormat',
      HTML.slice(start, end) + '; return formatTime;')(tf);
  }

  test('client formatTime defaults to 12h AM/PM', () => {
    const f = clientFormatTime('12h');
    expect(f(T_1724)).toBe('5:24 PM');
    expect(f(T_0930)).toBe('9:30 AM');
  });
  test('client formatTime honors the 24h toggle', () => {
    const f = clientFormatTime('24h');
    expect(f(T_1724)).toBe('17:24');
  });
  test('renderAll adopts data.timeFormat; /api/dashboard sends timeFormat', () => {
    expect(HTML).toMatch(/_timeFormat = data\.timeFormat === '24h' \? '24h' : '12h'/);
    const api = fs.readFileSync(path.join(__dirname, '..', 'routes', 'api.js'), 'utf8');
    expect(api).toMatch(/timeFormat: await appState\.getTimeFormat\(\)/);
  });
});

describe('BUG AMPM — server rendering points use the shared helper', () => {
  test('Carolina context (dm-handler), EOD summary, operator page', () => {
    const dm = fs.readFileSync(path.join(__dirname, '..', 'slack', 'dm-handler.js'), 'utf8');
    expect(dm).toMatch(/require\('\.\.\/utils\/time'\)/);
    expect(dm).toMatch(/getTimeFormat\(\)/);
    const eod = fs.readFileSync(path.join(__dirname, '..', 'eod.js'), 'utf8');
    expect(eod).toMatch(/require\('\.\/utils\/time'\)/);
    expect(eod).toMatch(/getTimeFormatSync\(\)/);
    const router = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'router.js'), 'utf8');
    expect(router).toMatch(/require\('\.\.\/utils\/time'\)/);
    // config page exposes the 12h/24h control
    expect(router).toMatch(/Formato de hora/);
    expect(router).toMatch(/saveTimeFormat\('24h'\)/);
  });
});
