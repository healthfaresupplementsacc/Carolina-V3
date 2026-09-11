'use strict';
/**
 * CHECAGEM DE DURAÇÃO (Bruno 09-11): pergunta no kiosk quando a tarefa ficou muito
 * curta (< 5 min, e a atividade normalmente leva ≥ 15) ou muito longa (≥ 30 min e
 * > 2× a mediana); "não está certo" marca o registro; o dashboard marca consertado.
 * Express real; banco falso; tokens FICTÍCIOS.
 */
const express = require('express');
const { createDurationCheckRouter, evaluate } = require('../v3/duration-check/router');

describe('evaluate (regra pura)', () => {
  test('sem amostras suficientes → nada', () => { expect(evaluate(2, 40, 3)).toBeNull(); });
  test('3 min numa tarefa que leva 45 → too_short', () => { expect(evaluate(3, 45, 20)).toMatchObject({ kind: 'too_short', dur_min: 3, median_min: 45 }); });
  test('3 min em Impressão de Ordens (mediana 8) → não pergunta', () => { expect(evaluate(3, 8, 20)).toBeNull(); });
  test('3 h numa tarefa de 45 min → too_long; 1 h não', () => {
    expect(evaluate(180, 45, 20)).toMatchObject({ kind: 'too_long' });
    expect(evaluate(60, 45, 20)).toBeNull();
  });
  test('25 min numa tarefa de 5 min: passa do dobro mas é curto em absoluto → não pergunta', () => { expect(evaluate(25, 5, 20)).toBeNull(); });
});

const PAGE = 'page-fake'; const SESSION = 'sess-fake';
const state = { flagged: null, fixed: null };
const db = {
  async query(sql, params) {
    const q = String(sql).replace(/\s+/g, ' ');
    if (/FROM v3\.operator_sessions s/.test(q)) return { rows: params[0] === SESSION ? [{ session_id: 1, person_id: 9, display_name: 'Caroline Braga' }] : [] };
    if (/FROM v3\.events e LEFT JOIN v3\.activity_types at ON at\.id = e\.activity_type_id WHERE e\.id/.test(q)) {
      if (params[0] === 4307) return { rows: [{ id: 4307, person_id: 9, activity_type_id: 3, started_at: '2026-09-11T13:00:00Z', ended_at: '2026-09-11T13:03:00Z', deleted_at: null, paused: 0, product_batch_id: null, slug: 'packaging', activity: 'Empacotamento' }] };
      if (params[0] === 4310) return { rows: [{ id: 4310, person_id: 9, activity_type_id: 5, started_at: '2026-09-11T13:00:00Z', ended_at: '2026-09-11T13:03:00Z', deleted_at: null, paused: 0, product_batch_id: 300, slug: 'review', activity: 'Revisão' }] };
      if (params[0] === 4308) return { rows: [{ id: 4308, person_id: 4, activity_type_id: 3, started_at: '2026-09-11T13:00:00Z', ended_at: '2026-09-11T13:03:00Z', deleted_at: null, paused: 0, slug: 'packaging', activity: 'Empacotamento' }] };
      return { rows: [] };
    }
    if (/JOIN v3\.product_batches pb ON pb\.id = x\.product_batch_id WHERE x\.activity_type_id/.test(q)) return { rows: [{ samples: params[2] === 300 ? 6 : 1, median_min: 12 }] };
    if (/GROUP BY at\.slug, pb\.product_id/.test(q)) return { rows: [{ slug: 'review', product_id: 7, samples: 6, median_min: 52.4, last_min: 48, last_at: '2026-09-10T18:00:00Z' }] };
    if (/GROUP BY at\.slug$/.test(q.trim()) || /GROUP BY at\.slug`/.test(q) || (/GROUP BY at\.slug/.test(q) && !/pb\.product_id/.test(q))) return { rows: [{ slug: 'packaging', samples: 42, median_min: 70.2 }, { slug: 'review', samples: 12, median_min: 40 }] };
    if (/percentile_cont/.test(q)) return { rows: [{ samples: 30, median_min: 70 }] };
    if (q.startsWith("UPDATE v3.events SET duration_flag = ")) { state.flagged = { id: params[0], kind: params[1] }; return { rows: [] }; }
    if (q.startsWith("UPDATE v3.events SET duration_flag_status = 'fixed'")) { if (params[0] === 4307 && state.flagged) { state.fixed = { id: params[0], by: params[1] }; return { rows: [{ id: 4307, duration_flag: 'too_short' }] }; } return { rows: [] }; }
    if (/FROM v3\.app_logins l JOIN v3\.app_roles/.test(q)) return { rows: params[0] === '111111' ? [{ id: 1, name: 'Bruno', role: 'admin', rank: 100, functions: ['*'], granted: [], revoked: [] }] : [] };
    if (q.startsWith('INSERT INTO v3.audit_log')) return { rows: [] };
    return { rows: [] };
  },
};
let server, base;
beforeAll(async () => { const app = express(); app.use('/', createDurationCheckRouter({ db, operatorToken: PAGE })); server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); base = 'http://127.0.0.1:' + server.address().port; });
afterAll(async () => { await new Promise((r) => server.close(r)); });
const kiosk = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { authorization: 'Bearer ' + PAGE, 'x-session-token': SESSION, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };

test('kiosk: 3 min de Empacotamento (mediana 70) → pergunta too_short', async () => {
  const r = await kiosk('GET', '/api/v3/duration-check/event/4307');
  expect(r.status).toBe(200); expect(r.body.data.check).toMatchObject({ kind: 'too_short', dur_min: 3, median_min: 70, activity: 'Empacotamento' });
});
test('kiosk: revisão de 3 min de um produto cuja mediana é 12 min → NÃO pergunta (base = produto)', async () => {
  const r = await kiosk('GET', '/api/v3/duration-check/event/4310');
  expect(r.status).toBe(200); expect(r.body.data.check).toBeNull();
});
test('dashboard: expectations traz mediana por atividade e por produto (com o último)', async () => {
  const r = await fetch(base + '/api/v3/duration-check/expectations', { headers: { 'x-admin-pin': '111111' } }); const j = await r.json();
  expect(r.status).toBe(200);
  expect(j.data.by_activity.packaging).toEqual({ median_min: 70, samples: 42 });
  expect(j.data.by_product.review[7]).toMatchObject({ median_min: 52, samples: 6, last_min: 48 });
  expect((await fetch(base + '/api/v3/duration-check/expectations')).status).toBe(401);
});
test('kiosk: registro de outra pessoa → 403; sem página → 401', async () => {
  expect((await kiosk('GET', '/api/v3/duration-check/event/4308')).status).toBe(403);
  const r = await fetch(base + '/api/v3/duration-check/event/4307'); expect(r.status).toBe(401);
});
test('resposta "não está certo" marca o registro; "está certo" não', async () => {
  let r = await kiosk('POST', '/api/v3/duration-check/event/4307/answer', { ok: true, kind: 'too_short' });
  expect(r.body.data.flagged).toBe(false); expect(state.flagged).toBeNull();
  r = await kiosk('POST', '/api/v3/duration-check/event/4307/answer', { ok: false, kind: 'too_short' });
  expect(r.body.data.flagged).toBe(true); expect(state.flagged).toEqual({ id: 4307, kind: 'too_short' });
});
test('dashboard: marcar consertado exige PIN e grava quem consertou', async () => {
  let r = await fetch(base + '/api/v3/duration-check/event/4307/fix', { method: 'POST' }); expect(r.status).toBe(401);
  r = await fetch(base + '/api/v3/duration-check/event/4307/fix', { method: 'POST', headers: { 'x-admin-pin': '111111', 'content-type': 'application/json' }, body: '{}' });
  expect(r.status).toBe(200); expect(state.fixed).toEqual({ id: 4307, by: 'Bruno' });
  r = await fetch(base + '/api/v3/duration-check/event/4308/fix', { method: 'POST', headers: { 'x-admin-pin': '111111' } }); expect(r.status).toBe(409);
});
