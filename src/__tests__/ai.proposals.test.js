'use strict';
// BLOCO C / P4 — carolina_proposals store.
jest.mock('../db');
const db = require('../db');

// In-memory model of carolina_proposals + app_state.
function wire(store) {
  store.rows = store.rows || [];
  store.kv = store.kv || {};
  let seq = store.rows.reduce((m, r) => Math.max(m, r.id), 0);
  db.query = jest.fn().mockImplementation((sql, p = []) => {
    if (/SELECT value FROM app_state WHERE key = \$1/.test(sql)) {
      const v = store.kv[p[0]];
      return Promise.resolve({ rows: v == null ? [] : [{ value: v }] });
    }
    if (/UPDATE carolina_proposals\s+SET status = 'expired'/.test(sql)) {
      const win = parseInt(p[0], 10);
      const cutoff = Date.now() - win * 60000;
      const hit = store.rows.filter((r) => r.status === 'pending' && r._createdMs < cutoff);
      hit.forEach((r) => { r.status = 'expired'; r.resolved_by = 'system'; });
      return Promise.resolve({ rows: hit.map((r) => ({ id: r.id })) });
    }
    if (/SELECT \* FROM carolina_proposals\s+WHERE status = 'pending' AND proposal_type/.test(sql)) {
      const dup = store.rows.filter((r) => r.status === 'pending'
        && r.proposal_type === p[0]
        && (r.target_entity_type || '') === (p[1] || '')
        && (r.target_entity_id || '') === (p[2] == null ? '' : String(p[2])))
        .sort((a, b) => b.id - a.id);
      return Promise.resolve({ rows: dup.slice(0, 1) });
    }
    if (/INSERT INTO carolina_proposals/.test(sql)) {
      const row = {
        id: ++seq, proposal_type: p[0], target_entity_type: p[1],
        target_entity_id: p[2], proposed_action: p[3], status: 'pending',
        source: p[4], _createdMs: store._now || Date.now(),
        created_at: new Date(store._now || Date.now()).toISOString(),
        resolved_at: null, resolved_by: null,
      };
      store.rows.push(row);
      return Promise.resolve({ rows: [row] });
    }
    if (/SELECT \* FROM carolina_proposals WHERE status = 'pending'\s+ORDER BY/.test(sql)) {
      return Promise.resolve({ rows: store.rows.filter((r) => r.status === 'pending') });
    }
    if (/SELECT \* FROM carolina_proposals WHERE id = \$1/.test(sql)) {
      return Promise.resolve({ rows: store.rows.filter((r) => r.id === p[0]) });
    }
    if (/UPDATE carolina_proposals\s+SET status = \$2/.test(sql)) {
      const row = store.rows.find((r) => r.id === p[0] && r.status === 'pending');
      if (row) { row.status = p[1]; row.resolved_by = p[2]; row.resolved_at = 'now'; }
      return Promise.resolve({ rows: row ? [row] : [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

const proposals = require('../ai/proposals');
beforeEach(() => { jest.clearAllMocks(); });

describe('P4 — getWindowMinutes', () => {
  test('defaults to 24h, clamps out-of-range', async () => {
    const s = {}; wire(s);
    expect(await proposals.getWindowMinutes()).toBe(1440);
    s.kv[proposals.WINDOW_KEY] = '120';
    expect(await proposals.getWindowMinutes()).toBe(120);
    s.kv[proposals.WINDOW_KEY] = '999999';
    expect(await proposals.getWindowMinutes()).toBe(7 * 24 * 60);
    s.kv[proposals.WINDOW_KEY] = '1';
    expect(await proposals.getWindowMinutes()).toBe(5);
  });
});

describe('P4 — create / dedupe / list', () => {
  test('create inserts a pending row', async () => {
    const s = {}; wire(s);
    const p = await proposals.create({
      proposalType: 'close_phase', targetEntityType: 'phase', targetEntityId: 5,
      proposedAction: { phase_instance_id: 5 }, source: 'cron',
    });
    expect(p.status).toBe('pending');
    expect(p.proposal_type).toBe('close_phase');
    expect(s.rows).toHaveLength(1);
  });

  test('create de-dupes an identical pending proposal', async () => {
    const s = {}; wire(s);
    await proposals.create({ proposalType: 'close_phase', targetEntityType: 'phase', targetEntityId: 5, proposedAction: {} });
    const dup = await proposals.create({ proposalType: 'close_phase', targetEntityType: 'phase', targetEntityId: 5, proposedAction: {} });
    expect(dup._deduped).toBe(true);
    expect(s.rows).toHaveLength(1);
  });

  test('listPending returns only pending, ordered', async () => {
    const s = {}; wire(s);
    await proposals.create({ proposalType: 'a', proposedAction: {} });
    await proposals.create({ proposalType: 'b', proposedAction: {} });
    const list = await proposals.listPending();
    expect(list.map((r) => r.proposal_type)).toEqual(['a', 'b']);
  });
});

describe('P4 — expiry', () => {
  test('expireOld flips stale pending → expired', async () => {
    const s = { _now: Date.now() - 49 * 60 * 60 * 1000 }; wire(s); // 49h ago
    await proposals.create({ proposalType: 'old', proposedAction: {} });
    s._now = Date.now();
    const n = await proposals.expireOld();
    expect(n).toBe(1);
    expect(s.rows[0].status).toBe('expired');
    expect(await proposals.getLatestPending()).toBeNull();
  });

  test('fresh proposals survive expiry', async () => {
    const s = {}; wire(s);
    await proposals.create({ proposalType: 'fresh', proposedAction: {} });
    expect(await proposals.expireOld()).toBe(0);
    expect((await proposals.getLatestPending()).proposal_type).toBe('fresh');
  });
});

describe('P4 — resolve', () => {
  test('resolve marks accepted/rejected only when pending', async () => {
    const s = {}; wire(s);
    const p = await proposals.create({ proposalType: 'x', proposedAction: {} });
    const ok = await proposals.resolve(p.id, 'accepted', 'slack_admin');
    expect(ok.status).toBe('accepted');
    // already resolved → null
    expect(await proposals.resolve(p.id, 'rejected')).toBeNull();
  });

  test('resolveLatest resolves the newest pending', async () => {
    const s = {}; wire(s);
    await proposals.create({ proposalType: 'first', proposedAction: {} });
    await proposals.create({ proposalType: 'second', proposedAction: {} });
    const r = await proposals.resolveLatest('rejected');
    expect(r.proposal_type).toBe('second');
    expect(r.status).toBe('rejected');
    expect((await proposals.getLatestPending()).proposal_type).toBe('first');
  });

  test('resolveLatest with nothing pending → null', async () => {
    const s = {}; wire(s);
    expect(await proposals.resolveLatest('accepted')).toBeNull();
  });
});
