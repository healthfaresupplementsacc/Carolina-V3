'use strict';
/**
 * HEALTHFARE V3 — tests behavioral da Architect API (Fase 1).
 * HTTP REAL: app Express + listen(porta efêmera) + fetch nativo (Node 20+).
 * (supertest não pôde ser instalado — npm global da máquina quebrado;
 *  comportamento testado é idêntico: requests HTTP de verdade.)
 */
const express = require('express');
const { createArchitectRouter } = require('../routes/architect');

const ARCH_TOKEN = 'a'.repeat(64);
const OP_TOKEN = 'b'.repeat(64);
const B = '/api/v3/architect';

const resp = (rows) => ({ rows, rowCount: rows.length });

const EVENT_999 = {
  id: 999, person_id: 4, display_name: 'Vitor', slug: 'production_line', flow: 'production',
  batch_number: 'BR-2026-0190', product: 'Magnesium Glycinate',
  started_at: '2026-06-12T12:00:00.000Z', ended_at: null,
  started_at_edt: '2026-06-12 08:00:00 AM', ended_at_edt: null,
  cowork_with: [6], confidence: 'high', is_long_running: false, closed_reason: null,
  quantity: null, quantity_unit: null, source_message_ts: '1781.100', description: 'linha',
};
const OPEN_ROWS = [
  { ...EVENT_999, id: 700 },
  { ...EVENT_999, id: 213, display_name: 'Bruno Sarmento', slug: 'formulation', is_long_running: true },
];
const OPERATORS = [
  { id: 4, display_name: 'Vitor', role: 'operator' },
  { id: 5, display_name: 'Simone', role: 'operator' },
];
const ALL_PERSONS = [
  { id: 1, display_name: 'Bruno Camp', role: 'owner', slack_user_id: 'U1', slack_dm_id: 'D1', active: true, hired_at: null, deleted_at: null },
  { id: 4, display_name: 'Vitor', role: 'operator', slack_user_id: 'U4', slack_dm_id: 'D4', active: true, hired_at: null, deleted_at: null },
];
const PRODUCTS = [
  { id: 1, canonical_name: 'Magnesium Glycinate', aliases: ['glycinate', 'mag'], last_used_at: '2026-06-10T12:00:00.000Z' },
  { id: 2, canonical_name: 'Berberine', aliases: [], last_used_at: null },
];

function makeFakeDb() {
  const audits = [];
  const db = {
    audits,
    query: jest.fn(async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/INSERT INTO v3\.audit_log/.test(s)) {
        audits.push({ actor_type: params[0], metadata: JSON.parse(params[1]) });
        return resp([]);
      }
      if (/FROM v3\.messages WHERE slack_ts = split_part/.test(s)) {
        return resp([{ id: 50, slack_ts: '1781.100', slack_user_id: 'U4', raw_text: 'S: linha', llm_result: null, processing_error: null, created_at_edt: '2026-06-12 08:00:00 AM' }]);
      }
      if (/WHERE e\.id = \$1/.test(s)) return params[0] === 999 ? resp([EVENT_999]) : resp([]);
      if (/WHERE e\.ended_at IS NULL/.test(s)) return resp(OPEN_ROWS);
      if (/WHERE e\.person_id = \$1/.test(s)) return resp([{ ...EVENT_999, id: 701 }]);
      if (/FROM v3\.production_counts/.test(s)) return resp([]);
      if (/array_length\(m\.events_created/.test(s)) return resp([]);
      if (/LEFT JOIN v3\.messages m ON m\.slack_ts/.test(s)) return resp([]);
      if (/target_type = 'event'/.test(s)) return resp([]);
      if (/FROM v3\.audit_log/.test(s)) return resp([{ id: 1, actor_type: 'admin', action: 'x', metadata: {}, created_at_edt: '…', created_at: null, actor_person_id: null, target_type: null, target_id: null }]);
      if (/FROM v3\.messages m WHERE/.test(s)) return resp([]); // snapshot messages
      if (/SELECT 1 AS ok/.test(s)) return resp([{ ok: 1 }]);
      if (/MAX\(created_at\) AS ts, MAX\(llm_processed_at\)/.test(s)) return resp([{ ts: '2026-06-12T12:00:00Z', processed_ts: '2026-06-12T12:00:05Z' }]);
      if (/MAX\(created_at\) AS ts FROM v3\.events/.test(s)) return resp([{ ts: '2026-06-12T12:00:00Z' }]);
      if (/COUNT\(\*\)::int AS pending/.test(s)) return resp([{ pending: 3 }]);
      if (/AVG\(processing_ms\)/.test(s) && /1 hour/.test(s)) return resp([{ avg_ms: 4200, n: 12 }]);
      if (/MIN\(created_at\) AS oldest/.test(s)) return resp([{ n: 2, oldest: new Date(Date.now() - 60000).toISOString() }]);
      if (/FROM v3\.pending_commands/.test(s)) return resp([{ n: 0 }]);
      if (/MAX\(llm_processed_at\) AS ts/.test(s)) return resp([{ ts: '2026-06-12T12:00:05Z' }]);
      if (/SUM\(input_tokens\)/.test(s)) return resp([{ calls: 10, input_tokens: '1000', output_tokens: '400', cache_creation_tokens: '0', cache_read_tokens: '800', cost_usd: '0.1000', cache_hit_pct: '70.0', avg_processing_ms: 4000 }]);
      if (/GROUP BY caller/.test(s)) return resp([{ caller: 'observer', calls: 10, cost_usd: '0.1000' }]);
      if (/processing_error IS NOT NULL/.test(s)) return resp([{ n: 1 }]);
      if (/FROM v3\.persons WHERE role = 'operator'/.test(s)) return resp(OPERATORS);
      if (/FROM v3\.persons ORDER BY id/.test(s)) return resp(ALL_PERSONS);
      if (/FROM v3\.products p/.test(s)) return resp(PRODUCTS);
      if (/FROM v3\.events e/.test(s)) return resp([]); // snapshot events (dia)
      return resp([]);
    }),
  };
  return db;
}

let server; let db; let base;
const GET = (path, headers = {}) => fetch(base + path, { headers });
const asArch = (path, extra = {}) => GET(path, { Authorization: `Bearer ${ARCH_TOKEN}`, ...extra });
const asOp = (path, extra = {}) => GET(path, { Authorization: `Bearer ${OP_TOKEN}`, ...extra });
const flushAudit = () => new Promise((r) => setTimeout(r, 40));

beforeAll(async () => {
  db = makeFakeDb();
  const app = express();
  app.use('/', createArchitectRouter({ db, architectToken: ARCH_TOKEN, operatorToken: OP_TOKEN }));
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => { db.audits.length = 0; });

const ARCH_ONLY = [
  `${B}/snapshot`, `${B}/audit`, `${B}/event/999`, `${B}/health`,
  `${B}/diagnostics/orphans`, `${B}/diagnostics/queue`, `${B}/diagnostics/llm_metrics`,
];
const OP_ROUTES = [`${B}/persons`, `${B}/person/4/today`, `${B}/open_events`, `${B}/supplements`];
const ALL_ROUTES = [...ARCH_ONLY, ...OP_ROUTES];

// ─── 401: sem token / token inválido ───────────────────────
describe('architect API — autenticação', () => {
  test.each(ALL_ROUTES)('401 sem token: %s', async (path) => {
    const r = await GET(path);
    expect(r.status).toBe(401);
  });

  test('401 token inválido', async () => {
    const r = await GET(`${B}/health`, { Authorization: 'Bearer wrong-token' });
    expect(r.status).toBe(401);
  });

  test('401 quando env tokens não configurados (string vazia nunca autentica)', async () => {
    const app2 = express();
    app2.use('/', createArchitectRouter({ db, architectToken: '', operatorToken: undefined }));
    const s2 = await new Promise((resolve) => { const x = app2.listen(0, '127.0.0.1', () => resolve(x)); });
    const r = await fetch(`http://127.0.0.1:${s2.address().port}${B}/health`, { headers: { Authorization: 'Bearer ' } });
    expect(r.status).toBe(401);
    const r2 = await fetch(`http://127.0.0.1:${s2.address().port}${B}/health`, { headers: { Authorization: `Bearer ${ARCH_TOKEN}` } });
    expect(r2.status).toBe(401);
    await new Promise((r3) => s2.close(r3));
  });
});

// ─── 200 com ARCHITECT_TOKEN em todas ───────────────────────
describe('architect API — scope architect (200 + shape)', () => {
  test.each(ALL_ROUTES)('200 architect: %s', async (path) => {
    const r = await asArch(path, path.includes('/person/4/') ? {} : {});
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toBeTruthy();
  });

  test('snapshot shape: totals + events + counts + messages', async () => {
    const r = await asArch(`${B}/snapshot?date=2026-06-12`);
    const j = await r.json();
    expect(j).toHaveProperty('totals');
    expect(Array.isArray(j.events)).toBe(true);
    expect(Array.isArray(j.counts)).toBe(true);
    expect(Array.isArray(j.messages)).toBe(true);
  });

  test('snapshot date inválida → 400', async () => {
    const r = await asArch(`${B}/snapshot?date=12-06-2026`);
    expect(r.status).toBe(400);
  });

  test('event/:id existente → event + source_message + audit_trail', async () => {
    const r = await asArch(`${B}/event/999`);
    const j = await r.json();
    expect(j.event.id).toBe(999);
    expect(j.source_message).toBeTruthy();
    expect(j.source_message.slack_ts).toBe('1781.100');
    expect(Array.isArray(j.audit_trail)).toBe(true);
  });

  test('event/:id inexistente → 404', async () => {
    const r = await asArch(`${B}/event/12345`);
    expect(r.status).toBe(404);
  });

  test('event/:id não-numérico → 400', async () => {
    const r = await asArch(`${B}/event/abc`);
    expect(r.status).toBe(400);
  });

  test('health shape', async () => {
    const r = await asArch(`${B}/health`);
    const j = await r.json();
    expect(j.db).toBe('connected');
    expect(typeof j.uptime_s).toBe('number');
    expect(j).toHaveProperty('queue_pending');
    expect(j).toHaveProperty('observer_avg_latency_ms_1h');
  });

  test('diagnostics/orphans shape', async () => {
    const r = await asArch(`${B}/diagnostics/orphans`);
    const j = await r.json();
    expect(j).toHaveProperty('events_without_source_message');
    expect(j).toHaveProperty('sf_messages_without_event');
  });

  test('diagnostics/queue shape', async () => {
    const r = await asArch(`${B}/diagnostics/queue`);
    const j = await r.json();
    expect(j).toHaveProperty('pending_messages');
    expect(j).toHaveProperty('oldest_pending_age_s');
    expect(j).toHaveProperty('pending_commands');
    expect(j).toHaveProperty('last_processed_ts');
  });

  test('diagnostics/llm_metrics shape', async () => {
    const r = await asArch(`${B}/diagnostics/llm_metrics`);
    const j = await r.json();
    expect(j).toHaveProperty('calls');
    expect(j).toHaveProperty('cost_usd');
    expect(j).toHaveProperty('cache_hit_pct');
    expect(Array.isArray(j.by_caller)).toBe(true);
  });

  test('persons (architect) inclui admins e operators', async () => {
    const r = await asArch(`${B}/persons`);
    const j = await r.json();
    const roles = j.persons.map((p) => p.role);
    expect(roles).toContain('owner');
    expect(roles).toContain('operator');
  });

  test('open_events separa background_events (is_long_running)', async () => {
    const r = await asArch(`${B}/open_events`);
    const j = await r.json();
    expect(j.open_events.map((e) => e.id)).toEqual([700]);
    expect(j.background_events.map((e) => e.id)).toEqual([213]);
  });
});

// ─── scope operator_page ─────────────────────────────────────
describe('architect API — scope operator_page', () => {
  test.each(ARCH_ONLY)('403 operator em rota architect-only: %s', async (path) => {
    const r = await asOp(path);
    expect(r.status).toBe(403);
  });

  test('200 operator: /persons (só operators ativos, sem pin_hash)', async () => {
    const r = await asOp(`${B}/persons`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.persons.every((p) => p.role === 'operator')).toBe(true);
    for (const p of j.persons) {
      expect(p).not.toHaveProperty('pin_hash');
      expect(p).not.toHaveProperty('pin_salt');
      expect(p).not.toHaveProperty('slack_user_id');
    }
  });

  test('200 operator: /person/4/today com X-Operator-Id=4', async () => {
    const r = await asOp(`${B}/person/4/today`, { 'X-Operator-Id': '4' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.person_id).toBe(4);
    expect(Array.isArray(j.events)).toBe(true);
  });

  test('403 operator: /person/5/today com X-Operator-Id=4 (mismatch)', async () => {
    const r = await asOp(`${B}/person/5/today`, { 'X-Operator-Id': '4' });
    expect(r.status).toBe(403);
  });

  test('403 operator: /person/4/today SEM X-Operator-Id', async () => {
    const r = await asOp(`${B}/person/4/today`);
    expect(r.status).toBe(403);
  });

  test('architect NÃO precisa de X-Operator-Id em /person/:id/today', async () => {
    const r = await asArch(`${B}/person/5/today`);
    expect(r.status).toBe(200);
  });

  test('200 operator: /open_events com campos RESTRITOS', async () => {
    const r = await asOp(`${B}/open_events`);
    expect(r.status).toBe(200);
    const j = await r.json();
    const ev = j.open_events[0];
    expect(ev).toEqual({
      id: 700, display_name: 'Vitor', slug: 'production_line',
      batch_number: 'BR-2026-0190', started_at_edt: expect.any(String), cowork_with: [6],
    });
    expect(ev).not.toHaveProperty('confidence');
    expect(ev).not.toHaveProperty('source_message_ts');
    expect(j.background_events[0].id).toBe(213);
  });

  test('200 operator: /supplements com e sem q', async () => {
    const r1 = await asOp(`${B}/supplements?q=gly`);
    expect(r1.status).toBe(200);
    const j1 = await r1.json();
    expect(Array.isArray(j1.supplements)).toBe(true);
    expect(j1.supplements[0]).toHaveProperty('canonical_name');
    expect(j1.supplements[0]).toHaveProperty('aliases');
    const r2 = await asOp(`${B}/supplements`);
    expect(r2.status).toBe(200);
  });

  test('supplements: q é passado parametrizado (sem concatenação SQL)', async () => {
    await asOp(`${B}/supplements?q=${encodeURIComponent("x'; DROP TABLE v3.events; --")}`);
    const calls = db.query.mock.calls.filter((c) => /FROM v3\.products p/.test(String(c[0])) && c[1] && c[1].length);
    const call = calls[calls.length - 1]; // última (mock acumula entre tests)
    expect(call).toBeTruthy();
    expect(call[1][0]).toContain('DROP TABLE'); // foi pro $1, não pro SQL
    expect(String(call[0])).not.toContain('DROP TABLE');
  });
});

// ─── rate-limit ──────────────────────────────────────────────
describe('architect API — rate-limit (60/min/IP só operator_page)', () => {
  test('operator: 60 requests passam, a 61ª → 429', async () => {
    // server dedicado pra não poluir o contador do principal
    const db2 = makeFakeDb();
    const app2 = express();
    app2.use('/', createArchitectRouter({ db: db2, architectToken: ARCH_TOKEN, operatorToken: OP_TOKEN }));
    const s2 = await new Promise((resolve) => { const x = app2.listen(0, '127.0.0.1', () => resolve(x)); });
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    let last = null;
    for (let i = 0; i < 60; i++) {
      last = await fetch(`${b2}${B}/persons`, { headers: { Authorization: `Bearer ${OP_TOKEN}` } });
      expect(last.status).toBe(200);
    }
    const over = await fetch(`${b2}${B}/persons`, { headers: { Authorization: `Bearer ${OP_TOKEN}` } });
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBeTruthy();
    await new Promise((r) => s2.close(r));
  }, 30000);

  test('architect: bypassa rate-limit (61+ requests ok)', async () => {
    const db2 = makeFakeDb();
    const app2 = express();
    app2.use('/', createArchitectRouter({ db: db2, architectToken: ARCH_TOKEN, operatorToken: OP_TOKEN }));
    const s2 = await new Promise((resolve) => { const x = app2.listen(0, '127.0.0.1', () => resolve(x)); });
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    for (let i = 0; i < 61; i++) {
      const r = await fetch(`${b2}${B}/health`, { headers: { Authorization: `Bearer ${ARCH_TOKEN}` } });
      expect(r.status).toBe(200);
    }
    await new Promise((r) => s2.close(r));
  }, 30000);
});

// ─── audit log ───────────────────────────────────────────────
describe('architect API — audit de toda chamada', () => {
  test('chamada architect → 1 entry com actor=architect, endpoint, status, latency', async () => {
    await asArch(`${B}/health`);
    await flushAudit();
    expect(db.audits).toHaveLength(1);
    const a = db.audits[0];
    expect(a.actor_type).toBe('admin'); // CHECK constraint: architect→admin
    expect(a.metadata.actor).toBe('architect');
    expect(a.metadata.endpoint).toBe(`${B}/health`);
    expect(a.metadata.response_status).toBe(200);
    expect(typeof a.metadata.latency_ms).toBe('number');
  });

  test('chamada operator_page → actor_type=operator_page (CHECK ampliado na 018)', async () => {
    await asOp(`${B}/persons`);
    await flushAudit();
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0].actor_type).toBe('operator_page');
    expect(db.audits[0].metadata.actor).toBe('operator_page');
  });

  test('401 também é auditado (actor=unauthenticated)', async () => {
    await GET(`${B}/health`);
    await flushAudit();
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0].metadata.actor).toBe('unauthenticated');
    expect(db.audits[0].metadata.response_status).toBe(401);
  });

  test('403 também é auditado com status correto', async () => {
    await asOp(`${B}/health`);
    await flushAudit();
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0].metadata.response_status).toBe(403);
  });

  test('falha no INSERT de audit NÃO derruba a resposta', async () => {
    const db3 = makeFakeDb();
    const origQuery = db3.query;
    db3.query = jest.fn(async (sql, params) => {
      if (/INSERT INTO v3\.audit_log/.test(String(sql))) throw new Error('db down');
      return origQuery(sql, params);
    });
    const app3 = express();
    app3.use('/', createArchitectRouter({ db: db3, architectToken: ARCH_TOKEN, operatorToken: OP_TOKEN }));
    const s3 = await new Promise((resolve) => { const x = app3.listen(0, '127.0.0.1', () => resolve(x)); });
    const r = await fetch(`http://127.0.0.1:${s3.address().port}${B}/health`, { headers: { Authorization: `Bearer ${ARCH_TOKEN}` } });
    expect(r.status).toBe(200);
    await new Promise((r2) => s3.close(r2));
  });
});
