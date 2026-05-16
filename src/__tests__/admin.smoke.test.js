'use strict';
/**
 * Entrega 2 commit 14: end-to-end integration smoke tests.
 *
 * Each test exercises a realistic admin SEQUENCE (e.g. create → edit →
 * close → reopen → delete) instead of an isolated endpoint. The goal is
 * to catch ordering bugs and to confirm every step writes its expected
 * audit_log row.
 *
 * Unlike scripts/admin-validate.js (which hits real prod), these run
 * with jest.mock'd db and verify the SQL/audit shape locally.
 */

jest.mock('../db');
jest.mock('../slack/client');
jest.mock('../parser');
jest.mock('../eod');

const db = require('../db');
const express = require('express');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', require('../routes/api'));
  return app;
}

function request(method, url, body) {
  return new Promise((resolve) => {
    const http = require('http');
    const server = buildApp().listen(0, () => {
      const port = server.address().port;
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({
        hostname: '127.0.0.1', port, path: url, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      }, (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          server.close();
          let parsed = null; try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', () => { server.close(); resolve({ status: 0, body: null }); });
      if (data) req.write(data);
      req.end();
    });
  });
}

function auditCalls() {
  return db.query.mock.calls
    .filter((c) => /INSERT INTO admin_audit_log/.test(c[0]))
    .map((c) => ({ action: c[1][1], entity_type: c[1][2], entity_id: c[1][3] }));
}

beforeEach(() => { jest.clearAllMocks(); });

// ─── Stateful task store — simulates a real DB through one test ──────────
function taskStore(initial = []) {
  const tasks = new Map(initial.map((t) => [t.id, { ...t }]));
  let nextId = Math.max(0, ...initial.map((t) => t.id)) + 1;
  return {
    get: (id) => tasks.get(Number(id)) ? { ...tasks.get(Number(id)) } : null,
    insert: (row) => { const id = nextId++; tasks.set(id, { ...row, id }); return id; },
    update: (id, patch) => { const r = tasks.get(Number(id)); if (r) Object.assign(r, patch); },
    all: () => Array.from(tasks.values()),
  };
}

describe('Task lifecycle — create → edit → close → reopen → delete', () => {
  test('every step succeeds and writes its own audit row', async () => {
    const store = taskStore();

    db.query = jest.fn().mockImplementation((sql, params) => {
      // INSERT new task
      if (/INSERT INTO tasks[\s\S]*RETURNING id/.test(sql)) {
        const id = store.insert({
          operator: params[0], supplement_name: params[1], batch_number: params[2],
          status: 'open', started_at: '2026-05-15T10:00:00Z', ended_at: null,
        });
        return Promise.resolve({ rows: [{ id }] });
      }
      // snapshotRow: SELECT * FROM tasks WHERE id = $1 LIMIT 1
      if (/SELECT \* FROM tasks WHERE id = \$1 LIMIT 1/.test(sql)) {
        const r = store.get(params[0]);
        return Promise.resolve({ rows: r ? [r] : [] });
      }
      // UPDATE for edit / close / reopen / delete
      if (/UPDATE tasks SET[\s\S]*WHERE id = /.test(sql)) {
        const id = params[params.length - 1];
        // Sniff the SQL to know what changed
        if (/status = 'deleted'/.test(sql))   store.update(id, { status: 'deleted' });
        else if (/status = 'closed'/.test(sql)) store.update(id, { status: 'closed', ended_at: '2026-05-15T11:00:00Z' });
        else if (/status = 'open'/.test(sql) && /ended_at = NULL/.test(sql)) store.update(id, { status: 'open', ended_at: null });
        else {
          // edit — apply by inspecting which fields the SET clause touches
          const r = store.get(id);
          if (r) {
            if (/helpers/.test(sql)) r.helpers = params.find(p => typeof p === 'string' && p.includes(','));
            store.update(id, r);
          }
        }
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    // 1. CREATE
    let r = await request('POST', '/api/admin/task/create', {
      pin: '510510', supplement_name: 'Berberine', operator: 'Vitor', started_at: '2026-05-15 10:00',
    });
    expect(r.status).toBe(200);
    const taskId = r.body.id;
    expect(taskId).toBeGreaterThan(0);

    // 2. EDIT (helpers)
    r = await request('PUT', '/api/admin/task/' + taskId, { pin: '510510', helpers: 'Ana, Bruno' });
    expect(r.status).toBe(200);

    // 3. CLOSE
    r = await request('POST', '/api/admin/task/' + taskId + '/close', { pin: '510510' });
    expect(r.status).toBe(200);

    // 4. REOPEN
    r = await request('POST', '/api/admin/task/' + taskId + '/reopen', { pin: '510510' });
    expect(r.status).toBe(200);

    // 5. DELETE (soft)
    r = await request('DELETE', '/api/admin/task/' + taskId + '?pin=510510');
    expect(r.status).toBe(200);

    // Audit sequence is in order
    const audits = auditCalls().filter((a) => a.entity_id === String(taskId));
    expect(audits.map((a) => a.action)).toEqual([
      'task.create',
      'task.edit',
      'task.close',
      'task.reopen',
      'task.delete',
    ]);
  });
});

describe('Pause lifecycle — create → edit → close → delete', () => {
  test('every step writes its audit row in order', async () => {
    let nextId = 100;
    const store = new Map();

    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/INSERT INTO pauses[\s\S]*RETURNING id/.test(sql)) {
        const id = nextId++;
        store.set(id, { id, operator: params[0], reason: params[1], started_at: params[2],
                        task_id: params[3], ended_at: null, deleted_at: null });
        return Promise.resolve({ rows: [{ id }] });
      }
      if (/SELECT \* FROM pauses WHERE id = \$1 LIMIT 1/.test(sql)) {
        const r = store.get(Number(params[0]));
        return Promise.resolve({ rows: r ? [{ ...r }] : [] });
      }
      if (/UPDATE pauses SET/.test(sql)) {
        const id = Number(params[params.length - 1]);
        const r = store.get(id);
        if (r) {
          if (/deleted_at = NOW\(\)/.test(sql)) r.deleted_at = '2026-05-15T13:00:00Z';
          else if (/ended_reason = 'admin_force_close'/.test(sql)) {
            r.ended_at = params[0]; r.ended_reason = 'admin_force_close';
          } else if (/SET ended_at = \$1/.test(sql)) {
            // standalone close-from-create path
            r.ended_at = params[0];
          } else {
            // generic edit — apply reason if present
            if (/reason/.test(sql)) {
              const reasonParam = params.find(p => typeof p === 'string' && /edited/.test(p));
              if (reasonParam) r.reason = reasonParam;
            }
          }
        }
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    // 1. CREATE
    let r = await request('POST', '/api/admin/pause/create', {
      pin: '510510', operator: 'Ana', reason: 'almoço', started_at: '2026-05-15 12:00',
    });
    expect(r.status).toBe(200);
    const pid = r.body.id;

    // 2. EDIT
    r = await request('PUT', '/api/admin/pause/' + pid, { pin: '510510', reason: 'edited reason' });
    expect(r.status).toBe(200);

    // 3. CLOSE
    r = await request('POST', '/api/admin/pause/' + pid + '/close', { pin: '510510' });
    expect(r.status).toBe(200);

    // 4. DELETE (soft)
    r = await request('DELETE', '/api/admin/pause/' + pid + '?pin=510510');
    expect(r.status).toBe(200);

    const audits = auditCalls().filter((a) => a.entity_id === String(pid));
    expect(audits.map((a) => a.action)).toEqual([
      'pause.create',
      'pause.edit',
      'pause.close',
      'pause.delete',
    ]);
  });
});

describe('Merge scenario — 2 tasks become 1, alias learned, audit row complete', () => {
  test('survivor wins, others soft-deleted, task_aliases populated, audit task.merge', async () => {
    const TASK_A = {
      id: 200, operator: 'Vitor', supplement_name: 'Berberine', batch_number: '0119',
      description: 'A', task_type: 'producao', helpers: null,
      started_at: '2026-05-15T10:00:00Z', ended_at: '2026-05-15T11:00:00Z',
      status: 'closed', slack_start_ts: '1700000000.000000',
    };
    const TASK_B = {
      id: 201, operator: 'Bruno', supplement_name: 'Berberina', batch_number: '0119',
      description: 'B', task_type: 'producao', helpers: 'Ana',
      started_at: '2026-05-15T11:30:00Z', ended_at: '2026-05-15T12:30:00Z',
      status: 'closed', slack_start_ts: '1700001000.000000',
    };
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, operator, supplement_name[\s\S]+FROM tasks[\s\S]+ORDER BY started_at ASC/.test(sql)) {
        return Promise.resolve({ rows: [TASK_A, TASK_B] });
      }
      if (/SELECT \* FROM tasks WHERE id = \$1/.test(sql)) {
        return Promise.resolve({ rows: [TASK_A] });
      }
      return Promise.resolve({ rows: [] });
    });

    const r = await request('POST', '/api/admin/task/merge', { pin: '510510', taskIds: [200, 201] });
    expect(r.status).toBe(200);
    expect(r.body.survivor_id).toBe(200);
    expect(r.body.merged_ids).toEqual([201]);
    expect(r.body.learned_aliases).toEqual([{ canonical: 'berberine', alias: 'berberina' }]);

    // task_aliases insert happened
    const aliasInsert = db.query.mock.calls.find((c) => /INSERT INTO task_aliases/.test(c[0]));
    expect(aliasInsert).toBeTruthy();
    expect(aliasInsert[1]).toEqual(['Berberine', 'Berberina', 200]);

    // production_counts re-pointed
    const pcRepoint = db.query.mock.calls.find((c) =>
      /UPDATE production_counts SET task_id = \$1/.test(c[0])
    );
    expect(pcRepoint[1]).toEqual([200, [201]]);

    // Non-survivor was soft-deleted
    const softDel = db.query.mock.calls.find((c) =>
      /UPDATE tasks SET status = 'deleted'/.test(c[0]) && c[1][1] === 201
    );
    expect(softDel).toBeTruthy();
    expect(softDel[1][0]).toMatch(/\[merged into #200\]/);

    // Single audit row, action=task.merge
    const audits = auditCalls();
    expect(audits.length).toBe(1);
    expect(audits[0]).toEqual({ action: 'task.merge', entity_type: 'task', entity_id: '200' });
  });
});

describe('Audit trail — after many ops, query returns them filterable', () => {
  test('GET /admin/audit?entity_type=task&action=task.delete works end-to-end', async () => {
    // Simulate: query returns 2 task.delete rows for entity_type=task
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/SELECT id, admin_user, action[\s\S]+FROM admin_audit_log/.test(sql)) {
        return Promise.resolve({ rows: [
          { id: 100, action: 'task.delete', entity_type: 'task', entity_id: '5', after_data: null, before_data: { id: 5 }, created_at: '2026-05-15T13:00:00Z' },
          { id: 99,  action: 'task.delete', entity_type: 'task', entity_id: '4', after_data: null, before_data: { id: 4 }, created_at: '2026-05-15T12:00:00Z' },
        ]});
      }
      if (/SELECT COUNT\(\*\)::int AS total FROM admin_audit_log/.test(sql)) {
        return Promise.resolve({ rows: [{ total: 2 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const r = await request('GET', '/api/admin/audit?pin=510510&entity_type=task&action=task.delete');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.rows.every((x) => x.action === 'task.delete' && x.entity_type === 'task')).toBe(true);

    // The SELECT had WHERE on both filters
    const selectCall = db.query.mock.calls.find((c) => /FROM admin_audit_log\s*\n\s*WHERE/.test(c[0]));
    expect(selectCall[1]).toEqual(['task', 'task.delete']);
  });
});

describe('Operator full flow — create → edit role → deactivate', () => {
  test('all three steps audited in order', async () => {
    let active = true;
    let role = null;
    db.query = jest.fn().mockImplementation((sql) => {
      if (/INSERT INTO operators[\s\S]*RETURNING id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 50 }] });
      }
      if (/SELECT \* FROM operators WHERE id = \$1/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 50, name: 'TestOp', role, active }] });
      }
      if (/UPDATE operators SET[\s\S]*WHERE id = /.test(sql)) {
        if (/active = FALSE/.test(sql)) active = false;
        if (/role/.test(sql)) role = 'manager';
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    let r = await request('POST', '/api/admin/operator/create', { pin: '510510', name: 'TestOp' });
    expect(r.status).toBe(200);

    r = await request('PUT', '/api/admin/operator/50', { pin: '510510', role: 'manager' });
    expect(r.status).toBe(200);

    r = await request('DELETE', '/api/admin/operator/50?pin=510510');
    expect(r.status).toBe(200);

    const actions = auditCalls().filter((a) => a.entity_id === '50').map((a) => a.action);
    expect(actions).toEqual(['operator.create', 'operator.edit', 'operator.deactivate']);
  });
});

describe('Soft-delete invariant — deleted entities do not appear in active queries', () => {
  test('a deleted task is recorded but no longer returned by the audit-listing for active rows', async () => {
    // This is a structural test — confirm that getOpenTasks / getTodayTasks
    // queries in tasks.js still hardcode status IN ('open', 'closed') so
    // 'deleted' is naturally excluded.
    const tasksSrc = require('fs').readFileSync(require.resolve('../tasks.js'), 'utf8');
    expect(tasksSrc).toMatch(/status\s*=\s*'open'/);
    expect(tasksSrc).toMatch(/status\s*=\s*'closed'/);
    // No place selects status='deleted' in listing queries
    const listMatches = tasksSrc.match(/SELECT[\s\S]+?FROM tasks[\s\S]+?WHERE[\s\S]+?status/g) || [];
    for (const m of listMatches) {
      expect(m).not.toMatch(/status\s*=\s*'deleted'/);
    }
  });

  test('pauses/orders/counts queries filter deleted_at IS NULL', async () => {
    // The new admin GET endpoints we added all filter deleted_at IS NULL.
    const apiSrc = require('fs').readFileSync(require.resolve('../routes/api.js'), 'utf8');
    // For pauses GET
    expect(apiSrc).toMatch(/FROM pauses p[\s\S]+?deleted_at IS NULL/);
    // For counts GET
    expect(apiSrc).toMatch(/FROM production_counts[\s\S]+?deleted_at IS NULL/);
    // For notes GET
    expect(apiSrc).toMatch(/FROM messages[\s\S]+?deleted_at IS NULL/);
  });
});
