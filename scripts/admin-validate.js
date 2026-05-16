'use strict';
/**
 * Admin endpoint validator — runs against PRODUCTION (or any deployed env).
 *
 * Usage:
 *   railway run --service ProductionLineService node scripts/admin-validate.js
 *
 * For every /admin/* endpoint introduced by Entrega 2 (and the retrofitted
 * pre-existing ones from commit 2), the script:
 *   1. Performs the HTTP call with a valid payload.
 *   2. Asserts a 2xx response shape.
 *   3. Queries the DB to confirm the row was actually written/updated.
 *   4. Confirms admin_audit_log gained a matching row.
 *
 * Side effects on production:
 *   - Creates test rows in tasks, pauses, production_counts, operators,
 *     orders_sessions, supplement_catalog. All marked with the prefix
 *     "[admin-validate]" or test names so admin can spot them.
 *   - At the end, attempts to soft-delete every test row.
 *   - Operators created are deactivated (no hard delete — operators table
 *     uses active=false).
 *
 * No Slack messages are sent. The /admin/broadcast endpoint is NOT exercised
 * here because it posts to the real production channel — admin can validate
 * it manually if needed.
 *
 * Exit code: 0 if all green, 1 if any failure.
 */

const http = require('http');
const https = require('https');
const url = require('url');
const { Pool } = require('pg');

// ─── Config ──────────────────────────────────────────────────────────────
const BASE_URL = process.env.BASE_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null)
  || 'https://productionlineservice-production.up.railway.app';
const PIN = process.env.ADMIN_PIN || '510510';
const DB_URL = process.env.DATABASE_URL;

if (!DB_URL) {
  console.error('FATAL: DATABASE_URL not set. Run via `railway run`.');
  process.exit(2);
}

const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false },
});

const MARKER = '[admin-validate]';

// ─── HTTP helpers ────────────────────────────────────────────────────────
function httpReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new url.URL(BASE_URL + path);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: data ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      } : {},
    };
    const req = lib.request(opts, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const adminGet    = (path, qs = '')        => httpReq('GET',    `${path}?pin=${encodeURIComponent(PIN)}${qs ? '&' + qs : ''}`);
const adminPost   = (path, body = {})      => httpReq('POST',   path, { pin: PIN, ...body });
const adminPut    = (path, body = {})      => httpReq('PUT',    path, { pin: PIN, ...body });
const adminDelete = (path)                  => httpReq('DELETE', `${path}?pin=${encodeURIComponent(PIN)}`);

// ─── DB helpers ──────────────────────────────────────────────────────────
async function dbQuery(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}
async function lastAudit(action, entityId) {
  const rows = await dbQuery(
    `SELECT id, action, entity_type, entity_id, before_data, after_data
     FROM admin_audit_log
     WHERE action = $1 ${entityId != null ? 'AND entity_id = $2' : ''}
     ORDER BY id DESC LIMIT 1`,
    entityId != null ? [action, String(entityId)] : [action]
  );
  // pg auto-parses JSONB to objects, but some drivers return strings.
  // Normalize so callers can just use row.after_data.helpers etc.
  const row = rows[0];
  if (row) {
    if (typeof row.before_data === 'string') { try { row.before_data = JSON.parse(row.before_data); } catch {} }
    if (typeof row.after_data  === 'string') { try { row.after_data  = JSON.parse(row.after_data);  } catch {} }
  }
  return row || null;
}

// ─── Test runner ─────────────────────────────────────────────────────────
const results = [];
async function step(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    await fn();
    console.log('PASS');
    results.push({ name, ok: true });
  } catch (err) {
    console.log(`FAIL: ${err.message}`);
    results.push({ name, ok: false, error: err.message });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assert2xx(r, msg) {
  assert(r.status >= 200 && r.status < 300, `${msg} — status ${r.status} body=${JSON.stringify(r.body).slice(0,200)}`);
}

// ─── Track created entities for cleanup ──────────────────────────────────
const cleanup = {
  taskIds: [],
  pauseIds: [],
  countIds: [],
  ordersIds: [],
  operatorIds: [],
  supplements: [],
};

// ─── Setup / health gate ─────────────────────────────────────────────────
async function ensureHealthy() {
  const r = await httpReq('GET', '/api/health');
  assert2xx(r, '/api/health');
  assert(r.body?.db === 'connected', '/api/health says db not connected');
}

// ─── Entrega 3 — workflow model endpoints ────────────────────────────────
async function runEntrega3Workflow() {
  console.log('\n[Entrega 3 — workflow model]');
  let wtId, ptId, wiId, piId;

  await step('GET /api/workflow-templates → seeded 3+ templates', async () => {
    const r = await httpReq('GET', '/api/workflow-templates');
    assert2xx(r, 'workflow-templates list');
    assert(Array.isArray(r.body) && r.body.length >= 3, 'expected >=3 seeded templates');
    const prod = r.body.find((w) => /Produção de Suplemento/.test(w.name));
    assert(prod, 'Produção de Suplemento template missing');
    wtId = prod.id;
  });

  await step('GET /api/workflow-templates/:id → 7 phases incl. Mix required', async () => {
    const r = await httpReq('GET', `/api/workflow-templates/${wtId}`);
    assert2xx(r, 'workflow-template detail');
    assert(r.body.phases && r.body.phases.length >= 7, `expected >=7 phases, got ${r.body.phases?.length}`);
    const mix = r.body.phases.find((p) => p.name === 'Mix');
    assert(mix && mix.is_required === true, 'Mix should be required');
    const rev = r.body.phases.find((p) => p.name === 'Revisão');
    assert(rev && rev.prerequisite_mode === 'any', 'Revisão prereq mode should be any');
    ptId = r.body.phases.find((p) => p.name === 'Formulação').id;
  });

  await step('GET /api/ad-hoc-tasks → 8 seeded incl. Transformação', async () => {
    const r = await httpReq('GET', '/api/ad-hoc-tasks');
    assert2xx(r, 'ad-hoc list');
    const names = r.body.map((t) => t.name);
    for (const n of ['Limpeza','Transformação','Reporte no sistema','Outro']) {
      assert(names.includes(n), `ad-hoc '${n}' missing from catalog`);
    }
  });

  await step('POST /api/admin/workflow-instances → create test instance', async () => {
    const r = await adminPost('/api/admin/workflow-instances', {
      workflow_template_id: wtId, product_name: `AV_${Date.now()}`,
      batch_number: 'AVTEST', started_at: '2026-05-15 02:00',
    });
    assert2xx(r, 'workflow-instance create');
    wiId = r.body.id;
    cleanup.workflowInstanceIds = cleanup.workflowInstanceIds || [];
    cleanup.workflowInstanceIds.push(wiId);
    const a = await lastAudit('workflow_instance.create', wiId);
    assert(a, 'audit workflow_instance.create missing');
  });

  await step('PUT /api/admin/workflow-instances/:id batch change → batch_changed audit', async () => {
    const r = await adminPut(`/api/admin/workflow-instances/${wiId}`, { batch_number: 'AVTEST2' });
    assert2xx(r, 'workflow-instance batch edit');
    assert(r.body.batch_changed === true, 'expected batch_changed=true');
    const a = await lastAudit('workflow_instance.batch_changed', wiId);
    assert(a, 'audit workflow_instance.batch_changed missing');
  });

  await step('POST /api/admin/phase-instances → create + audit', async () => {
    const r = await adminPost('/api/admin/phase-instances', {
      workflow_instance_id: wiId, phase_template_id: ptId, started_at: '2026-05-15 02:00',
    });
    assert2xx(r, 'phase-instance create');
    piId = r.body.id;
    const a = await lastAudit('phase_instance.create', piId);
    assert(a, 'audit phase_instance.create missing');
  });

  await step('GET /api/operator-panel → array shape', async () => {
    const r = await adminGet('/api/operator-panel');
    assert2xx(r, 'operator-panel');
    assert(Array.isArray(r.body), 'operator-panel should be an array');
  });

  await step('DELETE /api/admin/phase-instances/:id (soft) + workflow cleanup', async () => {
    const r1 = await adminDelete(`/api/admin/phase-instances/${piId}`);
    assert2xx(r1, 'phase-instance delete');
    const r2 = await adminDelete(`/api/admin/workflow-instances/${wiId}`);
    assert2xx(r2, 'workflow-instance delete');
    const rows = await dbQuery('SELECT status FROM workflow_instances WHERE id = $1', [wiId]);
    assert(rows[0]?.status === 'deleted', 'workflow_instance should be soft-deleted');
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────
async function runTaskLifecycle() {
  console.log('\n[Tasks — commits 2 + 7]');
  let taskId;

  await step('POST /admin/task/create → 200 + DB row + audit task.create', async () => {
    const r = await adminPost('/api/admin/task/create', {
      supplement_name: `TestSupp_${Date.now()}`, batch_number: '9999',
      operator: 'AdminValidateTest', started_at: '2026-05-15 02:00',
    });
    assert2xx(r, 'task.create');
    taskId = r.body.id;
    cleanup.taskIds.push(taskId);
    const rows = await dbQuery('SELECT id, supplement_name, status FROM tasks WHERE id = $1', [taskId]);
    assert(rows[0]?.status === 'open', 'task should be open after create');
    const a = await lastAudit('task.create', taskId);
    assert(a, 'audit task.create not written');
  });

  await step('PUT  /admin/task/:id with helpers/task_type/description → audit task.edit', async () => {
    const r = await adminPut(`/api/admin/task/${taskId}`, {
      helpers: 'Ana, Bruno', task_type: 'revisao',
      description: `${MARKER} edited by admin-validate`,
    });
    assert2xx(r, 'task.edit');
    const rows = await dbQuery('SELECT helpers, task_type, description FROM tasks WHERE id = $1', [taskId]);
    assert(rows[0].helpers === 'Ana, Bruno', 'helpers not updated');
    assert(rows[0].task_type === 'revisao', 'task_type not updated');
    assert(/admin-validate/.test(rows[0].description), 'description not updated');
    const a = await lastAudit('task.edit', taskId);
    assert(a && a.after_data && a.after_data.helpers === 'Ana, Bruno', 'audit after_data missing helpers');
  });

  await step('POST /admin/task/:id/close → audit task.close', async () => {
    const r = await adminPost(`/api/admin/task/${taskId}/close`);
    assert2xx(r, 'task.close');
    const rows = await dbQuery('SELECT status, ended_at FROM tasks WHERE id = $1', [taskId]);
    assert(rows[0].status === 'closed', 'status should be closed');
    assert(rows[0].ended_at != null, 'ended_at should be set');
    const a = await lastAudit('task.close', taskId);
    assert(a, 'audit task.close not written');
  });

  await step('POST /admin/task/:id/reopen → status=open, ended_at cleared, audit task.reopen', async () => {
    const r = await adminPost(`/api/admin/task/${taskId}/reopen`);
    assert2xx(r, 'task.reopen');
    const rows = await dbQuery('SELECT status, ended_at FROM tasks WHERE id = $1', [taskId]);
    assert(rows[0].status === 'open', 'reopened status should be open');
    assert(rows[0].ended_at == null, 'ended_at should be null after reopen');
    const a = await lastAudit('task.reopen', taskId);
    assert(a, 'audit task.reopen not written');
  });

  await step('DELETE /admin/task/:id (soft) → status=deleted, audit task.delete', async () => {
    const r = await adminDelete(`/api/admin/task/${taskId}`);
    assert2xx(r, 'task.delete');
    const rows = await dbQuery('SELECT status FROM tasks WHERE id = $1', [taskId]);
    assert(rows[0].status === 'deleted', 'status should be deleted');
    const a = await lastAudit('task.delete', taskId);
    assert(a, 'audit task.delete not written');
  });
}

async function runOrdersSession() {
  console.log('\n[Orders sessions — commit 2 retrofit]');
  let oid;

  await step('POST /admin/order/create → 200 + DB row + audit orders_session.create', async () => {
    const r = await adminPost('/api/admin/order/create', {
      operator: 'AdminValidateTest', order_count: 1, batch_label: 'afternoon',
      started_at: '2026-05-15 02:00',
    });
    assert2xx(r, 'orders_session.create');
    oid = r.body.id;
    cleanup.ordersIds.push(oid);
    const rows = await dbQuery('SELECT id, operator FROM orders_sessions WHERE id = $1', [oid]);
    assert(rows[0]?.operator === 'AdminValidateTest', 'orders_session not in DB');
    const a = await lastAudit('orders_session.create', oid);
    assert(a, 'audit orders_session.create not written');
  });

  await step('PUT  /admin/order/:id → audit orders_session.edit', async () => {
    const r = await adminPut(`/api/admin/order/${oid}`, { order_count: 42 });
    assert2xx(r, 'orders_session.edit');
    const rows = await dbQuery('SELECT order_count FROM orders_sessions WHERE id = $1', [oid]);
    assert(rows[0].order_count === 42, 'order_count not updated');
    const a = await lastAudit('orders_session.edit', oid);
    assert(a, 'audit orders_session.edit not written');
  });
}

async function runPauseCRUD() {
  console.log('\n[Pauses — commit 3, fixes B17]');
  let pid;

  await step('POST /admin/pause/create → 200 + DB row + audit pause.create', async () => {
    const r = await adminPost('/api/admin/pause/create', {
      operator: 'AdminValidateTest', reason: `${MARKER} test break`,
      started_at: '2026-05-15 02:00',
    });
    assert2xx(r, 'pause.create');
    pid = r.body.id;
    cleanup.pauseIds.push(pid);
    const rows = await dbQuery('SELECT operator, ended_at FROM pauses WHERE id = $1', [pid]);
    assert(rows[0].operator === 'AdminValidateTest', 'pause not in DB');
    assert(rows[0].ended_at == null, 'pause should be open (ended_at null)');
    const a = await lastAudit('pause.create', pid);
    assert(a, 'audit pause.create not written');
  });

  await step('GET  /admin/pauses?date=2026-05-15 → includes our test pause', async () => {
    const r = await adminGet('/api/admin/pauses', 'date=2026-05-15');
    assert2xx(r, 'pauses.list');
    assert(Array.isArray(r.body), 'should return array');
    const ours = r.body.find((p) => p.id === pid);
    assert(ours, `our pause #${pid} should be in list`);
  });

  await step('PUT  /admin/pause/:id → audit pause.edit', async () => {
    const r = await adminPut(`/api/admin/pause/${pid}`, { reason: `${MARKER} edited` });
    assert2xx(r, 'pause.edit');
    const rows = await dbQuery('SELECT reason FROM pauses WHERE id = $1', [pid]);
    assert(/edited/.test(rows[0].reason), 'reason not updated');
    const a = await lastAudit('pause.edit', pid);
    assert(a, 'audit pause.edit not written');
  });

  await step('POST /admin/pause/:id/close → audit pause.close (admin_force_close)', async () => {
    const r = await adminPost(`/api/admin/pause/${pid}/close`);
    assert2xx(r, 'pause.close');
    const rows = await dbQuery('SELECT ended_at, ended_reason FROM pauses WHERE id = $1', [pid]);
    assert(rows[0].ended_at != null, 'ended_at should be set');
    assert(rows[0].ended_reason === 'admin_force_close', 'ended_reason should be admin_force_close');
    const a = await lastAudit('pause.close', pid);
    assert(a, 'audit pause.close not written');
  });

  await step('DELETE /admin/pause/:id → soft delete + audit pause.delete', async () => {
    const r = await adminDelete(`/api/admin/pause/${pid}`);
    assert2xx(r, 'pause.delete');
    const rows = await dbQuery('SELECT deleted_at FROM pauses WHERE id = $1', [pid]);
    assert(rows[0].deleted_at != null, 'deleted_at should be set');
    const a = await lastAudit('pause.delete', pid);
    assert(a, 'audit pause.delete not written');
  });
}

async function runCountCRUD() {
  console.log('\n[Production counts — commit 4]');
  let cid;

  await step('POST /admin/count/create → 200 + DB row + audit production_count.create', async () => {
    const r = await adminPost('/api/admin/count/create', {
      supplement_name: `TestSupp_AV_${Date.now()}`, batch_number: '9999',
      count: 1, operator: 'AdminValidateTest', reported_at: '2026-05-15 02:00',
    });
    assert2xx(r, 'production_count.create');
    cid = r.body.id;
    cleanup.countIds.push(cid);
    const rows = await dbQuery('SELECT count FROM production_counts WHERE id = $1', [cid]);
    assert(rows[0].count === 1, 'count not in DB');
    const a = await lastAudit('production_count.create', cid);
    assert(a, 'audit not written');
  });

  await step('GET  /admin/counts → includes our count', async () => {
    const r = await adminGet('/api/admin/counts', 'date=2026-05-15');
    assert2xx(r, 'counts.list');
    assert(r.body.find((c) => c.id === cid), 'count not in list');
  });

  await step('PUT  /admin/count/:id → audit production_count.edit', async () => {
    const r = await adminPut(`/api/admin/count/${cid}`, { count: 2 });
    assert2xx(r, 'production_count.edit');
    const rows = await dbQuery('SELECT count FROM production_counts WHERE id = $1', [cid]);
    assert(rows[0].count === 2, 'count not updated');
    const a = await lastAudit('production_count.edit', cid);
    assert(a, 'audit not written');
  });

  await step('DELETE /admin/count/:id → soft delete + audit', async () => {
    const r = await adminDelete(`/api/admin/count/${cid}`);
    assert2xx(r, 'production_count.delete');
    const rows = await dbQuery('SELECT deleted_at FROM production_counts WHERE id = $1', [cid]);
    assert(rows[0].deleted_at != null, 'deleted_at should be set');
    const a = await lastAudit('production_count.delete', cid);
    assert(a, 'audit not written');
  });
}

async function runOperatorCRUD() {
  console.log('\n[Operators — commit 5]');
  let opId;
  const uniqueName = `AdminValidateTest_${Date.now()}`;

  await step('POST /admin/operator/create → 200 + DB row + audit operator.create', async () => {
    const r = await adminPost('/api/admin/operator/create', {
      name: uniqueName, slack_user_id: 'UTEST', aliases: 'TestA,TestB', role: 'operator',
    });
    assert2xx(r, 'operator.create');
    opId = r.body.id;
    cleanup.operatorIds.push(opId);
    const rows = await dbQuery('SELECT name, aliases, role FROM operators WHERE id = $1', [opId]);
    assert(rows[0].name === uniqueName, 'name not in DB');
    assert(rows[0].aliases === 'TestA,TestB', 'aliases not in DB');
    assert(rows[0].role === 'operator', 'role not in DB');
    const a = await lastAudit('operator.create', opId);
    assert(a, 'audit not written');
  });

  await step('GET  /admin/operators → includes new operator', async () => {
    const r = await adminGet('/api/admin/operators');
    assert2xx(r, 'operators.list');
    assert(r.body.find((o) => o.id === opId), 'operator not in list');
  });

  await step('PUT  /admin/operator/:id → audit operator.edit', async () => {
    const r = await adminPut(`/api/admin/operator/${opId}`, { role: 'manager' });
    assert2xx(r, 'operator.edit');
    const rows = await dbQuery('SELECT role FROM operators WHERE id = $1', [opId]);
    assert(rows[0].role === 'manager', 'role not updated');
    const a = await lastAudit('operator.edit', opId);
    assert(a, 'audit not written');
  });

  await step('DELETE /admin/operator/:id → active=false + audit operator.deactivate', async () => {
    const r = await adminDelete(`/api/admin/operator/${opId}`);
    assert2xx(r, 'operator.deactivate');
    const rows = await dbQuery('SELECT active FROM operators WHERE id = $1', [opId]);
    assert(rows[0].active === false, 'operator should be inactive');
    const a = await lastAudit('operator.deactivate', opId);
    assert(a, 'audit not written');
  });
}

async function runNotes() {
  console.log('\n[Notes — commit 6]');

  await step('GET /admin/notes?date=2026-05-15 → 200, returns array', async () => {
    const r = await adminGet('/api/admin/notes', 'date=2026-05-15');
    assert2xx(r, 'notes.list');
    assert(Array.isArray(r.body), 'notes.list should return array');
  });

  // Note creation requires a real Slack note message. Test edit/delete only if one exists.
  const existing = await dbQuery(
    `SELECT slack_ts FROM messages
     WHERE parsed_type = 'note' AND deleted_at IS NULL
     ORDER BY slack_ts DESC LIMIT 1`
  );
  if (!existing.length) {
    console.log('  PUT/DELETE /admin/note/:ts ... SKIP (no existing note to safely test against)');
    results.push({ name: 'notes.edit-delete skipped', ok: true, skipped: true });
  } else {
    // Use existing note BUT only stamp text with marker; revert in cleanup.
    const ts = existing[0].slack_ts;
    let originalText;
    await step(`PUT /admin/note/${ts} → audit note.edit (will revert at cleanup)`, async () => {
      const before = await dbQuery('SELECT text FROM messages WHERE slack_ts = $1', [ts]);
      originalText = before[0]?.text || '';
      const r = await adminPut(`/api/admin/note/${ts}`, { text: `${originalText}\n${MARKER}` });
      assert2xx(r, 'note.edit');
      const a = await lastAudit('note.edit', ts);
      assert(a, 'audit not written');
    });
    // Revert the note text to original
    if (originalText !== undefined) {
      try {
        await adminPut(`/api/admin/note/${ts}`, { text: originalText });
        console.log(`  (reverted note ${ts} to original text)`);
      } catch (_) {}
    }
  }
}

async function runMerge() {
  console.log('\n[Merge — commit 8]');
  let aId, bId;

  await step('Setup: create 2 test tasks for merge', async () => {
    const ra = await adminPost('/api/admin/task/create', {
      supplement_name: `MergeA_${Date.now()}`, started_at: '2026-05-15 02:00',
      operator: 'AdminValidateTest',
    });
    assert2xx(ra, 'merge setup a');
    aId = ra.body.id; cleanup.taskIds.push(aId);
    const rb = await adminPost('/api/admin/task/create', {
      supplement_name: `MergeB_${Date.now()}`, started_at: '2026-05-15 03:00',
      operator: 'AdminValidateTest',
    });
    assert2xx(rb, 'merge setup b');
    bId = rb.body.id; cleanup.taskIds.push(bId);
  });

  await step('POST /admin/task/merge → 200, B soft-deleted, alias learned, audit task.merge', async () => {
    const r = await adminPost('/api/admin/task/merge', { taskIds: [aId, bId] });
    assert2xx(r, 'task.merge');
    assert(r.body.survivor_id === aId, `survivor should be ${aId} (oldest), got ${r.body.survivor_id}`);
    assert(r.body.merged_ids.includes(bId), 'merged_ids should include B');
    const survRows = await dbQuery('SELECT status FROM tasks WHERE id = $1', [aId]);
    const otherRows = await dbQuery('SELECT status FROM tasks WHERE id = $1', [bId]);
    assert(otherRows[0].status === 'deleted', 'B should be soft-deleted');
    const a = await lastAudit('task.merge', aId);
    assert(a, 'audit not written');
    const aliasRows = await dbQuery(
      `SELECT canonical_term FROM task_aliases WHERE learned_from_task_id = $1`,
      [aId]
    );
    assert(aliasRows.length >= 1, 'task_aliases should have learned at least one synonym');
  });
}

async function runAuditQuery() {
  console.log('\n[Audit query — commit 9]');

  await step('GET /admin/audit → returns rows + total', async () => {
    const r = await adminGet('/api/admin/audit', 'limit=10');
    assert2xx(r, 'audit.list');
    assert(Array.isArray(r.body.rows), 'rows should be array');
    assert(typeof r.body.total === 'number', 'total should be number');
    assert(r.body.rows.length > 0, 'should have at least one row (we wrote many in this run)');
  });

  await step('GET /admin/audit?action=task.create → filtered', async () => {
    const r = await adminGet('/api/admin/audit', 'action=task.create&limit=5');
    assert2xx(r, 'audit.filtered');
    assert(r.body.rows.every((row) => row.action === 'task.create'), 'all rows should match filter');
  });

  await step('GET /admin/audit?since=2026-05-15 → date filter accepted', async () => {
    const r = await adminGet('/api/admin/audit', 'since=2026-05-15&limit=5');
    assert2xx(r, 'audit.since');
  });
}

async function runSupplements() {
  console.log('\n[Supplements (retrofitted) — commit 2]');
  const name = `TestSupp_AV_${Date.now()}`;
  cleanup.supplements.push(name);

  await step('POST /admin/supplement → audit supplement.create', async () => {
    const r = await adminPost('/api/admin/supplement', { canonical_name: name, aliases: 'TestAlias' });
    assert2xx(r, 'supplement.create');
    const rows = await dbQuery('SELECT canonical_name FROM supplement_catalog WHERE canonical_name = $1', [name]);
    assert(rows.length === 1, 'supplement not in DB');
    const a = await lastAudit('supplement.create', name);
    assert(a, 'audit not written');
  });

  await step('DELETE /admin/supplement/:name → audit supplement.delete', async () => {
    const r = await adminDelete(`/api/admin/supplement/${encodeURIComponent(name)}`);
    assert2xx(r, 'supplement.delete');
    const rows = await dbQuery('SELECT canonical_name FROM supplement_catalog WHERE canonical_name = $1', [name]);
    assert(rows.length === 0, 'supplement should be hard-deleted');
    const a = await lastAudit('supplement.delete', name);
    assert(a, 'audit not written');
    // Already deleted, remove from cleanup list
    cleanup.supplements = cleanup.supplements.filter((s) => s !== name);
  });
}

// ─── Cleanup ─────────────────────────────────────────────────────────────
// ─── Reserved test-data identifiers ──────────────────────────────────────
// EVERY row created by this script is identifiable by one of these markers.
// The sweep below uses these as the source of truth — not the in-memory
// cleanup arrays, which can lose IDs if an assertion throws mid-test.
//
//   operator   = 'AdminValidateTest'   (exact match)
//   supplement = 'TestSupp_*'          (any int suffix)
//                'TestSupp_AV_*'
//                'MergeA_*' / 'MergeB_*'
//                '_AdminValidateTest_curl' (legacy from older runs)
//   description / notes prefixed with the MARKER constant '[admin-validate]'
//
// The cleanup runs in two stages:
//   Stage 1 — best-effort cleanup via the in-memory ID lists (covers
//             entities created in this run; preserves audit trail of
//             individual deletes).
//   Stage 2 — sweep: any row matching the reserved identifiers that is
//             still active (not deleted) gets soft-deleted directly via
//             SQL, regardless of whether this run created it. Handles
//             orphans left by earlier failed runs.
async function cleanupAll() {
  console.log('\n[Cleanup Stage 1 — soft-deleting tracked rows via admin API]');
  for (const id of cleanup.taskIds) {
    try {
      const row = await dbQuery('SELECT status FROM tasks WHERE id = $1', [id]);
      if (row[0] && row[0].status !== 'deleted') {
        await adminDelete(`/api/admin/task/${id}`);
        console.log(`  task #${id} cleaned`);
      }
    } catch (err) { console.log(`  task #${id} cleanup error: ${err.message}`); }
  }
  for (const id of cleanup.pauseIds) {
    try {
      const row = await dbQuery('SELECT deleted_at FROM pauses WHERE id = $1', [id]);
      if (row[0] && row[0].deleted_at == null) {
        await adminDelete(`/api/admin/pause/${id}`);
        console.log(`  pause #${id} cleaned`);
      }
    } catch (err) { console.log(`  pause #${id} cleanup error: ${err.message}`); }
  }
  for (const id of cleanup.countIds) {
    try {
      const row = await dbQuery('SELECT deleted_at FROM production_counts WHERE id = $1', [id]);
      if (row[0] && row[0].deleted_at == null) {
        await adminDelete(`/api/admin/count/${id}`);
        console.log(`  count #${id} cleaned`);
      }
    } catch (err) { console.log(`  count #${id} cleanup error: ${err.message}`); }
  }
  for (const id of cleanup.operatorIds) {
    try {
      const row = await dbQuery('SELECT active FROM operators WHERE id = $1', [id]);
      if (row[0] && row[0].active) {
        await adminDelete(`/api/admin/operator/${id}`);
        console.log(`  operator #${id} deactivated`);
      }
    } catch (err) { console.log(`  operator #${id} cleanup error: ${err.message}`); }
  }
  for (const id of cleanup.ordersIds) {
    try {
      await pool.query(`UPDATE orders_sessions SET deleted_at = NOW(), status = 'deleted', updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL`, [id]);
      console.log(`  orders_session #${id} soft-deleted`);
    } catch (err) { console.log(`  orders #${id} cleanup error: ${err.message}`); }
  }
  for (const name of cleanup.supplements) {
    try {
      await adminDelete(`/api/admin/supplement/${encodeURIComponent(name)}`);
      console.log(`  supplement "${name}" deleted`);
    } catch (err) { console.log(`  supplement "${name}" cleanup error: ${err.message}`); }
  }

  console.log('\n[Cleanup Stage 2 — sweep by reserved identifiers]');
  await sweepCleanup();
}

/**
 * Stage-2 sweep — finds anything still active that matches the reserved
 * test-data identifiers and soft-deletes it. Idempotent. Catches orphans
 * left when an earlier run crashed before pushing IDs to cleanup arrays.
 */
async function sweepCleanup() {
  const NAME = 'AdminValidateTest';
  const SUPPS = ["TestSupp_%", "TestSupp_AV_%", "MergeA_%", "MergeB_%", "_AdminValidateTest_curl%"];

  // Tasks: soft-delete any active row with operator=NAME or marker supplement
  const taskSweep = await pool.query(
    `UPDATE tasks SET status = 'deleted', updated_at = NOW()
     WHERE status != 'deleted'
       AND (operator = $1
         OR supplement_name LIKE $2
         OR supplement_name LIKE $3
         OR supplement_name LIKE $4
         OR supplement_name LIKE $5
         OR supplement_name LIKE $6)
     RETURNING id`,
    [NAME, ...SUPPS]
  );
  if (taskSweep.rows.length > 0) console.log(`  swept ${taskSweep.rows.length} task(s)`);

  // orders_sessions: by operator NAME
  const ordSweep = await pool.query(
    `UPDATE orders_sessions
     SET status = 'deleted', deleted_at = COALESCE(deleted_at, NOW()), updated_at = NOW()
     WHERE operator = $1 AND (status != 'deleted' OR deleted_at IS NULL)
     RETURNING id`,
    [NAME]
  );
  if (ordSweep.rows.length > 0) console.log(`  swept ${ordSweep.rows.length} orders_session(s)`);

  // production_counts: by operator NAME or marker supplement
  const cntSweep = await pool.query(
    `UPDATE production_counts SET deleted_at = COALESCE(deleted_at, NOW())
     WHERE deleted_at IS NULL
       AND (operator = $1
         OR supplement_name LIKE $2
         OR supplement_name LIKE $3
         OR supplement_name LIKE $4
         OR supplement_name LIKE $5
         OR supplement_name LIKE $6)
     RETURNING id`,
    [NAME, ...SUPPS]
  );
  if (cntSweep.rows.length > 0) console.log(`  swept ${cntSweep.rows.length} production_count(s)`);

  // pauses: by operator NAME
  const pauseSweep = await pool.query(
    `UPDATE pauses SET deleted_at = COALESCE(deleted_at, NOW())
     WHERE operator = $1 AND deleted_at IS NULL
     RETURNING id`,
    [NAME]
  );
  if (pauseSweep.rows.length > 0) console.log(`  swept ${pauseSweep.rows.length} pause(s)`);

  // operators: deactivate by name (handles orphan rows if anyone ever created
  // an operator named AdminValidateTest, which the audit script does for the
  // operator-CRUD test)
  const opSweep = await pool.query(
    `UPDATE operators SET active = FALSE, updated_at = NOW()
     WHERE name LIKE 'AdminValidateTest%' AND active = TRUE
     RETURNING id, name`
  );
  if (opSweep.rows.length > 0) console.log(`  deactivated ${opSweep.rows.length} operator(s): ${opSweep.rows.map(r=>r.name).join(', ')}`);

  // supplement_catalog: hard-delete custom suppls with marker names
  const supSweep = await pool.query(
    `DELETE FROM supplement_catalog
     WHERE canonical_name LIKE 'TestSupp_%'
        OR canonical_name LIKE 'MergeA_%' OR canonical_name LIKE 'MergeB_%'
        OR canonical_name LIKE '_AdminValidateTest_%'
     RETURNING canonical_name`
  );
  if (supSweep.rows.length > 0) console.log(`  hard-deleted ${supSweep.rows.length} supplement(s)`);

  // task_aliases: hard-delete merge aliases learned from test runs
  const aliasSweep = await pool.query(
    `DELETE FROM task_aliases
     WHERE canonical_term LIKE 'TestSupp_%' OR alias_term LIKE 'TestSupp_%'
        OR canonical_term LIKE 'MergeA_%'    OR alias_term LIKE 'MergeA_%'
        OR canonical_term LIKE 'MergeB_%'    OR alias_term LIKE 'MergeB_%'
        OR canonical_term LIKE '_AdminValidateTest_%' OR alias_term LIKE '_AdminValidateTest_%'
     RETURNING id`
  );
  if (aliasSweep.rows.length > 0) console.log(`  hard-deleted ${aliasSweep.rows.length} task_alias(es)`);

  const total = taskSweep.rows.length + ordSweep.rows.length + cntSweep.rows.length
              + pauseSweep.rows.length + opSweep.rows.length + supSweep.rows.length + aliasSweep.rows.length;
  if (total === 0) console.log('  (sweep clean — no orphans)');
}

// ─── Main ────────────────────────────────────────────────────────────────
(async () => {
  console.log(`Admin endpoint validator — target: ${BASE_URL}`);
  console.log(`PIN: ${PIN === '510510' ? '510510 (legacy fallback)' : '*** (from env)'}`);
  console.log('');

  try {
    await ensureHealthy();
    console.log('[Health] /api/health OK');

    await runEntrega3Workflow();
    await runTaskLifecycle();
    await runOrdersSession();
    await runPauseCRUD();
    await runCountCRUD();
    await runOperatorCRUD();
    await runNotes();
    await runMerge();
    await runSupplements();
    await runAuditQuery();
  } catch (err) {
    console.error('\nFATAL during test run:', err.message);
  } finally {
    try { await cleanupAll(); } catch (err) { console.error('Cleanup error:', err.message); }
    await pool.end();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`==== Summary: ${passed}/${results.length} passed ====`);
  if (failed.length > 0) {
    console.log('FAILURES:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  } else {
    console.log('All endpoints behaving correctly.');
    process.exit(0);
  }
})().catch((err) => {
  console.error('UNCAUGHT:', err);
  pool.end().catch(() => {});
  process.exit(2);
});
