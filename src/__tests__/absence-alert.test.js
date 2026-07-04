'use strict';
/* Absence alert — regras Bruno 07-04:
   • aviso só DENTRO do expediente (1º check-in → MAX(+9h, fim da escala)); fora = silêncio
   • 1h sem ação = checkout automático (1 aviso só, flood morre)
   • sábado: pergunta "foi embora?" (✅ checkout / ❌ cobra tarefa) em vez de cobrar direto */
const { AbsenceAlert } = require('../workers/absence-alert');

// Qua 2026-07-01 12:00 EDT / Sáb 2026-07-04 12:00 EDT (meio-dia NY, dentro de 6–21h)
const WED_NOON = Date.parse('2026-07-01T16:00:00Z');
const SAT_NOON = Date.parse('2026-07-04T16:00:00Z');
const hAgo = (base, h) => new Date(base - h * 3600 * 1000);

function makeDb(opts = {}) {
  const posts = []; const logs = []; const notifs = []; const logoffs = [];
  return {
    posts, logs, notifs, logoffs,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/FROM v3\.persons p WHERE p\.role = 'operator'/.test(s)) return { rows: opts.candidates || [], rowCount: (opts.candidates || []).length };
      if (/action_type = 'absence_alert' AND created_at >/.test(s)) { const hit = (opts.recent || []).includes(params[0]); return { rows: hit ? [{ x: 1 }] : [], rowCount: hit ? 1 : 0 }; }
      if (/action_type = \$2 AND \(created_at AT TIME ZONE/.test(s)) { const hit = (opts.didToday || []).some((d) => d.id === params[0] && d.type === params[1]); return { rows: hit ? [{ x: 1 }] : [], rowCount: hit ? 1 : 0 }; }
      if (/UPDATE v3\.operator_sessions SET logged_out_at/.test(s)) { logoffs.push(params[0]); return { rows: [] }; }
      if (/INSERT INTO v3\.notifications/.test(s)) { notifs.push(JSON.parse(params[0])); return { rows: [] }; }
      if (/INSERT INTO v3\.operator_action_log/.test(s)) { logs.push({ person: params[0], type: /absence_auto_logoff/.test(s) ? 'absence_auto_logoff' : /saturday_idle_question/.test(s) ? 'saturday_idle_question' : 'absence_alert' }); return { rows: [] }; }
      return { rows: [] };
    },
  };
}
const mkSlack = () => { const s = { calls: [], postAs: async (m) => { s.calls.push(m); return { ok: true, ts: '111.222' }; } }; return s; };

describe('AbsenceAlert — janela de expediente', () => {
  test('dentro do expediente (check-in 3h atrás) → alerta; sem check-in hoje → silêncio', async () => {
    const db = makeDb({ candidates: [
      { id: 4, display_name: 'Vitor', idle_min: 22, ref: new Date(WED_NOON - 22 * 60000), first_checkin: hAgo(WED_NOON, 3), sched_end: null },
      { id: 9, display_name: 'SemCheckin', idle_min: 30, ref: new Date(WED_NOON - 30 * 60000), first_checkin: null, sched_end: null },
    ] });
    const w = new AbsenceAlert({ db, slack: mkSlack(), channelId: 'C_OPS', enabled: true, thresholdMin: 15, now: () => WED_NOON });
    expect((await w.findAbsent()).map((a) => a.id)).toEqual([4]);
  });

  test('EXPEDIENTE ACABOU (check-in há 10h, sem escala) → NENHUM aviso (fim do flood)', async () => {
    const db = makeDb({ candidates: [
      { id: 4, display_name: 'Vitor', idle_min: 54, ref: new Date(WED_NOON - 54 * 60000), first_checkin: hAgo(WED_NOON, 10), sched_end: null },
    ] });
    const w = new AbsenceAlert({ db, slack: mkSlack(), channelId: 'C_OPS', enabled: true, thresholdMin: 15, now: () => WED_NOON });
    expect(await w.findAbsent()).toEqual([]);
  });

  test('escala estende a janela: check-in há 10h MAS escala até mais tarde → ainda avisa', async () => {
    const db = makeDb({ candidates: [
      { id: 7, display_name: 'Bruno Sarmento', idle_min: 20, ref: new Date(WED_NOON - 20 * 60000), first_checkin: hAgo(WED_NOON, 10), sched_end: new Date(WED_NOON + 2 * 3600 * 1000) },
    ] });
    const w = new AbsenceAlert({ db, slack: mkSlack(), channelId: 'C_OPS', enabled: true, thresholdMin: 15, now: () => WED_NOON });
    expect((await w.findAbsent()).map((a) => a.id)).toEqual([7]);
  });

  test('madrugada NY (guarda 6–21h) → silêncio mesmo com idle alto', async () => {
    const NIGHT = Date.parse('2026-07-02T03:00:00Z'); // 23:00 EDT de 07-01
    const db = makeDb({ candidates: [
      { id: 4, display_name: 'Vitor', idle_min: 40, ref: new Date(NIGHT - 40 * 60000), first_checkin: hAgo(NIGHT, 2), sched_end: null },
    ] });
    const w = new AbsenceAlert({ db, slack: mkSlack(), channelId: 'C_OPS', enabled: true, thresholdMin: 15, now: () => NIGHT });
    expect(await w.findAbsent()).toEqual([]);
  });
});

describe('AbsenceAlert — 1h = checkout automático', () => {
  test('idle >= 60min → fecha sessões + posta :door: 1x + action_log (sem re-flood)', async () => {
    const slack = mkSlack();
    const db = makeDb({ candidates: [
      { id: 6, display_name: 'Ana', idle_min: 62, ref: new Date(WED_NOON - 62 * 60000), first_checkin: hAgo(WED_NOON, 4), sched_end: null },
    ] });
    const w = new AbsenceAlert({ db, slack, channelId: 'C_OPS', enabled: true, thresholdMin: 15, now: () => WED_NOON });
    const r = await w.tick();
    expect(r.sent).toBe(1);
    expect(db.logoffs).toEqual([6]);
    expect(slack.calls[0].text).toContain('checkout automático');
    expect(db.logs.some((l) => l.type === 'absence_auto_logoff')).toBe(true);
    // 2º tick no mesmo dia: já deslogada → didToday → nada
    const db2 = makeDb({ candidates: [
      { id: 6, display_name: 'Ana', idle_min: 70, ref: new Date(WED_NOON - 70 * 60000), first_checkin: hAgo(WED_NOON, 4), sched_end: null },
    ], didToday: [{ id: 6, type: 'absence_auto_logoff' }] });
    const w2 = new AbsenceAlert({ db: db2, slack: mkSlack(), channelId: 'C_OPS', enabled: true, thresholdMin: 15, now: () => WED_NOON });
    expect((await w2.tick()).sent).toBe(0);
  });
});

describe('AbsenceAlert — sábado pergunta em vez de cobrar', () => {
  test('sáb + idle>=30 → posta pergunta ✅/❌ + registra notificação pendente', async () => {
    const slack = mkSlack();
    const db = makeDb({ candidates: [
      { id: 6, display_name: 'Ana', slack_user_id: null, idle_min: 33, ref: new Date(SAT_NOON - 33 * 60000), first_checkin: hAgo(SAT_NOON, 3), sched_end: null },
    ] });
    const w = new AbsenceAlert({ db, slack, channelId: 'C_OPS', enabled: true, thresholdMin: 15, now: () => SAT_NOON });
    const r = await w.tick();
    expect(r.sent).toBe(1);
    expect(slack.calls[0].text).toContain('Foi embora?');
    expect(db.notifs[0]).toMatchObject({ person_id: 6, msg_ts: '111.222' });
    expect(db.logs.some((l) => l.type === 'saturday_idle_question')).toBe(true);
  });
  test('sáb + idle 15-29 → ainda não pergunta (espera 30)', async () => {
    const db = makeDb({ candidates: [
      { id: 6, display_name: 'Ana', idle_min: 20, ref: new Date(SAT_NOON - 20 * 60000), first_checkin: hAgo(SAT_NOON, 3), sched_end: null },
    ] });
    const w = new AbsenceAlert({ db, slack: mkSlack(), channelId: 'C_OPS', enabled: true, thresholdMin: 15, now: () => SAT_NOON });
    expect((await w.tick()).sent).toBe(0);
  });
});

describe('AbsenceAlert — comportamento preservado', () => {
  test('não re-alerta dentro do repeatMin (dedup)', async () => {
    const slack = mkSlack();
    const db = makeDb({ candidates: [
      { id: 4, display_name: 'Vitor', idle_min: 40, ref: new Date(WED_NOON - 40 * 60000), first_checkin: hAgo(WED_NOON, 3), sched_end: null },
    ], recent: [4] });
    const w = new AbsenceAlert({ db, slack, channelId: 'C_OPS', enabled: true, now: () => WED_NOON });
    expect((await w.tick()).sent).toBe(0);
    expect(slack.calls.length).toBe(0);
  });
  test('kill-switch OFF → não faz nada', async () => {
    const db = makeDb({ candidates: [{ id: 4, display_name: 'Vitor', idle_min: 40, ref: new Date(), first_checkin: new Date(), sched_end: null }] });
    const w = new AbsenceAlert({ db, slack: mkSlack(), channelId: 'C_OPS', enabled: false, now: () => WED_NOON });
    expect((await w.tick()).skipped).toBe(true);
  });
});
