'use strict';
// EMERGÊNCIA — gated cleanup of today's phantom "Linha de Produção".
jest.mock('../db');
jest.mock('../admin/audit', () => ({ auditAction: jest.fn().mockResolvedValue() }));
const { auditAction } = require('../admin/audit');
const cl = require('../../scripts/cleanup-fantasma-hoje');
const fs = require('fs');
const path = require('path');

beforeEach(() => { jest.clearAllMocks(); });
function db(rows) {
  const calls = [];
  return { calls, query: jest.fn((sql, p) => {
    calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), p });
    if (/FROM phase_instances pi/.test(String(sql)) && /phase_name = 'Linha de Produção'/.test(String(sql))) {
      return Promise.resolve({ rows });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }) };
}

describe('cleanup-fantasma — só pega a assinatura exata', () => {
  test('SQL exige Linha de Produção + product NULL + batch NULL + hoje ET + não deleted', () => {
    expect(cl.FANTASMA_SQL).toMatch(/phase_name = 'Linha de Produção'/);
    expect(cl.FANTASMA_SQL).toMatch(/wi\.product_name IS NULL/);
    expect(cl.FANTASMA_SQL).toMatch(/pi\.batch_number IS NULL AND wi\.batch_number IS NULL/);
    expect(cl.FANTASMA_SQL).toMatch(/AT TIME ZONE 'America\/New_York'\)::date\s*=\s*\(NOW\(\) AT TIME ZONE 'America\/New_York'\)::date/);
    expect(cl.FANTASMA_SQL).toMatch(/pi\.status <> 'deleted'/);
  });
  test('dry-run não escreve', async () => {
    const d = db([{ id: 537, starter: 'Simone', st: '10:14' }]);
    const r = await cl.cleanupFantasmas({ apply: false, db: d });
    expect(r).toMatchObject({ count: 1, applied: false });
    expect(d.calls.some((c) => /UPDATE phase_instances/.test(c.sql))).toBe(false);
    expect(auditAction).not.toHaveBeenCalled();
  });
  test('apply: status=deleted (NÃO hard-delete) + fecha oal + audita, em transação', async () => {
    const d = db([{ id: 537, starter: 'Simone', st: '10:14' }, { id: 536, starter: 'Vitor', st: '10:01' }]);
    const r = await cl.cleanupFantasmas({ apply: true, db: d, source: 'script' });
    expect(r).toMatchObject({ count: 2, applied: true });
    expect(d.calls.some((c) => c.sql === 'BEGIN')).toBe(true);
    expect(d.calls.some((c) => c.sql === 'COMMIT')).toBe(true);
    expect(d.calls.some((c) => /UPDATE phase_instances SET status = 'deleted'/.test(c.sql))).toBe(true);
    expect(d.calls.some((c) => /UPDATE operator_activity_log[\s\S]*ended_at IS NULL/.test(c.sql))).toBe(true);
    expect(d.calls.every((c) => !/DELETE FROM/.test(c.sql))).toBe(true); // soft, nunca hard-delete
    expect(auditAction).toHaveBeenCalledTimes(2);
    expect(auditAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'operator.cleanup_fantasma_atividade', entityType: 'phase_instance',
    }));
  });
  test('zero fantasmas → no-op', async () => {
    const d = db([]);
    const r = await cl.cleanupFantasmas({ apply: true, db: d });
    expect(r).toMatchObject({ count: 0, applied: false });
  });
  test('interlock ADMIN_CONFIRMED documentado', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'cleanup-fantasma-hoje.js'), 'utf8');
    expect(src).toMatch(/process\.env\.ADMIN_CONFIRMED !== 'TRUE'/);
    expect(src).toMatch(/RECUSADO: --apply exige ADMIN_CONFIRMED=TRUE/);
  });
});
