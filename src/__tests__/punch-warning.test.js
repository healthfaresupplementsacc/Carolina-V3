'use strict';
/* Aviso de ponto do DIA SEGUINTE (Bruno 09-28): escala de 30 dias + mensagem
   MAIÚSCULA/negrito + 1 ocorrência por pessoa/dia. Se alguém mexer na escala
   (1–2 dia · 3 semana · 4–5 +semanas · 6+ reunião + 2 meses), isto acusa. */
const pw = require('../workers/punch-warning');

describe('punch-warning — escala de 30 dias', () => {
  test('pickLevel segue a tabela do Bruno', () => {
    expect(pw.pickLevel(0)).toBe(0);
    expect(pw.pickLevel(1)).toBe(1);
    expect(pw.pickLevel(2)).toBe(2);
    expect(pw.pickLevel(3)).toBe(3);
    expect(pw.pickLevel(4)).toBe(4);
    expect(pw.pickLevel(5)).toBe(5);
    expect(pw.pickLevel(6)).toBe(6);
    expect(pw.pickLevel(11)).toBe(6);   // 6 ou mais = nível máximo
  });

  test('mensagem: MAIÚSCULA, negrito (*...*), sem emoji, cita o dia e o que faltou', () => {
    const p = { display_name: 'Vitor HealthFare' };
    const m1 = pw.composeMessage(p, { in: true, out: false, detail: 'volta do almoco' }, 1, '2026-09-27');
    expect(m1.startsWith('*')).toBe(true);
    expect(m1.endsWith('*')).toBe(true);
    expect(m1).toContain('VITOR, NAO ENCONTRAMOS REGISTRO DA BATIDA DE VOLTA DO ALMOCO DE ONTEM (27/09).');
    expect(m1).toContain('BENEFICIO DESTE DIA FOI REMOVIDO');
    expect(m1).toBe(m1.toUpperCase());            // tudo maiúsculo
    expect(m1).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u); // sem emoji
    expect(m1).not.toContain('—');                  // sem travessão
  });

  test('cada nível diz a punição certa', () => {
    const p = { display_name: 'Ana' };
    const miss = { in: false, out: true, detail: 'saida do dia' };
    expect(pw.composeMessage(p, miss, 2, '2026-09-27')).toContain('2a OCORRENCIA EM 30 DIAS. O BENEFICIO DESTE DIA FOI REMOVIDO. NA PROXIMA, A PERDA PASSA A SER DA SEMANA INTEIRA');
    expect(pw.composeMessage(p, miss, 3, '2026-09-27')).toContain('3a OCORRENCIA EM 30 DIAS. A PARTIR DE AGORA O BENEFICIO DA SEMANA INTEIRA FOI REMOVIDO');
    expect(pw.composeMessage(p, miss, 4, '2026-09-27')).toContain('4a OCORRENCIA EM 30 DIAS. O BENEFICIO DESTA SEMANA E DA SEMANA SEGUINTE FOI REMOVIDO');
    expect(pw.composeMessage(p, miss, 5, '2026-09-27')).toContain('5a OCORRENCIA EM 30 DIAS. MAIS UMA SEMANA DE BENEFICIO FOI REMOVIDA');
    expect(pw.composeMessage(p, miss, 6, '2026-09-27')).toContain('6a OCORRENCIA EM 30 DIAS. UMA REUNIAO COM VOCE FOI REQUERIDA E OS BENEFICIOS FICAM SUSPENSOS POR 2 MESES');
  });

  test('sexta cobrada na segunda diz o dia, não "ontem"', () => {
    const m = pw.composeMessage({ display_name: 'Larissa Barbosa' }, { in: true, out: true, detail: 'entrada da manha e saida do dia' }, 1, '2026-09-25', 'SEXTA-FEIRA');
    expect(m).toContain('DE SEXTA-FEIRA (25/09)');
    expect(m).toContain('ENTRADA DA MANHA E SAIDA DO DIA');
  });
});

describe('punch-warning — recordAndWarn (1 ocorrência por pessoa/dia)', () => {
  function makeDb({ existing = false, before = 0 } = {}) {
    const mem = { inserted: [], updated: [] };
    const db = {
      mem,
      query: jest.fn(async (sql, params) => {
        const s = String(sql).replace(/\s+/g, ' ');
        if (/SELECT id FROM v3\.punch_occurrence WHERE person_id/.test(s)) return { rows: existing ? [{ id: 1 }] : [] };
        if (/SELECT COUNT\(\*\)::int AS n FROM v3\.punch_occurrence/.test(s)) return { rows: [{ n: before }] };
        if (/INSERT INTO v3\.punch_occurrence/.test(s)) { mem.inserted.push(params); return { rows: [{ id: 7 }] }; }
        if (/UPDATE v3\.punch_occurrence SET notified_at/.test(s)) { mem.updated.push(params); return { rows: [] }; }
        return { rows: [] };
      }),
    };
    return db;
  }
  const person = { id: 4, display_name: 'Vitor' };
  const missing = { in: false, out: true, detail: 'saida do dia' };

  test('primeira falta em 30 dias → nível 1, posta e registra o ts', async () => {
    const db = makeDb({ before: 0 });
    const posted = [];
    const r = await pw.recordAndWarn({ db, person, missing, occDateISO: '2026-09-27', postOperators: async (t) => { posted.push(t); return '111.222'; } });
    expect(r.posted).toBe(true);
    expect(r.level).toBe(1);
    expect(r.count30).toBe(1);
    expect(posted).toHaveLength(1);
    expect(db.mem.inserted[0][6]).toBe(1);           // level gravado
    expect(db.mem.updated[0][1]).toBe('111.222');    // notify_ts
  });

  test('terceira falta em 30 dias → nível 3 (semana inteira)', async () => {
    const db = makeDb({ before: 2 });
    const r = await pw.recordAndWarn({ db, person, missing, occDateISO: '2026-09-27', postOperators: async () => 'x' });
    expect(r.level).toBe(3);
    expect(r.text).toContain('SEMANA INTEIRA');
  });

  test('já registrado pra esse dia → não posta de novo (idempotente)', async () => {
    const db = makeDb({ existing: true });
    const posted = [];
    const r = await pw.recordAndWarn({ db, person, missing, occDateISO: '2026-09-27', postOperators: async (t) => { posted.push(t); return 'x'; } });
    expect(r.posted).toBe(false);
    expect(posted).toHaveLength(0);
    expect(db.mem.inserted).toHaveLength(0);
  });
});
