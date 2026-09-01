'use strict';
/**
 * freight-watch (Bruno 08-28).
 *  1. janela 8h-19h NY: fora dela nem toca na Veeqo
 *  2. outlier NOVO → 1 alerta no admin-orin NA HORA; tick seguinte NÃO repete
 *  3. digest 1x por dia, só de 16:15 em diante (dedupe via audit_log)
 *  4. NUNCA canal de operador; desligado por padrão
 *  5. texto do alerta: forma combinada, sem em dash, folga do due_date
 *  6. Walmart custo 0 registrado mas nunca alertado
 *  7. state-aware (v2): histórico do estado muda a régua E o texto do alerta
 *  8. FASE A (v3, copiloto): cota antes de aconselhar; os TRES textos honestos
 *     (tem mais barata / ja era o melhor / nao consegui cotar); cap 25/tick;
 *     falha de cotacao NUNCA derruba o tick; digest ganha a frase da economia
 * DB/Veeqo/Slack/rates mockados; relógio injetado.
 */
const { FreightWatch } = require('../workers/freight-watch');
const freight = require('../v3/freight/service');
const { makeFreightDb, nyToday } = require('./helpers/freight-fake-db');

/** Relógio fixo em NY hoje (agosto = EDT, UTC-4). */
function atNy(hour, minute = 0) {
  const d = nyToday();
  return () => new Date(Date.UTC(
    Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)),
    hour + 4, minute, 0));
}

/** Pedido da Veeqo com um shipment (forma real: allocations[0].shipment). */
function order({ id, number, channel = 'eBay', shipmentId, service = 'USPS Ground Advantage',
  weight = 200, cost, createdAt, dueDate, state = 'TX' }) {
  return {
    id, number, channel: { name: channel },
    due_date: dueDate || null, dispatch_date: null,
    deliver_to: { state, zip: '75001' },
    allocations: [{ shipment: {
      id: shipmentId, service_name: service, weight,
      outbound_label_charges: { value: String(cost) },
      created_at: createdAt,
    } }],
  };
}

/** Histórico: 9 etiquetas na faixa usps_ga|4-8oz, ONTEM (mediana pronta).
 *  Default: $6.00 sem estado (régua da faixa). Com { state, cost } vira
 *  histórico do ESTADO e liga a régua estadual do expectedFor v2. */
async function seedHistory(db, { state = null, cost = 6.00, startId = 8000 } = {}) {
  for (let i = 0; i < 9; i++) {
    const id = startId + i;
    await freight.upsertShipments(db, [{ shipment_id: id, cost,
      service: 'USPS Ground Advantage', weight_g: 200, dest_state: state,
      ny_day: '2026-08-20', bought_at: '2026-08-20T14:00:00Z' }]);
    await freight.saveJudgement(db, id, { band: 'usps_ga|4-8oz', expected_cost: null, outlier: false, outlier_reason: null });
  }
}

function boot({ hour = 10, minute = 0, orders = [], enabled = true, rates = null, quoteCap } = {}) {
  const db = makeFreightDb();
  const posts = [];
  const veeqo = { getOrdersPage: jest.fn(async ({ page }) => (page === 1 ? orders : [])) };
  const worker = new FreightWatch({
    db, veeqo, enabled, rates, quoteCap,
    slack: { postAs: jest.fn(async (m) => { posts.push(m); }) },
    channelId: 'C_ADMIN',
    now: atNy(hour, minute),
  });
  return { db, posts, veeqo, worker };
}

/** Cliente de rates fake: devolve sempre as mesmas quotes (ou null = falhou). */
function fakeRates(quotes) {
  return { quoteParcel: jest.fn(async () => (quotes ? { quotes } : null)) };
}

const nowIso = (hour) => atNy(hour)().toISOString();
const alerts = (posts) => posts.filter((p) => /[Ee]tiquetas? acima do normal/.test(p.text));
const digests = (posts) => posts.filter((p) => p.text.includes('Frete de hoje:'));

describe('janela 8h-19h NY', () => {
  test('7h da manhã: não toca na Veeqo, não posta nada', async () => {
    const { posts, veeqo, worker } = boot({ hour: 7 });
    const out = await worker.tick();
    expect(out.skipped).toBe('window');
    expect(veeqo.getOrdersPage).not.toHaveBeenCalled();
    expect(posts.length).toBe(0);
  });
  test('19h: janela fechada', async () => {
    const { veeqo, worker } = boot({ hour: 19 });
    expect((await worker.tick()).skipped).toBe('window');
    expect(veeqo.getOrdersPage).not.toHaveBeenCalled();
  });
  test('8h: janela aberta', async () => {
    const { veeqo, worker } = boot({ hour: 8 });
    const out = await worker.tick();
    expect(out.skipped).toBeUndefined();
    expect(veeqo.getOrdersPage).toHaveBeenCalled();
  });
});

describe('desligado por padrão', () => {
  test('sem env WORKER_FREIGHT_WATCH_ENABLED o tick é no-op', async () => {
    delete process.env.WORKER_FREIGHT_WATCH_ENABLED;
    const veeqo = { getOrdersPage: jest.fn() };
    const worker = new FreightWatch({ db: makeFreightDb(), veeqo, now: atNy(10) });
    expect(worker.enabled).toBe(false);
    expect((await worker.tick()).skipped).toBe(true);
    expect(veeqo.getOrdersPage).not.toHaveBeenCalled();
  });
});

describe('alerta imediato de outlier', () => {
  const expensive = () => order({ id: 55, number: '2751', shipmentId: 501,
    cost: 7.86, createdAt: nowIso(9), dueDate: '2026-09-04T16:00:00Z' });

  test('etiqueta cara nova → 1 mensagem no admin-orin, na hora, com a forma combinada', async () => {
    const { db, posts, worker } = boot({ hour: 10, orders: [expensive()] });
    await seedHistory(db);
    const out = await worker.tick();
    expect(out.alerted).toBe(1);
    const a = alerts(posts);
    expect(a.length).toBe(1);
    expect(a[0].channel).toBe('C_ADMIN');
    const t = a[0].text;
    expect(t).toContain(':money_with_wings: *Etiqueta acima do normal*');
    expect(t).toContain('Pedido 2751 (eBay)');
    expect(t).toContain('USPS Ground Advantage saiu $7.86, o normal dessa faixa e $6.00.');
    expect(t).toContain('Cliente aceita ate 04/09, folga de');
    // v3: SEM cliente de rates o alerta e honesto sobre nao ter cotado — e
    // NUNCA manda deletar sem saber se existe opcao (objecao do Bruno)
    expect(t).toContain('Nao consegui cotar agora; confere na Veeqo se tem opcao mais barata antes de decidir.');
    expect(t).not.toContain('deleta o envio');
    expect(t).not.toMatch(/[—–]/);                       // sem em dash, nunca
    expect((t.match(/:[a-z_]+:/g) || []).length).toBeLessThanOrEqual(1);  // 1 emoji máx
  });

  test('3 outliers no MESMO tick = UMA mensagem agrupada (rajada da Simone não vira spam)', async () => {
    const tres = [
      order({ id: 55, number: '2751', shipmentId: 501, cost: 7.86, createdAt: nowIso(9), dueDate: '2026-09-04T16:00:00Z' }),
      order({ id: 56, number: '2752', shipmentId: 502, cost: 8.40, createdAt: nowIso(9) }),
      order({ id: 57, number: '2753', shipmentId: 503, cost: 9.62, createdAt: nowIso(9) }),
    ];
    const { db, posts, worker } = boot({ hour: 10, orders: tres });
    await seedHistory(db);
    const out = await worker.tick();
    expect(out.alerted).toBe(3);                         // os 3 carimbados
    const a = alerts(posts);
    expect(a.length).toBe(1);                            // mas UM post só
    const t = a[0].text;
    expect(t).toContain('*3 etiquetas acima do normal*');
    expect(t).toContain('2751');
    expect(t).toContain('2752');
    expect(t).toContain('2753');
    // v3: sem rates cada linha diz "sem cotacao" e a acao NUNCA manda deletar
    expect(t).toContain(' | sem cotacao');
    expect(t).toContain('Nenhuma com opcao mais barata na cotacao.');
    expect(t).not.toContain('deleta o envio');
    expect(t).not.toMatch(/[—–]/);
    expect((t.match(/:[a-z_]+:/g) || []).length).toBeLessThanOrEqual(1);
    // tick seguinte: nada repete
    const out2 = await worker.tick();
    expect(out2.alerted).toBe(0);
    expect(alerts(posts).length).toBe(1);
  });

  test('tick seguinte NÃO repete o alerta (alerted_at carimba uma vez)', async () => {
    const { db, posts, worker } = boot({ hour: 10, orders: [expensive()] });
    await seedHistory(db);
    await worker.tick();
    const out2 = await worker.tick();
    expect(out2.alerted).toBe(0);
    expect(alerts(posts).length).toBe(1);
  });

  test('sem folga de 2+ dias a linha do due_date fica de fora', async () => {
    const soon = order({ id: 56, number: '2800', shipmentId: 502, cost: 7.86,
      createdAt: nowIso(9), dueDate: atNy(23)().toISOString() });   // hoje mesmo
    const { db, posts, worker } = boot({ hour: 10, orders: [soon] });
    await seedHistory(db);
    await worker.tick();
    expect(alerts(posts)[0].text).not.toContain('Cliente aceita ate');
  });

  test('etiqueta no preço normal não gera alerta nenhum', async () => {
    const ok = order({ id: 57, number: '2801', shipmentId: 503, cost: 6.10, createdAt: nowIso(9) });
    const { db, posts, worker } = boot({ hour: 10, orders: [ok] });
    await seedHistory(db);
    await worker.tick();
    expect(alerts(posts).length).toBe(0);
  });

  test('teto absoluto: $12.50 <1lb grita mesmo SEM histórico da faixa', async () => {
    const crazy = order({ id: 58, number: '2802', shipmentId: 504, cost: 12.50,
      service: 'UPS 2nd Day Air', createdAt: nowIso(9) });
    const { posts, worker } = boot({ hour: 10, orders: [crazy] });
    await worker.tick();
    const a = alerts(posts);
    expect(a.length).toBe(1);
    expect(a[0].text).toContain('passou do teto de $12.00 pra pacote de menos de 1lb');
  });

  test('Walmart custo 0 e sem service: registra, NUNCA alerta', async () => {
    const wal = { id: 59, number: '2803', channel: { name: 'Walmart' }, due_date: null,
      deliver_to: { state: 'FL', zip: '33101' },
      allocations: [{ shipment: { id: 505, service_name: '', weight: 200,
        outbound_label_charges: { value: '0.0' }, created_at: nowIso(9) } }] };
    const { db, posts, worker } = boot({ hour: 10, orders: [wal] });
    await worker.tick();
    expect(db._rows.has('505')).toBe(true);
    expect(alerts(posts).length).toBe(0);
  });

  test('outlier julgado pelo ESTADO: alerta diz o normal do estado, nao da faixa', async () => {
    const ga = order({ id: 70, number: '2901', shipmentId: 510, cost: 8.40,
      createdAt: nowIso(9), state: 'GA' });
    const { db, posts, worker } = boot({ hour: 10, orders: [ga] });
    await seedHistory(db);                                            // faixa: 9x $6.00 sem estado
    await seedHistory(db, { state: 'GA', cost: 5.97, startId: 8100 }); // GA: 9x $5.97
    const out = await worker.tick();
    expect(out.alerted).toBe(1);
    const a = alerts(posts);
    expect(a.length).toBe(1);
    const t = a[0].text;
    expect(t).toContain('Pedido 2901 (eBay)');
    expect(t).toContain('USPS Ground Advantage saiu $8.40, o normal pra GA e $5.97.');
    expect(t).not.toContain('o normal dessa faixa');
    expect(t).not.toMatch(/[—–]/);
    expect((t.match(/:[a-z_]+:/g) || []).length).toBeLessThanOrEqual(1);
  });

  test('rajada pro mesmo estado: mensagem agrupada tambem fala o normal do estado', async () => {
    const dois = [
      order({ id: 71, number: '2902', shipmentId: 511, cost: 8.40, createdAt: nowIso(9), state: 'HI' }),
      order({ id: 72, number: '2903', shipmentId: 512, cost: 9.10, createdAt: nowIso(9), state: 'HI' }),
    ];
    const { db, posts, worker } = boot({ hour: 10, orders: dois });
    await seedHistory(db);                                            // faixa: 9x $6.00 sem estado
    await seedHistory(db, { state: 'HI', cost: 6.20, startId: 8200 }); // HI: 9x $6.20
    const out = await worker.tick();
    expect(out.alerted).toBe(2);
    const a = alerts(posts);
    expect(a.length).toBe(1);
    const t = a[0].text;
    expect(t).toContain('*2 etiquetas acima do normal*');
    expect(t).toContain('2902');
    expect(t).toContain('2903');
    expect(t).toContain(', normal pra HI $6.20');
    expect(t).not.toMatch(/[—–]/);
    expect((t.match(/:[a-z_]+:/g) || []).length).toBeLessThanOrEqual(1);
  });
});

describe('digest 16:15 NY', () => {
  test('antes das 16:15 não tem digest', async () => {
    const { posts, worker } = boot({ hour: 16, minute: 10 });
    await worker.tick();
    expect(digests(posts).length).toBe(0);
  });

  test('16:20: digest sai 1x; tick seguinte no mesmo dia NÃO repete', async () => {
    const exp = order({ id: 60, number: '2751', shipmentId: 601, cost: 7.86,
      createdAt: nowIso(15), dueDate: '2026-09-04T16:00:00Z' });
    const { db, posts, worker } = boot({ hour: 16, minute: 20, orders: [exp] });
    await seedHistory(db);
    await worker.tick();
    await worker.tick();
    const d = digests(posts);
    expect(d.length).toBe(1);
    expect(d[0].channel).toBe('C_ADMIN');
    expect(d[0].text).toContain('Frete de hoje:');
    expect(d[0].text).toContain('1 acima do normal, excesso de $1.86');
    expect(d[0].text).not.toMatch(/[—–]/);
  });

  test('dia normal (zero outlier, média perto do 30d) = digest de UMA linha', async () => {
    const ok = order({ id: 61, number: '2900', shipmentId: 602, cost: 6.00, createdAt: nowIso(15) });
    const { db, posts, worker } = boot({ hour: 16, minute: 30, orders: [ok] });
    await seedHistory(db);
    await worker.tick();
    const d = digests(posts);
    expect(d.length).toBe(1);
    expect(d[0].text).toContain('Nenhuma acima do normal.');
    expect(d[0].text.split('\n').length).toBe(1);
  });
});

describe('canais e limites', () => {
  test('TODA mensagem vai pro canal admin injetado, nenhuma pra outro lugar', async () => {
    const exp = order({ id: 62, number: '2751', shipmentId: 701, cost: 7.86,
      createdAt: nowIso(15), dueDate: '2026-09-04T16:00:00Z' });
    const { db, posts, worker } = boot({ hour: 16, minute: 20, orders: [exp] });
    await seedHistory(db);
    await worker.tick();
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) expect(p.channel).toBe('C_ADMIN');
  });

  test('pedido velho (48h+) fica fora do watch', async () => {
    const old = order({ id: 63, number: '2000', shipmentId: 702, cost: 20.00,
      createdAt: '2026-08-01T12:00:00Z' });
    const { db, posts, worker } = boot({ hour: 10, orders: [old] });
    await worker.tick();
    expect(db._rows.has('702')).toBe(false);
    expect(posts.length).toBe(0);
  });

  test('gentil com a Veeqo: nunca passa de maxPages', async () => {
    const full = [];
    for (let i = 0; i < 100; i++) full.push(order({ id: 1000 + i, number: String(1000 + i), shipmentId: 2000 + i, cost: 6.00, createdAt: nowIso(9) }));
    const db = makeFreightDb();
    const veeqo = { getOrdersPage: jest.fn(async () => full) };
    const worker = new FreightWatch({ db, veeqo, enabled: true,
      slack: { postAs: jest.fn() }, channelId: 'C_ADMIN', now: atNy(10) });
    await worker.tick();
    expect(veeqo.getOrdersPage.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe('FASE A: copiloto cota antes de aconselhar', () => {
  const gaOrder = (over = {}) => order({ id: 70, number: '2901', shipmentId: 510,
    cost: 8.40, createdAt: nowIso(9), state: 'GA', ...over });
  const seedGa = async (db) => {
    await seedHistory(db);                                              // faixa: 9x $6.00
    await seedHistory(db, { state: 'GA', cost: 5.97, startId: 8100 });  // GA: 9x $5.97
  };

  test('tem valida mais barata: o texto EXATO manda deletar e recomprar', async () => {
    const rates = fakeRates([
      { name: 'USPS Ground Advantage', price: 5.62, delivery_estimate: null, rate_id: 'r1' },
      { name: 'USPS Media Mail', price: 3.90, delivery_estimate: null, rate_id: 'r2' },  // banida: nunca vence
    ]);
    const { db, posts, worker } = boot({ hour: 10, orders: [gaOrder()], rates });
    await seedGa(db);
    const out = await worker.tick();
    expect(out.quoted).toBe(1);
    expect(out.alerted).toBe(1);
    const t = alerts(posts)[0].text;
    expect(t).toBe(':money_with_wings: *Etiqueta acima do normal* Pedido 2901 (eBay): '
      + 'USPS Ground Advantage saiu $8.40, o normal pra GA e $5.97.'
      + ' Cotei agora: tem USPS Ground Advantage por $5.62.'
      + ' Se ainda nao despachou: deleta o envio na Veeqo que o estorno e automatico, e recompra.'
      + ' Antes do SCAN form do dia.');
    expect(t).not.toMatch(/[—–]/);
    expect((t.match(/:[a-z_]+:/g) || []).length).toBeLessThanOrEqual(1);
    // a cotacao ficou na linha (quoted_* gravados)
    const row = db._rows.get('510');
    expect(Number(row.quoted_best_cost)).toBe(5.62);
    expect(row.quoted_best_service).toBe('USPS Ground Advantage');
    expect(row.quoted_valid_count).toBe(1);              // Media Mail fora
    expect(row.quoted_at).toBeTruthy();
  });

  test('cotou e o pago JA ERA o melhor: o texto EXATO diz que recomprar nao adianta', async () => {
    // melhor valida $8.30: acima de cost - $0.25 = $8.15, entao NAO e "mais barata"
    const rates = fakeRates([{ name: 'USPS Ground Advantage', price: 8.30, delivery_estimate: null, rate_id: 'r1' }]);
    const { db, posts, worker } = boot({ hour: 10, orders: [gaOrder()], rates });
    await seedGa(db);
    await worker.tick();
    const t = alerts(posts)[0].text;
    expect(t).toBe(':money_with_wings: *Etiqueta acima do normal* Pedido 2901 (eBay): '
      + 'USPS Ground Advantage saiu $8.40, o normal pra GA e $5.97.'
      + ' Cotei agora: ja era o melhor preco valido disponivel.'
      + ' Nao adianta recomprar; a causa e tarifa ou peso declarado.');
    expect(t).not.toContain('deleta o envio');
  });

  test('cotacao falhou (null): o texto EXATO manda conferir na Veeqo', async () => {
    const { db, posts, worker } = boot({ hour: 10, orders: [gaOrder()], rates: fakeRates(null) });
    await seedGa(db);
    const out = await worker.tick();
    expect(out.quoted).toBe(0);
    const t = alerts(posts)[0].text;
    expect(t).toBe(':money_with_wings: *Etiqueta acima do normal* Pedido 2901 (eBay): '
      + 'USPS Ground Advantage saiu $8.40, o normal pra GA e $5.97.'
      + ' Nao consegui cotar agora; confere na Veeqo se tem opcao mais barata antes de decidir.');
    expect(db._rows.get('510').quoted_at).toBe(null);    // sem carimbo: tenta de novo depois
  });

  test('cliente de rates que EXPLODE nunca derruba o tick (alerta sai como sem cotacao)', async () => {
    const rates = { quoteParcel: jest.fn(async () => { throw new Error('boom'); }) };
    const { db, posts, worker } = boot({ hour: 10, orders: [gaOrder()], rates });
    await seedGa(db);
    const out = await worker.tick();
    expect(out.alerted).toBe(1);                         // o tick viveu e avisou
    expect(alerts(posts)[0].text).toContain('Nao consegui cotar agora');
  });

  test('agrupada: sufixo por linha (cotei/ja era/sem cotacao) e acao so quando TEM mais barata', async () => {
    // 510 cota mais barato; 511 sem CEP nao entra na fila de cotacao (sem cotacao)
    const rates = fakeRates([{ name: 'USPS Priority Mail', price: 5.62, delivery_estimate: null, rate_id: 'r1' }]);
    const dois = [
      gaOrder(),
      order({ id: 71, number: '2902', shipmentId: 511, cost: 9.10, createdAt: nowIso(9), state: 'GA' }),
    ];
    dois[1].deliver_to.zip = null;                       // incotavel de proposito
    const { db, posts, worker } = boot({ hour: 10, orders: dois, rates });
    await seedGa(db);
    await worker.tick();
    const t = alerts(posts)[0].text;
    expect(t).toContain('*2 etiquetas acima do normal*');
    expect(t).toContain(' | cotei: da $5.62 (USPS Priority Mail)');
    expect(t).toContain(' | sem cotacao');
    expect(t).toContain('Se ainda nao despachou: deleta o envio na Veeqo que o estorno e automatico, e recompra as que tem opcao mais barata. Antes do SCAN form do dia.');
    expect(t).not.toMatch(/[—–]/);
    expect((t.match(/:[a-z_]+:/g) || []).length).toBeLessThanOrEqual(1);
  });

  test('agrupada sem NENHUMA mais barata: a acao nao manda deletar', async () => {
    const rates = fakeRates([{ name: 'USPS Ground Advantage', price: 8.35, delivery_estimate: null, rate_id: 'r1' }]);
    const dois = [
      gaOrder(),
      order({ id: 72, number: '2903', shipmentId: 512, cost: 8.50, createdAt: nowIso(9), state: 'GA' }),
    ];
    const { db, posts, worker } = boot({ hour: 10, orders: dois, rates });
    await seedGa(db);
    await worker.tick();
    const t = alerts(posts)[0].text;
    expect(t).toContain(' | ja era o melhor');
    expect(t).toContain('Nenhuma com opcao mais barata na cotacao. Nao adianta recomprar; a causa e tarifa ou peso declarado.');
    expect(t).not.toContain('deleta o envio');
  });

  test('cap de 25 cotacoes por tick; o resto fica pro proximo tick', async () => {
    const many = [];
    for (let i = 0; i < 30; i++) {
      many.push(order({ id: 3000 + i, number: String(3000 + i), shipmentId: 4000 + i,
        cost: 6.00, createdAt: nowIso(9) }));
    }
    const rates = fakeRates([{ name: 'USPS Ground Advantage', price: 5.50, delivery_estimate: null, rate_id: 'r1' }]);
    const { worker } = boot({ hour: 10, orders: many, rates });
    const out = await worker.tick();
    expect(out.quoted).toBe(25);
    expect(rates.quoteParcel.mock.calls.length).toBe(25);
    const out2 = await worker.tick();                    // a fila (quoted_at IS NULL) entrega o resto
    expect(out2.quoted).toBe(5);
    expect(rates.quoteParcel.mock.calls.length).toBe(30);
  });

  test('digest ganha a frase da economia quando tem opcao mais barata', async () => {
    const rates = fakeRates([{ name: 'USPS Ground Advantage', price: 5.62, delivery_estimate: null, rate_id: 'r1' }]);
    const { db, posts, worker } = boot({ hour: 16, minute: 20, orders: [gaOrder({ createdAt: nowIso(15) })], rates });
    await seedGa(db);
    await worker.tick();
    const d = digests(posts);
    expect(d.length).toBe(1);
    expect(d[0].text).toContain('1 acima do normal');
    expect(d[0].text).toContain('1 com opcao mais barata (da pra recuperar $2.78).');
    expect(d[0].text).not.toMatch(/[—–]/);
  });

  test('sem cliente de rates o tick segue identico ao v2 (quoted 0, nada explode)', async () => {
    const { posts, worker } = boot({ hour: 10, orders: [gaOrder()] });
    void posts;
    const out = await worker.tick();
    expect(out.quoted).toBe(0);
    expect(out.fetched).toBe(1);
  });
});
