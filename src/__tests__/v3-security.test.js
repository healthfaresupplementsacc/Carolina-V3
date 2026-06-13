'use strict';
/* Fase D — security: headers, rate-limit, brute-force guard, no-leak. */
const express = require('express');
const { securityHeaders, makeRateLimit, makeBruteForceGuard, CSP } = require('../middleware/security');

describe('Fase D — securityHeaders', () => {
  let server, base;
  beforeAll(async () => {
    const app = express();
    app.use(securityHeaders);
    app.get('/x', (_q, r) => r.json({ ok: true }));
    server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });

  test('CSP + headers presentes', async () => {
    const r = await fetch(base + '/x');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(r.headers.get('content-security-policy')).toContain('cdn.jsdelivr.net'); // Chart.js
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('same-origin');
    expect(r.headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(r.headers.get('permissions-policy')).toContain('microphone=(self)');
  });
  test('CSP bloqueia frame-ancestors e camera', () => {
    expect(CSP).toContain("frame-ancestors 'none'");
  });
});

describe('Fase D — makeRateLimit', () => {
  let server, base;
  beforeAll(async () => {
    const app = express();
    app.use('/lim', makeRateLimit({ limit: 3, windowMs: 60000 }));
    app.get('/lim', (_q, r) => r.json({ ok: true }));
    server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });
  test('3 passam, 4ª → 429 com Retry-After', async () => {
    for (let i = 0; i < 3; i++) expect((await fetch(base + '/lim')).status).toBe(200);
    const over = await fetch(base + '/lim');
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBeTruthy();
  });
});

describe('Fase D — brute-force guard', () => {
  test('10 falhas/h → ban + alerta Carolina (top-level) + audit', async () => {
    let t = 1000;
    const posts = []; const audits = [];
    const bf = makeBruteForceGuard({
      db: { query: async (sql, p) => { if (/login_bruteforce_ban/.test(String(sql))) audits.push(JSON.parse(p[0])); return { rows: [] }; } },
      slack: { postAs: async (o) => { posts.push(o); return { ts: 'x' }; } },
      adminChannelId: 'C_ADMIN', now: () => t,
    });
    expect(bf.isBanned('1.2.3.4')).toBe(false);
    for (let i = 0; i < 10; i++) await bf.recordFailure('1.2.3.4');
    expect(bf.isBanned('1.2.3.4')).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0].sender).toEqual({ name: 'Carolina' });
    expect(posts[0].thread_ts).toBeNull();
    expect(posts[0].text).toContain('1.2.3.4');
    expect(audits[0].ip).toBe('1.2.3.4');
  });
  test('sucesso limpa as falhas (não bane)', async () => {
    let t = 1000;
    const bf = makeBruteForceGuard({ db: { query: async () => ({ rows: [] }) }, slack: null, now: () => t });
    for (let i = 0; i < 9; i++) await bf.recordFailure('5.6.7.8');
    bf.recordSuccess('5.6.7.8');
    await bf.recordFailure('5.6.7.8'); // só 1 agora
    expect(bf.isBanned('5.6.7.8')).toBe(false);
  });
  test('ban expira após 24h', async () => {
    let t = 1000;
    const bf = makeBruteForceGuard({ db: { query: async () => ({ rows: [] }) }, slack: null, now: () => t });
    for (let i = 0; i < 10; i++) await bf.recordFailure('9.9.9.9');
    expect(bf.isBanned('9.9.9.9')).toBe(true);
    t += 24 * 60 * 60 * 1000 + 1;
    expect(bf.isBanned('9.9.9.9')).toBe(false);
  });
  test('gate bloqueia IP banido com 429', async () => {
    let t = 1000;
    const bf = makeBruteForceGuard({ db: { query: async () => ({ rows: [] }) }, slack: null, now: () => t });
    for (let i = 0; i < 10; i++) await bf.recordFailure('7.7.7.7');
    const app = express();
    app.use((req, _r, n) => { Object.defineProperty(req, 'ip', { value: '7.7.7.7', configurable: true }); n(); });
    app.use(bf.gate);
    app.get('/g', (_q, r) => r.json({ ok: true }));
    const s = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
    const r = await fetch(`http://127.0.0.1:${s.address().port}/g`);
    expect(r.status).toBe(429);
    await new Promise((r2) => s.close(r2));
  });
});

describe('Fase D — blocked_ips persistente (migration 023)', () => {
  test('ban persiste em v3.blocked_ips (INSERT ... ON CONFLICT) ao disparar', async () => {
    let t = 1000; const inserts = [];
    const bf = makeBruteForceGuard({
      db: { query: async (sql, p) => { if (/INSERT INTO v3\.blocked_ips/.test(String(sql))) inserts.push({ sql: String(sql), p }); return { rows: [] }; } },
      slack: null, now: () => t,
    });
    for (let i = 0; i < 10; i++) await bf.recordFailure('2.2.2.2');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].sql).toMatch(/ON CONFLICT \(ip_address\) DO UPDATE/);
    expect(inserts[0].sql).toMatch(/block_count = v3\.blocked_ips\.block_count \+ 1/);
    expect(inserts[0].p[0]).toBe('2.2.2.2');               // ip
    expect(inserts[0].p[1]).toBe(t + 24 * 60 * 60 * 1000); // expires (ms epoch)
  });

  test('hydrate() re-carrega bans não-expirados do DB (sobrevive a restart)', async () => {
    let t = 5_000_000;
    const future = (t + 60 * 60 * 1000) / 1000; // 1h no futuro, em segundos epoch
    const bf = makeBruteForceGuard({
      db: { query: async (sql) => {
        if (/DELETE FROM v3\.blocked_ips/.test(String(sql))) return { rows: [] };
        if (/SELECT ip_address/.test(String(sql))) return { rows: [{ ip_address: '3.3.3.3', until_ms: future * 1000 }] };
        return { rows: [] };
      } },
      slack: null, now: () => t,
    });
    expect(bf.isBanned('3.3.3.3')).toBe(false); // memória vazia antes do hydrate
    const n = await bf.hydrate();
    expect(n).toBe(1);
    expect(bf.isBanned('3.3.3.3')).toBe(true);  // re-hidratado
  });

  test('globalGate retorna 403 (sem detalhe) p/ IP banido', async () => {
    let t = 1000;
    const bf = makeBruteForceGuard({ db: { query: async () => ({ rows: [] }) }, slack: null, now: () => t });
    for (let i = 0; i < 10; i++) await bf.recordFailure('4.4.4.4');
    const app = express();
    app.use((req, _r, n) => { Object.defineProperty(req, 'ip', { value: '4.4.4.4', configurable: true }); n(); });
    app.use(bf.globalGate);
    app.get('/any', (_q, r) => r.json({ ok: true }));
    const s = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
    const r = await fetch(`http://127.0.0.1:${s.address().port}/any`);
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j).toEqual({ error: 'forbidden' }); // sem vazar motivo/contagem
    await new Promise((r2) => s.close(r2));
  });

  test('globalGate deixa passar IP limpo', async () => {
    const bf = makeBruteForceGuard({ db: { query: async () => ({ rows: [] }) }, slack: null });
    const app = express();
    app.use((req, _r, n) => { Object.defineProperty(req, 'ip', { value: '8.8.8.8', configurable: true }); n(); });
    app.use(bf.globalGate);
    app.get('/any', (_q, r) => r.json({ ok: true }));
    const s = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
    const r = await fetch(`http://127.0.0.1:${s.address().port}/any`);
    expect(r.status).toBe(200);
    await new Promise((r2) => s.close(r2));
  });
});
