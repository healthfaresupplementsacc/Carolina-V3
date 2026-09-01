'use strict';
/**
 * Rate Shopping client (FASE A do copiloto de frete).
 *  1. quoteParcel: body correto (peso lb, dims fixas, customer_reference
 *     OBRIGATORIO com prefixo HF-QUOTE-), parsing da resposta real
 *  2. validQuotes: banned (Media Mail/Bound Printed/Library) + preco>0 fora
 *  3. bestValid: com due date qualificando, sem nenhuma no prazo, sem due date
 *  4. TODA falha vira null (rede, timeout, HTTP != 2xx, JSON quebrado, sem
 *     chave, sem CEP): cotar e conselho, nunca pode derrubar o watch
 * Tudo com fetch injetado; nenhuma rede.
 */
const { createRatesClient, validQuotes, bestValid, poundsOf } = require('../v3/freight/rates-client');

/** Resposta REAL da API (forma testada ao vivo 08-28). */
const LIVE_SHAPE = {
  quotes: [
    { rate_id: 'r1', service_name: 'USPS Ground Advantage', carrier_id: 1,
      delivery_estimate: '2026-09-03T12:00:00Z', total_charge: '5.62', charges: [] },
    { rate_id: 'r2', service_name: 'USPS Priority Mail', carrier_id: 1,
      delivery_estimate: '2026-09-01T12:00:00Z', total_charge: '8.10', charges: [] },
    { rate_id: 'r3', service_name: 'USPS Media Mail', carrier_id: 1,
      delivery_estimate: '2026-09-06T12:00:00Z', total_charge: '3.90', charges: [] },
    { rate_id: 'r4', service_name: 'UPS Ground Saver', carrier_id: 2,
      delivery_estimate: null, total_charge: '0', charges: [] },
  ],
};

function okFetch(json = LIVE_SHAPE, capture = {}) {
  return jest.fn(async (url, init) => {
    capture.url = url; capture.init = init;
    capture.body = JSON.parse(init.body);
    return { ok: true, json: async () => json };
  });
}

describe('quoteParcel: request e parsing', () => {
  test('monta o body verificado: from fixo, peso em lb, dims 8x5x2, reference obrigatorio', async () => {
    const cap = {};
    const c = createRatesClient({ apiKey: 'k', fetchImpl: okFetch(LIVE_SHAPE, cap) });
    const out = await c.quoteParcel({ dest_zip: '30301', dest_state: 'GA', weight_g: 200, reference: '2751' });
    expect(cap.url).toBe('https://api.veeqo.com/shipping/api/v1/rates');
    expect(cap.init.headers['x-api-key']).toBe('k');
    expect(cap.init.headers['Content-Type']).toBe('application/json');
    expect(cap.body.from_address.postcode).toBe('33309');
    expect(cap.body.to_address.postcode).toBe('30301');
    expect(cap.body.to_address.county).toBe('GA');
    const p = cap.body.parcels[0];
    expect(p).toMatchObject({ weight: 0.44, weight_unit: 'lb', length: 8, width: 5, height: 2, dimension_unit: 'in' });
    // customer_reference: validation error da API sem ele; prefixo diz "foi o copiloto"
    expect(cap.body.customer_reference).toBe('HF-QUOTE-2751');
    // parsing: nome, preco numerico, estimativa, rate_id
    expect(out.quotes.length).toBe(4);
    expect(out.quotes[0]).toEqual({ name: 'USPS Ground Advantage', price: 5.62,
      delivery_estimate: '2026-09-03T12:00:00Z', rate_id: 'r1' });
  });

  test('peso: minimo 0.1 lb e arredondado em 2 casas', () => {
    expect(poundsOf(200)).toBe(0.44);
    expect(poundsOf(10)).toBe(0.1);       // 0.022 lb sobe pro piso
    expect(poundsOf(0)).toBe(0.1);
    expect(poundsOf(null)).toBe(0.1);
    expect(poundsOf(453.592)).toBe(1);
  });
});

describe('validQuotes: banned + preco > 0', () => {
  const quotes = [
    { name: 'USPS Ground Advantage', price: 5.62 },
    { name: 'USPS Media Mail', price: 3.90 },          // livro/midia: suplemento NAO PODE
    { name: 'Bound Printed Matter', price: 4.10 },
    { name: 'Library Mail', price: 3.50 },
    { name: 'UPS Ground Saver', price: 0 },            // preco 0 = cotacao morta
    { name: 'USPS Priority Mail', price: 8.10 },
  ];
  test('filtra as tres banidas e a de preco 0', () => {
    const v = validQuotes(quotes);
    expect(v.map((q) => q.name)).toEqual(['USPS Ground Advantage', 'USPS Priority Mail']);
  });
  test('lista vazia/nula nao explode', () => {
    expect(validQuotes([])).toEqual([]);
    expect(validQuotes(null)).toEqual([]);
  });
});

describe('bestValid: a mais barata valida que chega no prazo', () => {
  const quotes = [
    { name: 'USPS Ground Advantage', price: 5.62, delivery_estimate: '2026-09-05T12:00:00Z' },
    { name: 'USPS Priority Mail', price: 8.10, delivery_estimate: '2026-09-01T12:00:00Z' },
    { name: 'USPS Media Mail', price: 3.90, delivery_estimate: '2026-09-01T00:00:00Z' },   // banida: nunca
  ];
  test('sem due date: a mais barata valida geral', () => {
    expect(bestValid(quotes).name).toBe('USPS Ground Advantage');
  });
  test('com due date apertado: a mais barata QUE CHEGA (Priority ganha do GA)', () => {
    expect(bestValid(quotes, { dueDate: '2026-09-02T00:00:00Z' }).name).toBe('USPS Priority Mail');
  });
  test('com due date folgado: o GA barato qualifica e ganha', () => {
    expect(bestValid(quotes, { dueDate: '2026-09-10T00:00:00Z' }).name).toBe('USPS Ground Advantage');
  });
  test('NENHUMA chega no prazo: cai na mais barata valida geral (prazo estourado e decisao de gente)', () => {
    expect(bestValid(quotes, { dueDate: '2026-08-30T00:00:00Z' }).name).toBe('USPS Ground Advantage');
  });
  test('so banidas/preco 0: null', () => {
    expect(bestValid([{ name: 'USPS Media Mail', price: 3.9 }, { name: 'X', price: 0 }])).toBe(null);
  });
});

describe('toda falha vira null (conselho nunca derruba o watch)', () => {
  test('fetch rejeita (rede/timeout)', async () => {
    const c = createRatesClient({ apiKey: 'k', fetchImpl: jest.fn(async () => { throw new Error('boom'); }) });
    expect(await c.quoteParcel({ dest_zip: '30301', weight_g: 200, reference: 1 })).toBe(null);
  });
  test('HTTP nao-ok (422 validation, 500)', async () => {
    const c = createRatesClient({ apiKey: 'k', fetchImpl: jest.fn(async () => ({ ok: false, status: 422 })) });
    expect(await c.quoteParcel({ dest_zip: '30301', weight_g: 200, reference: 1 })).toBe(null);
  });
  test('JSON quebrado', async () => {
    const c = createRatesClient({ apiKey: 'k', fetchImpl: jest.fn(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })) });
    expect(await c.quoteParcel({ dest_zip: '30301', weight_g: 200, reference: 1 })).toBe(null);
  });
  test('sem apiKey', async () => {
    const f = jest.fn();
    const c = createRatesClient({ apiKey: '', fetchImpl: f });
    expect(await c.quoteParcel({ dest_zip: '30301', weight_g: 200, reference: 1 })).toBe(null);
    expect(f).not.toHaveBeenCalled();
    expect(c.configured()).toBe(false);
  });
  test('sem CEP de destino (nao tem o que cotar)', async () => {
    const f = jest.fn();
    const c = createRatesClient({ apiKey: 'k', fetchImpl: f });
    expect(await c.quoteParcel({ dest_zip: null, weight_g: 200, reference: 1 })).toBe(null);
    expect(f).not.toHaveBeenCalled();
  });
});
