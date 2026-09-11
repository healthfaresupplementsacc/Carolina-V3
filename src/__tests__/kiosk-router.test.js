'use strict';
/**
 * KIOSK — ordem por uso (mensal), limpeza com subtipo, "Outros" com título, painel de
 * reclassificação (Bruno 09-11). Express real; banco falso; tokens FICTÍCIOS.
 */
const express = require('express');
const K = require('../v3/kiosk/router');

describe('puro', () => {
  test('a janela fecha no dia 1 do mês (NY): a ordem vale o mês inteiro', () => {
    expect(K.monthStartNy(new Date('2026-09-11T15:00:00Z'))).toBe('2026-09-01');
    expect(K.monthStartNy(new Date('2026-10-01T02:00:00Z'))).toBe('2026-09-01');   // 22h NY do dia 30/09
  });
  test('título de fallback: 5 palavras, ≤ 40 chars, inicial maiúscula', () => {
    expect(K.fallbackTitle('transformando berberine 5000 em burn agora de tarde')).toBe('Transformando berberine 5000 em burn');
    expect(K.fallbackTitle('  recebimento   powder em sistema ')).toBe('Recebimento powder em sistema');
    expect(K.fallbackTitle('')).toBe('');
  });
  test('summarize: IA devolve o título; sem IA ou erro → fallback; texto curto nem chama a IA', async () => {
    const prov = { classifyRaw: async () => ({ json_parsed: { title: 'Berberine virando Burn.' }, provider_used: 'gemini' }) };
    expect(await K.summarize(prov, 'transformando berberine 5000 em burn agora de tarde')).toEqual({ title: 'Berberine virando Burn', via: 'gemini' });
    expect(await K.summarize({ classifyRaw: async () => { throw new Error('x'); } }, 'transformando berberine 5000 em burn')).toMatchObject({ via: 'fallback' });
    const spy = { classifyRaw: jest.fn() };
    expect(await K.summarize(spy, 'cortando silica')).toEqual({ title: 'Cortando silica', via: 'fallback' }); expect(spy.classifyRaw).not.toHaveBeenCalled();
  });
});

const PAGE = 'page-fake'; const SESSION = 'sess-fake';
const state = { phase: {}, reviewed: {}, reclass: {} };
const db = {
  async query(sql, params) {
    const q = String(sql).replace(/\s+/g, ' ');
    if (/FROM v3\.operator_sessions s/.test(q)) return { rows: params[0] === SESSION ? [{ session_id: 1, person_id: 9, display_name: 'Caroline Braga' }] : [] };
    if (/GROUP BY at\.slug, e\.phase_label/.test(q)) { expect(params[1]).toMatch(/^\d{4}-\d{2}-01$/); return { rows: [{ slug: 'production_line', phase_label: null, n: 37 }, { slug: 'cleaning', phase_label: 'limpeza:linha', n: 20 }, { slug: 'cleaning', phase_label: 'limpeza:fim', n: 8 }, { slug: 'cleaning', phase_label: null, n: 5 }] }; }
    if (q.startsWith('SELECT e.id, e.person_id, e.deleted_at, at.slug FROM v3.events e')) return { rows: params[0] === 501 ? [{ id: 501, person_id: 9, deleted_at: null, slug: 'cleaning' }] : params[0] === 502 ? [{ id: 502, person_id: 4, deleted_at: null, slug: 'special_task' }] : [] };
    if (q.startsWith('UPDATE v3.events SET phase_label')) { state.phase[params[0]] = params[1]; return { rows: [] }; }
    if (/FROM v3\.app_logins l JOIN v3\.app_roles/.test(q)) return { rows: params[0] === '111111' ? [{ id: 1, name: 'Bruno', role: 'admin', rank: 100, functions: ['*'], granted: [], revoked: [] }] : [] };
    if (/e\.other_reviewed_at IS NULL/.test(q)) return { rows: [{ id: 700, person: 'Simone', slug: 'special_task', activity: 'Outros', started_at: '2026-09-04T13:00:00Z', ended_at: '2026-09-04T13:40:00Z', title: 'Berberine virando Burn', text: 'Transformando Berberine 5000 em Burn', duration_min: 40 }] };
    if (q.startsWith('SELECT id, slug, display_name FROM v3.activity_types WHERE slug')) return { rows: params[0] === 'fnsku_labeling' ? [{ id: 41, slug: 'fnsku_labeling', display_name: 'FNSKU' }] : [] };
    if (q.startsWith('UPDATE v3.events SET activity_type_id')) { state.reclass[params[0]] = params[1]; return { rows: [] }; }
    if (q.startsWith('UPDATE v3.events SET other_reviewed_at')) { state.reviewed[params[0]] = params[1]; return { rows: [{ id: params[0] }] }; }
    if (q.startsWith('INSERT INTO v3.audit_log')) return { rows: [] };
    return { rows: [] };
  },
};
let server, base;
beforeAll(async () => { const app = express(); app.use('/', K.createKioskRouter({ db, operatorToken: PAGE, provider: null })); server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); base = 'http://127.0.0.1:' + server.address().port; });
afterAll(async () => { await new Promise((r) => server.close(r)); });
const kiosk = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { authorization: 'Bearer ' + PAGE, 'x-session-token': SESSION, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const pin = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'x-admin-pin': '111111', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };

test('GET /order: contagem por atividade e por subtipo de limpeza, janela fechada no dia 1', async () => {
  const r = await kiosk('GET', '/api/v3/kiosk/order');
  expect(r.status).toBe(200);
  expect(r.body.data.types).toEqual({ production_line: 37, cleaning: 33 });
  expect(r.body.data.clean_kinds).toEqual({ linha: 20, fim: 8 });
  expect((await fetch(base + '/api/v3/kiosk/order')).status).toBe(401);
});
test('subtipo de limpeza: só kinds válidos, só no registro da pessoa', async () => {
  let r = await kiosk('POST', '/api/v3/kiosk/event/501/subtype', { kind: 'capsula' });
  expect(r.status).toBe(200); expect(state.phase[501]).toBe('limpeza:capsula');
  r = await kiosk('POST', '/api/v3/kiosk/event/501/subtype', { kind: 'banheiro' }); expect(r.status).toBe(400);
  r = await kiosk('POST', '/api/v3/kiosk/event/502/subtype', { kind: 'linha' }); expect(r.status).toBe(403);
});
test('título do "Outros": resumo vira phase_label; texto inteiro fica na description', async () => {
  const r = await kiosk('POST', '/api/v3/kiosk/event/501/title', { text: 'recebimento dos powder em sistema e impressao labels' });
  expect(r.status).toBe(200); expect(r.body.data.title).toBe('Recebimento dos powder em sistema'); expect(state.phase[501]).toBe('Recebimento dos powder em sistema');
});
test('painel: lista os Outros não revisados; resolver reclassifica (opcional) e marca quem revisou', async () => {
  let r = await pin('GET', '/api/v3/kiosk/others');
  expect(r.status).toBe(200); expect(r.body.data.rows[0]).toMatchObject({ id: 700, person: 'Simone', title: 'Berberine virando Burn' });
  expect((await fetch(base + '/api/v3/kiosk/others')).status).toBe(401);
  r = await pin('POST', '/api/v3/kiosk/others/700/resolve', { activity_slug: 'fnsku_labeling' });
  expect(r.status).toBe(200); expect(r.body.data.reclassified).toBe('fnsku_labeling'); expect(state.reclass[700]).toBe(41); expect(state.reviewed[700]).toBe('Bruno');
  r = await pin('POST', '/api/v3/kiosk/others/700/resolve', { activity_slug: 'nao_existe' }); expect(r.status).toBe(400);
  r = await pin('POST', '/api/v3/kiosk/others/700/resolve', {}); expect(r.body.data.reclassified).toBeNull();
});
