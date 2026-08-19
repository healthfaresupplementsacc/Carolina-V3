'use strict';
/**
 * REVISÃO DO DIA — /api/v3/review/* (Bruno 08-19).
 *
 * A pergunta que o Bruno fez, virada em teste: "segunda-feira Bruno e Simone
 * revisaram Charcoal — quantas garrafas, quanto tempo, e o Charcoal já rodou na
 * linha?" Mais a barra lateral com tudo que espera revisão.
 *
 *  1. AUTH: PIN válido entra; PIN errado ou ausente → 401.
 *  2. DIA: linha por revisão, com pessoa, garrafas, tempo e o check da linha.
 *  3. GARRAFAS: `events.quantity` (unidade bottle) manda; sem ela cai no
 *     `target_bottles` do lote — e a linha DIZ qual das duas está mostrando.
 *     `quantity_unit='order'` NÃO é garrafa e não pode virar garrafa.
 *  4. TEMPO: WORK_SEC = fim − início − pausas (a mesma conta do reviewRate).
 *  5. LINHA DE PRODUÇÃO: evento 'production_line' OU production_counts já dão o
 *     check; production_counts também traz as garrafas produzidas.
 *  6. REGRA #0: revisão sem lote vinculado APARECE (batch null, on_line false).
 *  7. CALENDÁRIO: só dias com revisão; mês inválido → 400.
 *  8. FILA: vem do EMS (o lote esquecido não tem evento nosso), ordenada com o
 *     não-revisado mais velho no topo; EMS fora do ar → ems_ok:false + espelho
 *     local, nunca 500.
 *
 * Express de verdade num socket efêmero (padrão do prefs-router.test.js); banco
 * falso em memória com linhas realistas. PINs FICTÍCIOS.
 */
const express = require('express');
const { createReviewRouter } = require('../v3/review/router');
const { ReviewService, bottlesOf, flattenStage } = require('../v3/review/service');

const BRUNO_PIN = '111111';    // fictício — login id 1
const BAD_PIN = '000000';      // fictício — não existe

const DAY = '2026-08-17';      // a "segunda-feira" do pedido

// ── linhas de evento cruas, como o SELECT do service devolve ────────────────
// Charcoal, lote CHR-2201: Bruno e Simone revisaram no mesmo dia.
const EVENT_ROWS = [
  {
    // Bruno: disse quantas garrafas revisou (quantity em garrafas).
    event_id: 501, product_batch_id: 90,
    started_at: '2026-08-17T09:00:00-04:00', ended_at: '2026-08-17T11:00:00-04:00',
    quantity: 420, quantity_unit: 'bottle',
    work_sec: 6600, // 2h − 10min de pausa
    operator_id: 1, operator: 'Bruno',
    batch_number: 'CHR-2201', target_bottles: 500, units_per_bottle: 60,
    product_id: 7, product: 'Activated Charcoal 1200mg', nickname: 'Charcoal',
  },
  {
    // Simone: sem quantity → cai no target_bottles do lote.
    event_id: 502, product_batch_id: 90,
    started_at: '2026-08-17T11:15:00-04:00', ended_at: '2026-08-17T12:15:00-04:00',
    quantity: null, quantity_unit: null,
    work_sec: 3600,
    operator_id: 2, operator: 'Simone',
    batch_number: 'CHR-2201', target_bottles: 500, units_per_bottle: 60,
    product_id: 7, product: 'Activated Charcoal 1200mg', nickname: 'Charcoal',
  },
  {
    // Berberine, lote BER-0455: revisado, mas o lote NÃO rodou na linha ainda.
    event_id: 503, product_batch_id: 91,
    started_at: '2026-08-17T13:00:00-04:00', ended_at: '2026-08-17T14:00:00-04:00',
    quantity: 300, quantity_unit: 'bottle',
    work_sec: 3600,
    operator_id: 2, operator: 'Simone',
    batch_number: 'BER-0455', target_bottles: 350, units_per_bottle: 90,
    product_id: 9, product: 'Berberine HCl 6000mg', nickname: 'Berberine',
  },
  {
    // REGRA #0 — revisão SEM lote vinculado. O trabalho aconteceu; o vínculo
    // é que falta. Tem que aparecer.
    event_id: 504, product_batch_id: null,
    started_at: '2026-08-17T15:00:00-04:00', ended_at: '2026-08-17T15:40:00-04:00',
    quantity: null, quantity_unit: null,
    work_sec: 2400,
    operator_id: 1, operator: 'Bruno',
    batch_number: null, target_bottles: null, units_per_bottle: null,
    product_id: null, product: null, nickname: null,
  },
];

// ── EMS /pipeline, no formato que o worker ems-activity-sync espera ─────────
// production_line é OBJETO-por-stage (não array plana).
const EMS_PIPELINE = {
  pending_queue: [],
  formulation: { weighing: [], weighed: [] },
  production_line: {
    yield_review: [
      {
        id: 'b1', batch_record_number: 'MAG-7788',
        product: { name: 'Magnesium Glycinate 500mg' },
        target_qty_bottles: 800, actual_yield_bottles: 780,
        timeline: { encapsulating: { completed_at: '2026-08-10T16:00:00-04:00' } },
        updated_at: '2026-08-10T16:05:00-04:00',
      },
      {
        id: 'b2', batch_record_number: 'ASH-3311',
        formula: { name: 'Ashwagandha 1300mg' },
        target_qty_bottles: 400, actual_yield_bottles: null,
        timeline: { encapsulating: { completed_at: '2026-08-15T10:00:00-04:00' } },
        updated_at: '2026-08-15T10:30:00-04:00',
      },
    ],
    to_separate: [
      {
        // Este é o Charcoal: já foi REVISADO (tem evento nosso) e já rodou na linha.
        id: 'b3', batch_record_number: 'CHR-2201',
        product: { name: 'Activated Charcoal 1200mg' },
        target_qty_bottles: 500, actual_yield_bottles: 500,
        timeline: { encapsulating: { completed_at: '2026-08-14T12:00:00-04:00' } },
        updated_at: '2026-08-17T09:00:00-04:00',
      },
    ],
    on_line: [
      {
        id: 'b4', batch_record_number: 'BER-0455',
        product: { name: 'Berberine HCl 6000mg' },
        target_qty_bottles: 350, actual_yield_bottles: 350,
        timeline: { encapsulating: { completed_at: '2026-08-16T09:00:00-04:00' } },
        updated_at: '2026-08-18T08:00:00-04:00',
      },
    ],
    finalized: [
      // Finalizado NÃO entra na fila — já acabou.
      { id: 'b9', batch_record_number: 'OLD-0001', product: { name: 'Turmeric 1500mg' } },
    ],
  },
};

const EMS_PRODUCTS = [
  { name: 'Magnesium Glycinate 500mg', internal_sku: 'HF-MAG-500' },
  { name: 'Activated Charcoal 1200mg', internal_sku: 'HF-CHR-1200' },
];

/** EMS falso: configurado e respondendo. */
function makeEms(state) {
  return {
    configured: () => true,
    async pipeline() { state.pipelineCalls += 1; return EMS_PIPELINE; },
    async products() { return EMS_PRODUCTS; },
  };
}

/** EMS falso fora do ar (a chamada explode). */
const emsDown = {
  configured: () => true,
  async pipeline() { throw new Error('EMS inacessível'); },
  async products() { throw new Error('EMS inacessível'); },
};

/** EMS falso sem chave configurada. */
const emsUnset = { configured: () => false, async pipeline() { throw new Error('no'); } };

/**
 * Banco falso: só o que o service consulta. As linhas imitam o que o Postgres
 * devolveria (inclusive tipos: array_agg vira array JS, SUM vira número).
 */
function makeDb(state) {
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();

      // auth
      if (/FROM v3\.app_logins l/.test(q)) {
        const l = params[0] === BRUNO_PIN
          ? { id: 1, name: 'Bruno', role: 'owner', rank: 100, functions: ['*'] } : null;
        return { rows: l ? [l] : [] };
      }

      // (1) eventos do dia
      if (/FROM v3\.events e/.test(q) && /slug = 'review'/.test(q) && /::date = \$1/.test(q)) {
        state.dayQueries += 1;
        return { rows: params[0] === DAY ? EVENT_ROWS : [] };
      }

      // (2) calendário
      if (/to_char/.test(q) && /slug = 'review'/.test(q)) {
        if (params[0] !== '2026-08') return { rows: [] };
        return {
          rows: [
            { d: '2026-08-17', revisions: 4, bottles: 1220 },
            { d: '2026-08-18', revisions: 1, bottles: 200 },
          ],
        };
      }

      // eventos de linha de produção por lote
      if (/slug = 'production_line'/.test(q) && /GROUP BY e\.product_batch_id/.test(q)) {
        // Só o Charcoal (lote 90) tem evento de linha.
        const ids = params[0] || [];
        return { rows: ids.includes(90) ? [{ batch_id: 90, at: '2026-08-18T08:00:00-04:00' }] : [] };
      }

      // contagens de produção por lote
      if (/FROM v3\.production_counts pc/.test(q) && /GROUP BY pc\.product_batch_id/.test(q)) {
        const ids = params[0] || [];
        return { rows: ids.includes(90) ? [{ batch_id: 90, bottles: 496, at: '2026-08-18T09:30:00-04:00' }] : [] };
      }

      // (3) cruzamento da fila com os nossos lotes
      if (/FROM v3\.product_batches pb/.test(q) && /n_reviews/.test(q)) {
        const keys = params[0] || [];
        const rows = [];
        if (keys.includes('CHR-2201')) {
          rows.push({
            id: 90, batch_number: 'CHR-2201', product_id: 7,
            product: 'Activated Charcoal 1200mg', nickname: 'Charcoal',
            n_reviews: 2, reviewers: ['Bruno', 'Simone'],
            first_at: '2026-08-17T09:00:00-04:00', bottles: 420,
            line_at: '2026-08-18T08:00:00-04:00', line_bottles: 496,
          });
        }
        if (keys.includes('BER-0455')) {
          rows.push({
            id: 91, batch_number: 'BER-0455', product_id: 9,
            product: 'Berberine HCl 6000mg', nickname: 'Berberine',
            n_reviews: 1, reviewers: ['Simone'],
            first_at: '2026-08-17T13:00:00-04:00', bottles: 300,
            line_at: null, line_bottles: null,
          });
        }
        // MAG-7788 e ASH-3311 NÃO existem no nosso banco: são os esquecidos.
        return { rows };
      }

      // catálogo de produtos
      if (/FROM v3\.products WHERE active/.test(q)) {
        return {
          rows: [
            { id: 7, canonical_name: 'Activated Charcoal 1200mg', nickname: 'Charcoal' },
            { id: 11, canonical_name: 'Magnesium Glycinate 500mg', nickname: 'Mag Gly' },
          ],
        };
      }

      // espelho local do EMS (fallback)
      if (/FROM v3\.ems_activity_cache/.test(q)) {
        state.cacheQueries += 1;
        return {
          rows: [
            {
              batch_number: 'MAG-7788', supplement_name: 'Magnesium Glycinate 500mg',
              stage: 'yield_review', target_bottles: 800, actual_bottles: 780,
              started_at: '2026-08-10T16:00:00-04:00', ended_at: '2026-08-10T16:00:00-04:00',
              last_synced_at: '2026-08-19T10:00:00-04:00',
            },
          ],
        };
      }

      throw new Error('query inesperada no teste: ' + q.slice(0, 120));
    },
  };
}

/** Sobe o router num socket efêmero e devolve { base, close }. */
async function serve(opts = {}) {
  const state = { dayQueries: 0, cacheQueries: 0, pipelineCalls: 0 };
  const db = makeDb(state);
  const app = express();
  const service = new ReviewService({
    db,
    ems: opts.ems !== undefined ? opts.ems : makeEms(state),
    now: () => Date.parse('2026-08-19T12:00:00-04:00'),
    emsTtlMs: opts.emsTtlMs,
  });
  app.use('/', createReviewRouter({ db, service }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  return { base, state, service, close: () => new Promise((r) => server.close(r)) };
}

async function get(base, path, pin = BRUNO_PIN) {
  const r = await fetch(base + path, { headers: pin ? { 'x-admin-pin': pin } : {} });
  let body = null;
  try { body = await r.json(); } catch (_) { body = null; }
  return { status: r.status, body };
}

// ═══════════════════════════════════════════════════════════════════════════

describe('review: auth', () => {
  let s;
  beforeAll(async () => { s = await serve(); });
  afterAll(async () => { await s.close(); });

  test('PIN válido entra', async () => {
    const r = await get(s.base, '/api/v3/review/day?date=' + DAY);
    expect(r.status).toBe(200);
  });

  test('PIN errado → 401', async () => {
    const r = await get(s.base, '/api/v3/review/day?date=' + DAY, BAD_PIN);
    expect(r.status).toBe(401);
  });

  test('sem PIN → 401', async () => {
    const r = await get(s.base, '/api/v3/review/waiting', null);
    expect(r.status).toBe(401);
  });
});

describe('review: o dia', () => {
  let s; let day;
  beforeAll(async () => {
    s = await serve();
    day = (await get(s.base, '/api/v3/review/day?date=' + DAY)).body.data;
  });
  afterAll(async () => { await s.close(); });

  test('envelope { data } com a data pedida', () => {
    expect(day.date).toBe(DAY);
    expect(Array.isArray(day.revisions)).toBe(true);
  });

  test('uma linha por revisão, com pessoa e produto', () => {
    expect(day.revisions).toHaveLength(4);
    const bruno = day.revisions.find((r) => r.event_id === 501);
    expect(bruno.operator).toBe('Bruno');
    expect(bruno.product).toBe('Activated Charcoal 1200mg');
    expect(bruno.nickname).toBe('Charcoal');
    expect(bruno.batch_number).toBe('CHR-2201');
  });

  test('garrafas do EVENTO quando a pessoa disse quantas revisou', () => {
    const bruno = day.revisions.find((r) => r.event_id === 501);
    expect(bruno.bottles).toBe(420);
    expect(bruno.bottles_source).toBe('evento');
  });

  test('garrafas do LOTE quando o evento não trouxe quantidade', () => {
    const simone = day.revisions.find((r) => r.event_id === 502);
    expect(simone.bottles).toBe(500);
    expect(simone.bottles_source).toBe('lote');
  });

  test('cápsulas = garrafas × unidades por garrafa', () => {
    const bruno = day.revisions.find((r) => r.event_id === 501);
    expect(bruno.capsules).toBe(420 * 60);
  });

  test('tempo de trabalho e ritmo', () => {
    const bruno = day.revisions.find((r) => r.event_id === 501);
    expect(bruno.work_sec).toBe(6600);              // já descontada a pausa
    expect(bruno.sec_per_bottle).toBe(+(6600 / 420).toFixed(1));
    expect(bruno.capsules_per_sec).toBe(+((420 * 60) / 6600).toFixed(2));
  });

  test('CHECK DA LINHA: Charcoal já rodou, Berberine não', () => {
    const charcoal = day.revisions.find((r) => r.event_id === 501);
    expect(charcoal.on_line).toBe(true);
    expect(charcoal.on_line_at).toMatch(/^2026-08-18T/);
    expect(charcoal.line_bottles).toBe(496);        // veio de production_counts

    const berberine = day.revisions.find((r) => r.event_id === 503);
    expect(berberine.on_line).toBe(false);
    expect(berberine.line_bottles).toBeNull();
  });

  test('REGRA #0: revisão sem lote aparece, com batch null', () => {
    const orfa = day.revisions.find((r) => r.event_id === 504);
    expect(orfa).toBeTruthy();
    expect(orfa.batch_number).toBeNull();
    expect(orfa.bottles).toBeNull();
    expect(orfa.on_line).toBe(false);
    expect(orfa.product).toBe('Sem produto vinculado');
  });

  test('totais somam garrafas, tempo e produtos distintos', () => {
    expect(day.totals.revisions).toBe(4);
    expect(day.totals.bottles).toBe(420 + 500 + 300);
    expect(day.totals.work_sec).toBe(6600 + 3600 + 3600 + 2400);
    expect(day.totals.products).toBe(3);            // Charcoal, Berberine, sem-produto
    expect(day.totals.on_line).toBe(2);             // as duas linhas do Charcoal
  });

  test('por pessoa: Bruno e Simone, com as garrafas de cada um', () => {
    const bruno = day.by_person.find((p) => p.operator === 'Bruno');
    const simone = day.by_person.find((p) => p.operator === 'Simone');
    expect(bruno.n).toBe(2);
    expect(bruno.bottles).toBe(420);                // a órfã não tem garrafas
    expect(simone.n).toBe(2);
    expect(simone.bottles).toBe(500 + 300);
  });

  test('por produto: Charcoal com o check da linha', () => {
    const charcoal = day.by_product.find((p) => p.product === 'Activated Charcoal 1200mg');
    expect(charcoal.n).toBe(2);
    expect(charcoal.bottles).toBe(920);
    expect(charcoal.on_line).toBe(true);
    const berberine = day.by_product.find((p) => p.product === 'Berberine HCl 6000mg');
    expect(berberine.on_line).toBe(false);
  });

  test('data inválida → 400 (não responde "hoje" caladinho)', async () => {
    const r = await get(s.base, '/api/v3/review/day?date=17-08-2026');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('bad_date');
  });

  test('sem data → hoje, sem quebrar', async () => {
    const r = await get(s.base, '/api/v3/review/day');
    expect(r.status).toBe(200);
    expect(r.body.data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('dia sem revisão → lista vazia, totais zerados', async () => {
    const r = await get(s.base, '/api/v3/review/day?date=2026-08-16');
    expect(r.status).toBe(200);
    expect(r.body.data.revisions).toHaveLength(0);
    expect(r.body.data.totals).toEqual({ revisions: 0, bottles: 0, work_sec: 0, products: 0, on_line: 0 });
  });
});

describe('review: garrafas (unidade)', () => {
  test("quantity_unit='order' NÃO é garrafa — cai no lote", () => {
    const r = bottlesOf({ quantity: 12, quantity_unit: 'order', target_bottles: 300 });
    expect(r).toEqual({ bottles: 300, source: 'lote' });
  });

  test("quantity_unit='box' NÃO é garrafa", () => {
    const r = bottlesOf({ quantity: 4, quantity_unit: 'box', target_bottles: 200 });
    expect(r.source).toBe('lote');
    expect(r.bottles).toBe(200);
  });

  test('sem quantidade e sem lote → null (não inventa número)', () => {
    expect(bottlesOf({ quantity: null, quantity_unit: null, target_bottles: null }))
      .toEqual({ bottles: null, source: null });
  });
});

describe('review: calendário', () => {
  let s;
  beforeAll(async () => { s = await serve(); });
  afterAll(async () => { await s.close(); });

  test('só os dias COM revisão', async () => {
    const r = await get(s.base, '/api/v3/review/calendar?month=2026-08');
    expect(r.status).toBe(200);
    expect(r.body.data.month).toBe('2026-08');
    expect(r.body.data.days).toEqual([
      { date: '2026-08-17', revisions: 4, bottles: 1220 },
      { date: '2026-08-18', revisions: 1, bottles: 200 },
    ]);
  });

  test('mês sem revisão → days vazio (não é erro)', async () => {
    const r = await get(s.base, '/api/v3/review/calendar?month=2026-07');
    expect(r.status).toBe(200);
    expect(r.body.data.days).toEqual([]);
  });

  test('mês inválido → 400', async () => {
    const r = await get(s.base, '/api/v3/review/calendar?month=2026-13');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('bad_month');
  });
});

describe('review: a fila (waiting)', () => {
  let s; let w;
  beforeAll(async () => {
    s = await serve();
    w = (await get(s.base, '/api/v3/review/waiting')).body.data;
  });
  afterAll(async () => { await s.close(); });

  test('EMS ok e lotes vindos do pipeline', () => {
    expect(w.ems_ok).toBe(true);
    expect(w.generated_at).toMatch(/^2026-08-19T/);
    const nums = w.items.map((x) => x.batch_number);
    expect(nums).toEqual(expect.arrayContaining(['MAG-7788', 'ASH-3311', 'CHR-2201', 'BER-0455']));
  });

  test('lote FINALIZADO não entra na fila', () => {
    expect(w.items.map((x) => x.batch_number)).not.toContain('OLD-0001');
  });

  test('o lote esquecido (sem evento nosso) aparece como NÃO revisado', () => {
    const mag = w.items.find((x) => x.batch_number === 'MAG-7788');
    expect(mag.reviewed).toBe(false);
    expect(mag.reviewed_by).toEqual([]);
    expect(mag.on_line).toBe(false);
    expect(mag.ems_stage).toBe('yield_review');
    expect(mag.ems_stage_label).toBe('cápsulas prontas');
  });

  test('produto casado por nome dá nickname e product_id mesmo sem lote nosso', () => {
    const mag = w.items.find((x) => x.batch_number === 'MAG-7788');
    expect(mag.nickname).toBe('Mag Gly');
    expect(mag.product_id).toBe(11);
    expect(mag.sku).toBe('HF-MAG-500');            // veio do /products do EMS
  });

  test('o Charcoal aparece revisado, por quem, e já na linha', () => {
    const chr = w.items.find((x) => x.batch_number === 'CHR-2201');
    expect(chr.reviewed).toBe(true);
    expect(chr.reviewed_by).toEqual(['Bruno', 'Simone']);
    expect(chr.reviewed_at).toMatch(/^2026-08-17T/);
    expect(chr.revised_bottles).toBe(420);
    expect(chr.on_line).toBe(true);
    expect(chr.ems_stage_label).toBe('separar / revisar');
  });

  test('dias esperando contam desde a encapsulação', () => {
    const mag = w.items.find((x) => x.batch_number === 'MAG-7788');
    expect(mag.waiting_days).toBeGreaterThan(8);   // 08-10 → 08-19
    expect(mag.encapsulated_at).toMatch(/^2026-08-10T/);
  });

  test('ORDEM: não revisado primeiro, mais velho no topo', () => {
    const naoRevisados = w.items.filter((x) => !x.reviewed && !x.on_line);
    expect(naoRevisados[0].batch_number).toBe('MAG-7788');  // 08-10 é mais velho que 08-15
    // e nenhum item revisado vem antes de um não revisado
    const firstReviewed = w.items.findIndex((x) => x.reviewed || x.on_line);
    const lastNotReviewed = w.items.map((x) => !x.reviewed && !x.on_line).lastIndexOf(true);
    expect(lastNotReviewed).toBeLessThan(firstReviewed);
  });

  test('contadores batem com a lista', () => {
    expect(w.counts.waiting).toBe(w.items.length);
    expect(w.counts.not_reviewed).toBe(2);              // MAG + ASH
    expect(w.counts.reviewed_waiting_line).toBe(1);     // CHR (revisado; on_line é o BER)
    expect(w.counts.on_line).toBe(1);                   // BER
  });

  test('CACHE: duas chamadas seguidas batem no EMS uma vez só', async () => {
    const before = s.state.pipelineCalls;
    await get(s.base, '/api/v3/review/waiting');
    await get(s.base, '/api/v3/review/waiting');
    expect(s.state.pipelineCalls).toBe(before);         // tudo servido do cache de 120 s
  });
});

describe('review: EMS fora do ar', () => {
  test('EMS explode → ems_ok:false + espelho local, nunca 500', async () => {
    const s = await serve({ ems: emsDown });
    const r = await get(s.base, '/api/v3/review/waiting');
    expect(r.status).toBe(200);
    expect(r.body.data.ems_ok).toBe(false);
    expect(s.state.cacheQueries).toBeGreaterThan(0);
    expect(r.body.data.items.map((x) => x.batch_number)).toContain('MAG-7788');
    await s.close();
  });

  test('EMS sem chave → ems_ok:false, sem tentar chamar', async () => {
    const s = await serve({ ems: emsUnset });
    const r = await get(s.base, '/api/v3/review/waiting');
    expect(r.status).toBe(200);
    expect(r.body.data.ems_ok).toBe(false);
    expect(r.body.data.items.length).toBeGreaterThan(0);   // veio do espelho
    await s.close();
  });

  test('sem EMS injetado → ems_ok:false, fila do espelho', async () => {
    const s = await serve({ ems: null });
    const r = await get(s.base, '/api/v3/review/waiting');
    expect(r.status).toBe(200);
    expect(r.body.data.ems_ok).toBe(false);
    await s.close();
  });
});

describe('review: flattenStage (formato do EMS)', () => {
  test('objeto-por-stage vira lista, herdando o sub-stage como status', () => {
    const out = flattenStage({ yield_review: [{ id: 'a' }], to_count: [{ id: 'b' }] });
    expect(out).toHaveLength(2);
    expect(out[0].status).toBe('yield_review');
    expect(out[1].status).toBe('to_count');
  });

  test('array plana passa direto e status próprio não é sobrescrito', () => {
    const out = flattenStage({ yield_review: [{ id: 'a', status: 'to_separate' }] });
    expect(out[0].status).toBe('to_separate');
    expect(flattenStage([{ id: 'x' }])).toHaveLength(1);
  });

  test('nulo/estranho → lista vazia (nunca explode)', () => {
    expect(flattenStage(null)).toEqual([]);
    expect(flattenStage(undefined)).toEqual([]);
    expect(flattenStage('nope')).toEqual([]);
  });
});

describe('review: banco fora do ar', () => {
  test('SELECT do dia falhando → dia vazio, não 500', async () => {
    const db = {
      async query(sql, params) {
        const q = String(sql).replace(/\s+/g, ' ');
        if (/FROM v3\.app_logins l/.test(q)) {
          return { rows: params[0] === BRUNO_PIN ? [{ id: 1, name: 'Bruno', role: 'owner', rank: 100, functions: ['*'] }] : [] };
        }
        throw new Error('banco fora');
      },
    };
    const app = express();
    app.use('/', createReviewRouter({ db, ems: emsUnset }));
    const server = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const r = await get(base, '/api/v3/review/day?date=' + DAY);
    expect(r.status).toBe(200);
    expect(r.body.data.revisions).toEqual([]);
    await new Promise((x) => server.close(x));
  });
});
