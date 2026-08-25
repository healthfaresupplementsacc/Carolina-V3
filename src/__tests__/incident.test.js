'use strict';
/* Pipeline de incidente (Bruno 08-25). Três coisas, sempre: linha no banco,
   dossiê em Markdown com os dados crus, UMA mensagem no admin-orin no formato
   exato que ele pediu. E tem que funcionar nos DOIS mundos: a máquina do Bruno
   (que tem o G: do Obsidian) e o Railway (que não tem). */
const {
  openIncident, resolveIncident, flushDossiers,
  buildDossier, buildSlackText, dossierName,
} = require('../v3/health/incident');

/** Banco falso que grava o que foi inserido/atualizado. */
function makeDb(opts = {}) {
  const db = { inserts: [], updates: [], rows: opts.rows || [] };
  db.query = async (sql, params) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/INSERT INTO v3\.incidents/.test(s)) {
      db.inserts.push({ code: params[0], title: params[1], detail: JSON.parse(params[2]), path: params[3] });
      return { rows: [{ id: 77 }], rowCount: 1 };
    }
    if (/UPDATE v3\.incidents SET slack_ts/.test(s)) {
      db.updates.push({ kind: 'slack_ts', id: params[0], ts: params[1] });
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE v3\.incidents SET status = 'resolved'/.test(s)) {
      db.updates.push({ kind: 'resolve', code: params[0] });
      return { rows: [{ id: 77 }], rowCount: 1 };
    }
    if (/SELECT id, code, dossier_path/.test(s)) return { rows: db.rows, rowCount: db.rows.length };
    if (/UPDATE v3\.incidents SET detail/.test(s) || /- 'dossier_md'/.test(s)) {
      db.updates.push({ kind: 'flushed', id: params[0] });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return db;
}
const mkSlack = () => { const s = { calls: [], postAs: async (m) => { s.calls.push(m); return { ok: true, ts: '17.9' }; } }; return s; };

/** fs falso da máquina que TEM o G: */
function makeFs() {
  const fs = { files: {}, dirs: [] };
  fs.mkdirSync = (d) => { fs.dirs.push(d); };
  fs.writeFileSync = (p, c) => { fs.files[p] = c; };
  return fs;
}

const INC = {
  code: 'signal_machine_state',
  title: 'Sinal parado: Câmera das máquinas (.28)',
  oneLine: 'Câmera das máquinas (.28) parou de mandar sinal desde as 19:39, já são 42h sem nada.',
  detail: { signal: 'machine_state', age_min: 2520, last_at: '2026-08-23T23:39:15Z' },
  fix_hint: 'Conferir no PC .28 se o machinemon está rodando.',
  dossier: {
    o_que_aconteceu: 'A câmera do .28 deixou de mandar estado de máquina.',
    desde: '19:39 (2026-08-23T23:39:15Z)',
    esperado: 'Sinal novo a cada 10 minutos no máximo.',
    observado: 'Último sinal 42h atrás.',
    afeta: ['O alarme da encapsulação fica cego e pode gritar falso.'],
    dados_crus: { payload: { machines: [{ name: 'Production Line', moving: true, running: true }], at: '2026-08-23T23:39:15Z' } },
  },
};

describe('incident — linha no banco', () => {
  test('grava code, title e o caminho pretendido do dossiê', async () => {
    const db = makeDb();
    await openIncident({ db, slack: mkSlack(), channelId: 'C_ADMIN' }, INC);
    expect(db.inserts.length).toBe(1);
    expect(db.inserts[0].code).toBe('signal_machine_state');
    expect(db.inserts[0].title).toMatch(/Câmera das máquinas/);
    expect(db.inserts[0].path).toMatch(/Obsidian Bruno/);
    expect(db.inserts[0].path).toMatch(/Incidentes/);
    expect(db.inserts[0].path).toMatch(/\.md$/);
  });

  test('guarda o slack_ts da mensagem postada', async () => {
    const db = makeDb(); const slack = mkSlack();
    const r = await openIncident({ db, slack, channelId: 'C_ADMIN' }, INC);
    expect(r.slack_ts).toBe('17.9');
    expect(db.updates.some((u) => u.kind === 'slack_ts' && u.ts === '17.9')).toBe(true);
  });

  test('Slack fora do ar NÃO derruba o incidente (a linha fica gravada)', async () => {
    const db = makeDb();
    const slack = { postAs: async () => { throw new Error('slack down'); } };
    const r = await openIncident({ db, slack, channelId: 'C_ADMIN' }, INC);
    expect(db.inserts.length).toBe(1);
    expect(r.slack_ts).toBe(null);
  });
});

describe('incident — dossiê em Markdown', () => {
  test('contém as seções em PT-BR e embute o payload CRU', () => {
    const md = buildDossier(INC, new Date('2026-08-25T18:00:00Z'));
    expect(md).toContain('## O que aconteceu');
    expect(md).toContain('## O que o sistema esperava');
    expect(md).toContain('## O que o sistema viu de verdade');
    expect(md).toContain('## O que isso afeta');
    expect(md).toContain('## Primeira coisa a conferir');
    expect(md).toContain('## Dados crus');
    // o payload real do .28, inteiro, dentro do bloco json
    expect(md).toContain('Production Line');
    expect(md).toContain('2026-08-23T23:39:15Z');
    expect(md).toContain('```json');
    expect(md).toContain('o alarme da encapsulação'.replace('o alarme', 'O alarme'));
  });

  test('nome do arquivo é "YYYY-MM-DD HHmm - codigo.md", com hífen simples', () => {
    const n = dossierName('signal_machine_state', new Date('2026-08-25T18:04:00Z'));
    expect(n).toMatch(/^\d{4}-\d{2}-\d{2} \d{4} - signal_machine_state\.md$/);
    // o nome entra na mensagem do Slack, então não pode carregar em dash
    expect(n).not.toMatch(/—/);
  });

  test('payload não serializável não derruba o dossiê', () => {
    const circ = {}; circ.self = circ;
    const md = buildDossier({ code: 'x', title: 'T', detail: circ, dossier: {} }, new Date());
    expect(md).toContain('## Dados crus');
  });
});

describe('incident — os dois mundos (G: presente vs Railway)', () => {
  test('COM fs (máquina do Bruno): escreve o arquivo de verdade', async () => {
    const db = makeDb(); const fs = makeFs();
    const r = await openIncident({ db, slack: mkSlack(), channelId: 'C_ADMIN', fs }, INC);
    expect(r.dossier_written).toBe(true);
    const paths = Object.keys(fs.files);
    expect(paths.length).toBe(1);
    expect(fs.files[paths[0]]).toContain('## Dados crus');
    // como o arquivo existe, o markdown NÃO precisa ficar pendurado no banco
    expect(db.inserts[0].detail.dossier_md).toBeUndefined();
    expect(db.inserts[0].detail.dossier_pending).toBe(false);
  });

  test('SEM fs (Railway): degrada guardando o markdown inteiro na linha', async () => {
    const db = makeDb();
    const r = await openIncident({ db, slack: mkSlack(), channelId: 'C_ADMIN', fs: null }, INC);
    expect(r.dossier_written).toBe(false);
    expect(db.inserts[0].detail.dossier_pending).toBe(true);
    expect(typeof db.inserts[0].detail.dossier_md).toBe('string');
    expect(db.inserts[0].detail.dossier_md).toContain('Production Line');
    // e o caminho PRETENDIDO fica gravado, pro flush achar depois
    expect(db.inserts[0].path).toMatch(/Incidentes/);
  });

  test('fs que EXPLODE (sem permissão) também degrada pro banco, sem lançar', async () => {
    const db = makeDb();
    const fs = { mkdirSync: () => {}, writeFileSync: () => { throw new Error('EACCES'); } };
    const r = await openIncident({ db, slack: mkSlack(), channelId: 'C_ADMIN', fs }, INC);
    expect(r.dossier_written).toBe(false);
    expect(db.inserts[0].detail.dossier_md).toContain('## Dados crus');
  });

  test('flushDossiers grava os pendentes quando a máquina tem o vault', async () => {
    const db = makeDb({ rows: [
      { id: 1, code: 'signal_machine_state', dossier_path: 'G:\\v\\Incidentes\\a.md', md: '# um', file: 'a.md' },
      { id: 2, code: 'signal_ems_sync', dossier_path: 'G:\\v\\Incidentes\\b.md', md: '# dois', file: 'b.md' },
    ] });
    const fs = makeFs();
    const r = await flushDossiers({ db, fs });
    expect(r.written).toBe(2);
    expect(fs.files['G:\\v\\Incidentes\\a.md']).toBe('# um');
    expect(fs.files['G:\\v\\Incidentes\\b.md']).toBe('# dois');
    // e marca como gravado, pra rodar duas vezes não reescrever
    expect(db.updates.filter((u) => u.kind === 'flushed').length).toBe(2);
  });

  test('flushDossiers sem fs não faz nada (e não quebra)', async () => {
    const db = makeDb({ rows: [{ id: 1, code: 'x', dossier_path: 'p', md: '# a', file: 'a.md' }] });
    const r = await flushDossiers({ db, fs: null });
    expect(r.written).toBe(0);
    expect(r.skipped).toBeTruthy();
  });
});

describe('incident — a mensagem do Slack, no formato do Bruno', () => {
  test('estrutura exata: alarme, uma linha, "Claude já está trabalhando nisso", Obsidian', async () => {
    const db = makeDb(); const slack = mkSlack();
    await openIncident({ db, slack, channelId: 'C_ADMIN' }, INC);
    expect(slack.calls.length).toBe(1);
    const t = slack.calls[0].text;
    const lines = t.split('\n');
    expect(lines[0]).toBe(':rotating_light: *Sinal parado: Câmera das máquinas (.28)*');
    expect(lines[1]).toBe(INC.oneLine);
    expect(lines[2]).toBe('Claude já está trabalhando nisso.');
    expect(lines[3]).toMatch(/^Detalhes completos no Obsidian: Incidentes\/.+\.md$/);
    expect(lines[4]).toMatch(/^Primeira coisa a conferir: /);
  });

  test('vai pro canal ADMIN, nunca pro canal dos operadores', async () => {
    const db = makeDb(); const slack = mkSlack();
    await openIncident({ db, slack, channelId: 'C0B36DR5MP1' }, INC);
    expect(slack.calls[0].channel).toBe('C0B36DR5MP1');
    expect(slack.calls[0].channel).not.toBe('C09UNBXFRKK');
  });

  test('SEM em dash e com no máximo 1 emoji', async () => {
    const db = makeDb(); const slack = mkSlack();
    await openIncident({ db, slack, channelId: 'C_ADMIN' }, INC);
    const t = slack.calls[0].text;
    expect(t).not.toMatch(/—/);          // em dash proibido (memória do Bruno)
    expect(t).not.toMatch(/–/);          // en dash também
    expect((t.match(/:[a-z_]+:/g) || []).length).toBe(1);
  });

  test('NÃO afirma que o Claude consertou nada, só que está trabalhando', () => {
    const t = buildSlackText({ title: 'T', oneLine: 'algo parou', fileName: 'x.md', fixHint: null });
    expect(t).toContain('Claude já está trabalhando nisso.');
    expect(t).not.toMatch(/consert|resolvid|corrigid/i);
  });
});

describe('incident — fechamento', () => {
  test('resolveIncident marca o mais recente daquele código como resolved', async () => {
    const db = makeDb();
    const n = await resolveIncident({ db }, 'signal_machine_state', 'sinal voltou');
    expect(n).toBe(1);
    expect(db.updates.some((u) => u.kind === 'resolve' && u.code === 'signal_machine_state')).toBe(true);
  });
});
