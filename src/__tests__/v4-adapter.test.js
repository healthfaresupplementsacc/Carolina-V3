'use strict';
/**
 * V4 adapter — testes de mapping. Roda com Jest no projeto raiz.
 * Requer o .cjs do dashboard-v4 diretamente (sem Vite). Garante que o shape
 * que sai do /api/v3/data/* vira o HFData que o template V4 espera.
 *
 * Sem DB, sem rede — só transformação pura. Cobertura:
 *   - operators a partir de catalog.persons (preferido) + timeline (fallback)
 *   - events com cowork, qty, started/ended_min, batch→product key
 *   - activities a partir do catálogo + inferido do event
 *   - goals com bateu/pct/duplicatas
 *   - alerts derivados (dup/invalid/downtime/open)
 *   - PP block + DEADLINE_MIN do mais cedo
 *   - FLOWS canônicos
 *   - payload vazio não estoura
 */

const path = require('path');
const ADAPTER = require(path.join(__dirname, '..', '..',
  'dashboard-v4', 'src', 'adapters', 'adapt-to-hfdata.cjs'));
const { adaptToHFData, isoToNyMin, hhmmToMin, slugify, colorPair, initials } = ADAPTER;

describe('V4 adapter — helpers', () => {
  test('isoToNyMin extrai HH:MM do ISO com offset', () => {
    expect(isoToNyMin('2026-05-25T08:35:00-04:00')).toBe(8 * 60 + 35);
    expect(isoToNyMin('2026-05-25T14:00:00-04:00')).toBe(14 * 60);
    expect(isoToNyMin('2026-05-25T00:01:00-05:00')).toBe(1);
    expect(isoToNyMin(null)).toBeNull();
    expect(isoToNyMin('')).toBeNull();
  });

  test('hhmmToMin parseia "HH:MM"', () => {
    expect(hhmmToMin('16:00')).toBe(960);
    expect(hhmmToMin('08:05')).toBe(485);
    expect(hhmmToMin('25:99')).toBe(25 * 60 + 99); // sem clamp — adapter assume input válido
    expect(hhmmToMin(null)).toBeNull();
    expect(hhmmToMin('lixo')).toBeNull();
  });

  test('slugify normaliza acento e espaços', () => {
    expect(slugify('Mix & Formulação')).toBe('mix_formulacao');
    expect(slugify('  Encapsulação  ')).toBe('encapsulacao');
    expect(slugify('')).toBe('unknown');
    expect(slugify(null)).toBe('unknown');
  });

  test('colorPair é determinístico por person_id', () => {
    const a = colorPair(7);
    const b = colorPair(7);
    expect(a).toEqual(b);
    expect(Array.isArray(a) && a.length === 2).toBe(true);
  });

  test('initials cobre 1 e 2 palavras', () => {
    expect(initials('Vitor')).toBe('V');
    expect(initials('Bruno Sarmento')).toBe('BS');
    expect(initials('')).toBe('?');
    expect(initials(null)).toBe('?');
  });
});

describe('V4 adapter — adaptToHFData (payload vazio)', () => {
  test('aceita input vazio sem estourar', () => {
    const out = adaptToHFData({});
    expect(out.operators).toEqual([]);
    expect(out.events).toEqual([]);
    expect(out.goals).toEqual([]);
    expect(out.alerts).toEqual([]);
    expect(out.products).toEqual({});
    expect(out.FLOWS).toHaveProperty('production');
    expect(out.FLOWS).toHaveProperty('pnp');
    expect(out.FLOWS).toHaveProperty('support');
    expect(out.DAY_START).toBe(8 * 60);
    expect(out.DAY_END).toBe(18 * 60);
    expect(out.DEADLINE_MIN).toBe(16 * 60); // default 4PM quando não há deadline
    expect(out.pp.total_minutes).toBe(0);
  });
});

describe('V4 adapter — operators (E7: só quem postou hoje)', () => {
  test('catalog.persons NÃO popula operators sozinho — admins filtrados', () => {
    // Bruno Camp, Thassio = admins (nunca postam event). Aparecem no catálogo
    // mas NÃO devem aparecer na timeline/lista de pessoas. Regra E7.
    const out = adaptToHFData({
      catalog: { persons: [
        { id: 10, display_name: 'Bruno Camp', role: 'Admin',          active: true },
        { id: 11, display_name: 'Thassio',    role: 'Admin',          active: true },
        { id: 1,  display_name: 'Ana',        role: 'Revisão',        active: true },
      ] },
      // sem timeline.people → ninguém postou → operators vazio mesmo com catálogo cheio
    });
    expect(out.operators).toEqual([]);
  });

  test('timeline.people é a fonte ÚNICA de operators (ordenado por nome PT)', () => {
    const out = adaptToHFData({
      timeline: { people: [
        { person_id: 3, display_name: 'Vitor',          role: 'Linha',      events: [] },
        { person_id: 1, display_name: 'Ana',            role: 'Revisão',    events: [] },
        { person_id: 2, display_name: 'Bruno Sarmento', role: 'Formulação', events: [] },
      ] },
    });
    expect(out.operators.map((o) => o.name)).toEqual(['Ana', 'Bruno Sarmento', 'Vitor']);
    expect(out.operators[0].id).toBe('p1');
    expect(out.operators[1].short).toBe('BS');
    expect(out.operators[0].c1).toBeDefined();
  });

  test('catalog + timeline juntos: só quem está em timeline aparece (admins do catálogo são descartados)', () => {
    const out = adaptToHFData({
      catalog: { persons: [
        { id: 10, display_name: 'Bruno Camp',     role: 'Admin', active: true },  // admin → descartado
        { id: 11, display_name: 'Thassio',        role: 'Admin', active: true },  // admin → descartado
        { id: 1,  display_name: 'Ana',            role: 'Revisão', active: true }, // posta → fica
        { id: 2,  display_name: 'Bruno Sarmento', role: 'Formulação', active: true }, // posta → fica
      ] },
      timeline: { people: [
        { person_id: 1, display_name: 'Ana',            role: 'Revisão',    events: [] },
        { person_id: 2, display_name: 'Bruno Sarmento', role: 'Formulação', events: [] },
      ] },
    });
    expect(out.operators).toHaveLength(2);
    expect(out.operators.map((o) => o.name).sort()).toEqual(['Ana', 'Bruno Sarmento']);
    expect(out.operators.map((o) => o.id).sort()).toEqual(['p1', 'p2']);
  });
});

describe('V4 adapter — events', () => {
  const TIMELINE = {
    date: '2026-05-25',
    people: [
      {
        person_id: 1, display_name: 'Ana', role: 'Revisão',
        idle_seconds: 600, unreported_seconds: 0, unreported_since: null,
        events: [
          {
            event_id: 101,
            activity: { id: 7, slug: 'review', display_name: 'Revisão', flow: 'production',
                        is_background: false, expected_seconds: 3600, phase_order: 5, category: 'qa' },
            flow: 'production',
            started_at: '2026-05-25T08:30:00-04:00',
            ended_at:   '2026-05-25T10:00:00-04:00',
            confidence: 'high', cowork_with: [3],
            product_batch_id: 42,
            quantity: 250, quantity_unit: 'bottle',
            description: '', source_message_ts: '17481.001',
          },
        ],
      },
      {
        person_id: 3, display_name: 'Vitor', role: 'Linha',
        idle_seconds: 0, unreported_seconds: 7200, unreported_since: '2026-05-25T13:00:00-04:00',
        events: [
          { // event aberto (live)
            event_id: 202,
            activity: { id: 11, slug: 'production_line', display_name: 'Linha', flow: 'production',
                        is_background: false, expected_seconds: 5400 },
            flow: 'production',
            started_at: '2026-05-25T12:50:00-04:00',
            ended_at: null,
            cowork_with: [1],
            product_batch_id: 42,
            description: 'tribulus em curso',
          },
        ],
      },
    ],
  };

  test('shape de event normalizado', () => {
    const out = adaptToHFData({ timeline: TIMELINE });
    const ev101 = out.events.find((e) => e.id === 101);
    expect(ev101).toBeDefined();
    expect(ev101.op).toBe('p1');
    expect(ev101.started_min).toBe(8 * 60 + 30);
    expect(ev101.ended_min).toBe(10 * 60);
    expect(ev101.activity).toBe('review');
    expect(ev101.product).toBe('b42');
    expect(ev101.cowork).toEqual(['p3']);
    expect(ev101.qty).toBe(250);
    expect(ev101.unit).toBe('bottle');
    expect(ev101._flow).toBe('production');
  });

  test('event aberto (live): ended_min = null', () => {
    const out = adaptToHFData({ timeline: TIMELINE });
    const ev202 = out.events.find((e) => e.id === 202);
    expect(ev202.ended_min).toBeNull();
    expect(ev202._ended_at).toBeNull();
  });

  test('activities recebe entries inferidas dos events sem catálogo', () => {
    const out = adaptToHFData({ timeline: TIMELINE });
    expect(out.activities.review).toBeDefined();
    expect(out.activities.review.flow).toBe('production');
    expect(out.activities.review.expected).toBe(60); // 3600s → 60min
    expect(out.activities.production_line).toBeDefined();
  });

  test('gaps são propagados por pessoa', () => {
    const out = adaptToHFData({ timeline: TIMELINE });
    expect(out._gaps.p1.idle_seconds).toBe(600);
    expect(out._gaps.p3.unreported_seconds).toBe(7200);
    expect(out._gaps.p3.unreported_since).toBe('2026-05-25T13:00:00-04:00');
  });
});

describe('V4 adapter — products + lotes', () => {
  test('production.lotes vira products keyed por b<batch_id>', () => {
    const out = adaptToHFData({
      production: { lotes: [
        { batch_id: 42, batch_number: 'BR-2026-0145',
          product: { id: 9, canonical_name: 'Tribulus Terrestris', category: 'Hormone' },
          total_seconds: 3600, invalid_event_count: 0, people: ['Vitor'], phases: [] },
        { batch_id: null, batch_number: null, product: null,
          total_seconds: 0, invalid_event_count: 2, people: [], phases: [] },
      ] },
    });
    expect(out.products.b42).toBeDefined();
    expect(out.products.b42.name).toBe('Tribulus Terrestris');
    expect(out.products.b42.batch).toBe('BR-2026-0145');
    // lote sem batch_id é descartado
    expect(Object.keys(out.products)).toEqual(['b42']);
  });
});

describe('V4 adapter — goals', () => {
  test('mapeia esperado/realizado/bateu do shape V3', () => {
    const out = adaptToHFData({
      goals: { goals: [
        { goal_id: 1, product: { id: 9, canonical_name: 'Tribulus' },
          batch_number: 'BR-2026-0145', unit: 'bottle',
          esperado: 750, realizado: 468, pct_atingido: 62, bateu: false,
          duplicatas_suspeitas: [{ count_id: 99 }], batch_id: 42 },
        { goal_id: 2, product: { id: 10, canonical_name: 'Ashwa' },
          batch_number: 'BR-2026-0157', unit: 'bottle',
          esperado: 600, realizado: 612, pct_atingido: 102, bateu: true,
          duplicatas_suspeitas: [], batch_id: 43 },
      ] },
    });
    expect(out.goals).toHaveLength(2);
    expect(out.goals[0].product).toBe('b42');
    expect(out.goals[0].target).toBe(750);
    expect(out.goals[0].done).toBe(468);
    expect(out.goals[0].completed).toBe(false);
    expect(out.goals[0].pct).toBe(62);
    expect(out.goals[1].completed).toBe(true);
  });
});

describe('V4 adapter — alerts derivados', () => {
  test('soma duplicatas + invalid + downtime + open', () => {
    const out = adaptToHFData({
      goals: { goals: [
        { goal_id: 1, esperado: 100, realizado: 50,
          duplicatas_suspeitas: [{ count_id: 1 }, { count_id: 2 }] },
      ] },
      production: { lotes: [{ batch_id: 1, invalid_event_count: 3, total_seconds: 0, phases: [] }] },
      pp: { total_seconds: 0, orders: 0, seconds_per_order: 0, invalid_event_count: 1 },
      support: { occurrences: [
        { event_id: 1, activity: 'conserto', person: 'Bruno',
          started_at: '2026-05-25T09:00:00-04:00', ended_at: '2026-05-25T10:00:00-04:00',
          seconds: 3600, is_downtime: true },
      ] },
      timeline: { people: [
        { person_id: 1, display_name: 'Ana', events: [
          { event_id: 99, activity: { slug: 'x', display_name: 'X', flow: 'support' },
            flow: 'support', started_at: '2026-05-25T08:00:00-04:00', ended_at: null },
        ] },
      ] },
    });
    const ids = out.alerts.map((a) => a.id).sort();
    expect(ids).toEqual(['down', 'dup', 'inv', 'open']);
    expect(out.alerts.find((a) => a.id === 'dup').detail).toMatch(/2/);
    expect(out.alerts.find((a) => a.id === 'inv').detail).toMatch(/4/); // 3+1
    expect(out.alerts.find((a) => a.id === 'down').detail).toMatch(/1/);
    expect(out.alerts.find((a) => a.id === 'open').detail).toMatch(/1/);
  });
});

describe('V4 adapter — DEADLINE_MIN', () => {
  test('pega o mais cedo dos deadlines ativos', () => {
    const out = adaptToHFData({
      deadlines: { deadlines: [
        { id: 1, label: 'DC',    time_of_day: '15:00', active: true },
        { id: 2, label: 'Correio', time_of_day: '16:00', active: true },
        { id: 3, label: 'Clínica', time_of_day: '11:30', active: true },
        { id: 4, label: 'Inativo', time_of_day: '07:00', active: false }, // ignorado
      ] },
    });
    expect(out.DEADLINE_MIN).toBe(11 * 60 + 30);
    expect(out.pp.deadline_min).toBe(11 * 60 + 30);
  });

  test('sem deadlines → fallback 16:00', () => {
    const out = adaptToHFData({});
    expect(out.DEADLINE_MIN).toBe(16 * 60);
    expect(out.pp.deadline_min).toBeNull();
  });
});

describe('V4 adapter — PP block', () => {
  test('total_seconds → total_minutes (round)', () => {
    const out = adaptToHFData({
      pp: { total_seconds: 12_300, orders: 475, seconds_per_order: 26 },
    });
    expect(out.pp.total_minutes).toBe(205); // 12300/60 = 205
    expect(out.pp.orders).toBe(475);
    expect(out.pp.seconds_per_order).toBe(26);
  });
});

describe('V4 adapter — _meta de fonte', () => {
  test('flags has_* refletem quais payloads chegaram', () => {
    const out = adaptToHFData({
      timeline: { people: [] }, production: { lotes: [] },
      pp: { total_seconds: 0 }, goals: { goals: [] },
      deadlines: { deadlines: [] },
      catalog: { persons: [], activity_types: [] },
      date: '2026-05-25',
    });
    expect(out._meta.date).toBe('2026-05-25');
    expect(out._meta.has_timeline).toBe(true);
    expect(out._meta.has_pp).toBe(true);
    expect(out._meta.has_goals).toBe(true);
    expect(out._meta.has_catalog).toBe(true);
  });
});
