'use strict';
// FASE 1 P7 — admin-chat ingestion: persist to `messages` (audit, no
// production dispatch), auto-discover slack_user_id, resolve the admin's
// disambiguation answer.
jest.mock('../../db');
jest.mock('../../admin/audit', () => ({ auditAction: jest.fn().mockResolvedValue(1) }));

const db = require('../../db');
const { auditAction } = require('../../admin/audit');
const dm = require('../dm-handler');
const config = require('../../config');

beforeEach(() => { jest.clearAllMocks(); });

describe('persistAdminMessage', () => {
  test('writes the admin message to `messages` as parsed_type=admin_chat (never production)', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await dm.persistAdminMessage(
      { ts: '1779200000.0001', user: 'U03URLL1D4L', text: 'foi a Ana' },
      'Bruno Camp'
    );
    const call = db.query.mock.calls[0];
    expect(call[0]).toMatch(/INSERT INTO messages/);
    expect(call[0]).toMatch(/'admin_chat'/);
    expect(call[1]).toEqual([
      '1779200000.0001', config.slack.managerChannelId, 'U03URLL1D4L',
      'Bruno Camp', 'foi a Ana', expect.any(String),
    ]);
  });
});

describe('autodiscoverSlackId', () => {
  const slack = { users: { info: jest.fn() } };

  test('adopts the slack id when exactly one NULL-slack operator name-matches + audits', async () => {
    db.query = jest.fn((sql) => {
      if (/SELECT 1 FROM operators WHERE slack_user_id/.test(sql)) return Promise.resolve({ rows: [] });
      if (/SELECT id, name FROM operators/.test(sql)) return Promise.resolve({ rows: [{ id: 2, name: 'Bruno Sarmento' }] });
      return Promise.resolve({ rows: [] });
    });
    await dm.autodiscoverSlackId(slack, { user: 'UNEW1', text: 'oi' }, 'Bruno Sarmento');
    const upd = db.query.mock.calls.find((c) => /UPDATE operators SET slack_user_id/.test(c[0]));
    expect(upd[1]).toEqual(['UNEW1', 2]);
    expect(auditAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'operator.update_slack_user_id', source: 'admin_chat_autodiscover',
      })
    );
  });

  test('does nothing when the slack id is already mapped', async () => {
    db.query = jest.fn((sql) =>
      /SELECT 1 FROM operators WHERE slack_user_id/.test(sql)
        ? Promise.resolve({ rows: [{ '?column?': 1 }] })
        : Promise.resolve({ rows: [] }));
    await dm.autodiscoverSlackId(slack, { user: 'U03URLL1D4L', text: 'x' }, 'Bruno Camp');
    const upd = db.query.mock.calls.find((c) => /UPDATE operators SET slack_user_id/.test(c[0]));
    expect(upd).toBeUndefined();
    expect(auditAction).not.toHaveBeenCalled();
  });

  test('never guesses when the name match is ambiguous (≠1 candidate)', async () => {
    db.query = jest.fn((sql) => {
      if (/SELECT 1 FROM operators WHERE slack_user_id/.test(sql)) return Promise.resolve({ rows: [] });
      if (/SELECT id, name FROM operators/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 2, name: 'Bruno Sarmento' }, { id: 333, name: 'Bruno Camp' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    await dm.autodiscoverSlackId(slack, { user: 'UX', text: 'x' }, 'Bruno');
    expect(db.query.mock.calls.find((c) => /UPDATE operators/.test(c[0]))).toBeUndefined();
  });

  test('skips bot messages', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    await dm.autodiscoverSlackId(slack, { user: 'UBOT', bot_id: 'B1', text: 'x' }, 'Carolina');
    expect(db.query).not.toHaveBeenCalled();
  });
});
