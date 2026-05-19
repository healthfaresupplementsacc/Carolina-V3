'use strict';
// FASE 1 P8 — legacy×ISA-88 divergence telemetry.
jest.mock('../db');
jest.mock('../admin/audit', () => ({ auditAction: jest.fn().mockResolvedValue(1) }));
jest.mock('../slack/admin-chat', () => ({ sendToAdminChat: jest.fn().mockResolvedValue('ts') }));

const db = require('../db');
const { auditAction } = require('../admin/audit');
const adminChat = require('../slack/admin-chat');
const tele = require('../workflow/divergence-telemetry');

beforeEach(() => { jest.clearAllMocks(); });

describe('computeDivergence (pure)', () => {
  test('within 5% → no divergence', () => {
    const r = tele.computeDivergence({
      a: { legacy: 100, isa: 100 },
      b: { legacy: 20, isa: 21 }, // 4.7%
    });
    expect(r.has_divergence).toBe(false);
    expect(r.rows.find((x) => x.metric === 'b').over).toBe(false);
  });

  test('over 5% → flagged', () => {
    const r = tele.computeDivergence({
      tasks_vs_phases: { legacy: 10, isa: 7 }, // 30%
    });
    expect(r.has_divergence).toBe(true);
    expect(r.rows[0].over).toBe(true);
    expect(r.rows[0].diff_pct).toBe(30);
  });

  test('both zero → 0% (no divide-by-zero)', () => {
    const r = tele.computeDivergence({ x: { legacy: 0, isa: 0 } });
    expect(r.rows[0].diff_pct).toBe(0);
    expect(r.has_divergence).toBe(false);
  });
});

describe('runDivergenceTelemetry', () => {
  test('always audits divergence.telemetry; alerts admin ONLY when over threshold', async () => {
    // legacy tasks 10 vs isa phases 5 → 50% divergence
    db.query = jest.fn((sql) => {
      if (/FROM tasks/.test(sql)) return Promise.resolve({ rows: [{ n: 10 }] });
      if (/FROM phase_instances/.test(sql)) return Promise.resolve({ rows: [{ n: 5 }] });
      return Promise.resolve({ rows: [{ n: 0 }] });
    });
    const r = await tele.runDivergenceTelemetry({ date: '2026-05-18' });
    expect(r.has_divergence).toBe(true);
    expect(auditAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'divergence.telemetry', entityId: '2026-05-18' })
    );
    expect(adminChat.sendToAdminChat).toHaveBeenCalledWith(
      expect.stringMatching(/DIVERGENTE/), 'telemetry', expect.any(Object)
    );
  });

  test('healthy day → audits but NO admin alert (no daily noise)', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [{ n: 0 }] });
    const r = await tele.runDivergenceTelemetry({ date: '2026-05-18' });
    expect(r.has_divergence).toBe(false);
    expect(auditAction).toHaveBeenCalled();
    expect(adminChat.sendToAdminChat).not.toHaveBeenCalled();
  });
});

describe('legacy shadow still writes (doc 8.1)', () => {
  test('poller still invokes the legacy taskEngine.handleParsed shadow path', () => {
    const src = require('fs').readFileSync(require.resolve('../slack/poller.js'), 'utf8');
    expect(src).toMatch(/taskEngine\.handleParsed\(parsed, msg\)/);
  });
});
