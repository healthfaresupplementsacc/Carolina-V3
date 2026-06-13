'use strict';
/* Fase G — ProactiveAlerts worker: idle / stale / anomaly + dedupe. */
const { ProactiveAlerts } = require('../workers/proactive-alerts');

const resp = (rows) => ({ rows, rowCount: rows.length });

function makeDb({ idle = [], stale = [], counts = [], avg = null, ordersRows = [], voiceBytes = 0, existingNotif = false } = {}) {
  const mem = { notifications: [], posts: 0 };
  const db = {
    mem,
    query: jest.fn(async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/SELECT 1 FROM v3\.notifications WHERE type=\$1 AND status='pending'/.test(s)) {
        return resp(existingNotif ? [{ x: 1 }] : []);
      }
      if (/INSERT INTO v3\.notifications/.test(s)) { const id = mem.notifications.length + 1; mem.notifications.push({ id }); return resp([{ id }]); }
      if (/UPDATE v3\.notifications SET carolina_slack_ts/.test(s)) return resp([]);
      if (/FROM v3\.operator_sessions s JOIN v3\.persons p/.test(s)) return resp(idle);
      if (/e\.is_long_running = false AND e\.started_at < NOW\(\) - INTERVAL '3 hours'/.test(s)) return resp(stale);
      if (/FROM v3\.production_counts pc JOIN v3\.product_batches pb ON pb\.id = pc\.product_batch_id JOIN v3\.products/.test(s) && /created_at > NOW\(\) - INTERVAL '24 hours'/.test(s)) return resp(counts);
      if (/SELECT ROUND\(AVG\(pc\.bottles\)\) AS avg/.test(s)) return resp([{ avg }]);
      if (/e\.orders_printed > 0 AND e\.created_at > NOW\(\) - INTERVAL '24 hours'/.test(s)) return resp(ordersRows);
      if (/SUM\(audio_size_bytes\)/.test(s)) return resp([{ b: String(voiceBytes) }]);
      return resp([]);
    }),
  };
  return db;
}
function mk(db, slack) { return new ProactiveAlerts({ db, slack: slack || { postAs: jest.fn(async () => ({ ts: 'x' })) }, adminChannelId: 'C_ADMIN' }); }

describe('Fase G — ProactiveAlerts', () => {
  test('operator_long_idle → notification + Carolina (top-level)', async () => {
    const slack = { postAs: jest.fn(async () => ({ ts: 'x' })) };
    const db = makeDb({ idle: [{ session_id: 9, display_name: 'Vitor', logged_edt: '08:13 AM', idle_min: 137 }] });
    const r = await mk(db, slack).tick();
    expect(r.idle).toBe(1);
    expect(db.mem.notifications).toHaveLength(1);
    const post = slack.postAs.mock.calls[0][0];
    expect(post.sender).toEqual({ name: 'Carolina' });
    expect(post.thread_ts).toBeNull();
    expect(post.text).toContain('💤');
    expect(post.text).toContain('Vitor');
  });

  test('event_stale_no_close → notification', async () => {
    const db = makeDb({ stale: [{ id: 311, display_name: 'Ana', slug: 'production_line', batch_number: 'BR-2026-0190', h_aberto: 3.4 }] });
    const r = await mk(db).tick();
    expect(r.stale).toBe(1);
  });

  test('bottle_count_anomaly: desvio >70% → notifica; dentro da faixa → não', async () => {
    const big = makeDb({ counts: [{ id: 5, bottles: 300, product: 'Glycinate', batch_number: '0190', product_id: 1 }], avg: 1200 });
    expect((await mk(big).tick()).anomaly).toBe(1); // -75%
    const small = makeDb({ counts: [{ id: 6, bottles: 1100, product: 'Glycinate', batch_number: '0190', product_id: 1 }], avg: 1200 });
    expect((await mk(small).tick()).anomaly).toBe(0); // -8%
  });

  test('sem média histórica (avg null) → não acusa anomalia', async () => {
    const db = makeDb({ counts: [{ id: 7, bottles: 50, product: 'Novo', batch_number: '0001', product_id: 9 }], avg: null });
    expect((await mk(db).tick()).anomaly).toBe(0);
  });

  test('dedupe: notification já pendente do mesmo alvo → não duplica', async () => {
    const db = makeDb({ idle: [{ session_id: 9, display_name: 'Vitor', logged_edt: '08:13 AM', idle_min: 137 }], existingNotif: true });
    const r = await mk(db).tick();
    expect(r.idle).toBe(0);
    expect(db.mem.notifications).toHaveLength(0);
  });

  test('high_orders_printed_anomaly: >3x média → notifica; ≤3x → não', async () => {
    const big = makeDb({ ordersRows: [{ id: 5, orders_printed: 400, person_id: 4, display_name: 'Simone', avg_orders: 50 }] });
    expect((await mk(big).tick()).orders).toBe(1); // 400 > 50*3
    const small = makeDb({ ordersRows: [{ id: 6, orders_printed: 120, person_id: 4, display_name: 'Simone', avg_orders: 50 }] });
    expect((await mk(small).tick()).orders).toBe(0); // 120 < 150
  });

  test('voice_storage_quota_warning: >=400MB → notifica; abaixo → não', async () => {
    const hi = makeDb({ voiceBytes: 420 * 1048576 });
    expect((await mk(hi).tick()).quota).toBe(1);
    const lo = makeDb({ voiceBytes: 100 * 1048576 });
    expect((await mk(lo).tick()).quota).toBe(0);
  });

  test('tick concorrente → skip overlap', async () => {
    const db = makeDb({});
    const w = mk(db);
    w._ticking = true;
    expect(await w.tick()).toEqual({ skipped: 'overlap' });
  });
});
