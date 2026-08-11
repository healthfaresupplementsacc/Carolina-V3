'use strict';
/* Bruno 07-18 — confirmação de auto-task do EMS: guard de presença + escalonamento
   + resposta autoritativa. Testa a LÓGICA pura contra um fake db (sem Postgres). */

const presence = require('../v3/presence');

describe('presence — fragmento SQL de presença real', () => {
  test('confirmedPresenceSQL: auto-task do EMS NUNCA prova presença sozinha', () => {
    const sql = presence.confirmedPresenceSQL('p');
    // exige: OU sessão hoje, OU evento hoje que NÃO seja ems_auto
    expect(sql).toContain('operator_sessions');
    expect(sql).toContain("e.source <> 'ems_auto'");
    // robusto: NÃO depende da linha em ems_unconfirmed (evita corrida)
    expect(sql).not.toContain('ems_unconfirmed');
  });
  test('usa o alias passado', () => {
    expect(presence.confirmedPresenceSQL('x')).toContain('x.id');
  });
});

describe('emsConfirm — lógica de resposta (fake db)', () => {
  const emsConfirm = require('../v3/ems-confirm');

  // fake db mínimo: registra queries e devolve respostas roteadas por regex
  function makeDb(routes) {
    const calls = [];
    return {
      calls,
      query: jest.fn(async (sql, params) => {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        for (const [re, rows] of routes) {
          if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(sql, params) : rows, rowCount: (typeof rows === 'function' ? rows(sql, params) : rows).length };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
  }

  test('applyAnswer "me" move o evento pro perguntador e marca reassigned', async () => {
    const unconf = { id: 1, event_id: 2354, subject_person_id: 7, batch_number: '0278', status: 'questionable' };
    const db = makeDb([
      [/FROM v3\.ems_unconfirmed WHERE id=/, [unconf]],
      [/FROM v3\.persons WHERE id=\$1/, (s, p) => [{ id: p[0], display_name: p[0] === 4 ? 'Vitor' : 'Bruno Sarmento' }]],
      [/SELECT \* FROM v3\.events WHERE id=/, [{ id: 2354, person_id: 7, description: 'x', bg_handoff_from_person_id: 4 }]],
      [/UPDATE v3\.events SET person_id/, []],
      [/INSERT INTO v3\.audit_log/, []],
      [/UPDATE v3\.ems_unconfirmed SET status='reassigned'/, []],
    ]);
    const r = await emsConfirm.applyAnswer(db, { unconfirmedId: 1, askerId: 4, answer: 'me' });
    expect(r.moved.length).toBe(1);
    expect(r.moved[0]).toEqual({ event_id: 2354, to: 4 });
    expect(r.to_person.id).toBe(4);
    // reatribuiu no events
    expect(db.calls.some((c) => /UPDATE v3\.events SET person_id/.test(c.sql) && c.params.includes(4))).toBe(true);
    // marcou reassigned
    expect(db.calls.some((c) => /status='reassigned'/.test(c.sql))).toBe(true);
  });

  test('applyAnswer "subject" confirma sem mover', async () => {
    const unconf = { id: 1, event_id: 2354, subject_person_id: 7, status: 'questionable' };
    const db = makeDb([
      [/FROM v3\.ems_unconfirmed WHERE id=/, [unconf]],
      [/FROM v3\.persons WHERE id=\$1/, (s, p) => [{ id: p[0], display_name: 'X' }]],
      [/UPDATE v3\.ems_unconfirmed SET status='confirmed'/, []],
    ]);
    const r = await emsConfirm.applyAnswer(db, { unconfirmedId: 1, askerId: 4, answer: 'subject' });
    expect(r.confirmedSubject).toBe(true);
    // NÃO tocou em events
    expect(db.calls.some((c) => /UPDATE v3\.events SET person_id/.test(c.sql))).toBe(false);
    expect(db.calls.some((c) => /status='confirmed'/.test(c.sql))).toBe(true);
  });

  test('applyAnswer já resolvido é idempotente', async () => {
    const db = makeDb([[/FROM v3\.ems_unconfirmed WHERE id=/, [{ id: 1, status: 'reassigned', subject_person_id: 7 }]]]);
    const r = await emsConfirm.applyAnswer(db, { unconfirmedId: 1, askerId: 4, answer: 'me' });
    expect(r.already).toBe(true);
  });

  test('skip adiciona o perguntador ao skipped_by (não repergunta)', async () => {
    const db = makeDb([[/UPDATE v3\.ems_unconfirmed/, []]]);
    await emsConfirm.skip(db, 1, 4);
    const c = db.calls.find((x) => /skipped_by/.test(x.sql));
    expect(c).toBeTruthy();
    expect(c.params).toContain(4);
  });
});
