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
      // overview: mensagens do dia (NY)
      if (/FROM v3\.messages m WHERE \(m\.created_at AT TIME ZONE/.test(s)) return Promise.resolve({ rows: seed.dayMessages || [] });
      // overview: produção do dia
      if (/FROM v3\.production_counts pc JOIN/.test(s)) return Promise.resolve({ rows: seed.dayCounts || [] });
      // overview: lotes ativos
      if (/FROM v3\.product_batches pb JOIN/.test(s)) return Promise.resolve({ rows: seed.activeBatches || [] });
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

describe('V3 — overview (dashboard temporário)', () => {
  const fakeBatchSvc = {
    getSummary: jest.fn(async () => ({
      people: [{ person_id: 6, display_name: 'Ana' }, { person_id: 4, display_name: 'Vitor' }],
      total_seconds: 3720, // 1h 2m
    })),
  };

  test('responde 200 com auth e renderiza as 6 seções', async () => {
    const db = makeFakeDb({
      dayMessages: [{ created_at: '2026-05-21T14:00:00Z', slack_user_id: 'U_PL', raw_text: 'oi',
        llm_result: { confidence_overall: 'high' }, llm_processed_at: '2026-05-21T14:00:05Z' }],
      events: [{ person_id: 6, person_name: 'Ana', activity: 'Formulação', category: 'production_phase',
        started_at: '2026-05-21T10:00:00Z', ended_at: null, cowork_with: [] }],
    });
    const out = await r.handleOverview(req({ date: '2026-05-21' }), { db });
    expect(out.status).toBe(200);
    expect(out.body).toContain('Resumo do dia');
    expect(out.body).toContain('Timeline por pessoa');
    expect(out.body).toContain('Produção do dia');
    expect(out.body).toContain('Lotes ativos');
    expect(out.body).toContain('Distribuição de confiança');
    expect(out.body).toContain('Atenção');
    expect(out.body).toContain('http-equiv="refresh"'); // auto-refresh 60s
  });

  test('rejeita sem PIN (403)', async () => {
    const out = await r.handleOverview(noPin({ date: '2026-05-21' }), { db: makeFakeDb() });
    expect(out.status).toBe(403);
  });

  test('?date é repassado pra todas as queries do dia', async () => {
    const db = makeFakeDb();
    await r.handleOverview(req({ date: '2026-05-19' }), { db });
    const msgCall = db.calls.find((c) => /FROM v3\.messages m WHERE \(m\.created_at AT TIME ZONE/.test(c.sql));
    const evCall = db.calls.find((c) => /FROM v3\.events e LEFT JOIN/.test(c.sql));
    const pcCall = db.calls.find((c) => /FROM v3\.production_counts pc JOIN/.test(c.sql));
    expect(msgCall.params[0]).toBe('2026-05-19');
    expect(evCall.params[0]).toBe('2026-05-19');
    expect(pcCall.params[0]).toBe('2026-05-19');
  });

  test('cards calculam mensagens, events, %alta+média e custo', async () => {
    const db = makeFakeDb({
      dayMessages: [
        { created_at: '2026-05-21T14:00:00Z', slack_user_id: 'A', raw_text: 'a',
          llm_result: { confidence_overall: 'high', cost_estimate_usd: 0.01 }, llm_processed_at: 'x' },
        { created_at: '2026-05-21T14:01:00Z', slack_user_id: 'B', raw_text: 'b',
          llm_result: { confidence_overall: 'medium', cost_estimate_usd: 0.02 }, llm_processed_at: 'x' },
        { created_at: '2026-05-21T14:02:00Z', slack_user_id: 'C', raw_text: 'c',
          llm_result: { confidence_overall: 'low', cost_estimate_usd: 0.03 }, llm_processed_at: 'x' },
      ],
      events: [
        { person_id: 6, person_name: 'Ana', activity: 'Mix', category: 'production_phase',
          started_at: '2026-05-21T10:00:00Z', ended_at: null, cowork_with: [] },
        { person_id: 4, person_name: 'Vitor', activity: 'Mix', category: 'production_phase',
          started_at: '2026-05-21T11:00:00Z', ended_at: null, cowork_with: [] },
      ],
    });
    const out = await r.handleOverview(req({ date: '2026-05-21' }), { db });
    expect(out.body).toMatch(/Mensagens lidas<\/div><div class="big">3</);
    expect(out.body).toMatch(/Events criados<\/div><div class="big">2</);
    expect(out.body).toMatch(/<div class="big">67%/); // 2 de 3 = high+medium
    expect(out.body).toContain('$0.0600'); // custo somado
  });

  test('seção Atenção filtra low/unconfirmed/unclear e exclui high', async () => {
    const db = makeFakeDb({
      dayMessages: [
        { created_at: '2026-05-21T14:00:00Z', slack_user_id: 'A', raw_text: 'MSG_ALTA_OK',
          llm_result: { confidence_overall: 'high', categorization: 'activity_start' }, llm_processed_at: 'x' },
        { created_at: '2026-05-21T14:01:00Z', slack_user_id: 'B', raw_text: 'MSG_BAIXA_REVISAR',
          llm_result: { confidence_overall: 'low', categorization: 'note' }, llm_processed_at: 'x' },
        { created_at: '2026-05-21T14:02:00Z', slack_user_id: 'C', raw_text: 'MSG_UNCLEAR_REVISAR',
          llm_result: { confidence_overall: 'medium', categorization: 'unclear' }, llm_processed_at: 'x' },
      ],
    });
    const out = await r.handleOverview(req({ date: '2026-05-21' }), { db });
    expect(out.body).toContain('MSG_BAIXA_REVISAR');     // low → entra
    expect(out.body).toContain('MSG_UNCLEAR_REVISAR');   // unclear → entra
    expect(out.body).not.toContain('MSG_ALTA_OK');       // high + não-unclear → fora
  });

  test('seção Produção e Lotes ativos renderizam (getSummary com dedup cowork)', async () => {
    const db = makeFakeDb({
      dayCounts: [
        { bottles: 684, reported_at: '2026-05-21T20:00:00Z', confidence: 'high',
          product: 'Vitamin B2', batch_number: '0142', reporter: 'Ana' },
        { bottles: 300, reported_at: '2026-05-21T21:00:00Z', confidence: 'high',
          product: 'Vitamin B2', batch_number: '0142', reporter: 'Ana' },
      ],
      activeBatches: [{ id: 7, batch_number: '0142', started_at: '2026-05-21T09:00:00Z', product: 'Vitamin B2' }],
    });
    const out = await r.handleOverview(req({ date: '2026-05-21' }), { db, batchService: fakeBatchSvc });
    expect(out.body).toContain('Vitamin B2');
    expect(out.body).toContain('684');
    expect(out.body).toMatch(/Total por produto.*Vitamin B2.*<b>984<\/b>/s); // 684+300
    expect(fakeBatchSvc.getSummary).toHaveBeenCalledWith(7);
    expect(out.body).toContain('1h 2m'); // total_seconds 3720 formatado
    expect(out.body).toContain('Ana, Vitor'); // pessoas que tocaram
  });

  test('read-only — overview não emite INSERT/UPDATE/DELETE', async () => {
    const db = makeFakeDb({
      dayMessages: [{ created_at: 'x', slack_user_id: 'A', raw_text: 'a', llm_result: {}, llm_processed_at: 'x' }],
      activeBatches: [{ id: 7, batch_number: '1', started_at: 'x', product: 'P' }],
    });
    await r.handleOverview(req({ date: '2026-05-21' }), { db, batchService: fakeBatchSvc });
    expect(db.calls.every((c) => !/\b(INSERT|UPDATE|DELETE)\b/i.test(c.sql))).toBe(true);
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
