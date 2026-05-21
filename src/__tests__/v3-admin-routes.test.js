'use strict';
// HEALTHFARE V3 — Bloco 0 / Etapa 3 — testes dos handlers HTML.
// Pós-desacoplamento: os handlers consomem os REPOS (não mais SQL inline).
// Aqui testamos os handlers com repos MOCKADOS; os repos em si têm
// teste próprio em v3-data-repos.test.js.
const r = require('../v3/admin-v3/routes');

/** Repos fake — cada método é jest.fn devolvendo o seed (ou default vazio). */
function makeRepos(seed = {}) {
  return {
    messages: {
      messagesByDay: jest.fn(async (date) => seed.messages
        || { date: date || '2026-05-21', count: 0, messages: [] }),
      messageById: jest.fn(async () => seed.messageById || null),
    },
    timeline: {
      eventsByDay: jest.fn(async (date) => seed.timeline
        || { date: date || '2026-05-21', people: [] }),
      eventsByPersonDay: jest.fn(async () => seed.timelinePerson || { date: '2026-05-21', person: {}, events: [] }),
    },
    vocabulary: { pending: jest.fn(async () => seed.vocabulary || { terms: [] }) },
    metrics: {
      metricsRange: jest.fn(async (from, to) => seed.metrics
        || { from, to, total_processed: 0, errors: 0, cost_estimate_usd: 0,
          by_confidence: {}, by_categorization: {}, avg_cost_per_msg: 0 }),
    },
    health: {
      workerHealth: jest.fn(async () => seed.health
        || { worker: { alive: true, last_tick_at: null, tick_age_seconds: null },
          queue: 0, errors: 0, last_processed_at: null, provider: 'anthropic', mode: 'shadow' }),
    },
    counts: {
      countsByDay: jest.fn(async (date) => seed.counts
        || { date: date || '2026-05-21', counts: [], totals_by_product: {} }),
    },
    batches: { activeBatches: jest.fn(async () => seed.batches || { active: [] }) },
  };
}

/** db fake — só pro cross-ref legado do /divergences. Conta as queries. */
function makeDb(legacyCount = 0) {
  const calls = [];
  return {
    calls,
    query: jest.fn((sql) => { calls.push(String(sql)); return Promise.resolve({ rows: [{ c: legacyCount }] }); }),
  };
}

const deps = (seed, db) => ({ repos: makeRepos(seed), db: db || makeDb() });
const req = (query = {}) => ({ query: Object.assign({ pin: '510510' }, query), headers: {} });
const noPin = (query = {}) => ({ query, headers: {} });

describe('V3 admin-v3 — auth PIN', () => {
  test('todos os handlers rejeitam sem PIN (403)', async () => {
    for (const slug of Object.keys(r.HANDLERS)) {
      const out = await r.HANDLERS[slug](noPin(), deps());
      expect(out.status).toBe(403);
    }
  });
  test('checkPin aceita o certo, rejeita o errado e lê o header', () => {
    expect(r.checkPin({ query: { pin: '510510' }, headers: {} })).toBe(true);
    expect(r.checkPin({ query: { pin: '000' }, headers: {} })).toBe(false);
    expect(r.checkPin({ query: {}, headers: { 'x-admin-pin': '510510' } })).toBe(true);
  });
});

describe('V3 admin-v3 — messages-shadow', () => {
  test('renderiza as mensagens vindas do repo', async () => {
    const seed = { messages: { date: '2026-05-21', count: 1, messages: [{
      id: 1, slack_ts: '1.1', slack_user_id: 'U_PL', raw_text: 'comecei a linha',
      created_at: '2026-05-21T12:00:00-04:00', person: { display_name: 'Ana' },
      processed: true, interpretation: 'Ana abriu linha', categorization: 'activity_start',
      confidence: 'high', action_count: 1, cost_estimate_usd: 0.002, processing_error: null, skipped: null,
    }] } };
    const d = deps(seed);
    const out = await r.handleMessagesShadow(req({ date: '2026-05-21', limit: '5' }), d);
    expect(out.status).toBe(200);
    expect(out.body).toContain('comecei a linha');
    expect(out.body).toContain('Ana abriu linha');
    expect(out.body).toContain('#16a34a'); // cor confidence high
    expect(d.repos.messages.messagesByDay).toHaveBeenCalledWith('2026-05-21', { limit: '5' });
  });
});

describe('V3 admin-v3 — events-shadow / timeline', () => {
  const timeline = { date: '2026-05-21', people: [
    { person_id: 6, display_name: 'Ana', role: 'operator', events: [
      { event_id: 1, activity: { id: 5, slug: 'production_line', display_name: 'Linha de Produção', category: 'production_phase' },
        started_at: '2026-05-21T09:30:00-04:00', ended_at: null, confidence: 'high',
        cowork_with: [], product_batch_id: null, source_message_ts: 't.1' } ] },
    { person_id: 4, display_name: 'Vitor', role: 'operator', events: [
      { event_id: 2, activity: { id: 2, slug: 'mixing', display_name: 'Mix', category: 'production_phase' },
        started_at: '2026-05-21T10:00:00-04:00', ended_at: '2026-05-21T11:00:00-04:00', confidence: 'medium',
        cowork_with: [6], product_batch_id: 7, source_message_ts: 't.2' } ] },
  ] };

  test('events-shadow agrupa por pessoa (do repo) e marca ativo', async () => {
    const out = await r.handleEventsShadow(req(), deps({ timeline }));
    expect(out.body).toContain('<h3>Ana</h3>');
    expect(out.body).toContain('<h3>Vitor</h3>');
    expect(out.body).toContain('ativo'); // event sem ended_at
  });

  test('timeline monta blocos por pessoa com a hora NY', async () => {
    const out = await r.handleTimeline(req({ date: '2026-05-21' }), deps({ timeline }));
    expect(out.body).toContain('<h3>Ana</h3>');
    expect(out.body).toContain('09:30 Linha de Produção');
  });
});

describe('V3 admin-v3 — divergences', () => {
  test('conta events do V3 (via repo) e cruza com o legado (via db)', async () => {
    const seed = { timeline: { date: '2026-05-21', people: [
      { person_id: 6, display_name: 'Ana', events: [
        { event_id: 1, activity: { display_name: 'Formulação' }, started_at: '2026-05-21T10:00:00-04:00', cowork_with: [] }] }] } };
    const db = makeDb(0);
    const out = await r.handleDivergences(req({ date: '2026-05-21' }), deps(seed, db));
    expect(out.status).toBe(200);
    expect(out.body).toContain('V3-only');
    expect(out.body).toMatch(/V3 criou <span class="big">1</);
    expect(db.calls.length).toBe(2); // cross-ref legado: public.tasks + phase_instances
  });
});

describe('V3 admin-v3 — vocabulary-pending', () => {
  test('lista os termos vindos do repo', async () => {
    const out = await r.handleVocabularyPending(req(),
      deps({ vocabulary: { terms: [{ term: 'fita', occurrence_count: 5, meaning: 'etiqueta', first_seen_at: null }] } }));
    expect(out.body).toContain('fita');
    expect(out.body).toContain('etiqueta');
  });
});

describe('V3 admin-v3 — llm-metrics', () => {
  test('renderiza as métricas e repassa from/to ao repo', async () => {
    const seed = { metrics: { from: '2026-05-01', to: '2026-05-21', total_processed: 2, errors: 1,
      cost_estimate_usd: 0.003, by_confidence: { high: 1, medium: 1 }, by_categorization: { note: 2 }, avg_cost_per_msg: 0.0015 } };
    const d = deps(seed);
    const out = await r.handleLlmMetrics(req({ from: '2026-05-01', to: '2026-05-21' }), d);
    expect(out.body).toMatch(/Processadas:\s*<span class="big">2</);
    expect(out.body).toMatch(/Erros\/retry:\s*<b>1</);
    expect(out.body).toContain('$0.0030');
    expect(out.body).toContain('high: <b>1</b>');
    expect(d.repos.metrics.metricsRange).toHaveBeenCalledWith('2026-05-01', '2026-05-21');
  });
});

describe('V3 admin-v3 — health', () => {
  test('reporta worker/fila/erro do repo', async () => {
    const out = await r.handleHealth(req(), deps({ health: {
      worker: { alive: true, last_tick_at: '2026-05-21T12:00:00-04:00', tick_age_seconds: 5 },
      queue: 4, errors: 1, last_processed_at: '2026-05-21T11:59:00-04:00', provider: 'anthropic', mode: 'shadow' } }));
    expect(out.body).toContain('ativo');
    expect(out.body).toMatch(/Fila.*<span class="big">4</);
    expect(out.body).toContain('anthropic');
    expect(out.body).toContain('shadow');
  });
  test('worker inativo → 🔴', async () => {
    const out = await r.handleHealth(req(), deps({ health: {
      worker: { alive: false, last_tick_at: null, tick_age_seconds: 3600 },
      queue: 0, errors: 0, last_processed_at: null, provider: 'anthropic', mode: 'shadow' } }));
    expect(out.body).toContain('🔴');
  });
});

describe('V3 admin-v3 — overview', () => {
  test('renderiza as 6 seções consumindo os 4 repos', async () => {
    const seed = {
      messages: { date: '2026-05-21', count: 3, messages: [
        { id: 1, slack_user_id: 'A', raw_text: 'a', created_at: 'x', processed: true,
          confidence: 'high', categorization: 'activity_start', cost_estimate_usd: 0.01, action_count: 1 },
        { id: 2, slack_user_id: 'B', raw_text: 'MSG_BAIXA', created_at: 'x', processed: true,
          confidence: 'low', categorization: 'note', cost_estimate_usd: 0.02, action_count: 0,
          interpretation: 'incerto' },
      ] },
      timeline: { date: '2026-05-21', people: [
        { person_id: 6, display_name: 'Ana', events: [
          { event_id: 1, activity: { display_name: 'Mix', category: 'production_phase' },
            started_at: '2026-05-21T10:00:00-04:00', ended_at: null, cowork_with: [] }] }] },
      counts: { date: '2026-05-21', counts: [
        { bottles: 684, reported_at: '2026-05-21T20:00:00-04:00', product: { canonical_name: 'Vitamin B2' },
          batch: { batch_number: '0142' }, reporter: { display_name: 'Ana' } }],
        totals_by_product: { 'Vitamin B2': 684 } },
      batches: { active: [
        { batch_id: 7, batch_number: '0142', product: { canonical_name: 'Vitamin B2' },
          started_at: '2026-05-21T09:00:00-04:00', total_seconds: 3720,
          people: [{ person_id: 4, display_name: 'Vitor' }], bottles: 684 }] },
    };
    const d = deps(seed);
    const out = await r.handleOverview(req({ date: '2026-05-21' }), d);
    expect(out.status).toBe(200);
    for (const h of ['Resumo do dia', 'Timeline por pessoa', 'Produção do dia',
      'Lotes ativos', 'Distribuição de confiança', 'Atenção']) {
      expect(out.body).toContain(h);
    }
    expect(out.body).toMatch(/Mensagens lidas<\/div><div class="big">2</); // count das mensagens
    expect(out.body).toContain('Vitamin B2');
    expect(out.body).toContain('1h 2m'); // total_seconds 3720
    expect(out.body).toContain('MSG_BAIXA'); // seção atenção (confidence low)
    expect(out.body).toContain('http-equiv="refresh"');
    // os 4 repos foram consultados
    expect(d.repos.messages.messagesByDay).toHaveBeenCalled();
    expect(d.repos.timeline.eventsByDay).toHaveBeenCalled();
    expect(d.repos.counts.countsByDay).toHaveBeenCalled();
    expect(d.repos.batches.activeBatches).toHaveBeenCalled();
  });
});

describe('V3 admin-v3 — desacoplamento (sem SQL inline)', () => {
  test('handlers não-divergences NÃO tocam deps.db (só consomem repos)', async () => {
    const db = { query: jest.fn(() => { throw new Error('SQL inline proibido'); }) };
    for (const slug of Object.keys(r.HANDLERS)) {
      if (slug === 'divergences') continue; // exceção: cross-ref legado
      const out = await r.HANDLERS[slug](req({ date: '2026-05-21' }), { repos: makeRepos(), db });
      expect(out.status).toBe(200);
    }
    expect(db.query).not.toHaveBeenCalled();
  });
});
