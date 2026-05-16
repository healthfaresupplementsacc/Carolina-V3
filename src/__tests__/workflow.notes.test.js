'use strict';
jest.mock('../db');
jest.mock('../slack/client');
const db = require('../db');
const slack = require('../slack/client');
const engine = require('../workflow/engine');
const announce = require('../workflow/announce');

beforeEach(() => {
  jest.clearAllMocks();
  slack.postMessage = jest.fn().mockResolvedValue('ts');
  slack.postToChannel = jest.fn().mockResolvedValue('ts');
});

describe('F2 — engine.addNote persists + auto-links', () => {
  test('inserts into operator_notes, links active phase, announces', async () => {
    const calls = [];
    db.query = jest.fn().mockImplementation((sql, params) => {
      calls.push(sql);
      if (/FROM operator_activity_log\s+WHERE operator_id/.test(sql)) {
        return Promise.resolve({ rows: [{ phase_instance_id: 50, ad_hoc_task_instance_id: null }] });
      }
      if (/SELECT workflow_instance_id FROM phase_instances/.test(sql)) {
        return Promise.resolve({ rows: [{ workflow_instance_id: 10 }] });
      }
      if (/INSERT INTO operator_notes/.test(sql)) {
        expect(params[0]).toBe(7);             // operatorId
        expect(params[1]).toBe('óleo na máquina X');
        expect(params[2]).toBe(50);            // linked phase
        expect(params[3]).toBe(10);            // linked workflow
        return Promise.resolve({ rows: [{ id: 99 }] });
      }
      if (/SELECT name FROM operators WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ name: 'Ana' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const r = await engine.addNote({ operatorId: 7, text: '  óleo na máquina X  ' });
    expect(r).toEqual({ noteId: 99, linkedPhaseInstanceId: 50 });
    // F3: announced to channel (postMessage) + admin mirror (postToChannel)
    expect(slack.postMessage).toHaveBeenCalled();
    expect(slack.postMessage.mock.calls[0][0]).toMatch(/Ana/);
    expect(slack.postToChannel).toHaveBeenCalled(); // toAdmin mirror
  });

  test('note with no active activity still persists (links null)', async () => {
    db.query = jest.fn().mockImplementation((sql, params) => {
      if (/FROM operator_activity_log\s+WHERE operator_id/.test(sql)) {
        return Promise.resolve({ rows: [] }); // no active activity
      }
      if (/INSERT INTO operator_notes/.test(sql)) {
        expect(params[2]).toBeNull();
        expect(params[3]).toBeNull();
        return Promise.resolve({ rows: [{ id: 100 }] });
      }
      if (/SELECT name FROM operators/.test(sql)) return Promise.resolve({ rows: [{ name: 'Bruno' }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await engine.addNote({ operatorId: 3, text: 'teste' });
    expect(r.noteId).toBe(100);
    expect(r.linkedPhaseInstanceId).toBeNull();
  });

  test('empty text rejected', async () => {
    db.query = jest.fn();
    await expect(engine.addNote({ operatorId: 1, text: '   ' })).rejects.toThrow(/note text/);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('bad operatorId rejected', async () => {
    await expect(engine.addNote({ operatorId: null, text: 'x' })).rejects.toThrow(/operatorId/);
  });
});

describe('F3 — announce.note', () => {
  test('posts a 📝 variation to channel + admin mirror', async () => {
    await announce.note({ operatorName: 'Simone', text: 'máquina parada' });
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.postMessage.mock.calls[0][0]).toMatch(/📝/);
    expect(slack.postMessage.mock.calls[0][0]).toMatch(/máquina parada/);
    expect(slack.postToChannel).toHaveBeenCalledTimes(1); // admin mirror
  });

  test('does not throw if channel post fails (best-effort)', async () => {
    slack.postMessage = jest.fn().mockRejectedValue(new Error('slack down'));
    await expect(announce.note({ operatorName: 'X', text: 'y' })).resolves.toBeUndefined();
  });
});
