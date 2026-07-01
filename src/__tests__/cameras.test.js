'use strict';
/* Câmeras — auth por sessão (PIN nunca em URL), proxy 503-fail-soft, brute-force ban.
   Cobre os achados do review adversarial: token curto em vez de PIN na query,
   lockout após 10 PINs errados, 503 quando envs faltam / upstream off. */
const express = require('express');

const ENV_KEYS = ['CAM_TUNNEL_URL', 'CAM_TOKEN', 'CAM_VIEW_PIN'];
const saved = {};

describe('câmeras — /api/cam', () => {
  let server, base;
  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.CAM_TUNNEL_URL = 'http://127.0.0.1:1'; // porta 1 → ECONNREFUSED → 503
    process.env.CAM_TOKEN = 'test-cam-secret';
    process.env.CAM_VIEW_PIN = '510510';
    const app = express();
    app.use('/', require('../routes/cameras'));
    server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    if (server) await new Promise((r) => server.close(r));
  });
  const session = (pin) => fetch(base + '/api/cam/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
  });

  test('página /cameras é servida e NÃO usa PIN em URL (?k=)', async () => {
    const r = await fetch(base + '/cameras');
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('PIN das câmeras');
    expect(html).toContain('/api/cam/session');   // troca por token
    expect(html).not.toContain('?k=');            // PIN nunca em query string
  });

  test('sessão: PIN errado → 403; certo → token; token abre o proxy (upstream off → 503)', async () => {
    expect((await session('000000')).status).toBe(403);
    const ok = await session('510510');
    expect(ok.status).toBe(200);
    const { token, expires_at } = await ok.json();
    expect(token).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(expires_at).toBeGreaterThan(Date.now());
    // token válido passa a auth; upstream (porta 1) recusa → 503, nunca crash
    const st = await fetch(base + '/api/cam/warehouse?t=' + encodeURIComponent(token));
    expect(st.status).toBe(503);
    expect((await st.json()).error).toBe('cameras_offline');
  });

  test('stream sem token / token adulterado / expirado → 403; câmera desconhecida → 404', async () => {
    expect((await fetch(base + '/api/cam/warehouse')).status).toBe(403);
    expect((await fetch(base + '/api/cam/warehouse?t=123.deadbeef')).status).toBe(403);
    // expirado: assina com o segredo real mas exp no passado
    const crypto = require('crypto');
    const exp = Date.now() - 1000;
    const mac = crypto.createHmac('sha256', 'test-cam-secret').update('cam:' + exp).digest('hex');
    expect((await fetch(base + '/api/cam/warehouse?t=' + exp + '.' + mac)).status).toBe(403);
    expect((await fetch(base + '/api/cam/nope?t=x')).status).toBe(404);
  });

  test('envs faltando → 503 cameras_offline (feature desligada, V4 intacto)', async () => {
    const old = process.env.CAM_VIEW_PIN;
    delete process.env.CAM_VIEW_PIN;
    expect((await session('510510')).status).toBe(503);
    process.env.CAM_VIEW_PIN = old;
  });

  // ÚLTIMO teste do arquivo: bane o IP (estado do guard é module-level).
  test('brute force: 10 PINs errados → ban (429 no gate)', async () => {
    for (let i = 0; i < 10; i++) await session('wrong-' + i);
    const r = await session('510510'); // até o PIN CERTO é barrado depois do ban
    expect(r.status).toBe(429);
    expect((await r.json()).error).toBe('ip_temporarily_blocked');
  });
});
