'use strict';
const { PrintDivergenceWatchdog } = require('../workers/print-divergence-watchdog');

function make(over = {}) {
  const posted = [];
  const logs = [];
  const db = {
    query: async (sql, params) => {
      if (/isMuted|operator_alerts_muted/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT 1 FROM v3.print_divergence_log/.test(sql)) return { rowCount: over.alreadyLogged ? 1 : 0, rows: [] };
      if (/SUM\(e.orders_printed\)/.test(sql)) return { rows: [{ total: over.operator != null ? over.operator : 100 }] };
      if (/INSERT INTO v3.print_divergence_log/.test(sql)) { logs.push(params); return { rowCount: 1, rows: [] }; }
      if (/answer_text IS NULL/.test(sql)) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
  };
  const w = new PrintDivergenceWatchdog({
    enabled: true, db,
    veeqo: { configured: () => true, shippedByDay: async () => ({ total_orders: over.veeqo != null ? over.veeqo : 100 }) },
    slack: { postAs: async (m) => { posted.push(m); return { ts: '123.456' }; } },
    slackWeb: null, channelId: 'CORDERS', askHour: 12,
  });
  w._ny = () => ({ hour: over.hour != null ? over.hour : 13, date: '2026-08-06' });
  return { w, posted, logs };
}

describe('print-divergence-watchdog', () => {
  test('bateu (diff 0) → NÃO pergunta, mas LOGA o dia', async () => {
    const { w, posted, logs } = make({ operator: 150, veeqo: 150 });
    const r = await w.tick();
    expect(posted).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(r.ask.diff).toBe(0);
    expect(r.ask.asked).toBe(false);
  });

  test('divergiu → pergunta com SÓ A DIFERENÇA (nunca os totais)', async () => {
    const { w, posted, logs } = make({ operator: 389, veeqo: 145 });
    const r = await w.tick();
    expect(r.ask.asked).toBe(true);
    expect(posted).toHaveLength(1);
    const text = posted[0].text;
    expect(text).toContain('244');                 // a diferença
    expect(text).not.toContain('389');             // NUNCA o total digitado
    expect(text).not.toContain('145');             // NUNCA o total do Veeqo
    expect(text).toMatch(/Simone/);
    expect(posted[0].channel).toBe('CORDERS');
    expect(logs[0][4]).toBe(true);                 // asked=true no log
  });

  test('antes do meio-dia → não roda', async () => {
    const { w, posted } = make({ hour: 9 });
    const r = await w.tick();
    expect(r.ask.skipped).toBe('before_noon');
    expect(posted).toHaveLength(0);
  });

  test('já logou hoje → não repete', async () => {
    const { w, posted } = make({ alreadyLogged: true });
    const r = await w.tick();
    expect(r.ask.skipped).toBe('already_logged');
    expect(posted).toHaveLength(0);
  });

  test('operador digitou 0 (não imprimiu) → loga mas não pergunta', async () => {
    const { w, posted, logs } = make({ operator: 0, veeqo: 80 });
    const r = await w.tick();
    expect(r.ask.asked).toBe(false);
    expect(posted).toHaveLength(0);
    expect(logs).toHaveLength(1);
  });

  test('disabled → skip', async () => {
    const { w } = make();
    w.enabled = false;
    expect((await w.tick()).skipped).toBe(true);
  });
});
