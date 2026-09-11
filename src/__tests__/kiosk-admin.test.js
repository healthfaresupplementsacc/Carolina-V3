'use strict';
/**
 * OPERADORES NO PAINEL (Bruno 09-11): PIN legível (auditado), PIN falso "DDDD…0",
 * "logar como", o que cada um vê no kiosk. Express real; banco falso; PINs FICTÍCIOS.
 */
const express = require('express');
const { createKioskAdminRouter, normalizeTypedPin } = require('../v3/kiosk-admin/router');

describe('normalizeTypedPin (PIN falso)', () => {
  test('DDDD + números + 0 → os 4 primeiros; 4 dígitos ou outro formato → como veio', () => {
    expect(normalizeTypedPin('999983726150')).toBe('9999');
    expect(normalizeTypedPin('43210')).toBe('4321');
    expect(normalizeTypedPin('4321')).toBe('4321');
    expect(normalizeTypedPin('43219')).toBe('43219');
    expect(normalizeTypedPin('abc')).toBe('abc');
  });
});

const PAGE = 'page-fake';
const state = { pins: {}, prefs: {}, imp: null, audit: [] };
const db = {
  async query(sql, params) {
    const q = String(sql).replace(/\s+/g, ' ');
    if (/FROM v3\.app_logins l JOIN v3\.app_roles r ON r\.id = l\.role_id LEFT JOIN v3\.role_functions/.test(q)) return { rows: params[0] === '111111' ? [{ id: 1, name: 'Bruno', role: 'admin', rank: 100, functions: ['*'], granted: [], revoked: [] }] : params[0] === '222222' ? [{ id: 2, name: 'Henrique', role: 'manager', rank: 50, functions: ['view_production'], granted: [], revoked: [] }] : [] };
    if (/FROM v3\.operator_sessions s JOIN v3\.persons p/.test(q)) return { rows: params[0] === 'tok-imp' ? [{ session_id: 77, person_id: 4, display_name: 'Vitor', role: 'operator', auto_logoff_seconds: 30, count_exempt: false, is_sandbox: false }] : [] };
    if (q.startsWith('SELECT impersonated_by FROM v3.operator_sessions')) return { rows: [{ impersonated_by: state.imp }] };
    if (/FROM v3\.persons p LEFT JOIN v3\.app_logins l/.test(q)) return { rows: [{ id: 4, display_name: 'Vitor', role: 'operator', active: true, is_sandbox: false, pin_plain: '4321', has_pin: true, kiosk_prefs: {}, login_id: null }, { id: 9, display_name: 'Caroline Braga', role: 'operator', active: true, is_sandbox: false, pin_plain: null, has_pin: true, kiosk_prefs: { hidden_groups: ['envio'] }, login_id: 5, login_role: 'operator' }] };
    if (q.startsWith('INSERT INTO v3.audit_log')) { state.audit.push(params[0]); return { rows: [] }; }
    if (q.startsWith('SELECT id, display_name FROM v3.persons WHERE active AND deleted_at IS NULL AND id <> $1 AND pin_plain')) return { rows: params[1] === '4321' && params[0] !== 4 ? [{ id: 4, display_name: 'Vitor' }] : [] };
    if (q.startsWith('UPDATE v3.persons SET pin_hash')) { state.pins[params[0]] = params[3]; return { rows: [{ id: params[0], display_name: 'X' }] }; }
    if (q.startsWith('UPDATE v3.persons SET kiosk_prefs')) { state.prefs[params[0]] = JSON.parse(params[1]); return { rows: [{ id: params[0], kiosk_prefs: JSON.parse(params[1]) }] }; }
    if (q.startsWith("SELECT id, display_name FROM v3.persons WHERE id = $1 AND active")) return { rows: params[0] === 4 ? [{ id: 4, display_name: 'Vitor' }] : [] };
    if (q.startsWith('INSERT INTO v3.operator_sessions')) return { rows: [{ id: 77, session_token: 'tok-imp' }] };
    if (q.startsWith('UPDATE v3.operator_sessions SET impersonated_by')) { state.imp = params[1]; return { rows: [] }; }
    return { rows: [] };
  },
};
let server, base;
beforeAll(async () => {
  const app = express();
  app.use('/', createKioskAdminRouter({ db, operatorToken: PAGE }));
  // "op.js" fake depois do middleware: devolve o pin que chegou
  app.post('/api/v3/op/auth/login', express.json(), (req, res) => res.json({ got: req.body.pin }));
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); base = 'http://127.0.0.1:' + server.address().port;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
const pin = async (method, p, body, who) => { const r = await fetch(base + p, { method, headers: { 'x-admin-pin': who || '111111', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };

test('login do kiosk com PIN falso chega ao op.js com 4 dígitos', async () => {
  const r = await fetch(base + '/api/v3/op/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '999912345670' }) });
  expect((await r.json()).got).toBe('9999');
});
test('GET /operators: PIN legível só pra quem gerencia usuários, com audit; PIN desconhecido é sinalizado', async () => {
  let r = await pin('GET', '/api/v3/kiosk-admin/operators', null, '222222'); expect(r.status).toBe(403);
  r = await pin('GET', '/api/v3/kiosk-admin/operators');
  expect(r.status).toBe(200);
  expect(r.body.data.operators[0]).toMatchObject({ display_name: 'Vitor', pin: '4321', pin_unknown: false });
  expect(r.body.data.operators[1]).toMatchObject({ display_name: 'Caroline Braga', pin: null, pin_unknown: true, login_role: 'operator' });
  expect(state.audit).toContain('operators.pins_viewed');
});
test('trocar PIN: 4 dígitos, não pode repetir o de outro ativo, grava hash + legível', async () => {
  let r = await pin('POST', '/api/v3/kiosk-admin/operators/9/pin', { pin: '12' }); expect(r.status).toBe(400);
  r = await pin('POST', '/api/v3/kiosk-admin/operators/9/pin', { pin: '4321' }); expect(r.status).toBe(409);
  r = await pin('POST', '/api/v3/kiosk-admin/operators/9/pin', { pin: '2468' }); expect(r.status).toBe(200); expect(state.pins[9]).toBe('2468');
});
test('o que cada um vê no kiosk: hidden_groups', async () => {
  const r = await pin('POST', '/api/v3/kiosk-admin/operators/9/kiosk-prefs', { hidden_groups: ['envio', 'embalagem', 'x y'] });
  expect(r.status).toBe(200); expect(state.prefs[9]).toEqual({ hidden_groups: ['envio', 'embalagem'] });
});
test('logar como: abre sessão marcada com quem abriu; o kiosk troca o token pelos dados', async () => {
  let r = await pin('POST', '/api/v3/kiosk-admin/operators/4/impersonate');
  expect(r.status).toBe(200); expect(r.body.data.url).toBe('/op/?as=tok-imp'); expect(state.imp).toBe('Bruno');
  const s = await fetch(base + '/api/v3/kiosk-admin/session/tok-imp', { headers: { authorization: 'Bearer ' + PAGE } });
  expect(s.status).toBe(200); const j = await s.json(); expect(j.data.person.display_name).toBe('Vitor'); expect(j.data.impersonated_by).toBe('Bruno');
  expect((await fetch(base + '/api/v3/kiosk-admin/session/tok-imp')).status).toBe(401);
  r = await pin('POST', '/api/v3/kiosk-admin/operators/99/impersonate'); expect(r.status).toBe(404);
});
