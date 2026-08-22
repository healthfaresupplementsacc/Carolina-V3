'use strict';
/**
 * Hub de estoque do OPERADOR — /api/v3/op/* (S15 Fase 3, Bruno 08-18).
 *  1. pareamento: pair → stream (SSE) → push do celular → o kiosk recebe
 *  2. push sem sessão (o código É a credencial); expirado = 410; par de outro = 403
 *  3. resolve: bin_code → box_number → UPC → SKU → formas de URL → unknown
 *  4. organizar aplica NA HORA (StockService.place); contagem vira PROPOSTA
 *  5. contagem por peso leva o meta da pesagem; sem peso unitário não propõe nada
 *  6. caixa nova = proposta kind 'entrada' com meta.box (número só na aprovação)
 * Handlers Express-agnósticos (session, body) → {status?, body}; DB mockado.
 */
const { createOpWarehouse, parseBarcode } = require('../v3/warehouse/op-warehouse');

const SESSION = { person_id: 7, display_name: 'Simone', token: 'sess-A', is_sandbox: false };
const OTHER_SESSION = { person_id: 8, display_name: 'Vitor', token: 'sess-B', is_sandbox: false };

/** Sink SSE falso: guarda o que foi escrito, do jeito que o res faria. */
function makeSink() {
  const sink = {
    head: null, chunks: [], closed: false, handlers: {},
    writeHead(status, headers) { sink.head = { status, headers }; },
    write(s) { if (sink.closed) throw new Error('escrita em conexão fechada'); sink.chunks.push(s); return true; },
    on(ev, fn) { sink.handlers[ev] = fn; },
    close() { sink.closed = true; if (sink.handlers.close) sink.handlers.close(); },
    /** eventos SSE decodificados (ignora os comentários de keepalive) */
    events() {
      return sink.chunks.filter((c) => c.startsWith('event:')).map((c) => {
        const ev = c.match(/^event: (.+)$/m)[1];
        const data = JSON.parse(c.match(/^data: (.+)$/m)[1]);
        return { event: ev, data };
      });
    },
  };
  return sink;
}

function makeDb(state) {
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      state.queries.push({ q, params });
      // scan_pairs
      if (q.startsWith('INSERT INTO v3.scan_pairs')) {
        state.pairs.set(params[0], { code: params[0], session_token: params[1],
          person_id: params[2], expires_at: params[3], last_seen_at: null, phone_ua: null });
        return { rows: [] };
      }
      if (/SELECT \* FROM v3\.scan_pairs WHERE code/.test(q)) {
        const p = state.pairs.get(params[0]);
        return { rows: p ? [{ ...p }] : [] };
      }
      if (q.startsWith('UPDATE v3.scan_pairs')) {
        const p = state.pairs.get(params[0]);
        if (!p) return { rows: [] };
        p.expires_at = params[1]; p.last_seen_at = new Date();
        if (params[2]) p.phone_ua = params[2];
        return { rows: [{ ...p }] };
      }
      // tarefas: contagens sugeridas e reposição (antes do resolve, que casa parecido)
      if (/LEFT JOIN \(SELECT bin_id, MAX\(created_at\)/.test(q)) {
        return { rows: [{ bin_id: 1, bin_code: 'A03B2', qty: 12, product_id: 10,
          product: 'BENF-300', last_count: null }] };
      }
      if (/LEFT JOIN LATERAL/.test(q)) {
        return { rows: [{ bin_id: 1, bin_code: 'A03B2', qty: 4, min_qty: 10, capacity: 48,
          product_id: 10, product: 'BENF-300', box_id: 5, box_number: 'BX-0451', box_qty: 180 }] };
      }
      // resolve
      if (/FROM v3\.stock_bins b LEFT JOIN v3\.products p/.test(q)) {
        const b = state.bins.find((x) => x.bin_code.toUpperCase() === params[0]);
        return { rows: b ? [{ ...b, product: 'BENF-300' }] : [] };
      }
      if (/FROM v3\.stock_boxes x LEFT JOIN v3\.products p ON p\.id = x\.product_id WHERE UPPER/.test(q)) {
        const b = state.boxes.find((x) => x.box_number.toUpperCase() === params[0]);
        return { rows: b ? [{ ...b, product: 'BENF-300' }] : [] };
      }
      if (/SELECT product_id FROM v3\.product_skus/.test(q)) {
        const s = state.skus.find((x) => (x.barcode || '').toUpperCase() === params[0]
          || x.sku.toUpperCase() === params[0]);
        return { rows: s ? [{ product_id: s.product_id }] : [] };
      }
      // produto
      if (/FROM v3\.products p LEFT JOIN v3\.stock_unplaced/.test(q)) {
        const p = state.products.find((x) => x.id === params[0]);
        return { rows: p ? [{ product_id: p.id, name: p.name, nickname: p.nickname,
          bottle_color: 'black', unit_weight_g: p.unit_weight_g, unplaced_qty: p.unplaced || 0 }] : [] };
      }
      if (/FROM v3\.stock_bins WHERE product_id/.test(q)) {
        return { rows: state.bins.filter((b) => b.product_id === params[0]) };
      }
      if (/FROM v3\.stock_boxes WHERE product_id/.test(q)) {
        return { rows: state.boxes.filter((b) => b.product_id === params[0]) };
      }
      // caixa por id (etiqueta)
      if (/FROM v3\.stock_boxes x LEFT JOIN v3\.products p ON p\.id = x\.product_id WHERE x\.id/.test(q)) {
        const b = state.boxes.find((x) => x.id === params[0]);
        return { rows: b ? [{ ...b, product: 'BENF-300' }] : [] };
      }
      // pesos
      if (/SELECT unit_weight_g FROM v3\.products/.test(q)) {
        const p = state.products.find((x) => x.id === params[0]);
        return { rows: p ? [{ unit_weight_g: p.unit_weight_g }] : [] };
      }
      if (/SELECT tare_g FROM v3\.stock_bins/.test(q)) {
        const b = state.bins.find((x) => x.id === params[0]);
        return { rows: b ? [{ tare_g: b.tare_g }] : [] };
      }
      if (/SELECT tare_g FROM v3\.stock_boxes/.test(q)) {
        const b = state.boxes.find((x) => x.id === params[0]);
        return { rows: b ? [{ tare_g: b.tare_g }] : [] };
      }
      // tara da caixa com o TIPO junto (S15.43: resolveTareInfo faz LEFT JOIN box_types)
      if (/SELECT x\.tare_g, t\.tare_g AS type_tare_g/.test(q)) {
        const b = state.boxes.find((x) => x.id === params[0]);
        return { rows: b ? [{ tare_g: b.tare_g, type_tare_g: b.type_tare_g || null,
          tare_min_g: b.tare_min_g || null, tare_max_g: b.tare_max_g || null }] : [] };
      }
      if (/FROM v3\.stock_unplaced u JOIN v3\.products/.test(q)) {
        return { rows: [{ product_id: 10, qty: 80, product: 'BENF-300' }] };
      }
      // taras prontas (weights.list) — a de tasks
      if (/FROM v3\.tare_presets/.test(q)) return { rows: state.tares };
      if (/FROM v3\.products p WHERE p\.active/.test(q)) return { rows: [] };
      if (/SELECT id, bin_code, tare_g, capacity FROM v3\.stock_bins/.test(q)) return { rows: state.bins };
      if (/SELECT id, box_number, tare_g, batch_number, sealed FROM v3\.stock_boxes/.test(q)) return { rows: state.boxes };
      // lookup
      if (/FROM v3\.products p LEFT JOIN v3\.product_skus/.test(q)) {
        return { rows: state.products.map((p) => ({ product_id: p.id, name: p.name,
          nickname: p.nickname, unit_weight_g: p.unit_weight_g })) };
      }
      return { rows: [] };
    },
  };
}

function makeStock() {
  return {
    place: jest.fn(async (p) => ({ movement: { id: 900 }, duplicate: false,
      applied: p.qty, unplaced: 80 - p.qty })),
  };
}

function makeRequests() {
  const rows = [];
  return { rows, propose: jest.fn(async (p) => { const r = { id: rows.length + 1, status: 'pending', ...p };
    rows.push(r); return r; }) };
}

function boot() {
  const state = {
    queries: [], pairs: new Map(),
    products: [{ id: 10, name: 'Benfotiamine 300 mg', nickname: 'BENF-300', unit_weight_g: 440, unplaced: 80 },
      { id: 11, name: 'Sem peso', nickname: 'SEMPESO', unit_weight_g: null, unplaced: 0 }],
    bins: [{ id: 1, bin_code: 'A03B2', shelf_code: 'S2', area: 'A', qty: 12, min_qty: 10,
      capacity: 48, tare_g: 120, product_id: 10 }],
    boxes: [{ id: 5, box_number: 'BX-0451', area: 'P1', qty: 180, tare_g: 780,
      batch_number: 'L-77', sealed: false, status: 'in_storage', product_id: 10, label_printed_at: null }],
    skus: [{ product_id: 10, sku: 'HF-BENF-300', barcode: '850012345678' }],
    tares: [{ id: 1, name: 'Caixa grande', kind: 'box', tare_g: 780, active: true },
      { id: 2, name: 'Prateleira padrão', kind: 'bin', tare_g: 120, active: true },
      { id: 3, name: 'Caixa velha', kind: 'box', tare_g: 900, active: false }],
  };
  const stock = makeStock();
  const requests = makeRequests();
  const wh = createOpWarehouse({ db: makeDb(state), stock, requests });
  return { state, stock, requests, wh };
}

describe('parseBarcode', () => {
  test('reconhece as formas de URL das nossas próprias etiquetas', () => {
    expect(parseBarcode('bin:A03B2')).toEqual({ hint: 'bin', value: 'A03B2' });
    expect(parseBarcode('box:BX-0451')).toEqual({ hint: 'box', value: 'BX-0451' });
    expect(parseBarcode('https://x/op/#estoque/p/10')).toEqual({ hint: 'product_id', value: '10' });
    expect(parseBarcode('https://x/scan/?b=A03B2')).toEqual({ hint: 'bin', value: 'A03B2' });
    expect(parseBarcode('https://x/scan/?x=BX-0451')).toEqual({ hint: 'box', value: 'BX-0451' });
    expect(parseBarcode('850012345678')).toEqual({ hint: 'any', value: '850012345678' });
    expect(parseBarcode('')).toBeNull();
  });
});

describe('scanner pareado', () => {
  test('pair devolve código de 6 chars + url do QR + validade', async () => {
    const { wh } = boot();
    const out = await wh.pair(SESSION, {});
    expect(out.body.ok).toBe(true);
    expect(out.body.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(out.body.url).toBe('/scan/?c=' + out.body.code);
    expect(new Date(out.body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  test('fluxo completo: kiosk assina o stream, celular empurra, kiosk recebe resolvido', async () => {
    const { wh } = boot();
    const code = (await wh.pair(SESSION, {})).body.code;
    const sink = makeSink();
    const s = await wh.stream(SESSION, { code }, sink);
    expect(s.sse).toBe(true);
    expect(sink.head.status).toBe(200);
    expect(sink.head.headers['Content-Type']).toBe('text/event-stream');
    expect(sink.events()[0].event).toBe('ready');

    const push = await wh.push({ code, barcode: '850012345678', symbology: 'UPC_A' });
    expect(push.body).toMatchObject({ ok: true, delivered: 1, kind: 'product' });
    const ev = sink.events().find((e) => e.event === 'scan');
    expect(ev.data).toMatchObject({ type: 'scan', code: '850012345678', symbology: 'UPC_A' });
    expect(ev.data.resolved.kind).toBe('product');
    expect(ev.data.resolved.product.product_id).toBe(10);
  });

  test('push NÃO precisa de sessão: quem autentica é o código do pareamento', async () => {
    const { wh } = boot();
    const code = (await wh.pair(SESSION, {})).body.code;
    const out = await wh.push({ code, barcode: 'A03B2' });   // nenhum argumento de sessão
    expect(out.body.ok).toBe(true);
    expect(out.body.kind).toBe('bin');
  });

  test('código inexistente → 404; expirado → 410 (leia o QR de novo)', async () => {
    const { state, wh } = boot();
    expect((await wh.push({ code: 'ZZZZZZ', barcode: 'x' })).status).toBe(404);
    const code = (await wh.pair(SESSION, {})).body.code;
    state.pairs.get(code).expires_at = new Date(Date.now() - 1000);
    const out = await wh.push({ code, barcode: 'x' });
    expect(out.status).toBe(410);
    expect(out.body.error).toBe('pair_expired');
  });

  test('kiosk vizinho não escuta o pareamento alheio (403)', async () => {
    const { wh } = boot();
    const code = (await wh.pair(SESSION, {})).body.code;
    const out = await wh.stream(OTHER_SESSION, { code }, makeSink());
    expect(out.status).toBe(403);
  });

  test('stream de par expirado → 410; sem code → 400', async () => {
    const { state, wh } = boot();
    const code = (await wh.pair(SESSION, {})).body.code;
    state.pairs.get(code).expires_at = new Date(Date.now() - 1);
    expect((await wh.stream(SESSION, { code }, makeSink())).status).toBe(410);
    expect((await wh.stream(SESSION, {}, makeSink())).status).toBe(400);
  });

  test('keepalive renova a validade e conta quem está escutando', async () => {
    const { wh } = boot();
    const first = await wh.pair(SESSION, {});
    const sink = makeSink();
    await wh.stream(SESSION, { code: first.body.code }, sink);
    const ka = await wh.keepalive({ code: first.body.code, ua: 'iPhone' });
    expect(ka.body.ok).toBe(true);
    expect(ka.body.listeners).toBe(1);
    expect(new Date(ka.body.expires_at).getTime())
      .toBeGreaterThanOrEqual(new Date(first.body.expires_at).getTime());
    expect((await wh.keepalive({ code: 'NOPE12' })).status).toBe(404);
  });

  test('kiosk que fecha a aba para de receber (sem vazar conexão)', async () => {
    const { wh } = boot();
    const code = (await wh.pair(SESSION, {})).body.code;
    const sink = makeSink();
    await wh.stream(SESSION, { code }, sink);
    sink.close();
    const out = await wh.push({ code, barcode: 'A03B2' });
    expect(out.body.delivered).toBe(0);
  });

  test('push sem barcode → 400', async () => {
    const { wh } = boot();
    const code = (await wh.pair(SESSION, {})).body.code;
    expect((await wh.push({ code })).status).toBe(400);
  });
});

describe('resolve de código de barras', () => {
  test('ordem: bin exato antes de tudo', async () => {
    const { wh } = boot();
    const r = await wh.resolve(SESSION, { barcode: 'a03b2' });   // minúsculo também resolve
    expect(r.body.kind).toBe('bin');
    expect(r.body.bin.bin_code).toBe('A03B2');
  });

  test('número da caixa', async () => {
    const { wh } = boot();
    const r = await wh.resolve(SESSION, { barcode: 'BX-0451' });
    expect(r.body.kind).toBe('box');
    expect(r.body.box.box_number).toBe('BX-0451');
  });

  test('UPC da garrafa vira produto, com onde ele mora e o que tem a organizar', async () => {
    const { wh } = boot();
    const r = await wh.resolve(SESSION, { barcode: '850012345678' });
    expect(r.body.kind).toBe('product');
    expect(r.body.product).toMatchObject({ product_id: 10, nickname: 'BENF-300',
      unplaced_qty: 80, home_bin: 'A03B2' });
  });

  test('SKU também resolve', async () => {
    const { wh } = boot();
    expect((await wh.resolve(SESSION, { barcode: 'HF-BENF-300' })).body.kind).toBe('product');
  });

  test('QR da nossa etiqueta (URL) resolve pro mesmo lugar', async () => {
    const { wh } = boot();
    expect((await wh.resolve(SESSION, { barcode: 'https://x/scan/?b=A03B2' })).body.kind).toBe('bin');
    expect((await wh.resolve(SESSION, { barcode: 'box:BX-0451' })).body.kind).toBe('box');
    expect((await wh.resolve(SESSION, { barcode: 'https://x/op/#estoque/p/10' })).body.kind).toBe('product');
  });

  test('bin: com código que não existe não cai no produto por engano', async () => {
    const { wh } = boot();
    const r = await wh.resolve(SESSION, { barcode: 'bin:NAOEXISTE' });
    expect(r.body.kind).toBe('unknown');
  });

  test('código desconhecido → unknown com o código lido (a tela oferece cadastrar)', async () => {
    const { wh } = boot();
    const r = await wh.resolve(SESSION, { barcode: '000000000000' });
    expect(r.body).toMatchObject({ kind: 'unknown', raw: '000000000000' });
  });

  test('sem barcode → 400', async () => {
    const { wh } = boot();
    expect((await wh.resolve(SESSION, {})).status).toBe(400);
  });
});

describe('organizar (aplica na hora)', () => {
  test('chama StockService.place e devolve o produto atualizado', async () => {
    const { wh, stock } = boot();
    const out = await wh.organize(SESSION, { product_id: 10, qty: 48, bin_id: 1 });
    expect(out.body.ok).toBe(true);
    expect(out.body.applied).toBe(48);
    expect(out.body.product.product_id).toBe(10);
    expect(stock.place.mock.calls[0][0]).toMatchObject({ product_id: 10, qty: 48, bin_id: 1,
      source: 'op_kiosk', actor_type: 'operator', person_id: 7, is_test: false });
  });

  test('sandbox marca is_test', async () => {
    const { wh, stock } = boot();
    await wh.organize({ ...SESSION, is_sandbox: true }, { product_id: 10, qty: 5, box_id: 5 });
    expect(stock.place.mock.calls[0][0].is_test).toBe(true);
  });

  test('sem destino, destino duplo ou qty ruim → 400 em PT-BR, sem escrever', async () => {
    const { wh, stock } = boot();
    expect((await wh.organize(SESSION, { product_id: 10, qty: 5 })).body.error).toBe('location_required');
    expect((await wh.organize(SESSION, { product_id: 10, qty: 5, bin_id: 1, box_id: 5 })).body.error)
      .toBe('location_ambiguous');
    expect((await wh.organize(SESSION, { product_id: 10, qty: 0, bin_id: 1 })).body.error).toBe('qty_required');
    expect((await wh.organize(SESSION, { qty: 5, bin_id: 1 })).body.error).toBe('product_required');
    expect(stock.place).not.toHaveBeenCalled();
  });
});

describe('contagem', () => {
  test('por peso: calcula, propõe kind count e leva o meta da pesagem', async () => {
    const { wh, requests } = boot();
    const out = await wh.countWeigh(SESSION, { product_id: 10, box_id: 5, gross_g: 48 * 440 + 780 });
    expect(out.body).toMatchObject({ ok: true, status: 'pending', qty: 48, confidence: 'high' });
    const p = requests.propose.mock.calls[0][0];
    expect(p).toMatchObject({ kind: 'count', direction: 'in', qty: 48, box_id: 5, person_id: 7 });
    expect(p.meta).toMatchObject({ gross_g: 48 * 440 + 780, tare_g: 780, unit_weight_g: 440,
      computed_qty: 48, residual_g: 0, confidence: 'high', method: 'weigh' });
  });

  test('a tara do bin é usada quando não informam nenhuma', async () => {
    const { wh, requests } = boot();
    await wh.countWeigh(SESSION, { product_id: 10, bin_id: 1, gross_g: 12 * 440 + 120 });
    expect(requests.propose.mock.calls[0][0].meta).toMatchObject({ tare_g: 120, computed_qty: 12 });
  });

  test('produto sem peso unitário → 409, NENHUMA proposta (nunca chuta um total)', async () => {
    const { wh, requests } = boot();
    const out = await wh.countWeigh(SESSION, { product_id: 11, bin_id: 1, gross_g: 5000 });
    expect(out.status).toBe(409);
    expect(out.body.error).toBe('no_unit_weight');
    expect(out.body.confidence).toBe('low');
    expect(requests.propose).not.toHaveBeenCalled();
  });

  test('pesagem exige lugar e peso', async () => {
    const { wh } = boot();
    expect((await wh.countWeigh(SESSION, { product_id: 10, gross_g: 100 })).body.error).toBe('location_required');
    expect((await wh.countWeigh(SESSION, { product_id: 10, bin_id: 1 })).body.error).toBe('gross_required');
  });

  test('manual: proposta com o found no meta', async () => {
    const { wh, requests } = boot();
    const out = await wh.countManual(SESSION, { product_id: 10, bin_id: 1, qty: 37 });
    expect(out.body).toMatchObject({ ok: true, qty: 37, status: 'pending' });
    expect(requests.propose.mock.calls[0][0].meta).toMatchObject({ computed_qty: 37, method: 'manual' });
  });

  test('contagem-no-zero vale: "está vazio" chega ao meta como 0', async () => {
    const { wh, requests } = boot();
    const out = await wh.countManual(SESSION, { product_id: 10, bin_id: 1, qty: 0 });
    expect(out.body.qty).toBe(0);
    const p = requests.propose.mock.calls[0][0];
    expect(p.meta.computed_qty).toBe(0);
    expect(p.qty).toBe(1);        // a fila exige qty > 0; o found real está no meta
    expect(p.note).toBe('contagem manual: found=0');
  });

  test('manual exige lugar e qty válida', async () => {
    const { wh } = boot();
    expect((await wh.countManual(SESSION, { product_id: 10, qty: 3 })).body.error).toBe('location_required');
    expect((await wh.countManual(SESSION, { product_id: 10, bin_id: 1, qty: -1 })).body.error).toBe('qty_required');
  });
});

describe('caixa nova e etiqueta', () => {
  test('proposta kind entrada com meta.box (o número só sai na aprovação)', async () => {
    const { wh, requests } = boot();
    const out = await wh.boxNew(SESSION, { product_id: 10, qty: 180, batch_number: 'L-99', area: 'P1' });
    expect(out.body).toMatchObject({ ok: true, status: 'pending' });
    const p = requests.propose.mock.calls[0][0];
    expect(p).toMatchObject({ kind: 'entrada', direction: 'in', qty: 180 });
    expect(p.box_id).toBeUndefined();
    expect(p.meta.box).toMatchObject({ new: true, batch_number: 'L-99', area: 'P1' });
  });

  test('caixa nova valida produto e quantidade', async () => {
    const { wh } = boot();
    expect((await wh.boxNew(SESSION, { qty: 10 })).body.error).toBe('product_required');
    expect((await wh.boxNew(SESSION, { product_id: 10, qty: 0 })).body.error).toBe('qty_required');
  });

  test('etiqueta da caixa: código, produto, quantidade e lote, sem em dash', async () => {
    const { wh } = boot();
    const out = await wh.boxLabel(SESSION, { box_id: 5 });
    expect(out.body.label).toMatchObject({ kind: 'box', code: 'BX-0451', line2: 'BENF-300',
      line3: '180 garrafas · lote L-77', url: '/scan/?x=BX-0451' });
    expect(out.body.label.line3).not.toMatch(/—/);
    expect((await wh.boxLabel(SESSION, { box_id: 999 })).status).toBe(404);
    expect((await wh.boxLabel(SESSION, {})).status).toBe(400);
  });
});

describe('tarefas de hoje e busca', () => {
  test('tasks devolve contagens sugeridas, reposição com a caixa e o que organizar', async () => {
    const { wh } = boot();
    const out = await wh.tasks(SESSION);
    expect(out.body.ok).toBe(true);
    expect(out.body.counts[0]).toMatchObject({ bin_id: 1, bin_code: 'A03B2', product: 'BENF-300' });
    expect(out.body.restock[0]).toMatchObject({ bin_code: 'A03B2', qty: 4, min_qty: 10,
      box_id: 5, box_number: 'BX-0451', box_qty: 180 });
    expect(out.body.organize[0]).toMatchObject({ product_id: 10, qty: 80 });
  });

  test('tasks leva as taras prontas: pesar sem sair da tela nem digitar', async () => {
    const { wh } = boot();
    const out = await wh.tasks(SESSION);
    expect(out.body.tares).toEqual([
      { id: 1, name: 'Caixa grande', kind: 'box', tare_g: 780 },
      { id: 2, name: 'Prateleira padrão', kind: 'bin', tare_g: 120 },
    ]);
    // tara desativada não aparece: o operador não pode escolher a caixa que saiu de uso
    expect(out.body.tares.some((t) => t.name === 'Caixa velha')).toBe(false);
  });

  test('tara que falha não derruba as tarefas do dia (regra #0: nunca travar)', async () => {
    const { state, wh } = boot();
    state.tares = null;                 // .filter estoura dentro do weights.list
    const out = await wh.tasks(SESSION);
    expect(out.body.ok).toBe(true);
    expect(out.body.tares).toEqual([]);
    expect(out.body.restock[0].bin_code).toBe('A03B2');
  });

  test('lookup busca por nome/apelido/SKU/UPC; menos de 2 letras não busca', async () => {
    const { wh } = boot();
    const out = await wh.lookup(SESSION, { q: 'benf' });
    expect(out.body.products[0]).toMatchObject({ product_id: 10, nickname: 'BENF-300' });
    expect((await wh.lookup(SESSION, { q: 'b' })).body.products).toEqual([]);
    expect((await wh.lookup(SESSION, {})).body.products).toEqual([]);
  });
});
