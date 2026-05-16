'use strict';
// OPERATOR-CRUD — Carolina manages employees from the admin chat:
// create_operator / deactivate_operator / reactivate_operator /
// promote_helper. Never hard-deletes; admin order = confirmation.
jest.mock('../db');
const db = require('../db');
const at = require('../ai/admin-tools');
const fs = require('fs');
const path = require('path');

beforeEach(() => { jest.clearAllMocks(); });

function wireResolve(roleRow) {
  db.query = jest.fn((sql, p) => {
    if (/INSERT INTO operators/.test(sql)) return Promise.resolve({ rows: [{ id: 77 }] });
    if (/FROM operators/.test(sql)) return Promise.resolve({ rows: roleRow ? [roleRow] : [] });
    return Promise.resolve({ rows: [] });
  });
}

describe('OPERATOR-CRUD — Carolina create_operator', () => {
  test('permanent → INSERT + audit operator.create', async () => {
    wireResolve();
    const audit = jest.fn().mockResolvedValue();
    const r = await at.runTool('create_operator', { name: 'João', role: 'operator' }, { auditAction: audit });
    expect(r).toMatchObject({ created: true, id: 77, name: 'João', is_temporary: false });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'operator.create' }));
  });

  test('helper by N days → expires_at ~N days out, audit operator.create_helper', async () => {
    wireResolve();
    const audit = jest.fn().mockResolvedValue();
    const r = await at.runTool('create_operator',
      { name: 'Maria', is_temporary: true, days: 15 }, { auditAction: audit });
    expect(r.is_temporary).toBe(true);
    const d = (new Date(r.expires_at) - Date.now()) / 86400000;
    expect(d).toBeGreaterThan(14);
    expect(d).toBeLessThan(16);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'operator.create_helper' }));
  });

  test('no name → not created', async () => {
    wireResolve();
    const r = await at.runTool('create_operator', {}, { auditAction: jest.fn() });
    expect(r.created).toBe(false);
  });
});

describe('OPERATOR-CRUD — Carolina deactivate/reactivate/promote', () => {
  test('deactivate by name → soft delete (active+is_active FALSE), audited', async () => {
    const sqls = [];
    db.query = jest.fn((sql) => {
      sqls.push(String(sql));
      if (/FROM operators/.test(sql)) return Promise.resolve({ rows: [{ id: 3, name: 'Pedro', role: 'operator' }] });
      return Promise.resolve({ rows: [] });
    });
    const audit = jest.fn().mockResolvedValue();
    const r = await at.runTool('deactivate_operator', { operator: 'Pedro' }, { auditAction: audit });
    expect(r).toMatchObject({ ok: true, operator: 'Pedro', action: 'deactivate' });
    expect(sqls.some(s => /UPDATE operators SET active = FALSE, is_active = FALSE/.test(s))).toBe(true);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'operator.deactivate' }));
  });

  test('reactivate sets both TRUE; promote clears temp+expiry', async () => {
    const sqls = [];
    db.query = jest.fn((sql) => {
      sqls.push(String(sql));
      if (/FROM operators/.test(sql)) return Promise.resolve({ rows: [{ id: 4, name: 'Ana', role: 'operator' }] });
      return Promise.resolve({ rows: [] });
    });
    const audit = jest.fn().mockResolvedValue();
    await at.runTool('reactivate_operator', { operator: 'Ana' }, { auditAction: audit });
    await at.runTool('promote_helper', { operator: 'Ana' }, { auditAction: audit });
    expect(sqls.some(s => /UPDATE operators SET active = TRUE, is_active = TRUE/.test(s))).toBe(true);
    expect(sqls.some(s => /SET is_temporary = FALSE, expires_at = NULL/.test(s))).toBe(true);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'operator.reactivate' }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'operator.promote' }));
  });

  test('unknown operator → ok:false', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await at.runTool('deactivate_operator', { operator: 'Fulano' }, { auditAction: jest.fn() });
    expect(r).toMatchObject({ ok: false });
  });
});

describe('OPERATOR-CRUD — registration + gating + prompt', () => {
  test('the four tools are registered + gated', () => {
    for (const t of ['create_operator', 'deactivate_operator', 'reactivate_operator', 'promote_helper']) {
      expect(at.CHANNEL_TOOLS.has(t)).toBe(true);
      expect(at.TOOL_DEFS.find(d => d.name === t)).toBeTruthy();
    }
  });
  test('cron/autonomous cannot manage operators (allowMutations:false)', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await expect(at.runTool('create_operator', { name: 'X' }, { allowMutations: false }))
      .rejects.toThrow(/ordem explícita/);
  });
  test('prompt: ask permanent/helper, never physical delete', () => {
    const dm = fs.readFileSync(path.join(__dirname, '..', 'slack', 'dm-handler.js'), 'utf8');
    expect(dm).toMatch(/GESTÃO DE FUNCIONÁRIOS/);
    expect(dm).toMatch(/create_operator/);
    expect(dm).toMatch(/permanente ou helper\s+temporário\?/);
    expect(dm).toMatch(/NUNCA delete físico/);
    expect(dm).toMatch(/deactivate_operator/);
  });
});
