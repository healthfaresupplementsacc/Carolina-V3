'use strict';
// HEALTHFARE V3 — PARTE 2.10 — testes comportamentais dos endpoints admin v3.
const r = require('../v3/admin-v3/routes');

function makeFakeDb(seed = {}) {
  const calls = [];
  return {
    calls,
    query: jest.fn((sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/FROM v3\.messages m LEFT JOIN v3\.persons/.test(s)) return Promise.resolve({ rows: seed.messagesShadow || [] });
      if (/COUNT\(\*\) c FROM v3\.events/.test(s)) return Promise.resolve({ rows: [{ c: (seed.events || []).length }] });
      if (/FROM v3\.events e LEFT JOIN/.test(s)) return Promise.resolve({ rows: seed.events || [] });
      if (/COUNT\(\*\) c FROM public\.tasks/.test(s)) return Promise.resolve({ rows: [{ c: seed.legacyTasks || 0 }] });
      if (/COUNT\(\*\) c FROM public\.phase_instances/.test(s)) return Promise.resolve({ rows: [{ c: seed.legacyPhases || 0 }] });
      if (/FROM v3\.vocabulary/.test(s)) {
        return Promise.resolve({ rows: (seed.vocab || []).filter((x) => x.occurrence_count >= 3 && !x.admin_confirmed) });
      }
      if (/SELECT llm_result, processing_error FROM v3\.messages/.test(s)) return Promise.resolve({ rows: seed.metricsRows || [] });
      if (/COUNT\(\*\) c FROM v3\.messages WHERE llm_processed_at IS NULL/.test(s)) return Promise.resolve({ rows: [{ c: seed.queueCount || 0 }] });
      if (/MAX\(llm_processed_at\)/.test(s)) return Promise.resolve({ rows: [{ mx: seed.lastProcessed || null }] });
      if (/COUNT\(\*\) c FROM v3\.messages WHERE processing_error/.test(s)) return Promise.resolve({ rows: [{ c: seed.errorCount || 0 }] });
      if (/FROM v3\.settings/.test(s)) return Promise.resolve({ rows: seed.settings || [] });
      return Promise.resolve({ rows: [] });
    }),
  };
}

const req = (query = {}) => ({ query: Object.assign({ pin: '510510' }, query), headers: {} });
const noPin = (query = {}) => ({ query, headers: {} });

describe('V3 §2.10 — auth PIN', () => {
  test('todos os endpoints rejeitam sem PIN (403)', async () => {
    const db = makeFakeDb();
    for (const slug of Object.keys(r.HANDLERS)) {
      const out = await r.HANDLERS[slug](noPin(), { db });
      expect(out.status).toBe(403);
    }
  });
  test('checkPin aceita o PIN certo, rejeita o errado', () => {
    expect(r.checkPin({ query: { pin: '510510' }, headers: {} })).toBe(true);
    expect(r.checkPin({ query: { pin: '000' }, headers: {} })).toBe(false);
    expect(r.checkPin({ query: {}, headers: { 'x-admin-pin': '510510' } })).toBe(true);
  });
});

describe('V3 §2.10 — messages-shadow', () => {
  test('lista mensagens com destaque de confiança', async () => {
    const db = makeFakeDb({
      messagesShadow: [{
        id: 1, slack_ts: '1.1', slack_user_id: 'U_PL', raw_text: 'comecei a linha',
        created_at: '2026-05-20T14:00:00Z', person_name: 'Ana',
        llm_result: { interpretation: 'Ana abriu linha', categorization: 'activity_start', confidence_overall: 'high', actions: [{ type: 'open_event' }] },
      }],
    });
    const out = await r.handleMessagesShadow(req(), { db });
    expect(out.status).toBe(200);
    expect(out.body).toContain('comecei a linha');
    expect(out.body).toContain('Ana abriu linha');
    expect(out.body).toContain('#16a34a'); // cor de confidence=high
  });

  test('limit e date são repassados pra query', async () => {
    const db = makeFakeDb();
    await r.handleMessagesShadow(req({ limit: '5', date: '2026-05-20' }), { db });
    const call = db.calls.find((c) => /FROM v3\.messages m LEFT JOIN/.test(c.sql));
    expect(call.params[0]).toBe(5);
    expect(call.params[1]).toBe('2026-05-20');
  });

  test('limit fora do range cai no default', async () => {
    const db = makeFakeDb();
    await r.handleMessagesShadow(req({ limit: '99999' }), { db });
    const call = db.calls.find((c) => /FROM v3\.messages m LEFT JOIN/.test(c.sql));
    expect(call.params[0]).toBe(200); // clamp no máx
  });
});

describe('V3 §2.10 — events-shadow / timeline', () => {
  test('events-shadow agrupa por pessoa', async () => {
    const db = makeFakeDb({
      events: [
        { id: 1, person_id: 6, person_name: 'Ana', activity: 'Formulação', started_at: '2026-05-20T10:00:00Z', ended_at: null, confidence: 'high', cowork_with: [] },
        { id: 2, person_id: 4, person_name: 'Vitor', activity: 'Mix', started_at: '2026-05-20T11:00:00Z', ended_at: '2026-05-20T12:00:00Z', confidence: 'medium', cowork_with: [6] },
      ],
    });
    const out = await r.handleEventsShadow(req(), { db });
    expect(out.status).toBe(200);
    expect(out.body).toContain('<h3>Ana</h3>');
    expect(out.body).toContain('<h3>Vitor</h3>');
    expect(out.body).toContain('ativo'); // event sem ended_at
  });

  test('timeline monta blocos por pessoa', async () => {
    const db = makeFakeDb({
      events: [{ person_id: 6, person_name: 'Ana', activity: 'Limpeza', started_at: '2026-05-20T09:30:00Z', ended_at: null, cowork_with: [] }],
    });
    const out = await r.handleTimeline(req({ date: '2026-05-20' }), { db });
    expect(out.status).toBe(200);
    expect(out.body).toContain('<h3>Ana</h3>');
    expect(out.body).toContain('09:30 Limpeza');
  });
});

describe('V3 §2.10 — divergences', () => {
  test('marca V3-only e mostra contagens V3 vs legado', async () => {
    const db = makeFakeDb({
      events: [{ started_at: '2026-05-20T10:00:00Z', person_name: 'Ana', activity: 'Formulação' }],
      legacyTasks: 0, legacyPhases: 0,
    });
    const out = await r.handleDivergences(req({ date: '2026-05-20' }), { db });
    expect(out.status).toBe(200);
    expect(out.body).toContain('V3-only');
    expect(out.body).toMatch(/V3 criou/);
  });
});

describe('V3 §2.10 — vocabulary-pending', () => {
  test('filtra occurrence_count >= 3 e não-confirmados', async () => {
    const db = makeFakeDb({
      vocab: [
        { term: 'fita', occurrence_count: 5, admin_confirmed: false, meaning: 'etiqueta' },
        { term: 'raro', occurrence_count: 2, admin_confirmed: false }, // <3 → fora
        { term: 'confirmado', occurrence_count: 9, admin_confirmed: true }, // confirmado → fora
      ],
    });
    const out = await r.handleVocabularyPending(req(), { db });
    expect(out.status).toBe(200);
    expect(out.body).toContain('fita');
    expect(out.body).not.toContain('raro');
    expect(out.body).not.toContain('confirmado');
  });
});

describe('V3 §2.10 — llm-metrics', () => {
  test('agrega total, custo, confiança e erros', async () => {
    const db = makeFakeDb({
      metricsRows: [
        { llm_result: { confidence_overall: 'high', categorization: 'activity_start', cost_estimate_usd: 0.002 }, processing_error: null },
        { llm_result: { confidence_overall: 'medium', categorization: 'note', cost_estimate_usd: 0.001 }, processing_error: null },
        { llm_result: null, processing_error: 'llm_error: x' },
      ],
    });
    const out = await r.handleLlmMetrics(req(), { db });
    expect(out.status).toBe(200);
    expect(out.body).toMatch(/Processadas:\s*<span class="big">2</);
    expect(out.body).toMatch(/Erros\/retry:\s*<b>1</);
    expect(out.body).toContain('$0.0030'); // custo total
    expect(out.body).toContain('high: <b>1</b>');
  });
});

describe('V3 §2.10 — health', () => {
  test('reporta fila, última processada e worker status', async () => {
    const db = makeFakeDb({
      queueCount: 4, errorCount: 1,
      lastProcessed: new Date(Date.now() - 2 * 60000).toISOString(), // 2 min atrás → ativo
      settings: [{ key: 'llm_provider', value: 'anthropic' }, { key: 'llm_observer_mode', value: 'shadow' }],
    });
    const out = await r.handleHealth(req(), { db });
    expect(out.status).toBe(200);
    expect(out.body).toContain('ativo');
    expect(out.body).toMatch(/Fila.*<span class="big">4</);
    expect(out.body).toContain('anthropic');
    expect(out.body).toContain('shadow');
  });

  test('worker sem processar há muito → marcado inativo', async () => {
    const db = makeFakeDb({
      lastProcessed: new Date(Date.now() - 60 * 60000).toISOString(), // 1h atrás
    });
    const out = await r.handleHealth(req(), { db });
    expect(out.body).toContain('🔴');
  });
});

describe('V3 §2.10 — read-only', () => {
  test('nenhum endpoint emite INSERT/UPDATE/DELETE', async () => {
    const db = makeFakeDb({ events: [{ person_id: 6, person_name: 'Ana', started_at: '2026-05-20T10:00:00Z', activity: 'X', cowork_with: [] }] });
    for (const slug of Object.keys(r.HANDLERS)) {
      await r.HANDLERS[slug](req({ date: '2026-05-20' }), { db });
    }
    expect(db.calls.every((c) => !/\b(INSERT|UPDATE|DELETE)\b/i.test(c.sql))).toBe(true);
  });
});
