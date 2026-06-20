'use strict';
/* Absence alert — operador logado sem função (foreground) > 15min → avisa no Slack
   do grupo dos operadores. Não re-alerta dentro de repeatMin. Gated. */
const { AbsenceAlert } = require('../workers/absence-alert');

function makeDb(opts = {}) {
  const posts = []; const logs = [];
  return {
    posts, logs,
    candidates: opts.candidates || [],
    recent: opts.recent || [], // person_ids alertados recentemente
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/FROM v3\.persons p WHERE p\.role = 'operator'/.test(s)) return { rows: opts.candidates || [], rowCount: (opts.candidates || []).length };
      if (/action_type = 'absence_alert' AND created_at >/.test(s)) { const hit = (opts.recent || []).includes(params[0]); return { rows: hit ? [{ x: 1 }] : [], rowCount: hit ? 1 : 0 }; }
      if (/INSERT INTO v3\.operator_action_log/.test(s)) { logs.push({ person: params[0], type: 'absence_alert' }); return { rows: [] }; }
      return { rows: [] };
    },
  };
}

describe('AbsenceAlert', () => {
  test('findAbsent filtra por idle >= threshold + ref de hoje', async () => {
    const db = makeDb({ candidates: [
      { id: 4, display_name: 'Vitor', idle_min: 22, ref: new Date() },
      { id: 5, display_name: 'Ana', idle_min: 8, ref: new Date() }, // ocioso pouco → fora
      { id: 6, display_name: 'X', idle_min: 30, ref: new Date('1970-01-01') }, // 1º login (epoch) → fora
    ] });
    const w = new AbsenceAlert({ db, slack: { postAs: async () => {} }, channelId: 'C_OPS', enabled: true, thresholdMin: 15 });
    const absent = await w.findAbsent();
    expect(absent.map((a) => a.id)).toEqual([4]); // só o Vitor (22min, ref hoje)
  });
  test('tick → posta no canal dos operadores + registra action_log', async () => {
    const slack = { calls: [], postAs: async (m) => { slack.calls.push(m); } };
    const db = makeDb({ candidates: [{ id: 4, display_name: 'Vitor', idle_min: 22, ref: new Date() }] });
    const w = new AbsenceAlert({ db, slack, channelId: 'C_OPS', enabled: true, thresholdMin: 15 });
    const r = await w.tick();
    expect(r.sent).toBe(1);
    expect(slack.calls[0].channel).toBe('C_OPS');
    expect(slack.calls[0].text).toContain('Vitor');
    expect(slack.calls[0].text).toContain('22 min');
    expect(db.logs.some((l) => l.type === 'absence_alert')).toBe(true);
  });
  test('não re-alerta quem já foi avisado há pouco (dedup)', async () => {
    const slack = { calls: [], postAs: async (m) => { slack.calls.push(m); } };
    const db = makeDb({ candidates: [{ id: 4, display_name: 'Vitor', idle_min: 40, ref: new Date() }], recent: [4] });
    const w = new AbsenceAlert({ db, slack, channelId: 'C_OPS', enabled: true });
    expect((await w.tick()).sent).toBe(0);
    expect(slack.calls.length).toBe(0);
  });
  test('kill-switch OFF → não faz nada', async () => {
    const db = makeDb({ candidates: [{ id: 4, display_name: 'Vitor', idle_min: 40, ref: new Date() }] });
    const w = new AbsenceAlert({ db, slack: { postAs: async () => {} }, channelId: 'C_OPS', enabled: false });
    expect((await w.tick()).skipped).toBe(true);
  });
});
