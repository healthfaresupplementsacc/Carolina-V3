'use strict';
// FASE 1 P10 — SEM DONO endpoints: list parked ambiguous events +
// PIN-gated, audited reassign (the dashboard "atribuir" button).
jest.mock('../db');
jest.mock('../slack/admin-chat', () => ({
  listPending: jest.fn(),
  resolveBySourceId: jest.fn(),
}));

const express = require('express');
const request = require('http');
const adminChat = require('../slack/admin-chat');
const apiRouter = require('../routes/api');

// Minimal in-process express harness.
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  return app;
}
function call(app, method, path, body) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const data = body ? JSON.stringify(body) : null;
      const req = request.request(
        { port, method, path, headers: { 'Content-Type': 'application/json' } },
        (resp) => {
          let buf = '';
          resp.on('data', (c) => (buf += c));
          resp.on('end', () => {
            server.close();
            let json = null; try { json = JSON.parse(buf); } catch (_) {}
            resolve({ status: resp.statusCode, body: json });
          });
        }
      );
      if (data) req.write(data);
      req.end();
    });
  });
}

beforeEach(() => { jest.clearAllMocks(); process.env.ADMIN_PIN = '510510'; });

describe('GET /api/admin/dispatcher/pending', () => {
  test('PIN required', async () => {
    const r = await call(makeApp(), 'GET', '/api/admin/dispatcher/pending');
    expect(r.status).toBe(403);
  });

  test('lists parked SEM DONO events (compact shape for cards)', async () => {
    adminChat.listPending.mockResolvedValue([
      { source_id: '1779.1', source_type: 'parser', account_user_id: 'U0AU8N8FA00',
        created_at: 'x', event: { type: 'start', supplement: 'Rutin', batch: '0138', raw_text: 'label das ordens' } },
    ]);
    const r = await call(makeApp(), 'GET', '/api/admin/dispatcher/pending?pin=510510');
    expect(r.status).toBe(200);
    expect(r.body.pending[0]).toMatchObject({
      source_id: '1779.1', type: 'start', supplement: 'Rutin', batch: '0138',
    });
  });
});

describe('POST /api/admin/dispatcher/reassign-operator', () => {
  test('PIN required', async () => {
    const r = await call(makeApp(), 'POST', '/api/admin/dispatcher/reassign-operator',
      { source_id: 's1', operator: 'Ana' });
    expect(r.status).toBe(403);
  });

  test('source_id + operator required', async () => {
    const r = await call(makeApp(), 'POST', '/api/admin/dispatcher/reassign-operator',
      { pin: '510510', source_id: 's1' });
    expect(r.status).toBe(400);
  });

  test('happy path → resolveBySourceId + 200', async () => {
    adminChat.resolveBySourceId.mockResolvedValue({
      handled: true, operator: 'Ana', operator_id: 1, source_id: 's1',
    });
    const r = await call(makeApp(), 'POST', '/api/admin/dispatcher/reassign-operator',
      { pin: '510510', source_id: 's1', operator: 'Ana' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, operator: 'Ana', operator_id: 1 });
    expect(adminChat.resolveBySourceId).toHaveBeenCalledWith(
      's1', 'Ana', expect.objectContaining({ _source: 'api' })
    );
  });

  test('already-resolved / not-found → 409', async () => {
    adminChat.resolveBySourceId.mockResolvedValue({ handled: false, reason: 'already resolved' });
    const r = await call(makeApp(), 'POST', '/api/admin/dispatcher/reassign-operator',
      { pin: '510510', source_id: 's1', operator: 'Ana' });
    expect(r.status).toBe(409);
  });
});
