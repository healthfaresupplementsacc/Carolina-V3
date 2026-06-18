'use strict';
/* Worker de limpeza do sandbox: HARD-delete dos events de teste vencidos +
   counts + lotes órfãos + audit. Mantém os frescos. Fake-db por regex. */
const { SandboxCleanup } = require('../workers/sandbox-cleanup');

function makeDb(mem) {
  const resp = (rows) => ({ rows, rowCount: rows.length });
  return {
    query: jest.fn(async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/SELECT id FROM v3\.persons WHERE is_sandbox = true/.test(s)) return resp(mem.persons.filter((p) => p.is_sandbox).map((p) => ({ id: p.id })));
      if (/SELECT id FROM v3\.events WHERE is_test = true/.test(s)) {
        // expirados: terminados há >15s OU abertos há >5min
        const now = Date.now();
        const exp = mem.events.filter((e) => e.is_test && !e.deleted
          && ((e.ended_at && now - e.ended_at > 15000) || (!e.ended_at && now - e.started_at > 300000)));
        return resp(exp.map((e) => ({ id: e.id })));
      }
      if (/DELETE FROM v3\.production_counts WHERE source_event_id = ANY/.test(s)) {
        const ids = params[0]; const before = mem.counts.length;
        mem.counts = mem.counts.filter((c) => !ids.includes(c.source_event_id));
        return resp(new Array(before - mem.counts.length).fill({}));
      }
      if (/DELETE FROM v3\.events WHERE id = ANY/.test(s)) {
        const ids = params[0]; mem.events = mem.events.filter((e) => !ids.includes(e.id));
        return resp(ids.map((id) => ({ id })));
      }
      if (/DELETE FROM v3\.product_batches pb WHERE pb\.created_by_person_id = ANY/.test(s)) {
        const sbIds = params[0]; const before = mem.batches.length;
        mem.batches = mem.batches.filter((b) => !(sbIds.includes(b.created_by_person_id) && b.origin === 'operator_created' && !mem.events.some((e) => e.product_batch_id === b.id)));
        return resp(new Array(before - mem.batches.length).fill({}));
      }
      if (/DELETE FROM v3\.audit_log WHERE actor_person_id = ANY/.test(s)) {
        const sbIds = params[0]; const before = mem.audits.length;
        mem.audits = mem.audits.filter((a) => !sbIds.includes(a.actor_person_id));
        return resp(new Array(before - mem.audits.length).fill({}));
      }
      return resp([]);
    }),
  };
}

describe('sandbox-cleanup worker', () => {
  test('deleta events de teste vencidos + counts + lote órfão + audit; mantém frescos', async () => {
    const now = Date.now();
    const mem = {
      persons: [{ id: 8, is_sandbox: true }, { id: 4, is_sandbox: false }],
      events: [
        { id: 100, is_test: true, started_at: now - 600000, ended_at: now - 20000, product_batch_id: 70 }, // vencido (terminou há 20s)
        { id: 101, is_test: true, started_at: now - 5000, ended_at: now - 3000, product_batch_id: 71 },     // fresco (terminou há 3s)
        { id: 102, is_test: true, started_at: now - 60000, ended_at: null, product_batch_id: null },        // aberto há 1min → mantém
        { id: 103, is_test: false, started_at: now - 999999, ended_at: now - 999999, product_batch_id: 1 }, // real → NUNCA
      ],
      counts: [{ source_event_id: 100, bottles: 900 }, { source_event_id: 101, bottles: 5 }],
      batches: [
        { id: 70, created_by_person_id: 8, origin: 'operator_created' }, // órfão depois que 100 sai
        { id: 71, created_by_person_id: 8, origin: 'operator_created' }, // 101 ainda referencia → mantém
        { id: 1, created_by_person_id: null, origin: 'pipeline' },       // real
      ],
      audits: [{ actor_person_id: 8 }, { actor_person_id: 8 }, { actor_person_id: 4 }],
    };
    const w = new SandboxCleanup({ db: makeDb(mem) });
    const r = await w.tick();
    expect(r.events).toBe(1); // só o 100
    expect(mem.events.map((e) => e.id).sort()).toEqual([101, 102, 103]); // 100 sumiu, real fica
    expect(mem.counts.map((c) => c.source_event_id)).toEqual([101]); // count do 100 sumiu
    expect(mem.batches.map((b) => b.id).sort()).toEqual([1, 71]); // 70 órfão sumiu, 71 e real ficam
    expect(mem.audits).toEqual([{ actor_person_id: 4 }]); // audit sandbox sumiu, real fica
  });

  test('no-op barato quando não há sandbox', async () => {
    const mem = { persons: [{ id: 4, is_sandbox: false }], events: [], counts: [], batches: [], audits: [] };
    const w = new SandboxCleanup({ db: makeDb(mem) });
    const r = await w.tick();
    expect(r.events).toBe(0);
  });
});
