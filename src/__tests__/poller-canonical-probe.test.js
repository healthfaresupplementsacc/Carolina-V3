'use strict';
// TAREFA 1 — behavioural lock on the [ProbeFASE1] observability probe.
// Drives the REAL canonicalProbe() with injected deps; asserts the log
// lines + control flow (no DB, no real parser/dispatcher).
jest.mock('../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../slack/client', () => ({}));
jest.mock('../urgency', () => ({ checkUrgency: jest.fn() }));
const poller = require('../slack/poller');

function harness(over = {}) {
  const logs = []; const errs = [];
  return {
    log: (s) => logs.push(s),
    errLog: (s) => errs.push(s),
    logs, errs,
    classify: over.classify,
    canonical: over.canonical,
    adminChat: over.adminChat,
  };
}
const MSG = { ts: '1779999999.111', text: 'S- Vitamina D 0140 - Bruno' };

describe('canonicalProbe — observability', () => {
  test('N events → header + per-event dispatch line + count', async () => {
    const h = harness({
      classify: jest.fn().mockResolvedValue([
        { source_id: '1779999999.111', type: 'start', operator_id: 2 },
      ]),
      canonical: { safeDispatch: jest.fn().mockResolvedValue({ dispatched: true, upsert: 'create', target_table: 'phase_instances', target_id: 99 }) },
    });
    const r = await poller.canonicalProbe(MSG, h);
    expect(r).toMatchObject({ ok: true, events: 1, dispatched: 1 });
    expect(h.logs[0]).toMatch(/\[ProbeFASE1\] ts=1779999999\.111 classify->1 event\(s\) types=\[start\]/);
    expect(h.logs[1]).toMatch(/\[ProbeFASE1\] dispatch src=1779999999\.111 type=start op=2 -> dispatched=true upsert=create target=phase_instances:99/);
    expect(h.canonical.safeDispatch).toHaveBeenCalledTimes(1);
  });

  test('0 events → explicit ZERO line w/ raw text, canonical NOT called', async () => {
    const canonical = { safeDispatch: jest.fn() };
    const h = harness({ classify: jest.fn().mockResolvedValue([]), canonical });
    const r = await poller.canonicalProbe({ ts: '12.3', text: '   ok 👍  ' }, h);
    expect(r).toMatchObject({ ok: true, events: 0, dispatched: 0 });
    expect(h.logs[0]).toMatch(/ts=12\.3 classify->0 events \(trivial_noise_or_empty\) text="ok 👍"/);
    expect(canonical.safeDispatch).not.toHaveBeenCalled();
  });

  test('classify THROWS → errLog, returns stage:classify, canonical NOT called', async () => {
    const canonical = { safeDispatch: jest.fn() };
    const h = harness({ classify: jest.fn().mockRejectedValue(new Error('boom-classify')), canonical });
    const r = await poller.canonicalProbe(MSG, h);
    expect(r).toMatchObject({ ok: false, stage: 'classify', error: 'boom-classify' });
    expect(h.errs[0]).toMatch(/\[ProbeFASE1\] classify THREW ts=1779999999\.111: boom-classify/);
    expect(canonical.safeDispatch).not.toHaveBeenCalled();
  });

  test('needsDisambiguation → askDisambiguation called + logged', async () => {
    const adminChat = { askDisambiguation: jest.fn().mockResolvedValue() };
    const h = harness({
      classify: jest.fn().mockResolvedValue([{ source_id: 's1', type: 'start', operator_id: null }]),
      canonical: { safeDispatch: jest.fn().mockResolvedValue({ dispatched: false, needsDisambiguation: true, reason: 'ambiguous operator' }) },
      adminChat,
    });
    const r = await poller.canonicalProbe(MSG, h);
    expect(adminChat.askDisambiguation).toHaveBeenCalledTimes(1);
    expect(h.logs[1]).toMatch(/op=NULL -> dispatched=false.*needsDisambiguation reason="ambiguous operator"/);
    expect(r).toMatchObject({ ok: true, events: 1, dispatched: 0 });
  });

  test('safeDispatch error surfaced in the log line', async () => {
    const h = harness({
      classify: jest.fn().mockResolvedValue([{ source_id: 's2', type: 'note', operator_id: 1 }]),
      canonical: { safeDispatch: jest.fn().mockResolvedValue({ dispatched: false, error: 'db down' }) },
    });
    await poller.canonicalProbe(MSG, h);
    expect(h.logs[1]).toMatch(/ERROR="db down"/);
  });

  test('canonical.safeDispatch THROWS → errLog dispatch error, ok:false stage:dispatch', async () => {
    const h = harness({
      classify: jest.fn().mockResolvedValue([{ source_id: 's3', type: 'start', operator_id: 1 }]),
      canonical: { safeDispatch: jest.fn().mockRejectedValue(new Error('kaboom')) },
    });
    const r = await poller.canonicalProbe(MSG, h);
    expect(r).toMatchObject({ ok: false, stage: 'dispatch', error: 'kaboom', events: 1 });
    expect(h.errs[0]).toMatch(/\[ProbeFASE1\] canonical dispatch error ts=1779999999\.111: kaboom/);
  });

  test('multiple events → dispatched count + one line each', async () => {
    const h = harness({
      classify: jest.fn().mockResolvedValue([
        { source_id: 'a', type: 'break_end', operator_id: 3 },
        { source_id: 'a', type: 'start', operator_id: 3 },
      ]),
      canonical: { safeDispatch: jest.fn()
        .mockResolvedValueOnce({ dispatched: true, upsert: 'create', target_table: 'pauses', target_id: 5 })
        .mockResolvedValueOnce({ dispatched: false, reason: 'unknown phase template' }) },
    });
    const r = await poller.canonicalProbe(MSG, h);
    expect(r).toMatchObject({ ok: true, events: 2, dispatched: 1 });
    expect(h.logs.filter((l) => l.includes('[ProbeFASE1] dispatch'))).toHaveLength(2);
  });
});
