'use strict';
/* FASE 6 (P6.4) — admin resolve tarefas não finalizadas (pausa que virou o dia):
   lista + finalize + reassign. */
const express = require('express');
const { createAdminRouter } = require('../routes/admin');

const resp = (rows) => ({ rows, rowCount: rows.length });
const PW = 'emergency-pw';

describe('FASE 6 — tarefas não finalizadas (admin)', () => {
  let server, base, mem, token;
  function makeDb(mem) {
    return { query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/INSERT INTO v3\.audit_log/.test(s)) { mem.audits.push({ action: params[0] }); return resp([]); }
      if (/COUNT\(\*\)::int n FROM v3\.admin_users WHERE is_active = true/.test(s)) return resp([{ n: 0 }]); // emergência
      if (/FROM v3\.admin_sessions s JOIN v3\.admin_users u/.test(s)) return resp([]);
      // lista unfinished
      if (/WHERE e\.is_unfinished = TRUE AND e\.ended_at IS NULL/.test(s)) {
        return resp(mem.events.filter((e) => e.is_unfinished && !e.ended_at).map((e) => ({ id: e.id, person_id: e.person, operator: 'Vitor', slug: e.slug, task: e.slug, batch_number: e.batch, product: 'Plant Sterols', started_at: new Date(), paused_at: new Date(), worked_seconds: 1800 })));
      }
      // resolve: lookup
      if (/SELECT id FROM v3\.events WHERE id=\$1 AND is_unfinished=TRUE/.test(s)) {
        const e = mem.events.find((x) => x.id === params[0] && x.is_unfinished && !x.ended_at); return resp(e ? [{ id: e.id }] : []);
      }
      if (/UPDATE v3\.events SET ended_at = NOW\(\), is_unfinished = FALSE, closed_reason = 'admin_finalized_unfinished'/.test(s)) {
        const e = mem.events.find((x) => x.id === params[0]); if (e) { e.ended_at = new Date(); e.is_unfinished = false; } return resp([]);
      }
      if (/UPDATE v3\.events SET person_id = \$2, is_unfinished = FALSE, paused_at = NULL/.test(s)) {
        const e = mem.events.find((x) => x.id === params[0]); if (e) { e.person = params[1]; e.is_unfinished = false; e.paused_at = null; } return resp([]);
      }
      return resp([]);
    } };
  }
  beforeEach(async () => {
    if (server) await new Promise((r) => server.close(r));
    mem = { audits: [], events: [{ id: 555, person: 4, slug: 'production_line', batch: 'BR-2026-0218', is_unfinished: true, ended_at: null, paused_at: new Date() }] };
    const app = express();
    app.use('/', createAdminRouter({ db: makeDb(mem), slack: { postAs: () => {} }, adminPassword: PW }));
    server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
    base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(base + '/api/adminpanel/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW }) });
    token = (await r.json()).token;
  });
  afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });
  const H = () => ({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' });
  async function get(p) { const r = await fetch(base + p, { headers: H() }); return { status: r.status, body: await r.json() }; }
  async function post(p, body) { const r = await fetch(base + p, { method: 'POST', headers: H(), body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, body: j }; }

  test('lista unfinished (worked_seconds antes da pausa)', async () => {
    const r = await get('/api/adminpanel/metrics/unfinished');
    expect(r.status).toBe(200);
    expect(r.body.unfinished[0]).toMatchObject({ id: 555, slug: 'production_line', batch_number: 'BR-2026-0218', worked_seconds: 1800 });
  });
  test('finalize → fecha + is_unfinished false + audit', async () => {
    const r = await post('/api/adminpanel/metrics/unfinished/555/resolve', { action: 'finalize' });
    expect(r.status).toBe(200);
    expect(mem.events[0].ended_at).toBeTruthy();
    expect(mem.events[0].is_unfinished).toBe(false);
    expect(mem.audits.some((a) => a.action === 'event.unfinished_finalized')).toBe(true);
  });
  test('reassign → muda dono, descongela (paused_at null), continua aberta', async () => {
    const r = await post('/api/adminpanel/metrics/unfinished/555/resolve', { action: 'reassign', assignee_person_id: 7 });
    expect(r.status).toBe(200);
    expect(mem.events[0].person).toBe(7);
    expect(mem.events[0].is_unfinished).toBe(false);
    expect(mem.events[0].ended_at).toBeFalsy(); // continua aberta p/ o novo dono
    expect(mem.events[0].paused_at).toBe(null); // descongelada
  });
  test('reassign sem assignee → 400', async () => {
    expect((await post('/api/adminpanel/metrics/unfinished/555/resolve', { action: 'reassign' })).body.error).toBe('assignee_required');
  });
  test('id inexistente → 404', async () => {
    expect((await post('/api/adminpanel/metrics/unfinished/999/resolve', { action: 'finalize' })).status).toBe(404);
  });
});
