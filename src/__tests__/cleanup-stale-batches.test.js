'use strict';
// TAREFA 2 — cleanup batches/fases/ad-hoc abertos >8h. Soft-close,
// fecha filhos, idempotente, auditado, tx-wrapped, gated.
jest.mock('../db');
jest.mock('../admin/audit', () => ({ auditAction: jest.fn().mockResolvedValue() }));
const { auditAction } = require('../admin/audit');
const cl = require('../../scripts/cleanup-stale-batches');
const fs = require('fs');
const path = require('path');

beforeEach(() => { jest.clearAllMocks(); });

function db({ wf = [], phS = [], ah = [], kids = [] }) {
  const calls = [];
  return { calls, query: jest.fn((sql) => {
    calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim() });
    const s = String(sql);
    // order matters: phStandalone's subquery also contains
    // "FROM workflow_instances WHERE status IN" — match the specific
    // shapes first.
    if (/SELECT id FROM phase_instances WHERE workflow_instance_id/.test(s)) return Promise.resolve({ rows: kids });
    if (/FROM phase_instances pi[\s\S]*NOT IN/.test(s)) return Promise.resolve({ rows: phS });
    if (/FROM ad_hoc_task_instances\s+WHERE status='open'/.test(s)) return Promise.resolve({ rows: ah });
    if (/SELECT id, product_name, batch_number, status[\s\S]*FROM workflow_instances/.test(s)) return Promise.resolve({ rows: wf });
    return Promise.resolve({ rows: [], rowCount: 0 });
  }) };
}

describe('cleanup-stale-batches — alvo >8h', () => {
  test('SQL exige >8h, aberto, ended_at NULL; wf cobre open+active', () => {
    expect(cl.SQL.wf).toMatch(/status IN \('open','active'\)/);
    expect(cl.SQL.wf).toMatch(/ended_at IS NULL/);
    expect(cl.SQL.wf).toMatch(/INTERVAL '8 hours'/);
    expect(cl.SQL.phStandalone).toMatch(/NOT IN \(\s*SELECT id FROM workflow_instances/);
  });

  test('dry-run não escreve', async () => {
    const d = db({ wf: [{ id: 454, product_name: 'Plant Sterols', batch_number: '0134', age_h: 29 }] });
    const r = await cl.cleanup({ apply: false, db: d });
    expect(r).toMatchObject({ total: 1, applied: false });
    expect(d.calls.some((c) => /UPDATE /.test(c.sql))).toBe(false);
    expect(auditAction).not.toHaveBeenCalled();
  });

  test('apply: soft-close wf + filhos + oal, standalone, adhoc; tx; audita; nunca DELETE', async () => {
    const d = db({
      wf: [{ id: 454, age_h: 29 }],
      phS: [{ id: 600, phase_name: 'X', age_h: 12 }],
      ah: [{ id: 42, task_name: 'Outro', age_h: 20 }],
      kids: [{ id: 567 }],
    });
    const r = await cl.cleanup({ apply: true, db: d, source: 'script' });
    expect(r.applied).toBe(true);
    expect(r.done).toMatchObject({ workflows: [454], child_phases: [567], phasesStandalone: [600], adhoc: [42] });
    expect(d.calls.some((c) => c.sql === 'BEGIN')).toBe(true);
    expect(d.calls.some((c) => c.sql === 'COMMIT')).toBe(true);
    expect(d.calls.some((c) => /UPDATE workflow_instances SET status='closed'/.test(c.sql))).toBe(true);
    expect(d.calls.some((c) => /UPDATE phase_instances SET status='closed'/.test(c.sql))).toBe(true);
    expect(d.calls.some((c) => /UPDATE operator_activity_log SET ended_at=COALESCE/.test(c.sql) || /UPDATE\s+operator_activity_log\s+SET ended_at = COALESCE/.test(c.sql))).toBe(true);
    expect(d.calls.every((c) => !/DELETE FROM/.test(c.sql))).toBe(true);
    expect(auditAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'operator.cleanup_stale_>8h_apply', entityType: 'database',
    }));
  });

  test('nada >8h → applied:false, sem writes', async () => {
    const d = db({});
    const r = await cl.cleanup({ apply: true, db: d });
    expect(r).toMatchObject({ total: 0, applied: false });
    expect(d.calls.some((c) => /UPDATE/.test(c.sql))).toBe(false);
  });

  test('rollback em erro (sem cleanup parcial)', async () => {
    const d = db({ wf: [{ id: 1 }] });
    let n = 0;
    d.query = jest.fn((sql) => {
      const s = String(sql);
      if (s === 'BEGIN') return Promise.resolve({});
      if (/FROM workflow_instances\s+WHERE status IN/.test(s)) return Promise.resolve({ rows: [{ id: 1 }] });
      if (/SELECT id FROM phase_instances WHERE workflow_instance_id/.test(s)) return Promise.resolve({ rows: [] });
      if (/UPDATE workflow_instances/.test(s)) { if (++n === 1) return Promise.reject(new Error('boom')); }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    await expect(cl.cleanup({ apply: true, db: d })).rejects.toThrow('boom');
    expect(d.query).toHaveBeenCalledWith('ROLLBACK');
  });

  test('interlock ADMIN_CONFIRMED documentado', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'cleanup-stale-batches.js'), 'utf8');
    expect(src).toMatch(/process\.env\.ADMIN_CONFIRMED !== 'TRUE'/);
    expect(src).toMatch(/RECUSADO: --apply exige ADMIN_CONFIRMED=TRUE/);
  });
});
