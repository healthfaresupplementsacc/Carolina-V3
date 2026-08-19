'use strict';
/**
 * PREFERÊNCIAS POR CONTA — /api/v3/prefs/* (Bruno 08-19).
 *
 *  1. AUTH: PIN válido entra; PIN errado ou ausente → 401.
 *  2. POR CONTA, NÃO POR NAVEGADOR: o que a Simone salva o Henrique não vê.
 *  3. UPSERT: PUT duas vezes na mesma chave sobrescreve, não duplica.
 *  4. CHAVE e TAMANHO: chave fora do padrão → 400; valor acima de 64 KB → 413.
 *  5. EMERGÊNCIA (ADMIN_PIN, login sem id): GET devolve account:null e prefs {},
 *     PUT/DELETE devolvem 409 no_account com o texto em português. Nunca 500,
 *     nunca grava linha órfã.
 *  6. AUSÊNCIA NÃO É ERRO: chave nunca salva → 200 com value null.
 *
 * Express de verdade num socket efêmero (padrão do print-queue.test.js); banco
 * falso em memória com linhas realistas. PINs FICTÍCIOS.
 */
const express = require('express');
const { createPrefsRouter, MSG_NO_ACCOUNT } = require('../v3/prefs/router');

const HENRIQUE_PIN = '111111';   // fictício — login id 1
const SIMONE_PIN = '222222';     // fictício — login id 2
const EMERGENCY_PIN = '987654';  // fictício — ADMIN_PIN do env, login SEM id

const LAYOUT = {
  grid: [
    { id: 'producao', x: 3, y: 0, w: 3, h: 4, on: true },
    { id: 'revisao', x: 0, y: 0, w: 3, h: 4, on: true },
    { id: 'cameras', x: 0, y: 4, w: 12, h: 7, on: false },
  ],
  stack: { order: ['filtros', 'timeline', 'resumo'], off: [] },
};

/**
 * Banco falso: só o que o router toca (app_logins pelo auth + user_prefs).
 * `state.rows` guarda as linhas como o Postgres guardaria: uma por (login_id,key).
 */
function makeDb(state) {
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();

      if (/FROM v3\.app_logins l/.test(q)) {
        const map = {
          [HENRIQUE_PIN]: { id: 1, name: 'Henrique', role: 'manager', rank: 50, functions: ['view_stock', 'manage_stock'] },
          [SIMONE_PIN]: { id: 2, name: 'Simone', role: 'operator', rank: 10, functions: ['do_pnp'] },
        };
        const l = map[params[0]];
        return { rows: l ? [l] : [] };
      }

      if (/SELECT key, value FROM v3\.user_prefs/.test(q)) {
        const rows = state.rows
          .filter((r) => r.login_id === params[0])
          .sort((a, b) => (a.key < b.key ? -1 : 1))
          .map((r) => ({ key: r.key, value: r.value }));
        return { rows };
      }

      if (/SELECT value, updated_at FROM v3\.user_prefs/.test(q)) {
        const r = state.rows.find((x) => x.login_id === params[0] && x.key === params[1]);
        return { rows: r ? [{ value: r.value, updated_at: r.updated_at }] : [] };
      }

      if (/INSERT INTO v3\.user_prefs/.test(q)) {
        state.inserts += 1;
        const [loginId, key, json] = params;
        const value = JSON.parse(json);
        const at = new Date(state.now).toISOString();
        const existing = state.rows.find((x) => x.login_id === loginId && x.key === key);
        if (existing) { existing.value = value; existing.updated_at = at; }
        else state.rows.push({ login_id: loginId, key, value, updated_at: at });
        return { rows: [{ key, updated_at: at }] };
      }

      if (/DELETE FROM v3\.user_prefs/.test(q)) {
        const i = state.rows.findIndex((x) => x.login_id === params[0] && x.key === params[1]);
        if (i < 0) return { rows: [] };
        state.rows.splice(i, 1);
        return { rows: [{ key: params[1] }] };
      }

      return { rows: [] };
    },
  };
}

let server, base, state;

async function boot() {
  if (server) await new Promise((r) => server.close(r));
  state = { rows: [], inserts: 0, now: Date.parse('2026-08-19T14:00:00Z') };
  const app = express();
  app.use('/', createPrefsRouter({ db: makeDb(state) }));
  server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
  base = `http://127.0.0.1:${server.address().port}`;
}

async function call(method, path, body, headers = {}) {
  const r = await fetch(base + path, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  return { status: r.status, body: j };
}

const asHenrique = { 'x-admin-pin': HENRIQUE_PIN };
const asSimone = { 'x-admin-pin': SIMONE_PIN };
const asEmergency = { 'x-admin-pin': EMERGENCY_PIN };

beforeAll(() => { process.env.ADMIN_PIN = EMERGENCY_PIN; });
beforeEach(async () => { await boot(); });
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('Preferências — auth', () => {
  test('sem PIN → 401', async () => {
    const r = await call('GET', '/api/v3/prefs');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthorized');
  });

  test('PIN errado → 401', async () => {
    const r = await call('GET', '/api/v3/prefs', undefined, { 'x-admin-pin': '000000' });
    expect(r.status).toBe(401);
  });

  test('qualquer login autenticado entra — não há gate de função', async () => {
    // a Simone só tem do_pnp; a preferência é DELA, não um recurso do sistema
    const r = await call('GET', '/api/v3/prefs', undefined, asSimone);
    expect(r.status).toBe(200);
    expect(r.body.data.account).toEqual({ id: 2, name: 'Simone', role: 'operator' });
  });
});

describe('Preferências — salvar e ler', () => {
  test('PUT grava e GET da chave devolve o mesmo valor', async () => {
    const put = await call('PUT', '/api/v3/prefs/hoje.layout', { value: LAYOUT }, asHenrique);
    expect(put.status).toBe(200);
    expect(put.body.data.key).toBe('hoje.layout');
    expect(put.body.data.updated_at).toBeTruthy();

    const get = await call('GET', '/api/v3/prefs/hoje.layout', undefined, asHenrique);
    expect(get.status).toBe(200);
    expect(get.body.data.value).toEqual(LAYOUT);
    expect(get.body.data.updated_at).toBeTruthy();
  });

  test('GET geral devolve o mapa de chaves + a conta', async () => {
    await call('PUT', '/api/v3/prefs/hoje.layout', { value: LAYOUT }, asHenrique);
    await call('PUT', '/api/v3/prefs/tema', { value: 'dark' }, asHenrique);
    const r = await call('GET', '/api/v3/prefs', undefined, asHenrique);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.data.prefs).sort()).toEqual(['hoje.layout', 'tema']);
    expect(r.body.data.prefs.tema).toBe('dark');
    expect(r.body.data.account).toEqual({ id: 1, name: 'Henrique', role: 'manager' });
  });

  test('chave nunca salva → 200 com value null (ausência não é erro)', async () => {
    const r = await call('GET', '/api/v3/prefs/nao.existe', undefined, asHenrique);
    expect(r.status).toBe(200);
    expect(r.body.data.value).toBeNull();
    expect(r.body.data.updated_at).toBeNull();
  });

  test('PUT duas vezes na mesma chave sobrescreve, não duplica', async () => {
    await call('PUT', '/api/v3/prefs/hoje.layout', { value: LAYOUT }, asHenrique);
    const changed = { ...LAYOUT, grid: LAYOUT.grid.map((w) => ({ ...w, x: 0 })) };
    await call('PUT', '/api/v3/prefs/hoje.layout', { value: changed }, asHenrique);
    expect(state.rows.filter((r) => r.key === 'hoje.layout').length).toBe(1);
    const get = await call('GET', '/api/v3/prefs/hoje.layout', undefined, asHenrique);
    expect(get.body.data.value).toEqual(changed);
  });

  test('a preferência é DA CONTA: o layout do Henrique não vaza pra Simone', async () => {
    await call('PUT', '/api/v3/prefs/hoje.layout', { value: LAYOUT }, asHenrique);
    const dela = await call('GET', '/api/v3/prefs/hoje.layout', undefined, asSimone);
    expect(dela.status).toBe(200);
    expect(dela.body.data.value).toBeNull();

    await call('PUT', '/api/v3/prefs/hoje.layout', { value: { grid: [], stack: null } }, asSimone);
    const dele = await call('GET', '/api/v3/prefs/hoje.layout', undefined, asHenrique);
    expect(dele.body.data.value).toEqual(LAYOUT);      // o dele continua o dele
  });

  test('valores não-objeto também valem (o servidor não opina sobre o formato)', async () => {
    await call('PUT', '/api/v3/prefs/tema', { value: 'dark' }, asHenrique);
    await call('PUT', '/api/v3/prefs/linhas', { value: 42 }, asHenrique);
    await call('PUT', '/api/v3/prefs/compacto', { value: false }, asHenrique);
    await call('PUT', '/api/v3/prefs/nulo', { value: null }, asHenrique);
    const r = await call('GET', '/api/v3/prefs', undefined, asHenrique);
    expect(r.body.data.prefs).toEqual({ tema: 'dark', linhas: 42, compacto: false, nulo: null });
  });
});

describe('Preferências — apagar', () => {
  test('DELETE apaga e devolve deleted true', async () => {
    await call('PUT', '/api/v3/prefs/hoje.layout', { value: LAYOUT }, asHenrique);
    const del = await call('DELETE', '/api/v3/prefs/hoje.layout', undefined, asHenrique);
    expect(del.status).toBe(200);
    expect(del.body.data.deleted).toBe(true);
    const get = await call('GET', '/api/v3/prefs/hoje.layout', undefined, asHenrique);
    expect(get.body.data.value).toBeNull();
  });

  test('DELETE do que não existe → 200 deleted false (o estado final é o pedido)', async () => {
    const r = await call('DELETE', '/api/v3/prefs/nao.existe', undefined, asHenrique);
    expect(r.status).toBe(200);
    expect(r.body.data.deleted).toBe(false);
  });
});

describe('Preferências — validação', () => {
  test.each([
    ['MAIUSCULA', '/api/v3/prefs/Hoje.Layout'],
    ['espaço', '/api/v3/prefs/hoje%20layout'],
    ['barra e acento', '/api/v3/prefs/pre%C3%A7o'],
  ])('chave inválida (%s) → 400 bad_key', async (_label, path) => {
    const r = await call('PUT', path, { value: 1 }, asHenrique);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('bad_key');
  });

  test('chave longa demais (65) → 400', async () => {
    const r = await call('PUT', '/api/v3/prefs/' + 'a'.repeat(65), { value: 1 }, asHenrique);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('bad_key');
  });

  test('corpo sem value → 400 bad_request', async () => {
    const r = await call('PUT', '/api/v3/prefs/hoje.layout', {}, asHenrique);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('bad_request');
  });

  test('valor acima de 64 KB → 413 too_large e nada é gravado', async () => {
    const r = await call('PUT', '/api/v3/prefs/gigante',
      { value: { blob: 'x'.repeat(70 * 1024) } }, asHenrique);
    expect([413, 400]).toContain(r.status);   // express pode cortar antes pelo limit
    expect(state.rows.length).toBe(0);
  });

  test('chave válida com ponto, traço e underscore passa', async () => {
    const r = await call('PUT', '/api/v3/prefs/hoje.layout-v2_beta', { value: 1 }, asHenrique);
    expect(r.status).toBe(200);
  });
});

describe('Preferências — login de EMERGÊNCIA (sem conta)', () => {
  test('GET geral devolve prefs vazias e account null', async () => {
    const r = await call('GET', '/api/v3/prefs', undefined, asEmergency);
    expect(r.status).toBe(200);
    expect(r.body.data.prefs).toEqual({});
    expect(r.body.data.account).toBeNull();
  });

  test('GET de uma chave devolve value null e account null', async () => {
    const r = await call('GET', '/api/v3/prefs/hoje.layout', undefined, asEmergency);
    expect(r.status).toBe(200);
    expect(r.body.data.value).toBeNull();
    expect(r.body.data.account).toBeNull();
  });

  test('PUT → 409 no_account com o texto em português', async () => {
    const r = await call('PUT', '/api/v3/prefs/hoje.layout', { value: LAYOUT }, asEmergency);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('no_account');
    expect(r.body.error.message).toBe(MSG_NO_ACCOUNT);
  });

  test('DELETE → 409 no_account', async () => {
    const r = await call('DELETE', '/api/v3/prefs/hoje.layout', undefined, asEmergency);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('no_account');
  });

  test('emergência NUNCA grava linha órfã na tabela', async () => {
    await call('PUT', '/api/v3/prefs/hoje.layout', { value: LAYOUT }, asEmergency);
    await call('PUT', '/api/v3/prefs/tema', { value: 'dark' }, asEmergency);
    expect(state.rows.length).toBe(0);
    expect(state.inserts).toBe(0);
  });
});
