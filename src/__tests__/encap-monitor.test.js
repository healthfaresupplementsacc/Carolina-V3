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
    query: async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/SELECT value FROM v3\.settings WHERE key = \$1/.test(s)) {
        return opts.muted ? { rows: [{ value: { until: new Date(Date.now() + 3600e3).toISOString() } }] } : { rows: [] };
      }
      if (/AS working/.test(s)) return { rows: [{ working: opts.present !== false }] }; // operador de máquina trabalhando
      // ── modo sob demanda (workday.js) ──
      if (/::date::text AS d/.test(s)) return { rows: [{ d: '2026-07-11', dow: 6 }] };
      if (/AS unscheduled/.test(s)) return { rows: [{ unscheduled: !!opts.unscheduled }] };
      if (/AS active/.test(s)) return { rows: [{ active: !!opts.weekendActivity }] };
      if (/SELECT value FROM v3\.settings WHERE key=\$1/.test(s)) {
        return opts.plan ? { rows: [{ value: { date: '2026-07-11', end: opts.plan.end || null } }] } : { rows: [] };
      }
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
      // ── CÂMERA (Bruno 08-25) ──
      // opts.cam = { machines:[...], ageMs } → o payload de v3.settings 'machine_state'.
      // Sem opts.cam o sinal simplesmente não existe (câmera cega), que é o
      // comportamento antigo dos testes que já existiam.
      if (/key='machine_state'/.test(s)) {
        if (!opts.cam) return { rows: [] };
        const at = new Date(Date.now() - (opts.cam.ageMs != null ? opts.cam.ageMs : 10 * 1000));
        return { rows: [{ value: { at: at.toISOString(), machines: opts.cam.machines || [], source: '28_machinemon' } }] };
      }
      if (/FROM v3\.camera_zones/.test(s)) {
        return { rows: opts.zones || [
          { id: 4, cam: 'warehouse', name: 'Capsule Dispensing Machine', kind: 'machine' },
          { id: 6, cam: 'packaging', name: 'Capsule Dispensing Machine', kind: 'machine' },
        ] };
      }
      if (/signal_incident/.test(s) && /SELECT 1/.test(s)) {
        return { rows: opts.incidentToday ? [{ x: 1 }] : [], rowCount: opts.incidentToday ? 1 : 0 };
      }
      if (/INSERT INTO v3\.incidents/.test(s)) {
        (opts._incidents = opts._incidents || []).push({ code: params && params[0], title: params && params[1] });
        return { rows: [{ id: 1 }], rowCount: 1 };
      }
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
    // a mensagem DO OPERADOR (sem câmera no teste, o admin também recebe a nota
    // de cegueira, então filtra pelo canal em vez de assumir a ordem)
    const ops = slack.calls.filter((c) => c.channel === 'C_OPS');
    expect(ops.length).toBe(1);
    expect(ops[0].sender.icon).toBe(':rotating_light:');                    // alarme grande, de propósito
    // TEXTO NOVO (Bruno 08-25): o sistema NÃO sabe que a máquina parou, só que
    // ninguém REGISTROU. A frase antiga afirmava o que ele não podia afirmar.
    expect(ops[0].text).toMatch(/Nenhuma encapsula[çc][ãa]o registrada desde as \d{2}:\d{2}/);
    expect(ops[0].text).not.toMatch(/Encapsula[çc][ãa]o parada h[áa]/i);
    expect(ops[0].text).toMatch(/Se a m[áa]quina t[áa] rodando, registrem agora/);
    expect(ops[0].text).toMatch(/Se t[áa] parada mesmo, tudo certo/);
    // total do dia continua, mas como tempo SEM REGISTRO
    expect(ops[0].text).toMatch(/sem registro de encapsula[çc][ãa]o/);
    expect(ops[0].text).not.toMatch(/—|–/);                                 // sem em dash
  });
  test('NENHUM operador de máquina trabalhando → silêncio (ocioso/limpeza/só não-operador)', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb({ present: false }), slack, channelId: 'C_OPS', enabled: true });
    expect((await w.tick()).no_operator_working).toBe(true);
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
  test('DEPOIS DAS 8pm mesmo com escala até 20:30 → silêncio (Bruno 07-10: teto 8pm)', async () => {
    // A máquina para ~16h (todo mundo vai pra limpeza/fim de dia). Antes o alarme
    // seguia o MAX(fim)=20:30 do Bruno Sarmento e gritava às 20:13. Agora o teto
    // é endHour (20h): a escala só ESTREITA a janela, nunca passa das 8pm.
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb({ present: true, nowTime: '20:13:00', sched: { total: 28, start: '08:00:00', end: '20:30:00' } }), slack, channelId: 'C_OPS', enabled: true });
    expect((await w.tick()).off).toBe(false);
    expect(slack.calls.length).toBe(0);
  });
  test('escala que TERMINA ANTES do teto (sáb até 13:00) → estreita a janela (agora 15:00 silêncio)', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb({ present: true, nowTime: '15:00:00', sched: { total: 28, start: '08:00:00', end: '13:00:00' } }), slack, channelId: 'C_OPS', enabled: true });
    expect((await w.tick()).off).toBe(false);
    expect(slack.calls.length).toBe(0);
  });
  test('DIA DE FOLGA (há escalas, mas nenhuma pra hoje) → silêncio', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb({ present: true, sched: { total: 28, start: null, end: null } }), slack, channelId: 'C_OPS', enabled: true });
    expect((await w.tick()).off).toBe(false);
    expect(slack.calls.length).toBe(0);
  });
  test('FDS/folga SEM modo sob demanda → silêncio (dorme)', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb({ present: true, sched: { total: 28, start: null, end: null }, unscheduled: true, weekendActivity: false }), slack, channelId: 'C_OPS', enabled: true });
    expect((await w.tick()).off).toBe(false);
    expect(slack.calls.length).toBe(0);
  });
  test('FDS com trabalho (sob demanda LIGADO) + operador trabalhando → alerta', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb({ present: true, sched: { total: 28, start: null, end: null }, unscheduled: true, weekendActivity: true }), slack, channelId: 'C_OPS', enabled: true });
    expect((await w.tick()).alerted).toBe(true);
  });
  test('sem escala cadastrada → fallback janela fixa (h=15 ∈ 8–20) alerta', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb({ present: true, sched: { total: 0, start: null, end: null } }), slack, channelId: 'C_OPS', enabled: true });
    expect((await w.tick()).alerted).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   CÂMERA (Bruno 08-25). Os dois bugs reais que deixaram o alarme mentir:
   (a) a encapsuladora nunca vinha no payload, então a supressão jamais podia
       casar a máquina certa;
   (b) `some(m => m.moving)` deixava QUALQUER máquina calar o alarme da cápsula.
   ──────────────────────────────────────────────────────────────────────────── */
const CAP = 'Capsule Dispensing Machine';

describe('EncapMonitor — a câmera tem que casar a ENCAPSULADORA, não qualquer máquina', () => {
  test('encapsuladora SE MEXENDO → não alarma o operador, pergunta no admin', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({
      db: makeDb({ present: true, cam: { machines: [{ name: CAP, moving: true }] } }),
      slack, channelId: 'C_OPS', adminChannelId: 'C_ADMIN', enabled: true });
    const r = await w.tick();
    expect(r.camera_moving).toBe(true);
    expect(r.asked_admin).toBe(true);
    // nada no canal dos operadores; a pergunta vai pro admin
    expect(slack.calls.every((c) => c.channel !== 'C_OPS')).toBe(true);
    expect(slack.calls.some((c) => c.channel === 'C_ADMIN')).toBe(true);
  });

  test('BUG (b) CONSERTADO: linha de produção rodando NÃO cala o alarme da cápsula', async () => {
    // Este é literalmente o último payload real do .28 antes de morrer.
    const slack = mkSlack();
    const w = new EncapMonitor({
      db: makeDb({ present: true, cam: { machines: [{ name: 'Production Line', moving: true, running: true }] } }),
      slack, channelId: 'C_OPS', adminChannelId: 'C_ADMIN', enabled: true });
    const r = await w.tick();
    expect(r.camera_moving).toBeUndefined();          // NÃO foi suprimido
    expect(r.alerted).toBe(true);                     // o alarme saiu, como devia
    expect(slack.calls.some((c) => c.channel === 'C_OPS')).toBe(true);
  });

  test('encapsuladora PARADA na câmera → alarme sai (câmera confirma, não contradiz)', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({
      db: makeDb({ present: true, cam: { machines: [{ name: CAP, moving: false, running: false }] } }),
      slack, channelId: 'C_OPS', adminChannelId: 'C_ADMIN', enabled: true });
    expect((await w.tick()).alerted).toBe(true);
  });

  test('casa o nome sem depender de acento nem de maiúscula', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({
      db: makeDb({ present: true, cam: { machines: [{ name: 'encapsulação', moving: true }] } }),
      slack, channelId: 'C_OPS', adminChannelId: 'C_ADMIN', enabled: true });
    expect((await w.tick()).camera_moving).toBe(true);
  });

  test('_cameraSaysMoving devolve matched/fresh/moving corretamente', async () => {
    const w = new EncapMonitor({
      db: makeDb({ cam: { machines: [{ name: CAP, moving: true }, { name: 'Production Line', moving: false }] } }),
      slack: mkSlack(), channelId: 'C_OPS', enabled: true });
    const cam = await w._cameraSaysMoving();
    expect(cam.fresh).toBe(true);
    expect(cam.matched).toBe(true);
    expect(cam.moving).toBe(true);
  });
});

describe('EncapMonitor — BUG (a): sinal fresco SEM a encapsuladora dentro', () => {
  test('vira INCIDENTE camera_no_encap_zone e NÃO cala o alarme', async () => {
    const opts = { present: true, cam: { machines: [{ name: 'Production Line', moving: true }] } };
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb(opts), slack, channelId: 'C_OPS', adminChannelId: 'C_ADMIN', enabled: true });
    const r = await w.tick();
    expect(opts._incidents.length).toBe(1);
    expect(opts._incidents[0].code).toBe('camera_no_encap_zone');
    expect(r.alerted).toBe(true);              // continua alertando: matched=false é "não sei"
  });

  test('o incidente do dia não repete (dedupe por dia NY)', async () => {
    const opts = { present: true, incidentToday: true, cam: { machines: [{ name: 'Production Line', moving: true }] } };
    const w = new EncapMonitor({ db: makeDb(opts), slack: mkSlack(), channelId: 'C_OPS', adminChannelId: 'C_ADMIN', enabled: true });
    await w.tick();
    expect(opts._incidents).toBeUndefined();
  });

  test('câmera com a encapsuladora presente NÃO abre incidente', async () => {
    const opts = { present: true, cam: { machines: [{ name: CAP, moving: false }] } };
    const w = new EncapMonitor({ db: makeDb(opts), slack: mkSlack(), channelId: 'C_OPS', adminChannelId: 'C_ADMIN', enabled: true });
    await w.tick();
    expect(opts._incidents).toBeUndefined();
  });
});

describe('EncapMonitor — sinal VELHO: o motivo tem que aparecer na hora', () => {
  test('câmera cega + alarme → linha extra no ADMIN dizendo desde quando', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({
      // sinal de 2h atrás: bem além do cameraMaxAgeMs de 3min
      db: makeDb({ present: true, cam: { machines: [{ name: CAP, moving: true }], ageMs: 2 * 3600e3 } }),
      slack, channelId: 'C_OPS', adminChannelId: 'C_ADMIN', enabled: true });
    const r = await w.tick();
    expect(r.alerted).toBe(true);                         // sinal velho não suprime
    const admin = slack.calls.filter((c) => c.channel === 'C_ADMIN');
    expect(admin.length).toBe(1);
    expect(admin[0].text).toMatch(/c[âa]mera est[áa] cega desde/i);
    // e o operador NÃO recebe esse detalhe técnico
    const ops = slack.calls.filter((c) => c.channel === 'C_OPS');
    expect(ops.length).toBe(1);
    expect(ops[0].text).not.toMatch(/c[âa]mera/i);
  });

  test('SEM sinal nenhum (o caso das 42h) → alarme sai e o admin é avisado da cegueira', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({ db: makeDb({ present: true }), slack, channelId: 'C_OPS', adminChannelId: 'C_ADMIN', enabled: true });
    expect((await w.tick()).alerted).toBe(true);
    const admin = slack.calls.filter((c) => c.channel === 'C_ADMIN');
    expect(admin.length).toBe(1);
    expect(admin[0].text).toMatch(/cega desde nunca/i);
  });

  test('câmera FRESCA e casada → nenhuma linha de cegueira no admin', async () => {
    const slack = mkSlack();
    const w = new EncapMonitor({
      db: makeDb({ present: true, cam: { machines: [{ name: CAP, moving: false }] } }),
      slack, channelId: 'C_OPS', adminChannelId: 'C_ADMIN', enabled: true });
    await w.tick();
    const admin = slack.calls.filter((c) => c.channel === 'C_ADMIN');
    expect(admin.length).toBe(0);
  });
});
