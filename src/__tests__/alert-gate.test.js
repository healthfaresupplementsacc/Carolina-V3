'use strict';
/* Alert Gate (Bruno 07-05): kill-switch dos avisos + presença + parser PT. */
const g = require('../v3/alert-gate');

// Domingo 2026-07-05 19:00 EDT (23:00Z). Segunda 07-06 07:00 EDT = 11:00Z.
const NOW = Date.parse('2026-07-05T23:00:00Z');

function makeDb(rows = {}) {
  const store = { ...rows }; const calls = [];
  return {
    calls, store,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ s, params });
      if (/SELECT value FROM v3\.settings WHERE key = \$1/.test(s)) {
        return store[params[0]] !== undefined ? { rows: [{ value: store[params[0]] }] } : { rows: [] };
      }
      if (/INSERT INTO v3\.settings/.test(s)) { store[params[0]] = JSON.parse(params[1]); return { rows: [] }; }
      if (/DELETE FROM v3\.settings WHERE key = \$1/.test(s)) { delete store[params[0]]; return { rows: [] }; }
      if (/AS present/.test(s)) { return { rows: [{ present: store.__present !== undefined ? store.__present : true }] }; }
      return { rows: [] };
    },
  };
}

describe('parseMuteCommand — mute/unmute/status/durações', () => {
  const P = (t) => g.parseMuteCommand(t, NOW);
  test('mute simples e variações', () => {
    for (const t of ['pausa os avisos', 'pausar avisos', 'muta os avisos', 'silêncio', 'chega de aviso', 'para de avisar', 'stop alerts', 'pausa até segunda'])
      expect(P(t).action).toBe('mute');
  });
  test('unmute', () => {
    for (const t of ['voltar avisos', 'religa os avisos', 'pode avisar', 'unmute', 'voltar a avisar', 'reativar avisos'])
      expect(P(t).action).toBe('unmute');
  });
  test('status (perguntas não mutam)', () => {
    for (const t of ['status dos avisos', 'os avisos estão pausados?', 'avisos ativos?'])
      expect(P(t).action).toBe('status');
  });
  test('NÃO dispara em conversa normal nem em "pausa a linha/máquina/lote"', () => {
    for (const t of ['bom dia pessoal', 'Henrique define meta 500 FBA', 'pausa a linha de produção', 'pausa a máquina', 'pausa o lote 0249', 'BR-2026-0244 YOHIMBINE 600 FBA'])
      expect(P(t).action).toBe(null);
  });
  test('duração "por 2 horas" e "por 30 min"', () => {
    expect(P('muta os avisos por 2 horas').untilMs).toBe(NOW + 2 * 3600e3);
    expect(P('pausa os avisos por 30 min').untilMs).toBe(NOW + 30 * 60e3);
  });
  test('default (sem duração) = próxima 07:00 NY (amanhã de manhã)', () => {
    expect(P('pausa os avisos').untilMs).toBe(Date.parse('2026-07-06T11:00:00Z'));
  });
  test('"até amanhã" = 07:00 NY do dia seguinte', () => {
    expect(P('pausa os avisos até amanhã').untilMs).toBe(Date.parse('2026-07-06T11:00:00Z'));
  });
  test('texto longo (conversa) é ignorado', () => {
    expect(P('pessoal só pra avisar que amanhã vou pausar um pouco a produção de manhã porque tem manutenção e não sei quanto tempo vai levar então').action).toBe(null);
  });

  // ── Regressão da auditoria adversarial 07-05 (12 agentes) ──
  test('FALSOS-POSITIVOS que o adversarial pegou → agora null', () => {
    for (const t of [
      'pausa ai', 'pausa ai deixa eu ver uma coisa', 'pausa um pouco', 'pausar tudo',
      'muta ele', 'muta o audio dele na call', 'silencia esse povo', 'silencia o telefone',
      'suspende ele do canal', 'suspende esse fornecedor', 'pausa a musica',
      'pausa', 'suspende', 'pausa a linha de produção', 'pausa o lote 0249',
      'volta a avisar o pessoal da limpeza', 'volta a avisar quando tiver novidade',
      'para de avisar o Henrique toda hora', 'para de me avisar sobre isso', 'para de ficar avisando toda hora',
      'manda um alerta para o Joao',
    ]) expect(P(t).action).toBe(null);
  });
  test('FALSOS-NEGATIVOS que o adversarial pegou → agora mute', () => {
    for (const t of ['para os alertas', 'para os avisos por enquanto', 'desativa os alertas',
      'corta os avisos', 'tira os avisos', 'nao avisa mais hoje', 'nao avisa mais', 'sem avisos hoje', 'desliga os avisos'])
      expect(P(t).action).toBe('mute');
  });
  test('"para de silenciar/mutar os avisos" = RELIGAR (não mutar de novo)', () => {
    expect(P('para de silenciar os avisos').action).toBe('unmute');
    expect(P('para de mutar os avisos').action).toBe('unmute');
  });
  test('verbo ambíguo só muta COM duração explícita', () => {
    expect(P('pausa').action).toBe(null);
    expect(P('pausa até segunda').action).toBe('mute');
    expect(P('pausa por 2h').action).toBe('mute');
    expect(P('pausa um pouco').action).toBe(null); // "um pouco" não é duração
  });
});

describe('estado do mute (v3.settings)', () => {
  test('setMute grava e isMuted respeita o prazo', async () => {
    const db = makeDb();
    await g.setMute(db, { untilMs: NOW + 3600e3, reason: 'teste', by: 'U1' });
    expect(await g.isMuted(db, NOW)).toBe(true);
    expect(await g.isMuted(db, NOW + 2 * 3600e3)).toBe(false); // já expirou
  });
  test('clearMute remove', async () => {
    const db = makeDb();
    await g.setMute(db, { untilMs: NOW + 3600e3 });
    await g.clearMute(db);
    expect(await g.isMuted(db, NOW)).toBe(false);
    expect(await g.getMute(db)).toBe(null);
  });
  test('sem setting → não mutado; erro de db → não bloqueia', async () => {
    expect(await g.isMuted(makeDb(), NOW)).toBe(false);
    const boom = { query: async () => { throw new Error('db down'); } };
    expect(await g.isMuted(boom, NOW)).toBe(false); // fail-open
  });
  test('aceita value legado como string ISO', async () => {
    const db = makeDb({ operator_alerts_muted_until: new Date(NOW + 3600e3).toISOString() });
    expect(await g.isMuted(db, NOW)).toBe(true);
  });
});

describe('anyonePresent', () => {
  test('true quando o SQL diz present', async () => {
    expect(await g.anyonePresent(makeDb({ __present: true }))).toBe(true);
  });
  test('false quando ninguém logado nem task aberta', async () => {
    expect(await g.anyonePresent(makeDb({ __present: false }))).toBe(false);
  });
});

describe('helpers de timezone', () => {
  test('nyOffsetMs em julho = -4h (EDT)', () => {
    expect(g.nyOffsetMs(NOW)).toBe(-4 * 3600e3);
  });
  test('nextNyHour(7) a partir de 19:00 dom = 07:00 seg', () => {
    expect(g.nextNyHour(NOW, 7)).toBe(Date.parse('2026-07-06T11:00:00Z'));
  });
});
