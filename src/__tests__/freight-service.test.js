'use strict';
/**
 * Freight cost watch — lógica pura + repo (Bruno 08-28).
 *  1. bandOf: bordas de peso, serviço desconhecido, cubic separado do GA comum
 *  2. mediana: ímpar, par (interpolada), custo 0 fora
 *  3. judge: 29% não / 31% sim / +$1.49 não / +$1.51 sim / faixa fina nunca /
 *     teto absoluto $12 <1lb sempre
 *  4. upsert idempotente por shipment_id; alerted_at nunca regride
 *  5. summary: custo 0 (Walmart) contado à parte, NUNCA na média
 */
const freight = require('../v3/freight/service');
const { makeFreightDb, nyToday } = require('./helpers/freight-fake-db');

const OZ = 28.3495;

describe('bandOf: faixas de serviço + peso', () => {
  test('bordas de peso: 4oz sobe de faixa, 8oz, 16oz, 32oz idem', () => {
    expect(freight.bandOf('USPS Ground Advantage', 4 * OZ - 0.01)).toBe('usps_ga|<4oz');
    expect(freight.bandOf('USPS Ground Advantage', 4 * OZ)).toBe('usps_ga|4-8oz');
    expect(freight.bandOf('USPS Ground Advantage', 8 * OZ - 0.01)).toBe('usps_ga|4-8oz');
    expect(freight.bandOf('USPS Ground Advantage', 8 * OZ)).toBe('usps_ga|8-16oz');
    expect(freight.bandOf('USPS Ground Advantage', 16 * OZ)).toBe('usps_ga|1-2lb');
    expect(freight.bandOf('USPS Ground Advantage', 32 * OZ)).toBe('usps_ga|>2lb');
  });

  test('sem peso ou peso inválido vira faixa própria, não explode', () => {
    expect(freight.bandOf('USPS Ground Advantage', null)).toBe('usps_ga|sem_peso');
    expect(freight.bandOf('USPS Ground Advantage', 0)).toBe('usps_ga|sem_peso');
    expect(freight.bandOf('USPS Ground Advantage', 'abc')).toBe('usps_ga|sem_peso');
  });

  test('cubic é OUTRA faixa que o GA comum (preços diferentes, régua diferente)', () => {
    expect(freight.bandOf('USPS Ground Advantage Cubic', 120)).toBe('usps_ga_cubic|4-8oz');
    expect(freight.bandOf('USPS Ground Advantage', 120)).toBe('usps_ga|4-8oz');
  });

  test('serviços conhecidos normalizam; desconhecido vira slug estável; vazio = desconhecido', () => {
    expect(freight.serviceKey('UPS Ground Saver')).toBe('ups_ground_saver');
    expect(freight.serviceKey('USPS Priority Mail')).toBe('usps_pm');
    expect(freight.serviceKey('USPS Priority Mail Express')).toBe('usps_pme');
    expect(freight.serviceKey('FedEx Home Delivery!')).toBe('fedex_home_delivery');
    expect(freight.serviceKey('FedEx Home Delivery!')).toBe(freight.serviceKey('fedex  home DELIVERY'));
    expect(freight.serviceKey('')).toBe('desconhecido');
    expect(freight.serviceKey(null)).toBe('desconhecido');
  });
});

describe('mediana da faixa (expectedFor)', () => {
  async function seed(db, costs, band = 'usps_ga|4-8oz', day = '2026-08-20') {
    let id = 9000;
    for (const c of costs) {
      await freight.upsertShipments(db, [{ shipment_id: ++id, cost: c, service: 'USPS Ground Advantage', weight_g: 200, ny_day: day, bought_at: day + 'T12:00:00Z' }]);
      await freight.saveJudgement(db, id, { band, expected_cost: null, outlier: false, outlier_reason: null });
    }
  }

  test('ímpar: mediana é o do meio', async () => {
    const db = makeFreightDb();
    await seed(db, [5, 6, 9]);
    const { expected, samples } = await freight.expectedFor(db, 'usps_ga|4-8oz');
    expect(expected).toBe(6);
    expect(samples).toBe(3);
  });

  test('par: mediana interpolada; custo 0 (Walmart) fica FORA da conta', async () => {
    const db = makeFreightDb();
    await seed(db, [5, 6, 7, 10, 0, 0]);
    const { expected, samples } = await freight.expectedFor(db, 'usps_ga|4-8oz');
    expect(expected).toBe(6.5);
    expect(samples).toBe(4);              // os dois zeros não contam
  });

  test('a query REAL exclui cost=0 e limita a 30 dias', async () => {
    const db = makeFreightDb();
    await freight.expectedFor(db, 'x|y');
    const q = db._queries.find((x) => /PERCENTILE_CONT/.test(x.q)).q;
    expect(q).toMatch(/cost > 0/);
    expect(q).toMatch(/30 days/);
  });
});

describe('judge: a régua do outlier', () => {
  const base = { expected: 6.00, samples: 10, weight_g: 200 };
  test('29% acima da mediana NÃO grita', () => {
    expect(freight.judge({ ...base, cost: 6.00 * 1.29 }).outlier).toBe(false);
  });
  test('31% acima grita (acima_da_faixa)', () => {
    const v = freight.judge({ ...base, cost: 6.00 * 1.31 });
    expect(v).toEqual({ outlier: true, reason: 'acima_da_faixa' });
  });
  test('+$1.49 NÃO grita quando o valor fixo é a régua dominante', () => {
    expect(freight.judge({ expected: 4.00, samples: 10, weight_g: 200, cost: 5.49 }).outlier).toBe(false);
  });
  test('+$1.51 grita', () => {
    expect(freight.judge({ expected: 4.00, samples: 10, weight_g: 200, cost: 5.51 }).outlier).toBe(true);
  });
  test('faixa fina (menos de 8 amostras) NUNCA grita, por mais caro que seja', () => {
    expect(freight.judge({ expected: 6.00, samples: 7, weight_g: 200, cost: 11.50 }).outlier).toBe(false);
    expect(freight.judge({ expected: null, samples: 0, weight_g: 200, cost: 11.50 }).outlier).toBe(false);
  });
  test('teto absoluto: $12 com menos de 1lb grita SEMPRE, mesmo sem amostra', () => {
    const v = freight.judge({ expected: null, samples: 0, weight_g: 200, cost: 12.00 });
    expect(v).toEqual({ outlier: true, reason: 'teto_absoluto' });
  });
  test('teto absoluto NÃO vale pra 1lb ou mais (pacote pesado caro pode ser normal)', () => {
    expect(freight.judge({ expected: null, samples: 0, weight_g: 500, cost: 12.00 }).outlier).toBe(false);
  });
  test('custo 0 (Walmart, etiqueta deles) nunca é outlier', () => {
    expect(freight.judge({ expected: 6.00, samples: 20, weight_g: 200, cost: 0 }).outlier).toBe(false);
  });
});

describe('upsert idempotente', () => {
  const ROW = { shipment_id: 111, order_id: 5, order_number: '2751', channel: 'eBay',
    service: 'USPS Ground Advantage', weight_g: 200, cost: 7.86,
    bought_at: '2026-08-28T13:41:00Z', ny_day: '2026-08-28' };

  test('mesma shipment 2x = UMA linha; 1ª inserted, 2ª não', async () => {
    const db = makeFreightDb();
    const a = await freight.upsertShipments(db, [ROW]);
    const b = await freight.upsertShipments(db, [ROW]);
    expect(a[0].inserted).toBe(true);
    expect(b[0].inserted).toBe(false);
    expect(db._rows.size).toBe(1);
  });

  test('alerted_at NUNCA regride no re-upsert (no SQL e no comportamento)', async () => {
    const db = makeFreightDb();
    await freight.upsertShipments(db, [ROW]);
    expect(await freight.markAlerted(db, 111)).toBe(true);
    const stamped = db._rows.get('111').alerted_at;
    expect(stamped).toBeTruthy();
    await freight.upsertShipments(db, [ROW]);
    expect(db._rows.get('111').alerted_at).toBe(stamped);
    // e a query real diz isso com todas as letras
    const q = db._queries.find((x) => x.q.startsWith('INSERT INTO v3.shipment_costs')).q;
    expect(q).toMatch(/alerted_at = v3\.shipment_costs\.alerted_at/);
  });

  test('markAlerted 2x = 1 carimbo só (segunda volta false)', async () => {
    const db = makeFreightDb();
    await freight.upsertShipments(db, [ROW]);
    expect(await freight.markAlerted(db, 111)).toBe(true);
    expect(await freight.markAlerted(db, 111)).toBe(false);
  });

  test('linha sem shipment_id é ignorada, não explode', async () => {
    const db = makeFreightDb();
    const out = await freight.upsertShipments(db, [null, {}, ROW]);
    expect(out.length).toBe(1);
  });
});

describe('summary: Walmart contado à parte, nunca na média', () => {
  test('média = total ÷ etiquetas COM custo; zero-cost aparece em walmart_zero', async () => {
    const db = makeFreightDb();
    const day = nyToday();
    await freight.upsertShipments(db, [
      { shipment_id: 1, cost: 6, service: 'GA', weight_g: 200, ny_day: day, bought_at: new Date().toISOString() },
      { shipment_id: 2, cost: 8, service: 'GA', weight_g: 200, ny_day: day, bought_at: new Date().toISOString() },
      { shipment_id: 3, cost: 0, service: '', weight_g: 200, ny_day: day, bought_at: new Date().toISOString(), channel: 'Walmart' },
    ]);
    const sum = await freight.summary(db, { days: 14 });
    const today = sum.days.find((d) => d.day === day);
    expect(today.shipments).toBe(3);
    expect(today.labeled).toBe(2);
    expect(today.walmart_zero).toBe(1);
    expect(today.total_cost).toBe(14);
    expect(today.avg_cost).toBe(7);       // 14/2, jamais 14/3
    expect(sum.avg_30d).toBe(7);
    // a query real também filtra: média nunca vê custo 0
    const q = db._queries.find((x) => /GROUP BY ny_day/.test(x.q)).q;
    expect(q).toMatch(/FILTER \(WHERE cost > 0\)/);
  });

  test('outlier_excess soma só custo menos esperado dos outliers', async () => {
    const db = makeFreightDb();
    const day = nyToday();
    await freight.upsertShipments(db, [
      { shipment_id: 10, cost: 7.86, service: 'GA', weight_g: 200, ny_day: day, bought_at: new Date().toISOString() },
      { shipment_id: 11, cost: 6.00, service: 'GA', weight_g: 200, ny_day: day, bought_at: new Date().toISOString() },
    ]);
    await freight.saveJudgement(db, 10, { band: 'usps_ga|4-8oz', expected_cost: 6.09, outlier: true, outlier_reason: 'acima_da_faixa' });
    await freight.saveJudgement(db, 11, { band: 'usps_ga|4-8oz', expected_cost: 6.09, outlier: false, outlier_reason: null });
    const sum = await freight.summary(db, { days: 14 });
    const today = sum.days.find((d) => d.day === day);
    expect(today.outliers).toBe(1);
    expect(today.outlier_excess).toBeCloseTo(1.77, 2);
  });

  test('todayOutliers devolve só os de hoje, com o que o alerta precisa', async () => {
    const db = makeFreightDb();
    const day = nyToday();
    await freight.upsertShipments(db, [
      { shipment_id: 20, order_number: '2751', channel: 'eBay', cost: 7.86, service: 'USPS Ground Advantage', weight_g: 200, ny_day: day, bought_at: new Date().toISOString(), due_date: '2026-09-04T00:00:00Z' },
      { shipment_id: 21, cost: 9.99, service: 'GA', weight_g: 200, ny_day: '2026-08-01', bought_at: '2026-08-01T12:00:00Z' },
    ]);
    await freight.saveJudgement(db, 20, { band: 'usps_ga|4-8oz', expected_cost: 6.09, outlier: true, outlier_reason: 'acima_da_faixa' });
    await freight.saveJudgement(db, 21, { band: 'usps_ga|4-8oz', expected_cost: 6.09, outlier: true, outlier_reason: 'acima_da_faixa' });
    const out = await freight.todayOutliers(db);
    expect(out.length).toBe(1);
    expect(String(out[0].shipment_id)).toBe('20');
    expect(out[0].order_number).toBe('2751');
    expect(out[0].due_date).toBeTruthy();
  });

  test('bands publica a régua: mediana, min, max, amostras e se já julga', async () => {
    const db = makeFreightDb();
    for (let i = 0; i < 9; i++) {
      await freight.upsertShipments(db, [{ shipment_id: 300 + i, cost: 6 + (i % 3), service: 'GA', weight_g: 200, ny_day: '2026-08-20', bought_at: '2026-08-20T12:00:00Z' }]);
      await freight.saveJudgement(db, 300 + i, { band: 'usps_ga|4-8oz', expected_cost: null, outlier: false, outlier_reason: null });
    }
    const bands = await freight.bands(db);
    expect(bands.length).toBe(1);
    expect(bands[0].band).toBe('usps_ga|4-8oz');
    expect(bands[0].samples).toBe(9);
    expect(bands[0].judging).toBe(true);
    expect(bands[0].min).toBe(6);
    expect(bands[0].max).toBe(8);
  });
});
