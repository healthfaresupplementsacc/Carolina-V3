'use strict';
/**
 * Entrega 2 commit 8: task merge endpoint.
 *
 * POST /api/admin/task/merge { pin, taskIds: [int...] }
 *
 * Rules (master doc §16.2.1 + Entrega 2 §4):
 *  - 2+ task IDs, survivor = oldest started_at.
 *  - ended_at = most recent across inputs (NULL if any open).
 *  - operator stays as survivor's; helpers = union of others'.
 *  - production_counts re-point to survivor.
 *  - non-survivors soft-deleted (status='deleted') with merge marker.
 *  - task_aliases learns synonym pairs when canonical terms differ.
 */

jest.mock('../db');
jest.mock('../slack/client');
jest.mock('../parser');
jest.mock('../eod');

const db = require('../db');
const express = require('express');

beforeEach(() => { jest.clearAllMocks(); });

function request(method, url, body) {
  return new Promise((resolve) => {
    const http = require('http');
    const app = express();
    app.use(express.json());
    app.use('/api', require('../routes/api'));
    const server = app.listen(0, () => {
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

function findAudit(action) {
  return db.query.mock.calls.find((c) =>
    /INSERT INTO admin_audit_log/.test(c[0]) && c[1][1] === action
  );
}

const TASK_A = {
  id: 10, operator: 'Vitor', supplement_name: 'Berberine', batch_number: '0119',
  description: 'lote A', task_type: 'producao', helpers: null,
  started_at: '2026-05-15T10:00:00Z', ended_at: '2026-05-15T11:00:00Z',
  status: 'closed', slack_start_ts: '1700000000.000000',
};
const TASK_B = {
  id: 11, operator: 'Bruno', supplement_name: 'Berberina', batch_number: '0119',
  description: 'mesmo lote', task_type: 'producao', helpers: 'Ana',
  started_at: '2026-05-15T11:30:00Z', ended_at: '2026-05-15T12:30:00Z',
  status: 'closed', slack_start_ts: '1700001000.000000',
};

describe('POST /api/admin/task/merge — input validation', () => {
  test('400 when fewer than 2 IDs', async () => {
    const r = await request('POST', '/api/admin/task/merge', { pin: '510510', taskIds: [10] });
    expect(r.status).toBe(400);
  });

  test('400 when duplicate IDs after dedup leave fewer than 2', async () => {
    const r = await request('POST', '/api/admin/task/merge', { pin: '510510', taskIds: [10, 10, 10] });
    expect(r.status).toBe(400);
  });

  test('404 when one of the tasks is missing', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [TASK_A] }); // only one of the two found
    const r = await request('POST', '/api/admin/task/merge', { pin: '510510', taskIds: [10, 11] });
    expect(r.status).toBe(404);
  });

  test('400 when one of the tasks is already deleted', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [TASK_A, { ...TASK_B, status: 'deleted' }] });
    const r = await request('POST', '/api/admin/task/merge', { pin: '510510', taskIds: [10, 11] });
    expect(r.status).toBe(400);
  });

  test('403 on wrong pin', async () => {
    const r = await request('POST', '/api/admin/task/merge', { pin: 'wrong', taskIds: [10, 11] });
    expect(r.status).toBe(403);
  });
});

describe('POST /api/admin/task/merge — successful merge', () => {
  function setupMergeMocks(survivorRow) {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, operator, supplement_name[\s\S]*FROM tasks[\s\S]*ORDER BY started_at ASC/.test(sql)) {
        return Promise.resolve({ rows: [TASK_A, TASK_B] });
      }
      if (/SELECT \* FROM tasks WHERE id = \$1/.test(sql)) {
        return Promise.resolve({ rows: [survivorRow] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  test('survivor = oldest started_at, others soft-deleted, response includes ids', async () => {
    setupMergeMocks({ ...TASK_A, helpers: 'Ana, Bruno', ended_at: TASK_B.ended_at });
    const r = await request('POST', '/api/admin/task/merge', { pin: '510510', taskIds: [10, 11] });
    expect(r.status).toBe(200);
    expect(r.body.survivor_id).toBe(10);
    expect(r.body.merged_ids).toEqual([11]);

    // Survivor was UPDATEd with merged helpers (Bruno from non-survivor + existing Ana)
    const survUpdate = db.query.mock.calls.find((c) =>
      /UPDATE tasks[\s\S]*helpers/.test(c[0]) && c[1].includes('Ana, Bruno')
    );
    expect(survUpdate).toBeTruthy();

    // Non-survivor was soft-deleted with merge marker
    const nonSurv = db.query.mock.calls.find((c) =>
      /UPDATE tasks SET status = 'deleted'/.test(c[0]) && c[1][1] === 11
    );
    expect(nonSurv).toBeTruthy();
    expect(nonSurv[1][0]).toMatch(/\[merged into #10\]/);

    // production_counts re-pointed
    const pcRepoint = db.query.mock.calls.find((c) =>
      /UPDATE production_counts SET task_id = \$1/.test(c[0])
    );
    expect(pcRepoint).toBeTruthy();
    expect(pcRepoint[1][0]).toBe(10);
    expect(pcRepoint[1][1]).toEqual([11]);

    // Audit row with action=task.merge
    expect(findAudit('task.merge')).toBeTruthy();
  });

  test('task_aliases learns Berberine ↔ Berberina synonym', async () => {
    setupMergeMocks({ ...TASK_A });
    const r = await request('POST', '/api/admin/task/merge', { pin: '510510', taskIds: [10, 11] });
    expect(r.status).toBe(200);

    const aliasInsert = db.query.mock.calls.find((c) =>
      /INSERT INTO task_aliases/.test(c[0])
    );
    expect(aliasInsert).toBeTruthy();
    expect(aliasInsert[1][0]).toBe('Berberine'); // canonical (from survivor)
    expect(aliasInsert[1][1]).toBe('Berberina'); // alias (from non-survivor)
    expect(aliasInsert[1][2]).toBe(10); // learned_from_task_id

    expect(r.body.learned_aliases).toEqual([
      { canonical: 'berberine', alias: 'berberina' },
    ]);
  });

  test('does NOT learn alias when terms are identical', async () => {
    const TASK_B_SAME = { ...TASK_B, supplement_name: 'Berberine' };
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, operator, supplement_name[\s\S]*FROM tasks[\s\S]*ORDER BY started_at ASC/.test(sql)) {
        return Promise.resolve({ rows: [TASK_A, TASK_B_SAME] });
      }
      if (/SELECT \* FROM tasks WHERE id = \$1/.test(sql)) {
        return Promise.resolve({ rows: [TASK_A] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('POST', '/api/admin/task/merge', { pin: '510510', taskIds: [10, 11] });
    expect(r.status).toBe(200);
    const aliasInsert = db.query.mock.calls.find((c) => /INSERT INTO task_aliases/.test(c[0]));
    expect(aliasInsert).toBeFalsy();
    expect(r.body.learned_aliases).toEqual([]);
  });

  test('any open task → survivor remains open, no ended_at update', async () => {
    const OPEN_B = { ...TASK_B, ended_at: null, status: 'open' };
    db.query = jest.fn().mockImplementation((sql) => {
      if (/SELECT id, operator, supplement_name[\s\S]*FROM tasks[\s\S]*ORDER BY started_at ASC/.test(sql)) {
        return Promise.resolve({ rows: [TASK_A, OPEN_B] });
      }
      if (/SELECT \* FROM tasks WHERE id = \$1/.test(sql)) {
        return Promise.resolve({ rows: [TASK_A] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await request('POST', '/api/admin/task/merge', { pin: '510510', taskIds: [10, 11] });
    expect(r.status).toBe(200);
    // The survivor UPDATE should set status='open' and NOT include the ended_at param
    const survUpdate = db.query.mock.calls.find((c) =>
      /UPDATE tasks[\s\S]*helpers/.test(c[0]) && /status\s*=\s*'open'/.test(c[0])
    );
    expect(survUpdate).toBeTruthy();
  });
});
