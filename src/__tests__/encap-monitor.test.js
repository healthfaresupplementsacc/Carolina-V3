'use strict';
/* Encap-monitor — ALARME GRANDE horário (Bruno: a fábrica depende da máquina
   rodando), mas só DENTRO do expediente e com ALGUÉM presente. Gates: mute,
   presença (anyonePresent), e janela da ESCALA (v3.operator_schedules). */
const { EncapMonitor } = require('../workers/encap-monitor');

// check() acha "máquina parada" (off_min alto, dentro da janela, factory_active).
// opts.sched = { total, start, end } controla a escala; now_time default 15:00.
function makeDb(opts = {}) {
  const sched = opts.sched || { total: 0, start: null, end: null };
  return {
    query: async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/SELECT value FROM v3\.settings WHERE key = \$1/.test(s)) {
        return opts.muted ? { rows: [{ value: { until: new Date(Date.now() + 3600e3).toISOString() } }] } : { rows: [] };
      }
      if (/AS present/.test(s)) return { rows: [{ present: opts.present !== false }] };
      if (/factory_active/.test(s)) return { rows: [{
        h: 15, now_t: '15:00', now_time: opts.nowTime || '15:00:00',
        sched_total: sched.total, sched_start: sched.start, sched_end: sched.end,
        factory_active: opts.factoryActive !== false,
      }] };
      if (/at\.slug = 'encapsulation'/.test(s)) return { rows: [] };
      if (/AS win_start/.test(s)) {
        const now = new Date(); const winStart = new Date(now.getTime() - 5 * 3600e3);
        return { rows: [{ win_start: winStart.toISOString(), now: now.toISOString() }] };
      }
      if (/encap_off_alert/.test(s)) return { rows: [], rowCount: 0 };
      return { rows: [] };
    },
  };
}
const mkSlack = () => { const s = { calls: [], postAs: async (m) => { s.calls.push(m); return { ok: true, ts: '1.1' }; } }; return s; };

describe('EncapMonitor — alarme grande, mas gated', () => {
  test('presente + dentro do expediente → ALARME GRANDE horário (:rotating_light:, total acumulado)', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb({ present: true }), slack, channelId: 'C_OPS', enabled: true });
    const r = await w.tick();
    expect(r.alerted).toBe(true);
    expect(slack.calls[0].sender.icon).toBe(':rotating_light:');            // alarme grande, de propósito
    expect(slack.calls[0].text).toContain('MÁQUINA DE ENCAPSULAÇÃO PARADA');
    expect(slack.calls[0].text).toContain('já ficou');                      // total acumulado importante
    expect(slack.calls[0].text).toContain('AGORA');
  });
  test('NINGUÉM presente → silêncio (Saturday 8pm: não grita com a parede)', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb({ present: false }), slack, channelId: 'C_OPS', enabled: true });
    expect((await w.tick()).nobody_present).toBe(true);
    expect(slack.calls.length).toBe(0);
  });
  test('MUTADO pelo admin → silêncio', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb({ present: true, muted: true }), slack, channelId: 'C_OPS', enabled: true });
    expect((await w.tick()).muted).toBe(true);
    expect(slack.calls.length).toBe(0);
  });
});

describe('EncapMonitor — janela da ESCALA (segue o horário de trabalho)', () => {
  test('dentro da escala (08:00–20:30, agora 15:00) → alerta', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb({ present: true, sched: { total: 28, start: '08:00:00', end: '20:30:00' } }), slack, channelId: 'C_OPS', enabled: true });
    expect((await w.tick()).alerted).toBe(true);
  });
  test('FORA da escala (agora 21:00, escala até 20:30) → silêncio', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb({ present: true, nowTime: '21:00:00', sched: { total: 28, start: '08:00:00', end: '20:30:00' } }), slack, channelId: 'C_OPS', enabled: true });
    expect((await w.tick()).off).toBe(false);
    expect(slack.calls.length).toBe(0);
  });
  test('DIA DE FOLGA (há escalas, mas nenhuma pra hoje) → silêncio', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb({ present: true, sched: { total: 28, start: null, end: null } }), slack, channelId: 'C_OPS', enabled: true });
    expect((await w.tick()).off).toBe(false);
    expect(slack.calls.length).toBe(0);
  });
  test('sem escala cadastrada → fallback janela fixa (h=15 ∈ 8–20) alerta', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb({ present: true, sched: { total: 0, start: null, end: null } }), slack, channelId: 'C_OPS', enabled: true });
    expect((await w.tick()).alerted).toBe(true);
  });
});
