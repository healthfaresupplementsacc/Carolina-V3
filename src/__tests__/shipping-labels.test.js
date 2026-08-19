'use strict';
/**
 * ETIQUETAS DE ENVIO — envelope, rodapé e composição do PDF (S15.37).
 *
 * O PDF é REAL: as etiquetas de entrada são geradas aqui com pdf-lib (4x6,
 * 288x432pt, a mesma geometria dos PDFs da Veeqo conferida em 08-19) e o
 * resultado é reaberto e medido. Nenhuma etiqueta real de cliente entra em
 * teste — dado de cliente não mora no repositório.
 *
 * O que estes testes protegem, em ordem de gravidade se quebrar:
 *  1. DEDUPLICAÇÃO — etiqueta impressa duas vezes = pacote com duas etiquetas.
 *  2. printed_at só no /done — compor não é imprimir.
 *  3. Ordem de caminhada + divisórias — é a rota do armazém virando papel.
 *  4. Rodapé com '?' no lugar do que não se sabe — nunca chutar.
 */

const { PDFDocument } = require('pdf-lib');
const { pickEnvelope, MIXED } = require('../v3/shipping-labels/envelope');
const { footerText } = require('../v3/shipping-labels/footer');
const { ShippingLabelsService, ShippingLabelsError } = require('../v3/shipping-labels/service');

/** Faixas reais (Bruno 08-06): regra do saco perfeito, menor que couber. */
const TIERS = [
  { bottle_color: 'black', min_bottles: 1, max_bottles: 1, package_size: '7x10' },
  { bottle_color: 'black', min_bottles: 2, max_bottles: 3, package_size: '9x12' },
  { bottle_color: 'black', min_bottles: 4, max_bottles: 12, package_size: '15x19' },
  { bottle_color: 'black', min_bottles: 13, max_bottles: null, package_size: 'BX' },
  { bottle_color: 'white', min_bottles: 1, max_bottles: 1, package_size: '4x8' },
  { bottle_color: 'white', min_bottles: 2, max_bottles: 4, package_size: '7x10' },
  { bottle_color: 'white', min_bottles: 5, max_bottles: 6, package_size: '9x12' },
  { bottle_color: 'white', min_bottles: 7, max_bottles: 24, package_size: '15x19' },
  { bottle_color: 'white', min_bottles: 25, max_bottles: null, package_size: 'BX' },
];

/** Uma etiqueta 4x6 sintética, do tamanho exato do que a Veeqo manda. */
async function fakeLabel(text) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([288, 432]);
  page.drawText(String(text || 'ETIQUETA'), { x: 20, y: 300, size: 10 });
  return Buffer.from(await doc.save());
}

// ── ENVELOPE ────────────────────────────────────────────────────────────────
describe('envelope: a regra do saco perfeito', () => {
  test('sempre o MENOR que cabe, por cor', () => {
    expect(pickEnvelope(TIERS, 1, ['white'])).toBe('4x8');
    expect(pickEnvelope(TIERS, 1, ['black'])).toBe('7x10');
    expect(pickEnvelope(TIERS, 2, ['black'])).toBe('9x12');
    expect(pickEnvelope(TIERS, 3, ['black'])).toBe('9x12');
    expect(pickEnvelope(TIERS, 4, ['black'])).toBe('15x19');
    expect(pickEnvelope(TIERS, 4, ['white'])).toBe('7x10');
    expect(pickEnvelope(TIERS, 6, ['white'])).toBe('9x12');
  });

  test('acima da maior faixa vira caixa (BX)', () => {
    expect(pickEnvelope(TIERS, 13, ['black'])).toBe('BX');
    expect(pickEnvelope(TIERS, 500, ['black'])).toBe('BX');
    expect(pickEnvelope(TIERS, 25, ['white'])).toBe('BX');
  });

  test('cor não cadastrada = desconhecido, nunca um palpite', () => {
    expect(pickEnvelope(TIERS, 3, [])).toBeNull();
    expect(pickEnvelope(TIERS, 3, [null])).toBeNull();
    expect(pickEnvelope(TIERS, 3, ['roxo'])).toBeNull();   // cor sem faixa
    expect(pickEnvelope(TIERS, 0, ['black'])).toBeNull();
  });

  test('cores misturadas = misto? (regra ainda não definida pelo Bruno)', () => {
    expect(pickEnvelope(TIERS, 3, ['black', 'white'])).toBe(MIXED);
    expect(pickEnvelope(TIERS, 3, ['Black', 'WHITE'])).toBe(MIXED);
  });

  test('a cor não é sensível a maiúscula/espaço', () => {
    expect(pickEnvelope(TIERS, 1, ['  Black '])).toBe('7x10');
    expect(pickEnvelope(TIERS, 2, ['black', 'BLACK'])).toBe('9x12');  // mesma cor, não é misto
  });
});

// ── RODAPÉ ──────────────────────────────────────────────────────────────────
describe('rodapé: uma linha, e um ? no que não se sabe', () => {
  test('linha completa na ordem das perguntas do operador', () => {
    expect(footerText({
      nicknames: ['BENF-300'], bin_code: 'A03B2', bottles: 3,
      envelope: '9x12', picker_ids: ['5'], packer_id: '10',
    })).toBe('BENF-300  ·  A03B2  ·  3 gar  ·  9x12  ·  Pick: 5  Pack: 10');
  });

  test('pedido misto: primeiro nickname + quantos mais', () => {
    const t = footerText({
      nicknames: ['BENF-300', 'CHAR-1200'], bin_code: 'A01', bottles: 4,
      envelope: 'misto?', picker_ids: ['5'], packer_id: '10',
    });
    expect(t).toContain('BENF-300 +1');
    expect(t).toContain('misto?');
  });

  test('sem picker, sem packer, sem envelope: ? em cada um', () => {
    const t = footerText({ nicknames: ['X-1'], bin_code: 'A1', bottles: 1 });
    expect(t).toBe('X-1  ·  A1  ·  1 gar  ·  ?  ·  Pick: ?  Pack: ?');
  });

  test('dois separadores ao mesmo tempo = os dois IDs', () => {
    expect(footerText({ nicknames: ['X'], bottles: 1, picker_ids: ['5', '7'], packer_id: '10' }))
      .toContain('Pick: 5,7  Pack: 10');
  });

  test('sem bin cai pra prateleira; sem nada, "sem local"', () => {
    expect(footerText({ nicknames: ['X'], shelf_code: 'S2', bottles: 1 })).toContain('·  S2  ·');
    expect(footerText({ nicknames: ['X'], bottles: 1 })).toContain('·  sem local  ·');
  });

  test('SKU sem mapeamento vira o nome (nunca some da etiqueta)', () => {
    expect(footerText({ nicknames: [], sku: 'HF-NOVO-999', bottles: 1 }))
      .toContain('HF-NOVO-999');
  });
});

// ── BANCO FALSO ─────────────────────────────────────────────────────────────
function makeDb(state) {
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();

      if (/FROM v3\.events e/.test(q)) return { rows: state.pickers || [] };
      if (/FROM v3\.bottle_size_tiers/.test(q)) return { rows: TIERS };
      if (/FROM v3\.product_skus ps/.test(q)) {
        const want = params[0] || [];
        return { rows: (state.skus || []).filter((r) => want.includes(r.sku)) };
      }
      if (/SELECT shipment_id FROM v3\.shipping_label_prints/.test(q)) {
        const want = (params[0] || []).map(String);
        return { rows: (state.prints || [])
          .filter((p) => want.includes(String(p.shipment_id)) && p.printed_at)
          .map((p) => ({ shipment_id: p.shipment_id })) };
      }
      if (/INSERT INTO v3\.print_files/.test(q)) {
        state.files.push({ id: state.files.length + 1, bytes: params[0], pages: params[1] });
        return { rows: [{ id: state.files.length }] };
      }
      if (/UPDATE v3\.print_files SET job_id/.test(q)) {
        const f = state.files.find((x) => x.id === params[1]);
        if (f) f.job_id = params[0];
        return { rows: [] };
      }
      if (/SELECT id, mime, bytes, pages FROM v3\.print_files/.test(q)) {
        const f = [...state.files].reverse().find((x) => x.job_id === Number(params[0]));
        return { rows: f ? [{ id: f.id, mime: 'application/pdf', bytes: f.bytes, pages: f.pages }] : [] };
      }
      if (/INSERT INTO v3\.shipping_label_prints/.test(q)) {
        const row = {
          external_order_id: params[0], shipment_id: String(params[1]), order_number: params[2],
          channel: params[3], product_ids: params[4], nicknames: params[5], bottles: params[6],
          envelope: params[7], picker_ids: params[8], packer_id: params[9], job_id: params[10],
          is_test: params[11], printed_at: null,
        };
        const i = (state.prints || []).findIndex((x) => String(x.shipment_id) === row.shipment_id);
        if (i >= 0) state.prints[i] = Object.assign(state.prints[i], row);
        else state.prints.push(row);
        return { rows: [] };
      }
      if (/UPDATE v3\.shipping_label_prints SET printed_at/.test(q)) {
        const want = (params[0] || []).map(String);
        const hit = state.prints.filter((p) => want.includes(String(p.shipment_id)) && !p.printed_at);
        for (const p of hit) p.printed_at = new Date().toISOString();
        return { rows: hit.map((p) => ({ external_order_id: p.external_order_id })) };
      }
      if (/UPDATE v3\.pnp_order_lines SET printed_at/.test(q)) {
        const want = (params[0] || []).map(String);
        const hit = (state.lines || []).filter((l) => want.includes(String(l.external_order_id))
          && !l.printed_at && l.status !== 'cancelled');
        for (const l of hit) l.printed_at = new Date().toISOString();
        return { rows: hit.map((l) => ({ id: l.id })) };
      }
      return { rows: [] };
    },
  };
}

/** Fila falsa: só enqueue/take, que é o que o compose usa. */
function makeQueue(state) {
  return {
    async enqueue(p) {
      const job = Object.assign({ id: state.jobs.length + 1, status: 'queued' }, p);
      state.jobs.push(job);
      return job;
    },
    async take(id, by) {
      const j = state.jobs.find((x) => x.id === id);
      j.status = 'taken'; j.taken_by = by;
      return j;
    },
  };
}

/** Um pedido da Veeqo, no formato real (allocations[].shipment.id). */
function order(id, number, sku, qty, shipmentId, day = '2026-08-19') {
  return {
    id, number,
    shipped_at: day + 'T15:00:00Z',
    channel: { name: 'HealthFare Website' },
    line_items: [].concat(sku).map((s, i) => ({
      quantity: [].concat(qty)[i], sellable: { sku_code: s },
    })),
    allocations: [{ shipment: { id: shipmentId, tracking_number: 'TRK' + shipmentId,
      carrier: { name: 'Buy Shipping' }, service_name: 'USPS Ground Advantage' } }],
  };
}

function setup(extra = {}) {
  const state = {
    jobs: [], files: [], prints: [], lines: [], pickers: [{ person_id: 5 }],
    skus: [
      { sku: 'HF-BENF-300', product_id: 1, units_per_pack: 1, nickname: 'BENF-300',
        bottle_color: 'black', bin_code: 'A03B2', shelf_code: 'S2', bin_area: 'A' },
      { sku: 'HF-CHAR-1200', product_id: 2, units_per_pack: 1, nickname: 'CHAR-1200',
        bottle_color: 'white', bin_code: 'B01', shelf_code: 'S1', bin_area: 'B' },
      { sku: 'HF-PACK-C3', product_id: 3, units_per_pack: 3, nickname: 'PACK-C3',
        bottle_color: 'black', bin_code: null, shelf_code: null, bin_area: null },
    ],
  };
  Object.assign(state, extra);
  const veeqo = {
    ordersShippedOn: jest.fn(async () => state.orders || []),
    getLabelPdf: jest.fn(async (id) => {
      if (state.failLabels && state.failLabels.includes(String(id))) {
        const e = new Error('Veeqo HTTP 404 na etiqueta ' + id); e.code = 'http_error'; throw e;
      }
      return fakeLabel('SHIP ' + id);
    }),
  };
  const svc = new ShippingLabelsService({ db: makeDb(state), veeqo, queue: makeQueue(state) });
  return { state, svc, veeqo };
}

// ── PREVIEW ─────────────────────────────────────────────────────────────────
describe('preview: o que dá pra imprimir hoje', () => {
  test('resolve produto, local, garrafas e envelope de cada pedido', async () => {
    const { svc } = setup({ orders: [order(1, '#3348', 'HF-BENF-300', 2, 900)] });
    const r = await svc.preview('2026-08-19');
    expect(r.counts).toEqual({ ready: 1, printed: 0, to_print: 1 });
    const it = r.ready[0];
    expect(it.order_number).toBe('#3348');
    expect(it.shipment_id).toBe('900');
    expect(it.tracking).toBe('TRK900');
    expect(it.bottles).toBe(2);
    expect(it.envelope).toBe('9x12');          // 2 pretas
    expect(it.products[0]).toMatchObject({ nickname: 'BENF-300', bin_code: 'A03B2' });
  });

  test('casepack multiplica garrafas por units_per_pack', async () => {
    const { svc } = setup({ orders: [order(1, '#1', 'HF-PACK-C3', 2, 901)] });
    const r = await svc.preview('2026-08-19');
    expect(r.ready[0].bottles).toBe(6);        // 2 * 3
    expect(r.ready[0].envelope).toBe('15x19'); // 6 pretas
  });

  test('pedido sem shipment não entra (não há etiqueta comprada)', async () => {
    const o = order(1, '#1', 'HF-BENF-300', 1, 902);
    o.allocations = [{}];
    const { svc } = setup({ orders: [o] });
    expect((await svc.preview('2026-08-19')).counts.ready).toBe(0);
  });

  test('SKU sem mapeamento aparece com o próprio SKU como nome', async () => {
    const { svc } = setup({ orders: [order(1, '#1', 'HF-DESCONHECIDO', 1, 903)] });
    const r = await svc.preview('2026-08-19');
    expect(r.ready[0].products[0]).toMatchObject({ product_id: null, nickname: 'HF-DESCONHECIDO' });
    expect(r.ready[0].envelope).toBeNull();     // sem cor: '?' no rodapé
  });

  test('já impresso conta como printed, não como to_print', async () => {
    const { svc } = setup({
      orders: [order(1, '#1', 'HF-BENF-300', 1, 904)],
      prints: [{ shipment_id: '904', printed_at: '2026-08-19T16:00:00Z' }],
    });
    const r = await svc.preview('2026-08-19');
    expect(r.counts).toEqual({ ready: 1, printed: 1, to_print: 0 });
  });
});

// ── COMPOSE ─────────────────────────────────────────────────────────────────
describe('compose: um PDF só, agrupado por produto', () => {
  test('divisória por grupo + uma página por etiqueta, tudo 4x6', async () => {
    const { svc, state } = setup({ orders: [
      order(1, '#1', 'HF-BENF-300', 1, 901),
      order(2, '#2', 'HF-BENF-300', 1, 902),
      order(3, '#3', 'HF-CHAR-1200', 1, 903),
    ] });
    const r = await svc.compose({ day: '2026-08-19', requested_by: 'Vitor', packer_id: '10' });

    // 2 grupos → 2 divisórias + 3 etiquetas = 5 páginas
    expect(r.counts).toMatchObject({ labels: 3, groups: 2, pages: 5, failed: 0 });

    const pdf = await PDFDocument.load(state.files[0].bytes);
    expect(pdf.getPageCount()).toBe(5);
    for (const pg of pdf.getPages()) {
      const { width, height } = pg.getSize();
      expect(Math.round(width)).toBe(288);      // 4in
      expect(Math.round(height)).toBe(432);     // 6in
    }
  });

  test('grupos saem na ordem de caminhada (área A antes de B)', async () => {
    const { svc, state } = setup({ orders: [
      order(1, '#1', 'HF-CHAR-1200', 1, 901),   // área B
      order(2, '#2', 'HF-BENF-300', 1, 902),    // área A
    ] });
    await svc.compose({ day: '2026-08-19', requested_by: 'Vitor' });
    const groups = state.jobs[0].payload.groups;
    expect(groups.map((g) => g.nickname)).toEqual(['BENF-300', 'CHAR-1200']);
    expect(groups[0]).toMatchObject({ count: 1, location: 'A03B2' });
  });

  test('produto sem local vai pro FIM da pilha', async () => {
    const { svc, state } = setup({ orders: [
      order(1, '#1', 'HF-PACK-C3', 1, 901),     // sem bin
      order(2, '#2', 'HF-BENF-300', 1, 902),    // A03B2
    ] });
    await svc.compose({ day: '2026-08-19', requested_by: 'Vitor' });
    expect(state.jobs[0].payload.groups.map((g) => g.nickname)).toEqual(['BENF-300', 'PACK-C3']);
  });

  test('enfileira kind shipping_labels com file_id e os shipments', async () => {
    const { svc, state } = setup({ orders: [order(1, '#1', 'HF-BENF-300', 1, 901)] });
    const r = await svc.compose({ day: '2026-08-19', requested_by: 'Vitor' });
    const job = state.jobs[0];
    expect(job.kind).toBe('shipping_labels');
    expect(job.payload).toMatchObject({ day: '2026-08-19', count: 1, shipment_ids: ['901'] });
    expect(job.payload.file_id).toBe(r.file_id);
    expect(state.files[0].job_id).toBe(job.id);
  });

  test('take:true já toma o job pra quem pediu', async () => {
    const { svc, state } = setup({ orders: [order(1, '#1', 'HF-BENF-300', 1, 901)] });
    const r = await svc.compose({ day: '2026-08-19', requested_by: 'Vitor', take: true });
    expect(r.job.status).toBe('taken');
    expect(state.jobs[0].taken_by).toBe('Vitor');
  });

  test('compor NÃO é imprimir: printed_at nasce nulo', async () => {
    const { svc, state } = setup({ orders: [order(1, '#1', 'HF-BENF-300', 1, 901)] });
    await svc.compose({ day: '2026-08-19', requested_by: 'Vitor', packer_id: '10' });
    expect(state.prints).toHaveLength(1);
    expect(state.prints[0].printed_at).toBeNull();
    expect(state.prints[0].packer_id).toBe('10');
    expect(state.prints[0].picker_ids).toEqual(['5']);
    expect(state.prints[0].envelope).toBe('7x10');
  });

  test('sem nada novo: 409 nothing_to_print (não um PDF vazio)', async () => {
    const { svc } = setup({
      orders: [order(1, '#1', 'HF-BENF-300', 1, 901)],
      prints: [{ shipment_id: '901', printed_at: '2026-08-19T16:00:00Z' }],
    });
    await expect(svc.compose({ day: '2026-08-19', requested_by: 'V' }))
      .rejects.toMatchObject({ code: 'nothing_to_print', status: 409 });
  });

  test('dia sem pedido nenhum: 409 também', async () => {
    const { svc } = setup({ orders: [] });
    await expect(svc.compose({ day: '2026-08-19', requested_by: 'V' }))
      .rejects.toBeInstanceOf(ShippingLabelsError);
  });

  test('reprint:true inclui de novo o que já saiu', async () => {
    const { svc, state } = setup({
      orders: [order(1, '#1', 'HF-BENF-300', 1, 901)],
      prints: [{ shipment_id: '901', printed_at: '2026-08-19T16:00:00Z' }],
    });
    const r = await svc.compose({ day: '2026-08-19', requested_by: 'V', reprint: true });
    expect(r.counts.labels).toBe(1);
    expect(state.jobs).toHaveLength(1);
  });

  test('shipment_ids limita a composição a esses pedidos', async () => {
    const { svc } = setup({ orders: [
      order(1, '#1', 'HF-BENF-300', 1, 901),
      order(2, '#2', 'HF-CHAR-1200', 1, 902),
    ] });
    const r = await svc.compose({ day: '2026-08-19', requested_by: 'V', shipment_ids: ['902'] });
    expect(r.counts.labels).toBe(1);
  });

  test('uma etiqueta que a Veeqo recusa não derruba as outras', async () => {
    const { svc, state } = setup({
      orders: [
        order(1, '#1', 'HF-BENF-300', 1, 901),
        order(2, '#2', 'HF-BENF-300', 1, 902),
      ],
      failLabels: ['901'],
    });
    const r = await svc.compose({ day: '2026-08-19', requested_by: 'V' });
    expect(r.counts).toMatchObject({ labels: 1, failed: 1 });
    // a que falhou NÃO entra no histórico nem no payload (não foi impressa)
    expect(state.jobs[0].payload.shipment_ids).toEqual(['902']);
    expect(state.prints.map((p) => p.shipment_id)).toEqual(['902']);
    expect(state.jobs[0].payload.failed[0]).toMatchObject({ shipment_id: '901' });
  });

  test('se NENHUMA etiqueta baixa, falha em vez de enfileirar papel vazio', async () => {
    const { svc, state } = setup({
      orders: [order(1, '#1', 'HF-BENF-300', 1, 901)], failLabels: ['901'],
    });
    await expect(svc.compose({ day: '2026-08-19', requested_by: 'V' }))
      .rejects.toMatchObject({ code: 'nothing_to_print' });
    expect(state.jobs).toHaveLength(0);
    expect(state.files).toHaveLength(0);
  });

  test('pedido misto: um grupo, envelope misto?, nickname +1 no rodapé', async () => {
    const { svc } = setup({ orders: [
      order(1, '#1', ['HF-BENF-300', 'HF-CHAR-1200'], [1, 1], 901),
    ] });
    const pre = await svc.preview('2026-08-19');
    expect(pre.ready[0].mixed).toBe(true);
    expect(pre.ready[0].bottles).toBe(2);
    expect(pre.ready[0].envelope).toBe(MIXED);   // preto + branco
  });
});

// ── DONE ────────────────────────────────────────────────────────────────────
describe('markPrinted: o carimbo só quando o papel saiu', () => {
  test('carimba as etiquetas do job e as linhas de pedido', async () => {
    const { svc, state } = setup({
      orders: [order(1, '#1', 'HF-BENF-300', 1, 901)],
      lines: [{ id: 7, external_order_id: '1', status: 'shipped', printed_at: null }],
    });
    await svc.compose({ day: '2026-08-19', requested_by: 'V' });
    const job = state.jobs[0];

    const r = await svc.markPrinted({ kind: 'shipping_labels', payload: job.payload });
    expect(r).toEqual({ labels: 1, lines: 1 });
    expect(state.prints[0].printed_at).not.toBeNull();
    expect(state.lines[0].printed_at).not.toBeNull();
    // status NÃO é rebaixado: a Veeqo já disse 'shipped' quando a etiqueta foi comprada
    expect(state.lines[0].status).toBe('shipped');
  });

  test('carimbar duas vezes não conta duas vezes', async () => {
    const { svc, state } = setup({
      orders: [order(1, '#1', 'HF-BENF-300', 1, 901)],
      lines: [{ id: 7, external_order_id: '1', status: 'shipped', printed_at: null }],
    });
    await svc.compose({ day: '2026-08-19', requested_by: 'V' });
    const job = state.jobs[0];
    await svc.markPrinted({ kind: 'shipping_labels', payload: job.payload });
    expect(await svc.markPrinted({ kind: 'shipping_labels', payload: job.payload }))
      .toEqual({ labels: 0, lines: 0 });
  });

  test('linha cancelada não é carimbada', async () => {
    const { svc, state } = setup({
      orders: [order(1, '#1', 'HF-BENF-300', 1, 901)],
      lines: [{ id: 7, external_order_id: '1', status: 'cancelled', printed_at: null }],
    });
    await svc.compose({ day: '2026-08-19', requested_by: 'V' });
    const r = await svc.markPrinted({ kind: 'shipping_labels', payload: state.jobs[0].payload });
    expect(r.lines).toBe(0);
    expect(state.lines[0].printed_at).toBeNull();
  });

  test('job de outro tipo não carimba nada', async () => {
    const { svc } = setup({ orders: [] });
    expect(await svc.markPrinted({ kind: 'picklist', payload: { shipment_ids: ['1'] } }))
      .toEqual({ labels: 0, lines: 0 });
  });

  test('depois do carimbo, o mesmo dia não compõe de novo (deduplicação)', async () => {
    const { svc, state } = setup({ orders: [order(1, '#1', 'HF-BENF-300', 1, 901)] });
    await svc.compose({ day: '2026-08-19', requested_by: 'V' });
    await svc.markPrinted({ kind: 'shipping_labels', payload: state.jobs[0].payload });
    await expect(svc.compose({ day: '2026-08-19', requested_by: 'V' }))
      .rejects.toMatchObject({ code: 'nothing_to_print' });
  });
});

// ── PICKERS ─────────────────────────────────────────────────────────────────
describe('pickers: quem tem tarefa de P&P aberta agora', () => {
  test('sem tarefa aberta = lista vazia (rodapé escreve ?)', async () => {
    const { svc } = setup({ pickers: [] });
    expect(await svc.pickerIds()).toEqual([]);
  });

  test('duas pessoas juntas = os dois IDs', async () => {
    const { svc } = setup({ pickers: [{ person_id: 5 }, { person_id: 7 }] });
    expect(await svc.pickerIds()).toEqual(['5', '7']);
  });

  test('banco fora do ar não derruba a impressão', async () => {
    const svc = new ShippingLabelsService({
      db: { query: async () => { throw new Error('db down'); } }, veeqo: {}, queue: {},
    });
    expect(await svc.pickerIds()).toEqual([]);
  });
});
