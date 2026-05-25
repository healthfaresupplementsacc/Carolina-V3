'use strict';
// HEALTHFARE V3 — Bloco 0 / Etapa 1 — testes isolados dos repos de leitura.
const nyd = require('../v3/data/ny-date');
const { HealthRepo } = require('../v3/data/health-repo');
const { VocabularyRepo, MIN_OCCURRENCES } = require('../v3/data/vocabulary-repo');
const { CatalogRepo } = require('../v3/data/catalog-repo');
const { CountsRepo } = require('../v3/data/counts-repo');
const { BatchesRepo } = require('../v3/data/batches-repo');
const { MessagesRepo } = require('../v3/data/messages-repo');
const { MetricsRepo } = require('../v3/data/metrics-repo');
const { TimelineRepo } = require('../v3/data/timeline-repo');
const { HistoryRepo, resolveRange } = require('../v3/data/history-repo');
const { GoalsRepo } = require('../v3/data/goals-repo');
const { FlowViewsRepo } = require('../v3/data/flow-views-repo');
const { DeadlinesRepo } = require('../v3/data/deadlines-repo');

/** Fake db: rotas [{match:regex, rows:[]|fn}]; 1ª que casa responde. Registra calls. */
function makeDb(routes = []) {
  const calls = [];
  return {
    calls,
    query: jest.fn((sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      for (const r of routes) {
        if (r.match.test(s)) {
          return Promise.resolve({ rows: typeof r.rows === 'function' ? r.rows(params) : r.rows });
        }
      }
      return Promise.resolve({ rows: [] });
    }),
  };
}

describe('V3 data — ny-date', () => {
  test('nyDate formata YYYY-MM-DD no fuso de New York', () => {
    // 03:00 UTC = 23:00 do dia anterior em NY (EDT, -4)
    expect(nyd.nyDate(new Date('2026-05-21T03:00:00Z'))).toBe('2026-05-20');
    expect(nyd.nyDate(new Date('2026-05-21T17:00:00Z'))).toBe('2026-05-21');
  });
  test('isValidDate aceita YYYY-MM-DD válido, rejeita o resto', () => {
    expect(nyd.isValidDate('2026-05-21')).toBe(true);
    expect(nyd.isValidDate('2026/05/21')).toBe(false);
    expect(nyd.isValidDate('abc')).toBe(false);
    expect(nyd.isValidDate(null)).toBe(false);
  });
  test('resolveDate devolve a data válida, ou hoje (NY) no fallback', () => {
    expect(nyd.resolveDate('2026-05-19')).toBe('2026-05-19');
    expect(nyd.resolveDate('lixo')).toBe(nyd.nyDate());
  });
  test('toNyIso converte UTC → ISO com offset de NY (mesmo instante)', () => {
    // 16:18:10 UTC = 12:18:10 em NY (EDT, -04:00) — mesmo instante
    expect(nyd.toNyIso('2026-05-21T16:18:10.000Z')).toBe('2026-05-21T12:18:10-04:00');
    expect(nyd.toNyIso(new Date('2026-05-21T16:18:10Z'))).toBe('2026-05-21T12:18:10-04:00');
    expect(nyd.toNyIso(null)).toBeNull();
    expect(nyd.toNyIso('lixo')).toBeNull();
  });
});

describe('V3 data — HealthRepo', () => {
  const base = (tickIso) => makeDb([
    { match: /COUNT\(\*\) c FROM v3\.messages WHERE llm_processed_at IS NULL/, rows: [{ c: '3' }] },
    { match: /MAX\(llm_processed_at\)/, rows: [{ mx: '2026-05-21T16:00:00Z' }] },
    { match: /COUNT\(\*\) c FROM v3\.messages WHERE processing_error/, rows: [{ c: '1' }] },
    { match: /FROM v3\.settings/, rows: [
      { key: 'llm_provider', value: 'anthropic' },
      { key: 'llm_observer_mode', value: 'shadow' },
      { key: 'observer_last_tick_at', value: tickIso },
    ] },
  ]);

  test('worker vivo quando o heartbeat é recente', async () => {
    const now = Date.parse('2026-05-21T16:05:00Z');
    const repo = new HealthRepo({ db: base('2026-05-21T16:04:30Z'), now: () => now });
    const h = await repo.workerHealth();
    expect(h.worker.alive).toBe(true);
    expect(h.worker.tick_age_seconds).toBe(30);
    expect(h.queue).toBe(3);
    expect(h.errors).toBe(1);
    expect(h.provider).toBe('anthropic');
    expect(h.mode).toBe('shadow');
  });

  test('worker marcado inativo quando o heartbeat é antigo', async () => {
    const now = Date.parse('2026-05-21T16:10:00Z');
    const repo = new HealthRepo({ db: base('2026-05-21T16:00:00Z'), now: () => now });
    const h = await repo.workerHealth();
    expect(h.worker.alive).toBe(false); // 600s > 120s
  });
});

describe('V3 data — VocabularyRepo', () => {
  test('mapeia termos pendentes e usa o limiar de ocorrências', async () => {
    const db = makeDb([{ match: /FROM v3\.vocabulary/, rows: [
      { term: 'fita', occurrence_count: '5', meaning: 'etiqueta', context_examples: null, first_seen_at: 'x' },
    ] }]);
    const out = await new VocabularyRepo({ db }).pending();
    expect(out.terms).toHaveLength(1);
    expect(out.terms[0]).toMatchObject({ term: 'fita', occurrence_count: 5, meaning: 'etiqueta' });
    expect(db.calls[0].params[0]).toBe(MIN_OCCURRENCES);
  });
});

describe('V3 data — CatalogRepo', () => {
  test('persons / products / activityTypes mapeiam o shape estável (com fluxo)', async () => {
    const db = makeDb([
      { match: /FROM v3\.persons WHERE deleted_at/, rows: [{ id: 4, display_name: 'Vitor', role: 'operator', slack_user_id: 'U08JC85HMNE', active: true }] },
      { match: /FROM v3\.products ORDER BY/, rows: [{ id: 67, canonical_name: 'Vitamin B2', aliases: ['vita b2'], active: true }] },
      { match: /FROM v3\.activity_types ORDER BY/, rows: [{ id: 5, slug: 'production_line', display_name: 'Linha de Produção', category: 'production_phase', requires_product: true, active: true, flow: 'production', phase_order: 5 }] },
    ]);
    const repo = new CatalogRepo({ db });
    expect((await repo.persons()).persons[0].display_name).toBe('Vitor');
    expect((await repo.products()).products[0].aliases).toEqual(['vita b2']);
    const at = (await repo.activityTypes()).activity_types[0];
    expect(at).toMatchObject({ slug: 'production_line', flow: 'production', phase_order: 5 });
  });

  test('flows() devolve os 3 fluxos com o mode', async () => {
    const db = makeDb([{ match: /FROM v3\.flows ORDER BY/, rows: [
      { slug: 'production', display_name: 'Produção', mode: 'ordered' },
      { slug: 'pnp', display_name: 'Picking & Packing', mode: 'block' },
      { slug: 'support', display_name: 'Suporte', mode: 'loose' },
    ] }]);
    const out = await new CatalogRepo({ db }).flows();
    expect(out.flows).toHaveLength(3);
    expect(out.flows.find((f) => f.slug === 'pnp').mode).toBe('block');
  });
});

describe('V3 data — CountsRepo', () => {
  test('countsByDay mapeia, soma por produto e repassa a data', async () => {
    const db = makeDb([{ match: /FROM v3\.production_counts pc JOIN/, rows: [
      { id: 1, bottles: 684, reported_at: 'x', confidence: 'high', notes: null, product_id: 67, product: 'Vitamin B2', product_batch_id: 12, batch_number: '0142', reported_by_person_id: 6, reporter: 'Ana' },
      { id: 2, bottles: 300, reported_at: 'y', confidence: 'high', notes: null, product_id: 67, product: 'Vitamin B2', product_batch_id: 12, batch_number: '0142', reported_by_person_id: 6, reporter: 'Ana' },
    ] }]);
    const out = await new CountsRepo({ db }).countsByDay('2026-05-21');
    expect(out.date).toBe('2026-05-21');
    expect(out.counts).toHaveLength(2);
    expect(out.totals_by_product['Vitamin B2']).toBe(984);
    expect(db.calls[0].params[0]).toBe('2026-05-21');
  });
});

describe('V3 data — BatchesRepo', () => {
  const fakeBatchService = {
    listActive: jest.fn(async () => [{ id: 12 }]),
    getSummary: jest.fn(async () => ({
      batch_id: 12, product_id: 67, batch_number: '0142', status: 'in_progress',
      started_at: 'x', finished_at: null, total_seconds: 3720, event_count: 2,
      people: [{ person_id: 4, display_name: 'Vitor' }], phases: [], bottles: 984,
    })),
  };

  test('activeBatches delega ao BatchService e injeta o nome do produto', async () => {
    const db = makeDb([{ match: /FROM v3\.products WHERE id = ANY/, rows: [{ id: 67, canonical_name: 'Vitamin B2' }] }]);
    const out = await new BatchesRepo({ db, batchService: fakeBatchService }).activeBatches();
    expect(out.active).toHaveLength(1);
    expect(out.active[0]).toMatchObject({
      batch_id: 12, total_seconds: 3720, bottles: 984,
      product: { id: 67, canonical_name: 'Vitamin B2' },
    });
    expect(out.active[0].people[0].display_name).toBe('Vitor');
  });

  test('activeBatches vazio quando não há lote in_progress', async () => {
    const empty = { listActive: jest.fn(async () => []), getSummary: jest.fn() };
    const out = await new BatchesRepo({ db: makeDb(), batchService: empty }).activeBatches();
    expect(out.active).toEqual([]);
    expect(empty.getSummary).not.toHaveBeenCalled();
  });
});

describe('V3 data — MessagesRepo', () => {
  const route = { match: /FROM v3\.messages m LEFT JOIN v3\.persons p .* WHERE \(m\.created_at AT TIME ZONE/, rows: [
    { id: 83, slack_ts: '1.1', slack_user_id: 'U_X', raw_text: 'oi', created_at: 'x',
      llm_result: { interpretation: 'cumprimento', categorization: 'small_talk', confidence_overall: 'high', cost_estimate_usd: 0.01, actions: [] },
      llm_processed_at: 'x', llm_provider_used: 'anthropic', processing_error: null, person_id: 4, person_name: 'Vitor' },
  ] };

  test('messagesByDay mapeia o resumo do llm_result e repassa data+limit', async () => {
    const db = makeDb([route]);
    const out = await new MessagesRepo({ db }).messagesByDay('2026-05-21', { limit: '10' });
    expect(out.date).toBe('2026-05-21');
    expect(out.messages[0]).toMatchObject({
      id: 83, categorization: 'small_talk', confidence: 'high', action_count: 0, processed: true,
    });
    expect(db.calls[0].params).toEqual(['2026-05-21', 10]);
  });

  test('limit fora do range cai no teto (500)', async () => {
    const db = makeDb([route]);
    await new MessagesRepo({ db }).messagesByDay('2026-05-21', { limit: '99999' });
    expect(db.calls[0].params[1]).toBe(500);
  });

  test('messageById devolve null quando não acha', async () => {
    const out = await new MessagesRepo({ db: makeDb() }).messageById(999);
    expect(out).toBeNull();
  });

  test('uncertainCases filtra por flag/low-conf/erro e respeita since_days', async () => {
    const uncertainRoute = {
      match: /\(m\.llm_result->>'uncertain'\)::boolean = true/, rows: [
        { id: 1, slack_ts: 't1', slack_user_id: 'U_X', raw_text: 'duvidoso',
          created_at: 'x', llm_processed_at: 'x', llm_provider_used: 'anthropic',
          processing_error: null, person_id: 4, person_name: 'Vitor',
          events_created: [10], events_updated: [],
          llm_result: { uncertain: true, uncertainty_reason: 'foi 1 ou 2?',
            interpretation: 'i', categorization: 'activity_start', confidence_overall: 'high' } },
      ],
    };
    const db = makeDb([uncertainRoute]);
    const out = await new MessagesRepo({ db }).uncertainCases({ limit: '5', since_days: '3' });
    expect(out.since_days).toBe(3);
    expect(out.count).toBe(1);
    expect(out.cases[0]).toMatchObject({
      id: 1, uncertain: true, uncertainty_reason: 'foi 1 ou 2?',
    });
    expect(db.calls[0].params).toEqual([3, 5]);
  });
});

describe('V3 data — MetricsRepo', () => {
  test('metricsByDay agrega total, erros, custo e distribuições', async () => {
    const db = makeDb([{ match: /SELECT llm_result, processing_error FROM v3\.messages/, rows: [
      { llm_result: { confidence_overall: 'high', categorization: 'activity_start', cost_estimate_usd: 0.02 }, processing_error: null },
      { llm_result: { confidence_overall: 'medium', categorization: 'note', cost_estimate_usd: 0.01 }, processing_error: null },
      { llm_result: null, processing_error: 'llm_error: x' },
    ] }]);
    const m = await new MetricsRepo({ db }).metricsByDay('2026-05-21');
    expect(m.total_processed).toBe(2);
    expect(m.errors).toBe(1);
    expect(m.cost_estimate_usd).toBeCloseTo(0.03, 5);
    expect(m.by_confidence).toEqual({ high: 1, medium: 1 });
    expect(m.avg_cost_per_msg).toBeCloseTo(0.015, 5);
  });

  test('metricsRange: sem from/to = todas as mensagens (sem filtro de data)', async () => {
    const db = makeDb([{ match: /SELECT llm_result, processing_error FROM v3\.messages/, rows: [
      { llm_result: { confidence_overall: 'high', cost_estimate_usd: 0.01 }, processing_error: null },
    ] }]);
    const m = await new MetricsRepo({ db }).metricsRange(null, null);
    expect(m.total_processed).toBe(1);
    expect(m.from).toBeNull();
    expect(db.calls[0].params).toEqual([]); // sem params → sem filtro
  });

  test('metricsRange: com from/to monta os filtros de created_at', async () => {
    const db = makeDb([{ match: /SELECT llm_result, processing_error FROM v3\.messages/, rows: [] }]);
    await new MetricsRepo({ db }).metricsRange('2026-05-01', '2026-05-21');
    expect(db.calls[0].params).toEqual(['2026-05-01', '2026-05-21']);
    expect(db.calls[0].sql).toMatch(/created_at >= \$1/);
    expect(db.calls[0].sql).toMatch(/created_at <= \$2/);
  });
});

describe('V3 data — TimelineRepo', () => {
  const ev = (over) => Object.assign({
    id: 1, person_id: 4, activity_type_id: 5, product_batch_id: null,
    started_at: '2026-05-21T12:00:00Z', ended_at: null, confidence: 'high', cowork_with: [],
    phase_label: null, description: null, source_message_ts: 't.1', flow_override: null,
    person_name: 'Vitor', person_role: 'operator',
    activity_slug: 'production_line', activity_name: 'Linha de Produção', activity_category: 'production_phase',
    activity_flow: 'production', activity_phase_order: 5,
  }, over);

  test('eventsByDay agrupa por pessoa e dá o shape do event (com flow)', async () => {
    const db = makeDb([{ match: /FROM v3\.events e .* WHERE e\.deleted_at IS NULL AND \(e\.started_at/, rows: [
      ev({ id: 1, person_id: 4, person_name: 'Vitor' }),
      ev({ id: 2, person_id: 6, person_name: 'Ana', activity_name: 'Revisão' }),
    ] }]);
    const out = await new TimelineRepo({ db }).eventsByDay('2026-05-21');
    expect(out.people).toHaveLength(2);
    const vitor = out.people.find((p) => p.display_name === 'Vitor');
    expect(vitor.events[0]).toMatchObject({
      event_id: 1, flow: 'production',
      activity: { slug: 'production_line', category: 'production_phase', phase_order: 5 },
    });
    // timestamps saem em ISO com offset de NY (-04:00 EDT / -05:00 EST), não UTC Z
    expect(vitor.events[0].started_at).toMatch(/^2026-05-21T\d{2}:\d{2}:\d{2}-0[45]:00$/);
  });

  test('flow_override do event vence o flow derivado do activity_type', async () => {
    const db = makeDb([{ match: /FROM v3\.events e .* WHERE e\.deleted_at IS NULL AND \(e\.started_at/, rows: [
      ev({ id: 9, activity_flow: 'production', flow_override: 'support' }),
    ] }]);
    const out = await new TimelineRepo({ db }).eventsByDay('2026-05-21');
    expect(out.people[0].events[0].flow).toBe('support'); // override > derivado
  });

  test('eventsByPersonDay filtra por pessoa (param) e devolve só ela', async () => {
    const db = makeDb([{ match: /FROM v3\.events e .* e\.person_id = \$1/, rows: [ev()] }]);
    const out = await new TimelineRepo({ db }).eventsByPersonDay(4, '2026-05-21');
    expect(out.person.display_name).toBe('Vitor');
    expect(out.events).toHaveLength(1);
    expect(db.calls[0].params).toEqual([4, '2026-05-21']);
  });
});

describe('V3 data — HistoryRepo', () => {
  test('resolveRange: default = últimos 30 dias até hoje', () => {
    const { from, to } = resolveRange({ to: '2026-05-21' });
    expect(to).toBe('2026-05-21');
    expect(from).toBe('2026-04-21');
  });

  test('personHistory agrupa eventos por dia (NY)', async () => {
    const db = makeDb([{ match: /FROM v3\.events e .* e\.person_id = \$1/, rows: [
      { id: 1, started_at: 'x', ended_at: null, confidence: 'high', cowork_with: [], product_batch_id: null,
        ny_day: '2026-05-20', activity_slug: 'mix', activity_name: 'Mix', activity_category: 'production_phase' },
      { id: 2, started_at: 'y', ended_at: null, confidence: 'high', cowork_with: [], product_batch_id: null,
        ny_day: '2026-05-21', activity_slug: 'review', activity_name: 'Revisão', activity_category: 'production_phase' },
    ] }]);
    const out = await new HistoryRepo({ db }).personHistory(4, { from: '2026-05-19', to: '2026-05-21' });
    expect(out.person_id).toBe(4);
    expect(out.event_count).toBe(2);
    expect(out.days.map((d) => d.date)).toEqual(['2026-05-20', '2026-05-21']);
  });

  test('productHistory devolve counts + batches + produto', async () => {
    const db = makeDb([
      { match: /FROM v3\.production_counts pc LEFT JOIN/, rows: [
        { id: 1, bottles: 568, production_date: '2026-05-20', reported_at: 'x', confidence: 'high', product_batch_id: 12, batch_number: '0136', reported_by_person_id: 6, reporter: 'Ana' },
      ] },
      { match: /FROM v3\.product_batches WHERE product_id/, rows: [
        { id: 12, batch_number: '0136', started_at: 'x', finished_at: null, status: 'in_progress' },
      ] },
      { match: /FROM v3\.products WHERE id = \$1/, rows: [{ id: 56, canonical_name: 'Plant Sterols' }] },
    ]);
    const out = await new HistoryRepo({ db }).productHistory(56, { from: '2026-05-19', to: '2026-05-21' });
    expect(out.product.canonical_name).toBe('Plant Sterols');
    expect(out.counts[0].bottles).toBe(568);
    expect(out.batches[0].batch_number).toBe('0136');
  });
});

describe('V3 data — GoalsRepo (esperado vs realizado)', () => {
  test('goalsByDay calcula esperado/realizado/%, exclui duplicata, ignora duração inválida', async () => {
    const db = makeDb([
      { match: /FROM v3\.production_goals g/, rows: [
        { id: 1, product_id: 56, batch_number: '0135', expected_quantity: 750, unit: 'bottle',
          destinations: null, confidence: 'high', source: 'channel', created_by_person_id: 3,
          product: 'Plant Sterols' }] },
      { match: /FROM v3\.production_counts pc LEFT JOIN/, rows: [
        { id: 10, product_id: 56, bottles: 723, unit: 'bottle', possible_duplicate_of: null,
          product_batch_id: 9, batch_raw: 'BR-2026-0135', reporter: 'Ana', reported_at: '2026-05-19T22:00:00Z' },
        { id: 11, product_id: 56, bottles: 723, unit: 'bottle', possible_duplicate_of: 10,
          product_batch_id: 9, batch_raw: '0135', reporter: 'Ana', reported_at: '2026-05-19T22:30:00Z' }] },
      { match: /FROM v3\.product_batches WHERE product_id = ANY/, rows: [
        { id: 9, product_id: 56, batch_number: 'BR-2026-0135' }] },
      { match: /FROM v3\.events e LEFT JOIN v3\.activity_types/, rows: [
        { product_batch_id: 9, started_at: '2026-05-19T13:00:00Z', ended_at: '2026-05-19T14:00:00Z',
          activity_name: 'Linha de Produção', activity_flow: 'production' },
        { product_batch_id: 9, started_at: '2026-05-19T15:00:00Z', ended_at: '2026-05-19T14:00:00Z',
          activity_name: 'Revisão', activity_flow: 'production' }] }, // ended<started → inválido
    ]);
    const out = await new GoalsRepo({ db }).goalsByDay('2026-05-19');
    expect(out.goals).toHaveLength(1);
    const g = out.goals[0];
    expect(g.esperado).toBe(750);
    expect(g.realizado).toBe(723);              // só a contagem NÃO-marcada
    expect(g.pct_atingido).toBe(96);
    expect(g.bateu).toBe(false);
    expect(g.duplicatas_suspeitas).toHaveLength(1); // a 723 repetida, pra revisão
    expect(g.batch.invalid_event_count).toBe(1);    // event de duração negativa ignorado
    expect(g.batch.total_seconds).toBe(3600);       // só o event válido (1h), não poluído
  });

  test('goalsByDay sem metas → lista vazia', async () => {
    const out = await new GoalsRepo({ db: makeDb() }).goalsByDay('2026-05-19');
    expect(out.goals).toEqual([]);
  });
});

describe('V3 data — FlowViewsRepo (Bloco 3)', () => {
  const evRoute = (rows) => [{ match: /FROM v3\.events e LEFT JOIN v3\.activity_types at/, rows }];

  test('productionByDay agrupa por lote, soma fases válidas, ignora duração inválida', async () => {
    const db = makeDb(evRoute([
      { id: 1, product_batch_id: 9, person_id: 4, started_at: '2026-05-21T13:00:00Z',
        ended_at: '2026-05-21T14:00:00Z', activity_name: 'Mix', activity_slug: 'mixing',
        batch_number: '0142', product_id: 67, product: 'Vitamin B2', person_name: 'Vitor' },
      { id: 2, product_batch_id: 9, person_id: 4, started_at: '2026-05-21T15:00:00Z',
        ended_at: '2026-05-21T14:00:00Z', activity_name: 'Revisão', activity_slug: 'review',
        batch_number: '0142', product_id: 67, product: 'Vitamin B2', person_name: 'Vitor' },
    ]));
    const out = await new FlowViewsRepo({ db }).productionByDay('2026-05-21');
    expect(out.mode).toBe('ordered');
    expect(out.lotes).toHaveLength(1);
    expect(out.lotes[0].total_seconds).toBe(3600);     // só o Mix válido (1h)
    expect(out.lotes[0].invalid_event_count).toBe(1);  // Revisão ended<started
    expect(out.lotes[0].phases).toEqual([{ activity: 'Mix', seconds: 3600 }]);
  });

  test('pnpByDay soma o bloco do dia; packages null (sem fonte ainda)', async () => {
    const db = makeDb(evRoute([
      { id: 1, product_batch_id: null, person_id: 5, started_at: '2026-05-21T13:00:00Z',
        ended_at: '2026-05-21T13:30:00Z', activity_name: 'Impressão de Ordens',
        activity_slug: 'order_printing', person_name: 'Simone' },
    ]));
    const out = await new FlowViewsRepo({ db }).pnpByDay('2026-05-21');
    expect(out.mode).toBe('block');
    expect(out.total_seconds).toBe(1800);
    expect(out.packages).toBeNull();
    expect(out.sub_steps).toEqual([{ activity: 'Impressão de Ordens', seconds: 1800 }]);
  });

  test('supportByDay lista ocorrências; conserto marcado downtime', async () => {
    const db = makeDb(evRoute([
      { id: 1, started_at: '2026-05-21T13:00:00Z', ended_at: '2026-05-21T15:00:00Z',
        activity_name: 'Conserto', activity_slug: 'repair', person_name: 'Ana' },
    ]));
    const out = await new FlowViewsRepo({ db }).supportByDay('2026-05-21');
    expect(out.mode).toBe('loose');
    expect(out.occurrences[0].is_downtime).toBe(true);
  });
});

describe('V3 data — DeadlinesRepo (Bloco 3)', () => {
  test('list calcula minutes_until_today p/ deadline recorrente', async () => {
    const db = makeDb([{ match: /FROM v3\.deadlines ORDER BY/, rows: [
      { id: 1, flow: 'pnp', label: 'Corte do correio', kind: 'recurring',
        time_of_day: '13:00', weekdays: [1, 2, 3, 4, 5], active: true }] }]);
    // 2026-05-21 = quinta · 12:00 NY → faltam 60 min pro corte das 13:00
    const repo = new DeadlinesRepo({ db, now: () => Date.parse('2026-05-21T12:00:00-04:00') });
    const out = await repo.list();
    expect(out.deadlines[0].minutes_until_today).toBe(60);
  });
});

describe('V3 data — repos são read-only (zero mutação)', () => {
  test('nenhum repo emite INSERT/UPDATE/DELETE', async () => {
    const db = makeDb();
    const bs = { listActive: async () => [], getSummary: async () => ({}) };
    await new HealthRepo({ db }).workerHealth();
    await new VocabularyRepo({ db }).pending();
    await new CatalogRepo({ db }).persons();
    await new CatalogRepo({ db }).products();
    await new CatalogRepo({ db }).activityTypes();
    await new CountsRepo({ db }).countsByDay('2026-05-21');
    await new BatchesRepo({ db, batchService: bs }).activeBatches();
    await new MessagesRepo({ db }).messagesByDay('2026-05-21');
    await new MessagesRepo({ db }).messageById(1);
    await new MetricsRepo({ db }).metricsByDay('2026-05-21');
    await new TimelineRepo({ db }).eventsByDay('2026-05-21');
    await new TimelineRepo({ db }).eventsByPersonDay(4, '2026-05-21');
    await new HistoryRepo({ db }).personHistory(4, {});
    await new HistoryRepo({ db }).productHistory(56, {});
    await new GoalsRepo({ db }).goalsByDay('2026-05-21');
    await new FlowViewsRepo({ db }).productionByDay('2026-05-21');
    await new FlowViewsRepo({ db }).pnpByDay('2026-05-21');
    await new FlowViewsRepo({ db }).supportByDay('2026-05-21');
    await new DeadlinesRepo({ db }).list();
    expect(db.calls.length).toBeGreaterThan(0);
    expect(db.calls.every((c) => !/\b(INSERT|UPDATE|DELETE)\b/i.test(c.sql))).toBe(true);
  });
});
