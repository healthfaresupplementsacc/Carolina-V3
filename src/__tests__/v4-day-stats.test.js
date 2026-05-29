'use strict';
/**
 * V4 day-stats — testes do helper que substitui a soma simples por união
 * de intervalos e expressa métricas em conceitos do negócio.
 *
 * Cenário canônico: Bruno Sarmento 28/mai/2026.
 *  - Soma simples = 17h52
 *  - Wall-clock real (presença) = 8h57 (9:49 AM → 6:46 PM = última fg ev303)
 *  - Lunch 13:55→16:44 = 2h49
 *  - Ativo = 8:57 − 2:49 = 6:08
 * (Casos com over-clip do lunch por F-implicito pra eod ficam mostrados
 * mas o cálculo continua válido — ativo nunca negativo.)
 */

const path = require('path');
const DS = require(path.join(__dirname, '..', '..',
  'dashboard-v4', 'src', 'utils', 'day-stats.cjs'));
const {
  mergeIntervals, subtractIntervals,
  personPresence, productionTime, supportBreakdown,
  idleRanking, openTasksByOp, coworkStats, lotesEnriched,
  BREAK_SLUGS, STOPPAGE_SLUGS,
} = DS;

const ACTIVITIES = {
  production_line:       { flow: 'production' },
  encapsulation:         { flow: 'production' },
  formulation:           { flow: 'production' },
  mixing:                { flow: 'production' },
  marketplace_prep:      { flow: 'production' },
  line_changeover:       { flow: 'production' },
  cleaning:              { flow: 'support' },
  facility_maintenance:  { flow: 'support' },
  organization:          { flow: 'support' },
  material_handling:     { flow: 'support' },
  meeting:               { flow: 'support' },
  lunch:                 { flow: 'support' },
  break:                 { flow: 'support' },
  end_of_day:            { flow: 'support' },
  machine_downtime:      { flow: 'support' },
  orders:                { flow: 'pnp' },
};

const OPS = [
  { id: 'p7', short: 'BS', name: 'Bruno Sarmento', c1: '#1e3f8c' },
  { id: 'p4', short: 'V',  name: 'Vitor',          c1: '#22b35d' },
  { id: 'p1', short: 'A',  name: 'Ana',            c1: '#7c5cd6' },
  { id: 'p5', short: 'S',  name: 'Simone',         c1: '#2855ad' },
];

describe('mergeIntervals', () => {
  test('soma intervalos disjuntos', () => {
    const { total } = mergeIntervals([[0, 10], [20, 30]]);
    expect(total).toBe(20);
  });
  test('une intervalos sobrepostos', () => {
    const { merged, total } = mergeIntervals([[0, 10], [5, 15], [12, 20]]);
    expect(merged).toEqual([[0, 20]]);
    expect(total).toBe(20);
  });
  test('intervalos contíguos viram um só', () => {
    const { merged, total } = mergeIntervals([[0, 10], [10, 20]]);
    expect(merged).toEqual([[0, 20]]);
    expect(total).toBe(20);
  });
  test('descarta lixo (b <= a, NaN)', () => {
    const { total } = mergeIntervals([[10, 10], [20, 5], [NaN, 100], null]);
    expect(total).toBe(0);
  });
  test('lista vazia', () => {
    expect(mergeIntervals([]).total).toBe(0);
    expect(mergeIntervals(null).total).toBe(0);
  });
});

describe('subtractIntervals', () => {
  test('subtrai pedaço do meio', () => {
    const { merged, total } = subtractIntervals([[0, 100]], [[40, 60]]);
    expect(merged).toEqual([[0, 40], [60, 100]]);
    expect(total).toBe(80);
  });
  test('subtrai todo o intervalo', () => {
    const { total } = subtractIntervals([[10, 20]], [[0, 100]]);
    expect(total).toBe(0);
  });
  test('subtrai pedaço fora — sem efeito', () => {
    const { total } = subtractIntervals([[0, 50]], [[60, 80]]);
    expect(total).toBe(50);
  });
  test('múltiplos subs', () => {
    const { total } = subtractIntervals([[0, 100]], [[10, 20], [30, 40], [80, 95]]);
    expect(total).toBe(100 - 10 - 10 - 15);
  });
});

describe('personPresence — Bruno Sarmento 28/mai (com end_of_day clamp)', () => {
  // Dados resumidos do diag: primeira fg 9:49, última fg 18:46 = 6:46 PM,
  // lunch 13:55→16:44 (2h49). end_of_day 18:46 instantâneo (pós-fix
  // bloco 28/mai noite #32 — antes era LIVE).
  const NOW = 20 * 60 + 54;  // 8:54 PM
  const events = [
    { op: 'p7', activity: 'production_line',     started_min: 9 * 60 + 49,  ended_min: 9 * 60 + 52,  _flow: 'production' },
    { op: 'p7', activity: 'cleaning',            started_min: 10 * 60 + 50, ended_min: 12 * 60 + 11, _flow: 'support' },
    { op: 'p7', activity: 'mixing',              started_min: 12 * 60 + 5,  ended_min: 13 * 60 + 14, _flow: 'production', _is_background: true },
    { op: 'p7', activity: 'encapsulation',       started_min: 13 * 60 + 23, ended_min: 16 * 60 + 42, _flow: 'production', _is_background: true },
    { op: 'p7', activity: 'lunch',               started_min: 13 * 60 + 55, ended_min: 16 * 60 + 44, _flow: 'support' },
    { op: 'p7', activity: 'production_line',     started_min: 17 * 60 + 31, ended_min: 18 * 60 + 46, _flow: 'production' },
    { op: 'p7', activity: 'end_of_day',          started_min: 18 * 60 + 46, ended_min: 18 * 60 + 46, _flow: 'support' },
  ];
  test('first/last/presence — lastMin é o end_of_day, não NOW', () => {
    const r = personPresence('p7', events, NOW);
    expect(r.firstMin).toBe(9 * 60 + 49);
    expect(r.endOfDayMin).toBe(18 * 60 + 46);
    expect(r.lastMin).toBe(18 * 60 + 46);    // 6:46 PM, não 8:54 PM (NOW)
    expect(r.presenceMin).toBe((18 * 60 + 46) - (9 * 60 + 49));  // 8h57
  });
  test('break extraído do lunch', () => {
    const r = personPresence('p7', events, NOW);
    expect(r.breakMin).toBe((16 * 60 + 44) - (13 * 60 + 55));   // 2h49 = 169
  });
  test('active = presence − break (caso real Bruno = 6h08)', () => {
    const r = personPresence('p7', events, NOW);
    expect(r.activeMin).toBe(r.presenceMin - r.breakMin);
    expect(r.activeMin).toBe((18 * 60 + 46) - (9 * 60 + 49) - ((16 * 60 + 44) - (13 * 60 + 55)));
  });
  test('sem eventos: tudo zero', () => {
    const r = personPresence('p99', [], NOW);
    expect(r).toEqual({ firstMin: null, lastMin: null, presenceMin: 0, breakMin: 0, activeMin: 0, breakEvents: [], endOfDayMin: null });
  });
});

describe('personPresence — end_of_day clamp (bloco 28/mai noite #32)', () => {
  // Caso real Bruno Sarmento: 9:49 AM → 6:46 PM end_of_day. Sem o clamp,
  // ev305 LIVE empurra lastMin pra NOW e infla presença.
  test('com end_of_day, lastMin = horário do end_of_day, não NOW', () => {
    const NOW = 22 * 60;  // 10 PM
    const events = [
      { op: 'p7', activity: 'production_line', started_min: 9 * 60 + 49,  ended_min: 18 * 60 + 46, _flow: 'production' },
      { op: 'p7', activity: 'end_of_day',      started_min: 18 * 60 + 46, ended_min: 18 * 60 + 46, _flow: 'support' },
    ];
    const r = personPresence('p7', events, NOW);
    expect(r.endOfDayMin).toBe(18 * 60 + 46);
    expect(r.lastMin).toBe(18 * 60 + 46);   // não NOW
    expect(r.presenceMin).toBe((18 * 60 + 46) - (9 * 60 + 49));  // 8h57
  });

  test('end_of_day LIVE (ended_at=null bug histórico) também clampa pelo started', () => {
    const NOW = 22 * 60;
    const events = [
      { op: 'p7', activity: 'production_line', started_min: 9 * 60 + 49, ended_min: 18 * 60 + 46, _flow: 'production' },
      { op: 'p7', activity: 'end_of_day',      started_min: 18 * 60 + 46, ended_min: null,        _flow: 'support' },
    ];
    const r = personPresence('p7', events, NOW);
    expect(r.endOfDayMin).toBe(18 * 60 + 46);
    expect(r.lastMin).toBe(18 * 60 + 46);
  });

  test('outro event LIVE após end_of_day NÃO empurra a presença pra NOW', () => {
    const NOW = 22 * 60;
    const events = [
      { op: 'p7', activity: 'production_line', started_min: 9 * 60,  ended_min: null,        _flow: 'production' },  // bug histórico: fg LIVE não fechado
      { op: 'p7', activity: 'end_of_day',      started_min: 18 * 60, ended_min: 18 * 60,     _flow: 'support' },
    ];
    const r = personPresence('p7', events, NOW);
    expect(r.endOfDayMin).toBe(18 * 60);
    expect(r.lastMin).toBe(18 * 60);  // o fg LIVE foi clampado pelo end_of_day
  });

  test('break LIVE também clampa pelo end_of_day', () => {
    const NOW = 22 * 60;
    const events = [
      { op: 'p7', activity: 'production_line', started_min: 9 * 60,  ended_min: 12 * 60,         _flow: 'production' },
      { op: 'p7', activity: 'lunch',           started_min: 12 * 60, ended_min: null,            _flow: 'support' },  // lunch sem F
      { op: 'p7', activity: 'end_of_day',      started_min: 18 * 60, ended_min: 18 * 60,         _flow: 'support' },
    ];
    const r = personPresence('p7', events, NOW);
    // lunch clampado em 18h: lunch = 12→18 = 360 min
    expect(r.breakMin).toBe(6 * 60);
    expect(r.lastMin).toBe(18 * 60);
    expect(r.activeMin).toBe((18 * 60 - 9 * 60) - (6 * 60));  // 9h - 6h = 3h
  });

  test('sem end_of_day, comportamento antigo: LIVE usa NOW', () => {
    const NOW = 16 * 60;  // 4 PM
    const events = [
      { op: 'p7', activity: 'production_line', started_min: 9 * 60, ended_min: null, _flow: 'production' },
    ];
    const r = personPresence('p7', events, NOW);
    expect(r.endOfDayMin).toBeNull();
    expect(r.lastMin).toBe(NOW);
  });
});

describe('productionTime — wall-clock real e paradas', () => {
  const NOW = 18 * 60;
  test('wall-clock une intervalos sobrepostos (cowork)', () => {
    const events = [
      { op: 'p7', activity: 'production_line', started_min: 10 * 60, ended_min: 12 * 60 },
      { op: 'p4', activity: 'production_line', started_min: 11 * 60, ended_min: 13 * 60 },
      { op: 'p1', activity: 'production_line', started_min: 12 * 60 + 30, ended_min: 14 * 60 },
    ];
    const r = productionTime(events, NOW, ACTIVITIES);
    expect(r.wallClockMin).toBe(4 * 60);     // 10:00 → 14:00 = 4h
  });
  test('parada dentro de produção é subtraída', () => {
    const events = [
      { op: 'p4', activity: 'production_line',  started_min: 10 * 60, ended_min: 14 * 60 },
      { op: 'p7', activity: 'line_changeover',  started_min: 11 * 60, ended_min: 11 * 60 + 30 },
    ];
    const r = productionTime(events, NOW, ACTIVITIES);
    expect(r.wallClockMin).toBe(4 * 60);
    expect(r.stoppageMin).toBe(30);
    expect(r.effectiveMin).toBe(4 * 60 - 30);
    expect(r.stoppageBySlug.line_changeover).toBe(30);
  });
  test('parada fora de produção não conta no stoppage da produção', () => {
    const events = [
      { op: 'p4', activity: 'production_line', started_min: 10 * 60, ended_min: 12 * 60 },
      { op: 'p7', activity: 'machine_downtime', started_min: 14 * 60, ended_min: 15 * 60 },
    ];
    const r = productionTime(events, NOW, ACTIVITIES);
    expect(r.stoppageMin).toBe(0);   // não overlapa produção
    expect(r.stoppageBySlug.machine_downtime).toBe(60);
  });
});

describe('supportBreakdown', () => {
  const NOW = 19 * 60;
  test('separa cleaning eod (após última produção do op) vs day', () => {
    const events = [
      { op: 'p7', activity: 'cleaning',        started_min: 10 * 60, ended_min: 10 * 60 + 30, _flow: 'support' },
      { op: 'p7', activity: 'production_line', started_min: 11 * 60, ended_min: 17 * 60,      _flow: 'production' },
      { op: 'p7', activity: 'cleaning',        started_min: 17 * 60, ended_min: 17 * 60 + 45, _flow: 'support' },  // eod
    ];
    const r = supportBreakdown(events, NOW, ACTIVITIES);
    expect(r.cleaningDay).toBe(30);
    expect(r.cleaningEod).toBe(45);
    expect(r.cleaningTotal).toBe(75);
  });
  test('agrupa manutenção (facility + repair)', () => {
    const events = [
      { op: 'p7', activity: 'facility_maintenance', started_min: 9 * 60,  ended_min: 9 * 60 + 30,  _flow: 'support' },
      { op: 'p4', activity: 'repair',               started_min: 10 * 60, ended_min: 10 * 60 + 15, _flow: 'support' },
    ];
    const r = supportBreakdown(events, NOW, ACTIVITIES);
    expect(r.maintenance).toBe(45);
  });
});

describe('idleRanking', () => {
  const NOW = 18 * 60;
  test('quem teve gap maior fica em cima', () => {
    const events = [
      { op: 'p7', activity: 'production_line', started_min: 9 * 60,  ended_min: 10 * 60 },
      { op: 'p7', activity: 'production_line', started_min: 11 * 60, ended_min: 12 * 60 },   // gap 60min
      { op: 'p4', activity: 'production_line', started_min: 9 * 60,  ended_min: 12 * 60 },   // sem gap
    ];
    const r = idleRanking(events, NOW, OPS, 25);
    const bs = r.find((x) => x.opId === 'p7');
    const v  = r.find((x) => x.opId === 'p4');
    expect(bs.idleMin).toBe(60);
    expect(v.idleMin).toBe(0);
    expect(r[0].opId).toBe('p7');
  });
  test('threshold filtra gaps pequenos', () => {
    const events = [
      { op: 'p4', activity: 'production_line', started_min: 9 * 60,  ended_min: 10 * 60 },
      { op: 'p4', activity: 'production_line', started_min: 10 * 60 + 10, ended_min: 11 * 60 },   // gap 10min < 25
    ];
    const r = idleRanking(events, NOW, OPS, 25);
    expect(r.find((x) => x.opId === 'p4').idleMin).toBe(0);
  });
});

describe('openTasksByOp', () => {
  test('conta apenas LIVE excluindo end_of_day', () => {
    const events = [
      { op: 'p7', activity: 'production_line', started_min: 9 * 60,  ended_min: null },
      { op: 'p7', activity: 'mixing',          started_min: 10 * 60, ended_min: null, _is_background: true },
      { op: 'p7', activity: 'end_of_day',      started_min: 18 * 60, ended_min: null },
      { op: 'p4', activity: 'production_line', started_min: 9 * 60,  ended_min: 10 * 60 },
    ];
    const r = openTasksByOp(events, OPS);
    expect(r.find((x) => x.opId === 'p7').count).toBe(2);
    expect(r.find((x) => x.opId === 'p4')).toBeUndefined();
  });
});

describe('coworkStats', () => {
  test('conta events com cowork não vazio', () => {
    const r = coworkStats([
      { op: 'p7', cowork: ['p4'] },
      { op: 'p7', cowork: [] },
      { op: 'p1', cowork: ['p7', 'p4'] },
    ]);
    expect(r.total).toBe(2);
    expect(r.byOp.p7).toBe(1);
    expect(r.byOp.p1).toBe(1);
  });
});

describe('lotesEnriched', () => {
  test('enriquece com fase atual + cowork + qty', () => {
    const raw = [
      { batch_id: 165, batch_number: 'BR-0165', product: { canonical_name: 'Melatonin' }, total_seconds: 3600, phases: [{}, {}] },
    ];
    const events = [
      { op: 'p7', product: 'b165', activity: 'formulation',  started_min: 10 * 60, ended_min: 11 * 60, _flow: 'production', cowork: ['p4'], qty: 0 },
      { op: 'p7', product: 'b165', activity: 'encapsulation', started_min: 12 * 60, ended_min: null,    _flow: 'production', cowork: [],     qty: 500 },
    ];
    const [lote] = lotesEnriched(raw, events);
    expect(lote.product_name).toBe('Melatonin');
    expect(lote.current_phase_slug).toBe('encapsulation');
    expect(lote.qty).toBe(500);
    expect(lote.is_live).toBe(true);
    expect(new Set(lote.people_ops)).toEqual(new Set(['p7', 'p4']));
  });
});

describe('canonical sets', () => {
  test('BREAK_SLUGS', () => {
    expect(BREAK_SLUGS.has('lunch')).toBe(true);
    expect(BREAK_SLUGS.has('break')).toBe(true);
    expect(BREAK_SLUGS.has('end_of_day')).toBe(false);
  });
  test('STOPPAGE_SLUGS', () => {
    for (const s of ['machine_downtime', 'line_changeover', 'facility_maintenance', 'repair']) {
      expect(STOPPAGE_SLUGS.has(s)).toBe(true);
    }
  });
});
