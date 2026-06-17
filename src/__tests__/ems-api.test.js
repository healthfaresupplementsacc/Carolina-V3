'use strict';
/* EMS Production API client — unit (fetch mockado, chave de teste; sem rede real). */
const { createEmsClient, ENDPOINTS } = require('../v3/services/ems-api');

const ok = (body, status = 200) => () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
function capturing(caps, resp) { return async (url, init) => { caps.push({ url, init }); return resp(); }; }

describe('EMS Production API client', () => {
  test('sem chave: configured() false e get() lança no_key (não chama fetch)', async () => {
    let called = false;
    const c = createEmsClient({ apiKey: null, fetchImpl: async () => { called = true; return ok({})(); } });
    expect(c.configured()).toBe(false);
    await expect(c.overview()).rejects.toMatchObject({ code: 'no_key' });
    expect(called).toBe(false);
  });

  test('manda x-api-key do ambiente + normaliza a URL', async () => {
    const caps = [];
    const c = createEmsClient({ apiKey: 'k-123', baseUrl: 'https://ems.test/api/', fetchImpl: capturing(caps, ok({ generated_at: 'now', formulas: { active: 1 } })) });
    expect(c.configured()).toBe(true);
    const r = await c.overview();
    expect(r.generated_at).toBe('now');
    expect(caps[0].url).toBe('https://ems.test/api/overview'); // barra final normalizada
    expect(caps[0].init.headers['x-api-key']).toBe('k-123');
    expect(caps[0].init.method).toBe('GET');
  });

  test('os 6 endpoints batem no path certo', async () => {
    const caps = [];
    const c = createEmsClient({ apiKey: 'k', baseUrl: 'https://ems.test', fetchImpl: capturing(caps, ok({})) });
    for (const name of ENDPOINTS) { await c[name](); }
    expect(caps.map((x) => x.url)).toEqual(ENDPOINTS.map((n) => 'https://ems.test/' + n));
    expect(ENDPOINTS).toEqual(['overview', 'formulas', 'pipeline', 'line', 'products', 'employees']);
  });

  test('401 → unauthorized; 500 → http_error', async () => {
    const c401 = createEmsClient({ apiKey: 'bad', fetchImpl: ok({ error: 'x' }, 401) });
    await expect(c401.overview()).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    const c500 = createEmsClient({ apiKey: 'k', fetchImpl: ok({}, 500) });
    await expect(c500.line()).rejects.toMatchObject({ code: 'http_error', status: 500 });
  });

  test('erro de rede → code network e NÃO vaza a chave na mensagem', async () => {
    const c = createEmsClient({ apiKey: 'super-secret-key', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    let msg = '';
    try { await c.pipeline(); } catch (e) { expect(e.code).toBe('network'); msg = e.message; }
    expect(msg).not.toContain('super-secret-key');
  });
});
