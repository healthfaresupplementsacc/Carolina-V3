'use strict';
/* Vigia de sinais (Bruno 08-25). O caso real: o push da câmera do .28 morreu em
   23/08 às 23:39 e ninguém viu por 42h. Este vigia existe pra isso nunca mais
   passar batido. Testes: janela NY, um incidente por dia, recuperação uma vez só,
   NADA no canal dos operadores, e desligado por padrão. */
const { SignalWatchdog, fmtAge } = require('../workers/signal-watchdog');
const { SIGNALS, checkOne, checkAll, inWindow } = require('../v3/health/signal-registry');

const OPS_CHANNEL = 'C09UNBXFRKK';     // canal dos operadores: proibido aqui
const ADMIN = 'C0B36DR5MP1';

/** Banco falso: memória de audit_log + incidents. */
function makeDb(opts = {}) {
  const db = {
    audit: opts.audit ? opts.audit.slice() : [],
    incidents: opts.incidents ? opts.incidents.slice() : [],
    inserts: [],
  };
  db.query = async (sql, params) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/action = 'signal_incident'/.test(s) && /SELECT 1/.test(s)) {
      const hit = db.audit.some((a) => a.action === 'signal_incident' && a.signal === params[0] && a.ny_date === params[1]);
      return { rows: hit ? [{ x: 1 }] : [], rowCount: hit ? 1 : 0 };
    }
    if (/action = 'signal_recovered'/.test(s) && /SELECT 1/.test(s)) {
      const hit = db.audit.some((a) => a.action === 'signal_recovered' && a.signal === params[0] && a.ny_date === params[1]);
      return { rows: hit ? [{ x: 1 }] : [], rowCount: hit ? 1 : 0 };
    }
    if (/SELECT 1 FROM v3\.incidents WHERE code/.test(s)) {
      const hit = db.incidents.some((i) => i.code === params[0] && i.status !== 'resolved');
      return { rows: hit ? [{ x: 1 }] : [], rowCount: hit ? 1 : 0 };
    }
    if (/INSERT INTO v3\.audit_log/.test(s)) {
      const m = JSON.parse(params[0]);
      db.audit.push(Object.assign({ action: /signal_recovered/.test(s) ? 'signal_recovered' : 'signal_incident' }, m));
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO v3\.incidents/.test(s)) {
      db.incidents.push({ id: db.incidents.length + 1, code: params[0], status: 'open' });
      db.inserts.push({ code: params[0], title: params[1], detail: JSON.parse(params[2]) });
      return { rows: [{ id: db.incidents.length }], rowCount: 1 };
    }
    if (/UPDATE v3\.incidents SET status = 'resolved'/.test(s)) {
      const t = db.incidents.find((i) => i.code === params[0] && i.status !== 'resolved');
      if (t) t.status = 'resolved';
      return { rows: t ? [{ id: t.id }] : [], rowCount: t ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  return db;
}
const mkSlack = () => { const s = { calls: [], postAs: async (m) => { s.calls.push(m); return { ok: true, ts: '1.1' }; } }; return s; };

/** Um resultado de sinal pronto, pra não depender do banco real. */
function sig(over = {}) {
  return Object.assign({
    key: 'machine_state', label: 'Câmera das máquinas (.28)',
    how: 'O machinemon do .28 manda o estado a cada 30s.', source: '.28 machinemon',
    stale_after_min: 10, window: { startHour: 8, endHour: 20, workdaysOnly: false },
    severity: 'alta', fix_hint: 'Conferir o machinemon no .28.',
    at: new Date('2026-08-23T23:39:15Z'), age_min: 2520, stale: true, in_window: true,
    detail: { payload: { machines: [{ name: 'Production Line', moving: true }] } },
  }, over);
}
const fixed = (iso) => () => new Date(iso);

describe('signal-registry — o cálculo de idade e janela', () => {
  test('todo sinal tem os campos que o vigia precisa', () => {
    for (const s of SIGNALS) {
      expect(typeof s.key).toBe('string');
      expect(typeof s.label).toBe('string');
      expect(typeof s.how).toBe('string');
      expect(typeof s.read).toBe('function');
      expect(typeof s.stale_after_min).toBe('number');
      expect(['alta', 'média']).toContain(s.severity);
      expect(typeof s.fix_hint).toBe('string');
    }
  });

  test('os 5 sinais pedidos estão registrados', () => {
    const keys = SIGNALS.map((s) => s.key);
    for (const k of ['machine_state', 'print_event', 'ems_sync', 'veeqo_sync', 'ngteco_clock']) {
      expect(keys).toContain(k);
    }
  });

  test('idade fresca → stale=false; idade além do limiar → stale=true', async () => {
    const now = new Date('2026-08-25T18:00:00Z');           // 14:00 NY
    const db = { query: async () => ({ rows: [{ value: { at: '2026-08-25T17:58:00Z', machines: [] } }] }) };
    const fresh = await checkOne(db, SIGNALS.find((s) => s.key === 'machine_state'), now);
    expect(fresh.age_min).toBe(2);
    expect(fresh.stale).toBe(false);

    const db2 = { query: async () => ({ rows: [{ value: { at: '2026-08-23T23:39:15Z', machines: [] } }] }) };
    const old = await checkOne(db2, SIGNALS.find((s) => s.key === 'machine_state'), now);
    expect(old.stale).toBe(true);
    expect(old.age_min).toBeGreaterThan(2000);              // as 42h reais do caso
  });

  test('sinal que NUNCA chegou conta como velho (não como desconhecido)', async () => {
    const db = { query: async () => ({ rows: [] }) };
    const r = await checkOne(db, SIGNALS.find((s) => s.key === 'machine_state'), new Date('2026-08-25T18:00:00Z'));
    expect(r.at).toBe(null);
    expect(r.age_min).toBe(null);
    expect(r.stale).toBe(true);
  });

  test('erro de leitura não derruba o checkAll', async () => {
    const db = { query: async () => { throw new Error('sem tabela'); } };
    const all = await checkAll(db, new Date('2026-08-25T18:00:00Z'));
    expect(all.length).toBe(SIGNALS.length);
    for (const s of all) expect(s.at).toBe(null);
  });
});

describe('signal-registry — a FRONTEIRA da janela NY', () => {
  const W = { startHour: 8, endHour: 20, workdaysOnly: false };
  test('07:59 NY está FORA, 08:00 NY está DENTRO', () => {
    expect(inWindow(W, new Date('2026-08-25T11:59:00Z'))).toBe(false);  // 07:59 EDT
    expect(inWindow(W, new Date('2026-08-25T12:00:00Z'))).toBe(true);   // 08:00 EDT
  });
  test('19:59 NY está DENTRO, 20:00 NY está FORA', () => {
    expect(inWindow(W, new Date('2026-08-25T23:59:00Z'))).toBe(true);   // 19:59 EDT
    expect(inWindow(W, new Date('2026-08-26T00:00:00Z'))).toBe(false);  // 20:00 EDT
  });
  test('madrugada (03:00 NY) está fora: .28 desligado às 3h é normal', () => {
    expect(inWindow(W, new Date('2026-08-25T07:00:00Z'))).toBe(false);
  });
  test('workdaysOnly ignora sábado e domingo', () => {
    const WD = { startHour: 10, endHour: 18, workdaysOnly: true };
    expect(inWindow(WD, new Date('2026-08-21T18:00:00Z'))).toBe(true);   // sexta 14h NY
    expect(inWindow(WD, new Date('2026-08-22T18:00:00Z'))).toBe(false);  // sábado
    expect(inWindow(WD, new Date('2026-08-23T18:00:00Z'))).toBe(false);  // domingo
    expect(inWindow(WD, new Date('2026-08-24T18:00:00Z'))).toBe(true);   // segunda
  });
  test('window null = 24 horas por dia', () => {
    expect(inWindow(null, new Date('2026-08-25T07:00:00Z'))).toBe(true);
  });
});

describe('SignalWatchdog — abre incidente uma vez por dia', () => {
  test('sinal velho DENTRO da janela → abre 1 incidente e posta no admin', async () => {
    const db = makeDb(); const slack = mkSlack();
    const w = new SignalWatchdog({
      db, slack, channelId: ADMIN, enabled: true,
      now: fixed('2026-08-25T18:00:00Z'),
      checkAll: async () => [sig()],
    });
    const r = await w.tick();
    expect(r.opened).toEqual(['machine_state']);
    expect(db.incidents.length).toBe(1);
    expect(db.incidents[0].code).toBe('signal_machine_state');
    expect(slack.calls.length).toBe(1);
    expect(slack.calls[0].channel).toBe(ADMIN);
    expect(slack.calls[0].text).toContain('Claude já está trabalhando nisso.');
  });

  test('SEGUNDA tick no MESMO dia → não abre de novo (dedupe por dia NY)', async () => {
    const db = makeDb(); const slack = mkSlack();
    const mk = () => new SignalWatchdog({
      db, slack, channelId: ADMIN, enabled: true,
      now: fixed('2026-08-25T18:00:00Z'), checkAll: async () => [sig()],
    });
    await mk().tick();
    await mk().tick();
    await mk().tick();
    expect(db.incidents.length).toBe(1);
    expect(slack.calls.length).toBe(1);
  });

  test('no DIA SEGUINTE, ainda parado → abre de novo (é problema novo pra cobrar)', async () => {
    const db = makeDb(); const slack = mkSlack();
    await new SignalWatchdog({ db, slack, channelId: ADMIN, enabled: true,
      now: fixed('2026-08-25T18:00:00Z'), checkAll: async () => [sig()] }).tick();
    await new SignalWatchdog({ db, slack, channelId: ADMIN, enabled: true,
      now: fixed('2026-08-26T18:00:00Z'), checkAll: async () => [sig()] }).tick();
    expect(db.incidents.length).toBe(2);
    expect(slack.calls.length).toBe(2);
  });

  test('sinal velho FORA da janela → silêncio (não grita com a parede)', async () => {
    const db = makeDb(); const slack = mkSlack();
    const w = new SignalWatchdog({ db, slack, channelId: ADMIN, enabled: true,
      now: fixed('2026-08-25T07:00:00Z'),                 // 03:00 NY
      checkAll: async () => [sig({ in_window: false })] });
    const r = await w.tick();
    expect(r.opened).toEqual([]);
    expect(slack.calls.length).toBe(0);
    expect(db.incidents.length).toBe(0);
  });

  test('sinal FRESCO → nada acontece', async () => {
    const db = makeDb(); const slack = mkSlack();
    const w = new SignalWatchdog({ db, slack, channelId: ADMIN, enabled: true,
      now: fixed('2026-08-25T18:00:00Z'),
      checkAll: async () => [sig({ stale: false, age_min: 1 })] });
    const r = await w.tick();
    expect(r.opened).toEqual([]);
    expect(slack.calls.length).toBe(0);
  });

  test('vários sinais parados → um incidente pra cada', async () => {
    const db = makeDb(); const slack = mkSlack();
    const w = new SignalWatchdog({ db, slack, channelId: ADMIN, enabled: true,
      now: fixed('2026-08-25T18:00:00Z'),
      checkAll: async () => [sig(), sig({ key: 'ems_sync', label: 'Sincronização do EMS' })] });
    const r = await w.tick();
    expect(r.opened.sort()).toEqual(['ems_sync', 'machine_state']);
    expect(db.incidents.length).toBe(2);
  });
});

describe('SignalWatchdog — recuperação', () => {
  test('sinal volta → UMA linha de recuperação e o incidente vira resolved', async () => {
    const db = makeDb(); const slack = mkSlack();
    // dia 1: quebra
    await new SignalWatchdog({ db, slack, channelId: ADMIN, enabled: true,
      now: fixed('2026-08-25T18:00:00Z'), checkAll: async () => [sig()] }).tick();
    expect(db.incidents[0].status).toBe('open');
    slack.calls.length = 0;

    // dia 2: voltou
    const w = new SignalWatchdog({ db, slack, channelId: ADMIN, enabled: true,
      now: fixed('2026-08-26T18:00:00Z'),
      checkAll: async () => [sig({ stale: false, age_min: 1 })] });
    const r = await w.tick();
    expect(r.recovered).toEqual(['machine_state']);
    expect(db.incidents[0].status).toBe('resolved');
    expect(slack.calls.length).toBe(1);
    expect(slack.calls[0].text).toMatch(/voltou a mandar sinal/);
    expect(slack.calls[0].channel).toBe(ADMIN);
  });

  test('recuperação NÃO se repete no mesmo dia', async () => {
    const db = makeDb(); const slack = mkSlack();
    await new SignalWatchdog({ db, slack, channelId: ADMIN, enabled: true,
      now: fixed('2026-08-25T12:30:00Z'), checkAll: async () => [sig()] }).tick();
    slack.calls.length = 0;
    const mk = () => new SignalWatchdog({ db, slack, channelId: ADMIN, enabled: true,
      now: fixed('2026-08-25T18:00:00Z'), checkAll: async () => [sig({ stale: false, age_min: 1 })] });
    await mk().tick();
    await mk().tick();
    expect(slack.calls.length).toBe(1);
  });

  test('sinal fresco SEM incidente aberto → não posta nada', async () => {
    const db = makeDb(); const slack = mkSlack();
    const w = new SignalWatchdog({ db, slack, channelId: ADMIN, enabled: true,
      now: fixed('2026-08-25T18:00:00Z'),
      checkAll: async () => [sig({ stale: false, age_min: 1 })] });
    await w.tick();
    expect(slack.calls.length).toBe(0);
  });
});

describe('SignalWatchdog — as travas de segurança', () => {
  test('DESLIGADO por padrão (precisa de WORKER_SIGNAL_WATCHDOG_ENABLED=true)', async () => {
    const old = process.env.WORKER_SIGNAL_WATCHDOG_ENABLED;
    delete process.env.WORKER_SIGNAL_WATCHDOG_ENABLED;
    const db = makeDb(); const slack = mkSlack();
    const w = new SignalWatchdog({ db, slack, channelId: ADMIN, checkAll: async () => [sig()] });
    expect(w.enabled).toBe(false);
    expect((await w.tick()).skipped).toBe(true);
    expect(slack.calls.length).toBe(0);
    if (old !== undefined) process.env.WORKER_SIGNAL_WATCHDOG_ENABLED = old;
  });

  test('NUNCA posta no canal dos operadores, em nenhum caminho', async () => {
    const db = makeDb(); const slack = mkSlack();
    // quebra e recupera, checando todo post
    await new SignalWatchdog({ db, slack, channelId: ADMIN, enabled: true,
      now: fixed('2026-08-25T12:30:00Z'), checkAll: async () => [sig()] }).tick();
    await new SignalWatchdog({ db, slack, channelId: ADMIN, enabled: true,
      now: fixed('2026-08-26T18:00:00Z'), checkAll: async () => [sig({ stale: false, age_min: 1 })] }).tick();
    expect(slack.calls.length).toBeGreaterThan(0);
    for (const c of slack.calls) {
      expect(c.channel).toBe(ADMIN);
      expect(c.channel).not.toBe(OPS_CHANNEL);
    }
  });

  test('nenhuma mensagem tem em dash', async () => {
    const db = makeDb(); const slack = mkSlack();
    await new SignalWatchdog({ db, slack, channelId: ADMIN, enabled: true,
      now: fixed('2026-08-25T12:30:00Z'), checkAll: async () => [sig()] }).tick();
    await new SignalWatchdog({ db, slack, channelId: ADMIN, enabled: true,
      now: fixed('2026-08-26T18:00:00Z'), checkAll: async () => [sig({ stale: false, age_min: 1 })] }).tick();
    for (const c of slack.calls) expect(c.text).not.toMatch(/—|–/);
  });

  test('NÃO escreve estoque: nenhuma query toca stock/quantidade', async () => {
    const seen = [];
    const db = makeDb();
    const inner = db.query;
    db.query = async (sql, p) => { seen.push(String(sql)); return inner(sql, p); };
    await new SignalWatchdog({ db, slack: mkSlack(), channelId: ADMIN, enabled: true,
      now: fixed('2026-08-25T18:00:00Z'), checkAll: async () => [sig()] }).tick();
    const joined = seen.join(' ');
    expect(joined).not.toMatch(/stock_|product_stock|qty|quantity/i);
  });

  test('Slack fora do ar não derruba o tick', async () => {
    const db = makeDb();
    const slack = { postAs: async () => { throw new Error('down'); } };
    const w = new SignalWatchdog({ db, slack, channelId: ADMIN, enabled: true,
      now: fixed('2026-08-25T18:00:00Z'), checkAll: async () => [sig()] });
    const r = await w.tick();
    expect(r.opened).toEqual(['machine_state']);
    expect(db.incidents.length).toBe(1);       // o registro sobrevive
  });

  test('start() agenda a 1ª rodada 2min depois do boot e para limpo', () => {
    jest.useFakeTimers();
    const w = new SignalWatchdog({ db: makeDb(), slack: mkSlack(), enabled: false });
    w.start(5 * 60 * 1000);
    expect(w._kick).toBeTruthy();
    expect(w._t).toBeTruthy();
    w.stop();
    expect(w._t).toBe(null);
    jest.useRealTimers();
  });
});

describe('SignalWatchdog — o dossiê que vai pro incidente', () => {
  test('leva o payload CRU do último sinal e o que quebra downstream', async () => {
    const db = makeDb();
    await new SignalWatchdog({ db, slack: mkSlack(), channelId: ADMIN, enabled: true,
      now: fixed('2026-08-25T18:00:00Z'), checkAll: async () => [sig()] }).tick();
    const md = db.inserts[0].detail.dossier_md;
    expect(typeof md).toBe('string');
    expect(md).toContain('Production Line');                       // payload cru do .28
    expect(md).toContain('2026-08-23T23:39:15');                   // o momento real da morte
    expect(md).toMatch(/alarme da encapsula/i);                    // o que isso afeta
    expect(md).toContain('## Dados crus');
  });
});

describe('fmtAge — idade em português curto', () => {
  test('minutos, horas e dias', () => {
    expect(fmtAge(45)).toBe('45min');
    expect(fmtAge(64)).toBe('1h04');
    expect(fmtAge(2520)).toBe('42h00');
    expect(fmtAge(5000)).toBe('3 dias');
    expect(fmtAge(null)).toBe('nunca');
  });
});
