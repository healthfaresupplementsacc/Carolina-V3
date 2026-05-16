'use strict';
// BLOCO C / P7 — Bloco B integration: toggles gate the autonomous
// Carolina; proposal expiry is configurable.
jest.mock('../db');
const db = require('../db');
const detect = require('../ai/detect');
const proposals = require('../ai/proposals');

beforeEach(() => { jest.clearAllMocks(); });

describe('P7 — defaultIsTypeEnabled maps proposal type → Bloco B toggle', () => {
  test('close_phase maps to the "conflict" toggle', () => {
    expect(detect.PROPOSAL_TYPE_TOGGLE.close_phase).toBe('conflict');
    expect(detect.PROPOSAL_TYPE_TOGGLE.operator_idle).toBe('urgency');
  });

  test('toggle OFF → type disabled; ON/absent → enabled', async () => {
    db.query = jest.fn().mockImplementation((sql, p) => {
      if (/SELECT value FROM app_state WHERE key = \$1/.test(sql) && p[0] === 'conflict_enabled') {
        return Promise.resolve({ rows: [{ value: 'false' }] });
      }
      return Promise.resolve({ rows: [] }); // default → enabled
    });
    expect(await detect.defaultIsTypeEnabled('close_phase')).toBe(false); // conflict off
    expect(await detect.defaultIsTypeEnabled('operator_idle')).toBe(true); // urgency default on
    expect(await detect.defaultIsTypeEnabled('weird_unmapped')).toBe(true); // unmapped → true
  });

  test('a config read failure fails open (detection not silenced)', async () => {
    db.query = jest.fn().mockRejectedValue(new Error('db down'));
    expect(await detect.defaultIsTypeEnabled('close_phase')).toBe(true);
  });
});

describe('P7 — toggle gates the cron end-to-end', () => {
  function deps() {
    return {
      proposals: { create: jest.fn().mockResolvedValue({ id: 1 }) },
      adminTools: { MUTATION_TOOLS: new Set(['close_phase']), getProposal: jest.fn().mockResolvedValue(null), setProposal: jest.fn() },
      postToAdmin: jest.fn().mockResolvedValue(),
      // NOTE: isTypeEnabled NOT injected → real defaultIsTypeEnabled runs.
    };
  }

  test('conflict OFF → stale phase produces NO proposal', async () => {
    db.query = jest.fn().mockImplementation((sql, p) => {
      if (/FROM phase_instances pi/.test(sql)) return Promise.resolve({ rows: [{ id: 5, phase_name: 'Enc' }] });
      if (/SELECT value FROM app_state WHERE key = \$1/.test(sql) && p[0] === 'conflict_enabled') {
        return Promise.resolve({ rows: [{ value: 'false' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const d = deps();
    const made = await detect.detectAndPropose(d);
    expect(d.proposals.create).not.toHaveBeenCalled();
    expect(made).toHaveLength(0);
  });

  test('conflict ON (default) → stale phase produces a proposal', async () => {
    db.query = jest.fn().mockImplementation((sql) => {
      if (/FROM phase_instances pi/.test(sql)) return Promise.resolve({ rows: [{ id: 5 }] });
      return Promise.resolve({ rows: [] }); // conflict_enabled absent → default ON
    });
    const d = deps();
    const made = await detect.detectAndPropose(d);
    expect(d.proposals.create).toHaveBeenCalledWith(expect.objectContaining({ proposalType: 'close_phase' }));
    expect(made).toHaveLength(1);
  });
});

describe('P7 — configurable proposal expiry (7.2)', () => {
  test('getWindowMinutes reads the configurable app_state key', async () => {
    expect(proposals.WINDOW_KEY).toBe('proposal_window_minutes');
    db.query = jest.fn().mockImplementation((sql, p) => {
      if (/SELECT value FROM app_state WHERE key = \$1/.test(sql) && p[0] === 'proposal_window_minutes') {
        return Promise.resolve({ rows: [{ value: '60' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    expect(await proposals.getWindowMinutes()).toBe(60); // admin-configured window honoured
  });

  test('expireOld uses the configured window in its interval', async () => {
    const seen = [];
    db.query = jest.fn().mockImplementation((sql, p) => {
      if (/SELECT value FROM app_state WHERE key = \$1/.test(sql)) return Promise.resolve({ rows: [{ value: '90' }] });
      if (/UPDATE carolina_proposals\s+SET status = 'expired'/.test(sql)) { seen.push(p[0]); return Promise.resolve({ rows: [] }); }
      return Promise.resolve({ rows: [] });
    });
    await proposals.expireOld();
    expect(seen[0]).toBe('90'); // configured window passed into the SQL interval
  });
});
