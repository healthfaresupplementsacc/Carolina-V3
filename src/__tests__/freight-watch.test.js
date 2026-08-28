'use strict';
/**
 * freight-watch (Bruno 08-28).
 *  1. janela 8h-19h NY: fora dela nem toca na Veeqo
 *  2. outlier NOVO → 1 alerta no admin-orin NA HORA; tick seguinte NÃO repete
 *  3. digest 1x por dia, só de 16:15 em diante (dedupe via audit_log)
 *  4. NUNCA canal de operador; desligado por padrão
 *  5. texto do alerta: forma combinada, sem em dash, folga do due_date
 *  6. Walmart custo 0 registrado mas nunca alertado
 * DB/Veeqo/Slack mockados; relógio injetado.
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
  weight = 200, cost, createdAt, dueDate }) {
  return {
    id, number, channel: { name: channel },
    due_date: dueDate || null, dispatch_date: null,
    deliver_to: { state: 'TX', zip: '75001' },
    allocations: [{ shipment: {
      id: shipmentId, service_name: service, weight,
      outbound_label_charges: { value: String(cost) },
      created_at: createdAt,
    } }],
  };
}

/** Histórico: 9 etiquetas de $6.00 na faixa usps_ga|4-8oz, ONTEM (mediana pronta). */
async function seedHistory(db) {
  for (let i = 0; i < 9; i++) {
    const id = 8000 + i;
    await freight.upsertShipments(db, [{ shipment_id: id, cost: 6.00,
      service: 'USPS Ground Advantage', weight_g: 200,
      ny_day: '2026-08-20', bought_at: '2026-08-20T14:00:00Z' }]);
    await freight.saveJudgement(db, id, { band: 'usps_ga|4-8oz', expected_cost: null, outlier: false, outlier_reason: null });
  }
}

function boot({ hour = 10, minute = 0, orders = [], enabled = true } = {}) {
  const db = makeFreightDb();
  const posts = [];
  const veeqo = { getOrdersPage: jest.fn(async ({ page }) => (page === 1 ? orders : [])) };
  const worker = new FreightWatch({
    db, veeqo, enabled,
    slack: { postAs: jest.fn(async (m) => { posts.push(m); }) },
    channelId: 'C_ADMIN',
    now: atNy(hour, minute),
  });
  return { db, posts, veeqo, worker };
}

const nowIso = (hour) => atNy(hour)().toISOString();
const alerts = (posts) => posts.filter((p) => p.text.includes('Etiqueta acima do normal'));
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
    expect(t).toContain('deleta o envio na Veeqo que o estorno e automatico, e recompra mais barato');
    expect(t).toContain('Antes do SCAN form do dia.');
    expect(t).not.toMatch(/[—–]/);                       // sem em dash, nunca
    expect((t.match(/:[a-z_]+:/g) || []).length).toBeLessThanOrEqual(1);  // 1 emoji máx
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
