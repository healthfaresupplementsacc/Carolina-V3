'use strict';
/* Encap-monitor — gates novos (Bruno 07-05): não alerta se MUTADO nem se
   NINGUÉM está presente (o flood 07-04: máquina gritando 16h→19h depois que
   todo mundo já tinha sido auto-deslogado às 15h). */
const { EncapMonitor } = require('../workers/encap-monitor');

// check() acha "máquina parada" (off_min alto, janela ok, factory_active).
function makeDb(opts = {}) {
  const posts = [];
  return {
    posts,
    query: async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      // alert-gate.isMuted → settings
      if (/SELECT value FROM v3\.settings WHERE key = \$1/.test(s)) {
        return opts.muted ? { rows: [{ value: { until: new Date(Date.now() + 3600e3).toISOString() } }] } : { rows: [] };
      }
      // alert-gate.anyonePresent
      if (/AS present/.test(s)) return { rows: [{ present: opts.present !== false }] };
      // check(): hora + factory_active
      if (/factory_active/.test(s)) return { rows: [{ h: 15, now_t: '15:00', factory_active: true }] };
      // check(): intervalos de encapsulação de hoje (nenhum aberto → parada)
      if (/at\.slug = 'encapsulation'/.test(s)) return { rows: [] };
      // check(): bounds da janela
      if (/AS win_start/.test(s)) {
        const now = new Date(); const winStart = new Date(now.getTime() - 5 * 3600e3);
        return { rows: [{ win_start: winStart.toISOString(), now: now.toISOString() }] };
      }
      // _alertedRecently
      if (/encap_off_alert/.test(s)) return { rows: [], rowCount: 0 };
      return { rows: [] };
    },
  };
}
const mkSlack = () => { const s = { calls: [], postAs: async (m) => { s.calls.push(m); return { ok: true, ts: '1.1' }; } }; return s; };

describe('EncapMonitor — gates de silêncio', () => {
  test('presente + não-mutado → ALERTA (comportamento normal)', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb({ present: true }), slack, channelId: 'C_OPS', enabled: true });
    const r = await w.tick();
    expect(r.alerted).toBe(true);
    expect(slack.calls[0].text).toContain('ENCAPSULAÇÃO PARADA');
  });
  test('NINGUÉM presente → silêncio (fim do flood pós-saída)', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb({ present: false }), slack, channelId: 'C_OPS', enabled: true });
    const r = await w.tick();
    expect(r.nobody_present).toBe(true);
    expect(slack.calls.length).toBe(0);
  });
  test('MUTADO pelo admin → silêncio', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb({ present: true, muted: true }), slack, channelId: 'C_OPS', enabled: true });
    const r = await w.tick();
    expect(r.muted).toBe(true);
    expect(slack.calls.length).toBe(0);
  });
});
