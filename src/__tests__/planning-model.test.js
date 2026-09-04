'use strict';
/**
 * planning/model.js — o funil do Planejamento (Bruno 09-04, direção corrigida).
 *
 *  A. classify(): as 7 regras de estágio, com as bordas que importam:
 *     finalized + 0 reviews = Esperando revisão (finalized NÃO é produzido);
 *     review aberto = Em revisão; reviews fechados + 0 line = Pronto;
 *     line > 0 = Produzido; stock_box com o lote = Encaixotado;
 *     manual_boxed sobrepõe tudo; estágio desconhecido cai em Formulando.
 *  B. daysBetween/stageSince: a matemática de "dias no estágio".
 *  C. board() com db fake: 7 colunas na ordem do Bruno, contagens, quem está
 *     no lote, garrafas do production_counts, fila viva do pipeline (na_fila),
 *     EMS fora do ar → ems_ok false e o quadro segue só com o cache.
 *  D. COMPAT: createPlanningModel()._velocityByProduct continua existindo
 *     (src/v3/stock/interim-days.js depende — days_of_stock interino D-6).
 */
const {
  classify, stageSince, daysBetween, COLUMNS,
  createPlanningBoard, createPlanningModel,
} = require('../v3/planning/model');

const base = {
  stage: null, review_count: 0, review_open: 0, line_count: 0,
  boxed_auto: false, manual_boxed: false,
};

describe('classify — as 7 regras do funil', () => {
  test('1. weighing/weighed = Formulando', () => {
    expect(classify({ ...base, stage: 'weighing' })).toBe('formulating');
    expect(classify({ ...base, stage: 'weighed' })).toBe('formulating');
  });
  test('1b. estágio desconhecido/ausente cai em Formulando', () => {
    expect(classify({ ...base, stage: null })).toBe('formulating');
    expect(classify({ ...base, stage: 'algo_novo_do_ems' })).toBe('formulating');
  });
  test('2. encapsulating = Encapsulando', () => {
    expect(classify({ ...base, stage: 'encapsulating' })).toBe('encapsulating');
  });
  test('3. BORDA CRÍTICA: finalized + zero reviews = Esperando revisão (não Produzido)', () => {
    expect(classify({ ...base, stage: 'finalized' })).toBe('waiting');
  });
  test('3b. todos os estágios pós-encapsuladora sem review = Esperando revisão', () => {
    for (const s of ['yield_review', 'to_separate', 'label_printing', 'finalized']) {
      expect(classify({ ...base, stage: s })).toBe('waiting');
    }
  });
  test('4. review ABERTO = Em revisão (mesmo com estágio EMS finalized)', () => {
    expect(classify({ ...base, stage: 'finalized', review_count: 2, review_open: 1 })).toBe('revising');
  });
  test('5. reviews fechados + zero production_line = Pronto pra produção', () => {
    expect(classify({ ...base, stage: 'finalized', review_count: 1, review_open: 0 })).toBe('ready');
  });
  test('6. production_line > 0 = Produzido (vence review aberto: completude manda)', () => {
    expect(classify({ ...base, stage: 'finalized', review_count: 1, line_count: 3 })).toBe('produced');
    expect(classify({ ...base, stage: 'finalized', review_count: 1, review_open: 1, line_count: 1 })).toBe('produced');
  });
  test('7. stock_box com o lote = Encaixotado (vence Produzido)', () => {
    expect(classify({ ...base, stage: 'finalized', review_count: 1, line_count: 3, boxed_auto: true })).toBe('boxed');
  });
  test('7b. manual_boxed sobrepõe tudo (o único toque manual do quadro)', () => {
    expect(classify({ ...base, stage: 'weighing', manual_boxed: true })).toBe('boxed');
  });
  test('conta como string (COUNT do pg vem string) ainda classifica certo', () => {
    expect(classify({ ...base, stage: 'finalized', review_count: '2', review_open: '0', line_count: '0' })).toBe('ready');
    expect(classify({ ...base, stage: 'finalized', review_count: '1', review_open: '1' })).toBe('revising');
  });
});

describe('dias no estágio', () => {
  const now = Date.parse('2026-09-04T12:00:00Z');
  test('daysBetween arredonda pra 1 casa e nunca é negativo', () => {
    expect(daysBetween('2026-09-01T12:00:00Z', now)).toBe(3);
    expect(daysBetween('2026-09-04T00:00:00Z', now)).toBe(0.5);
    expect(daysBetween('2026-09-05T12:00:00Z', now)).toBe(0); // futuro = 0, não -1
    expect(daysBetween(null, now)).toBe(null);
  });
  test('stageSince escolhe a âncora certa por coluna', () => {
    const b = {
      ems_started_at: 'A', ems_ended_at: 'B', first_seen_at: 'C', last_synced_at: 'D',
      review_open_since: 'E', review_last_end: 'F', line_last_start: 'G', boxed_at: 'H',
    };
    expect(stageSince('formulating', b)).toBe('A');
    expect(stageSince('encapsulating', b)).toBe('A');
    expect(stageSince('waiting', b)).toBe('B');   // desde que o EMS terminou
    expect(stageSince('revising', b)).toBe('E');  // desde que a revisão abriu
    expect(stageSince('ready', b)).toBe('F');     // desde o fim da última revisão
    expect(stageSince('produced', b)).toBe('G');  // desde a última rodada da linha
    expect(stageSince('boxed', b)).toBe('H');     // desde a caixa
    // fallback: sem âncora específica cai no last_synced_at
    expect(stageSince('waiting', { last_synced_at: 'D' })).toBe('D');
  });
});

/** db fake: responde cada query do board() pelo pedaço de SQL. */
function makeDb(state) {
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      state.queries.push(q);
      if (/DISTINCT ON \(c\.batch_number\)/.test(q)) return { rows: state.ems };
      if (/GROUP BY pb\.batch_number/.test(q) && /review_count/.test(q)) return { rows: state.ours };
      if (/e\.ended_at IS NULL AND e\.deleted_at IS NULL/.test(q)) return { rows: state.who };
      if (/FROM v3\.production_counts/.test(q)) return { rows: state.bottles };
      if (/FROM v3\.stock_boxes/.test(q)) return { rows: state.boxes };
      if (/FROM v3\.production_plan_items WHERE plan_date IS NULL/.test(q)) return { rows: state.flags };
      if (/FROM v3\.products WHERE id = ANY/.test(q)) return { rows: state.products };
      return { rows: [] };
    },
  };
}

describe('board() — o quadro inteiro', () => {
  /** Cenário: 1 lote por coluna + 1 da fila viva. */
  const state = {
    queries: [],
    ems: [
      { batch_number: 'B-FORM', stage: 'weighing', supplement_name: 'Ashwagandha',
        ems_started_at: '2026-09-03T10:00:00Z', last_synced_at: '2026-09-04T10:00:00Z' },
      { batch_number: 'B-ENC', stage: 'encapsulating', supplement_name: 'Berberine',
        ems_started_at: '2026-09-04T08:00:00Z', last_synced_at: '2026-09-04T10:00:00Z' },
      { batch_number: 'B-WAIT', stage: 'finalized', supplement_name: 'Charcoal',
        ems_ended_at: '2026-08-30T10:00:00Z', last_synced_at: '2026-09-01T10:00:00Z' },
      { batch_number: 'B-REV', stage: 'finalized', supplement_name: 'NAC',
        last_synced_at: '2026-09-01T10:00:00Z' },
      { batch_number: 'B-READY', stage: 'finalized', supplement_name: 'Omega',
        last_synced_at: '2026-09-01T10:00:00Z' },
      { batch_number: 'B-PROD', stage: 'finalized', supplement_name: 'Zinc',
        actual_bottles: 500, last_synced_at: '2026-09-01T10:00:00Z' },
      { batch_number: 'B-BOX', stage: 'finalized', supplement_name: 'Magnesium',
        last_synced_at: '2026-09-01T10:00:00Z' },
    ],
    ours: [
      { batch_number: 'B-REV', product_id: 4, review_count: '1', review_open: '1',
        review_open_since: '2026-09-04T09:00:00Z', review_last_end: null, line_count: '0', line_last_start: null },
      { batch_number: 'B-READY', product_id: 5, review_count: '2', review_open: '0',
        review_open_since: null, review_last_end: '2026-09-02T15:00:00Z', line_count: '0', line_last_start: null },
      { batch_number: 'B-PROD', product_id: 6, review_count: '1', review_open: '0',
        review_open_since: null, review_last_end: '2026-09-01T15:00:00Z', line_count: '2',
        line_last_start: '2026-09-03T13:00:00Z' },
      { batch_number: 'B-BOX', product_id: 7, review_count: '1', review_open: '0',
        review_open_since: null, review_last_end: null, line_count: '1', line_last_start: '2026-09-02T13:00:00Z' },
    ],
    who: [
      { batch_number: 'B-REV', slug: 'review', name: 'Simone', started_at: '2026-09-04T09:00:00Z' },
      { batch_number: 'B-ENC', slug: 'encapsulation', name: 'Vitor', started_at: '2026-09-04T08:05:00Z' },
    ],
    bottles: [{ batch_number: 'B-PROD', bottles: '480' }],
    boxes: [{ batch_number: 'B-BOX', boxed_at: '2026-09-03T18:00:00Z' }],
    flags: [],
    products: [
      { id: 4, canonical_name: 'NAC 600', nickname: null },
      { id: 5, canonical_name: 'Omega 3', nickname: 'Omega' },
      { id: 6, canonical_name: 'Zinc 50', nickname: null },
      { id: 7, canonical_name: 'Magnesium Citrate', nickname: 'Mag' },
    ],
  };
  const emsClient = {
    configured: () => true,
    pipeline: async () => ({ pending_queue: [
      { batch_number: 'B-QUEUE', supplement_name: 'Turmeric' },
      { batch_number: 'B-FORM', supplement_name: 'Ashwagandha' },  // já no cache → ignorado
    ] }),
  };

  let out;
  beforeAll(async () => {
    out = await createPlanningBoard({ db: makeDb(state), ems: emsClient }).board();
  });

  test('7 colunas na ordem exata do Bruno, com títulos PT-BR', () => {
    expect(out.columns.map((c) => c.id)).toEqual(
      ['formulating', 'encapsulating', 'waiting', 'revising', 'ready', 'produced', 'boxed']);
    expect(out.columns.map((c) => c.title)).toEqual(
      ['Formulando', 'Encapsulando', 'Esperando revisão', 'Em revisão',
        'Pronto pra produção', 'Produzido', 'Encaixotado']);
    expect(COLUMNS.length).toBe(7);
  });
  const col = (id) => out.columns.find((c) => c.id === id);
  test('cada lote caiu na coluna certa; count bate com os cartões', () => {
    expect(col('formulating').cards.map((c) => c.batch_number).sort()).toEqual(['B-FORM', 'B-QUEUE']);
    expect(col('encapsulating').cards.map((c) => c.batch_number)).toEqual(['B-ENC']);
    expect(col('waiting').cards.map((c) => c.batch_number)).toEqual(['B-WAIT']);
    expect(col('revising').cards.map((c) => c.batch_number)).toEqual(['B-REV']);
    expect(col('ready').cards.map((c) => c.batch_number)).toEqual(['B-READY']);
    expect(col('produced').cards.map((c) => c.batch_number)).toEqual(['B-PROD']);
    expect(col('boxed').cards.map((c) => c.batch_number)).toEqual(['B-BOX']);
    for (const c of out.columns) expect(c.count).toBe(c.cards.length);
  });
  test('cartão traz nome (nickname > canonical > supplement_name do EMS)', () => {
    expect(col('waiting').cards[0].product).toBe('Charcoal');       // sem product_id → EMS
    expect(col('ready').cards[0].product).toBe('Omega');            // nickname
    expect(col('produced').cards[0].product).toBe('Zinc 50');       // canonical
  });
  test('quem está no lote agora (evento aberto) aparece no cartão', () => {
    expect(col('revising').cards[0].who).toEqual([
      { name: 'Simone', slug: 'review', since: '2026-09-04T09:00:00Z' }]);
    expect(col('encapsulating').cards[0].who[0].name).toBe('Vitor');
  });
  test('garrafas: production_counts vence actual_bottles do EMS', () => {
    expect(col('produced').cards[0].bottles).toBe(480);
  });
  test('fila viva do pipeline entra em Formulando com na_fila, sem duplicar cache', () => {
    const q = col('formulating').cards.find((c) => c.batch_number === 'B-QUEUE');
    expect(q.na_fila).toBe(true);
    expect(q.product).toBe('Turmeric');
    expect(col('formulating').cards.filter((c) => c.batch_number === 'B-FORM').length).toBe(1);
    expect(out.ems_ok).toBe(true);
  });
  test('manual_boxed sobrepõe: flag do quadro manda o lote pra Encaixotado', async () => {
    const st2 = { ...state, queries: [], flags: [{ batch_number: 'B-PROD', manual_boxed: true }] };
    const out2 = await createPlanningBoard({ db: makeDb(st2), ems: null }).board();
    const boxed = out2.columns.find((c) => c.id === 'boxed');
    expect(boxed.cards.map((c) => c.batch_number).sort()).toEqual(['B-BOX', 'B-PROD']);
    expect(boxed.cards.find((c) => c.batch_number === 'B-PROD').manual_boxed).toBe(true);
  });
  test('EMS fora do ar: ems_ok false e o quadro segue só com o cache', async () => {
    const st3 = { ...state, queries: [] };
    const down = { configured: () => true, pipeline: async () => { throw new Error('timeout'); } };
    const out3 = await createPlanningBoard({ db: makeDb(st3), ems: down }).board();
    expect(out3.ems_ok).toBe(false);
    expect(out3.columns.find((c) => c.id === 'formulating').cards.map((c) => c.batch_number)).toEqual(['B-FORM']);
  });
});

describe('COMPAT interim-days (D-6)', () => {
  test('createPlanningModel()._velocityByProduct segue existindo com a MESMA conta 14d', async () => {
    const seen = [];
    const db = { async query(sql) { seen.push(String(sql)); return { rows: [{ product_id: 9, per_day: '2.5', days_seen: '10' }] }; } };
    const v = await createPlanningModel({ db })._velocityByProduct();
    expect(v.get(9)).toEqual({ perDay: 2.5, daysSeen: 10 });
    expect(seen[0]).toMatch(/\/ 14 AS per_day/);
    expect(seen[0]).toMatch(/status = 'shipped'/);
  });
});
