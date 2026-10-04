'use strict';
/* TRAVA DE ACUSACAO (Bruno 10-04, caso Vitor): nenhum aviso que nomeie
 * funcionario sai no grupo sem o Bruno reagir ✅ na DM dele. */
const gate = require('../v3/accusation-gate');
const pw = require('../workers/punch-warning');

function fakeDb() {
  const calls = [];
  return { calls, query: async (sql, args) => { calls.push({ sql, args }); if (/INSERT INTO v3\.punch_occurrence/.test(sql)) return { rows: [{ id: 1 }] }; if (/SELECT COUNT/.test(sql)) return { rows: [{ n: 0 }] }; return { rows: [] }; } };
}

describe('accusation-gate', () => {
  test('holdForAdmin manda DM pro Bruno (nao pro admin-orin, nao pro grupo) e grava notificacao pendente', async () => {
    const db = fakeDb(); const dms = []; const posts = [];
    const slack = { postDm: async (o) => { dms.push(o); return { ts: '9.9', channel: 'D123' }; }, postAs: async (o) => { posts.push(o); return { ts: '1.1' }; } };
    const r = await gate.holdForAdmin({ db, slack, adminChannelId: 'CADMIN', productionChannelId: 'CGRUPO', kind: 'ponto', person: { id: 4, display_name: 'Vitor' }, groupText: 'VITOR, VOCE NAO BATEU', proof: 'batidas 8:15, 16:32' });
    expect(r.held).toBe(true);
    expect(dms).toHaveLength(1); expect(dms[0].userId).toBe('U03URLL1D4L'); expect(dms[0].text).toMatch(/AVISO RETIDO/); expect(dms[0].text).toMatch(/Prova: batidas/);
    expect(posts).toHaveLength(0);
    const ins = db.calls.find((c) => /INSERT INTO v3\.notifications/.test(c.sql));
    expect(JSON.parse(ins.args[0])).toMatchObject({ msg_ts: '9.9', channel: 'D123', target_channel: 'CGRUPO', group_text: 'VITOR, VOCE NAO BATEU' });
  });

  test('DM falhou → cai no admin-orin AVISANDO que a DM falhou (nunca no grupo)', async () => {
    const db = fakeDb(); const posts = [];
    const slack = { postDm: async () => { throw new Error('dm off'); }, postAs: async (o) => { posts.push(o); return { ts: '2.2' }; } };
    const r = await gate.holdForAdmin({ db, slack, adminChannelId: 'CADMIN', productionChannelId: 'CGRUPO', kind: 'ponto', person: { id: 4, display_name: 'Vitor' }, groupText: 'X' });
    expect(r.held).toBe(true); expect(posts).toHaveLength(1); expect(posts[0].channel).toBe('CADMIN'); expect(posts[0].text).toMatch(/DM do Bruno falhou/);
  });

  test('resolveHold ✅ posta o texto EXATO no grupo e carimba a ocorrencia', async () => {
    const db = fakeDb(); const posts = [];
    const slack = { postAs: async (o) => { posts.push(o); return { ts: '5.5' }; } };
    const n = { id: 77, payload: { target_channel: 'CGRUPO', group_text: 'TEXTO DO GRUPO', kind: 'ponto', person_id: 4, on_approve: { type: 'punch_occurrence', person_id: 4, occ_date: '2026-10-03' } } };
    const r = await gate.resolveHold({ db, slack, notification: n, approved: true, reactorSlackUserId: 'U03URLL1D4L' });
    expect(r.group_ts).toBe('5.5'); expect(posts[0]).toMatchObject({ channel: 'CGRUPO', text: 'TEXTO DO GRUPO' });
    expect(db.calls.some((c) => /SET notified_at=NOW\(\), notify_ts=\$3/.test(c.sql) && c.args[2] === '5.5')).toBe(true);
    expect(db.calls.some((c) => /UPDATE v3\.notifications SET status=\$2/.test(c.sql) && c.args[1] === 'admin_accepted')).toBe(true);
  });

  test('resolveHold ❌ nao posta nada e APAGA a ocorrencia', async () => {
    const db = fakeDb(); const posts = [];
    const slack = { postAs: async (o) => { posts.push(o); return { ts: '5.5' }; } };
    const n = { id: 78, payload: { target_channel: 'CGRUPO', group_text: 'TEXTO', kind: 'ponto', person_id: 4, on_approve: { type: 'punch_occurrence', person_id: 4, occ_date: '2026-10-03' } } };
    await gate.resolveHold({ db, slack, notification: n, approved: false, reactorSlackUserId: 'U03URLL1D4L' });
    expect(posts).toHaveLength(0);
    expect(db.calls.some((c) => /DELETE FROM v3\.punch_occurrence/.test(c.sql))).toBe(true);
    expect(db.calls.some((c) => /UPDATE v3\.notifications SET status=\$2/.test(c.sql) && c.args[1] === 'admin_rejected')).toBe(true);
  });

  test('recordAndWarn SEM trava nao acusa ninguem (e desfaz a ocorrencia)', async () => {
    const db = fakeDb();
    const r = await pw.recordAndWarn({ db, person: { id: 4, display_name: 'Vitor' }, missing: { out: true, detail: 'saida do dia' }, occDateISO: '2026-10-03' });
    expect(r.posted).toBe(false); expect(r.reason).toMatch(/sem trava/);
    expect(db.calls.some((c) => /DELETE FROM v3\.punch_occurrence/.test(c.sql))).toBe(true);
  });

  test('recordAndWarn COM trava: segura, nao posta, ocorrencia fica sem notified_at', async () => {
    const db = fakeDb(); let held = null;
    const r = await pw.recordAndWarn({ db, person: { id: 4, display_name: 'Vitor' }, missing: { out: true, detail: 'saida do dia' }, occDateISO: '2026-10-03',
      hold: async (h) => { held = h; return { held: true, msg_ts: '7.7' }; } });
    expect(r.held).toBe(true); expect(held.text).toMatch(/VITOR/i);
    expect(db.calls.some((c) => /SET notified_at=NOW\(\)/.test(c.sql))).toBe(false);
  });
});
