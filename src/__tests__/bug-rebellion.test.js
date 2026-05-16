'use strict';
// BUG REBELLION — Carolina lied: "não tenho ferramenta pra fechar break
// direto" and "anunciar no chat eu não consigo". She has both. Pins:
// close_active_break / close_all_active_breaks, tool composition, and
// the anti-lie + capabilities prompt.
jest.mock('../db');
const db = require('../db');
const at = require('../ai/admin-tools');
const fs = require('fs');
const path = require('path');

beforeEach(() => { jest.clearAllMocks(); });

function engineMock() { return { endBreak: jest.fn().mockResolvedValue({ wasOnBreak: true }) }; }

describe('BUG REBELLION — close_active_break', () => {
  test('closes the operator open break via engine.endBreak + audits', async () => {
    let openChecks = 0;
    db.query = jest.fn((sql, p) => {
      if (/FROM operators/.test(sql)) return Promise.resolve({ rows: [{ id: 3, name: 'Simone', role: 'operator' }] });
      if (/ended_at IS NULL AND activity_type = 'break' LIMIT 1/.test(sql)) {
        openChecks++; return Promise.resolve({ rows: openChecks <= 1 ? [{ '?column?': 1 }] : [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const engine = engineMock();
    const audit = jest.fn().mockResolvedValue();
    const r = await at.runTool('close_active_break', { operator: 'Simone' }, { engine, auditAction: audit });
    expect(engine.endBreak).toHaveBeenCalledWith(expect.objectContaining({ operatorId: 3 }));
    expect(r).toMatchObject({ closed: true, closed_count: 1, operator: 'Simone' });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ai_admin_closed_break', entityType: 'operator_activity_log', entityId: 3,
    }));
  });

  test('duplicate open breaks → loop closes them all', async () => {
    let n = 0;
    db.query = jest.fn((sql) => {
      if (/FROM operators/.test(sql)) return Promise.resolve({ rows: [{ id: 5, name: 'Vitor' }] });
      if (/activity_type = 'break' LIMIT 1/.test(sql)) { n++; return Promise.resolve({ rows: n <= 2 ? [{ x: 1 }] : [] }); }
      return Promise.resolve({ rows: [] });
    });
    const engine = engineMock();
    const r = await at.runTool('close_active_break', { operator: 'Vitor' }, { engine, auditAction: jest.fn() });
    expect(engine.endBreak).toHaveBeenCalledTimes(2);
    expect(r.closed_count).toBe(2);
  });

  test('no active break → closed:false, note, engine not called', async () => {
    db.query = jest.fn((sql) => {
      if (/FROM operators/.test(sql)) return Promise.resolve({ rows: [{ id: 9, name: 'Ana' }] });
      return Promise.resolve({ rows: [] });
    });
    const engine = engineMock();
    const r = await at.runTool('close_active_break', { operator: 'Ana' }, { engine, auditAction: jest.fn() });
    expect(engine.endBreak).not.toHaveBeenCalled();
    expect(r).toMatchObject({ closed: false });
    expect(r.note).toMatch(/não tinha break/i);
  });

  test('unknown operator → found:false', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await at.runTool('close_active_break', { operator: 'Fulano' }, { engine: engineMock(), auditAction: jest.fn() });
    expect(r).toMatchObject({ closed: false, found: false });
  });
});

describe('BUG REBELLION — close_all_active_breaks', () => {
  test('closes every operator on break + aggregate audit', async () => {
    const onBreak = [{ operator_id: 3, operator: 'Simone' }, { operator_id: 5, operator: 'Vitor' }];
    const seen = {};
    db.query = jest.fn((sql, p) => {
      if (/SELECT DISTINCT oal\.operator_id, o\.name AS operator/.test(sql)) return Promise.resolve({ rows: onBreak });
      if (/activity_type = 'break' LIMIT 1/.test(sql)) {
        const id = p[0]; seen[id] = (seen[id] || 0) + 1;
        return Promise.resolve({ rows: seen[id] <= 1 ? [{ x: 1 }] : [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const engine = engineMock();
    const audit = jest.fn().mockResolvedValue();
    const r = await at.runTool('close_all_active_breaks', {}, { engine, auditAction: audit });
    expect(engine.endBreak).toHaveBeenCalledTimes(2);
    expect(r.closed_operators).toBe(2);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ai_admin_closed_break', entityId: 'all',
    }));
  });
});

describe('BUG REBELLION — tools registered + gated', () => {
  test('both break tools + post tool are channel tools in TOOL_DEFS', () => {
    for (const t of ['close_active_break', 'close_all_active_breaks', 'post_to_production_channel']) {
      expect(at.CHANNEL_TOOLS.has(t)).toBe(true);
      expect(at.TOOL_DEFS.find((d) => d.name === t)).toBeTruthy();
    }
  });
  test('cron/autonomous cannot close breaks (allowMutations:false)', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await expect(at.runTool('close_active_break', { operator: 'x' }, { allowMutations: false }))
      .rejects.toThrow(/ordem explícita/);
  });
});

describe('BUG REBELLION — composition: close breaks AND announce', () => {
  test('admin combo runs both tools in sequence, each audited', async () => {
    db.query = jest.fn((sql, p) => {
      if (/SELECT DISTINCT oal\.operator_id/.test(sql)) return Promise.resolve({ rows: [{ operator_id: 3, operator: 'Simone' }] });
      if (/activity_type = 'break' LIMIT 1/.test(sql)) return Promise.resolve({ rows: [] }); // already closed after 1st pass
      return Promise.resolve({ rows: [] });
    });
    const audit = jest.fn().mockResolvedValue();
    const slackClient = { postMessage: jest.fn().mockResolvedValue('1718.99') };
    const deps = { engine: engineMock(), auditAction: audit, slackClient };
    const a = await at.runTool('close_all_active_breaks', {}, deps);
    const b = await at.runTool('post_to_production_channel',
      { message_text: 'Fechei os breaks, pessoal — bora voltar!' }, deps);
    expect(a).toHaveProperty('results');
    expect(b).toMatchObject({ posted: true });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai_admin_closed_break' }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai_admin_posted_to_channel' }));
  });
});

describe('BUG REBELLION — prompt: anti-lie + capabilities + combo', () => {
  test('prompt lists capabilities, forbids lying, demands combo execution', () => {
    const dm = fs.readFileSync(path.join(__dirname, '..', 'slack', 'dm-handler.js'), 'utf8');
    expect(dm).toMatch(/SUAS CAPACIDADES/);
    expect(dm).toMatch(/close_active_break/);
    expect(dm).toMatch(/PROIBIDO MENTIR SOBRE CAPACIDADE/);
    expect(dm).toMatch(/NUNCA diga "não tenho ferramenta"/);
    expect(dm).toMatch(/COMBO DE AÇÕES/);
    expect(dm).toMatch(/execute TODAS as ferramentas em sequência/);
  });
});
