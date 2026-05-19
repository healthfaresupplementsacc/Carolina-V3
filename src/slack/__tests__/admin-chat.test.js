'use strict';
// FASE 1 P6 — admin-chat disambiguation: always reaches the admin chat
// (never gated by silent_text), audited, and the admin's reply
// re-dispatches the parked event WITH the operator.
jest.mock('../../db');
jest.mock('../client', () => ({
  postToChannel: jest.fn().mockResolvedValue('1700000000.0001'),
}));
jest.mock('../../admin/audit', () => ({ auditAction: jest.fn().mockResolvedValue(1) }));
jest.mock('../../dispatcher/canonical-dispatcher', () => ({
  safeDispatch: jest.fn().mockResolvedValue({ dispatched: true, upsert: 'create' }),
}));
jest.mock('../../ai/admin-tools', () => ({
  resolveOperator: jest.fn(),
}));

const db = require('../../db');
const client = require('../client');
const { auditAction } = require('../../admin/audit');
const canonical = require('../../dispatcher/canonical-dispatcher');
const adminTools = require('../../ai/admin-tools');
const config = require('../../config');
const adminChat = require('../admin-chat');

beforeEach(() => {
  jest.clearAllMocks();
  db.query = jest.fn().mockResolvedValue({ rows: [] });
});

describe('sendToAdminChat', () => {
  test('posts to the manager channel (exempt from silent_text) + audits', async () => {
    await adminChat.sendToAdminChat('teste', 'disambiguation');
    expect(client.postToChannel).toHaveBeenCalledWith(config.slack.managerChannelId, 'teste');
    expect(auditAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'carolina.admin_chat_question',
        entityId: 'disambiguation',
      })
    );
  });
});

describe('askDisambiguation', () => {
  test('builds the "quem foi?" question with account + hora + texto', async () => {
    await adminChat.askDisambiguation(
      { source_id: '1779120923.0001', raw_text: 'label das ordens',
        timestamp: '2026-05-18T14:30:00.000Z',
        metadata: { accountUserId: 'U0AU8N8FA00' } },
      { user: 'U0AU8N8FA00', text: 'label das ordens', ts: '1779120923.0001' }
    );
    const posted = client.postToChannel.mock.calls[0][1];
    expect(posted).toMatch(/U0AU8N8FA00/);
    expect(posted).toMatch(/label das ordens/);
    expect(posted).toMatch(/Quem foi/i);
  });
});

describe('listPending', () => {
  test('returns parsed pending events', async () => {
    db.query = jest.fn().mockResolvedValue({
      rows: [{ source_id: 's1', source_type: 'parser',
        event: JSON.stringify({ type: 'start', raw_text: 'x' }),
        account_user_id: 'U0', created_at: 'now' }],
    });
    const r = await adminChat.listPending();
    expect(r).toHaveLength(1);
    expect(r[0].event.type).toBe('start');
  });
});

describe('resolveDisambiguationReply', () => {
  test('admin answers "foi a Ana" → re-dispatch parked event WITH operator + mark resolved + audit', async () => {
    const parked = { source_id: '1779.1', source_type: 'parser', type: 'start',
      operator_id: null, supplement: 'Rutin', raw_text: 'label das ordens' };
    db.query = jest.fn((sql) => {
      if (/SELECT source_id FROM pending_disambiguation\s+WHERE status = 'pending'/.test(sql)) {
        return Promise.resolve({ rows: [{ source_id: '1779.1' }] });
      }
      if (/SELECT source_id, source_type, event, status FROM pending_disambiguation/.test(sql)) {
        return Promise.resolve({ rows: [{ source_id: '1779.1', source_type: 'parser', event: parked, status: 'pending' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    adminTools.resolveOperator.mockResolvedValue({ id: 1, name: 'Ana', role: 'operator' });

    const r = await adminChat.resolveDisambiguationReply('foi a Ana');
    expect(r.handled).toBe(true);
    expect(r.operator).toBe('Ana');
    // event re-dispatched WITH the resolved operator
    const ev = canonical.safeDispatch.mock.calls[0][0];
    expect(ev.operator_id).toBe(1);
    expect(ev.source_id).toBe('1779.1');
    // pending row marked resolved
    const upd = db.query.mock.calls.find((c) => /UPDATE pending_disambiguation/.test(c[0]));
    expect(upd[1]).toEqual([1, '1779.1']);
    expect(auditAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'operator.reassign_retroactive' })
    );
  });

  test('nothing pending → handled:false (falls through to normal loop)', async () => {
    db.query = jest.fn().mockResolvedValue({ rows: [] });
    const r = await adminChat.resolveDisambiguationReply('Ana');
    expect(r.handled).toBe(false);
    expect(canonical.safeDispatch).not.toHaveBeenCalled();
  });

  test('name does not resolve → handled:false (admin meant something else)', async () => {
    db.query = jest.fn((sql) =>
      /FROM pending_disambiguation/.test(sql)
        ? Promise.resolve({ rows: [{ source_id: 's', source_type: 'parser', event: { type: 'start' }, status: 'pending' }] })
        : Promise.resolve({ rows: [] }));
    adminTools.resolveOperator.mockResolvedValue(null);
    const r = await adminChat.resolveDisambiguationReply('fecha a fase 5');
    expect(r.handled).toBe(false);
    expect(canonical.safeDispatch).not.toHaveBeenCalled();
  });
});
