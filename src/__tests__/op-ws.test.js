'use strict';
/* S15 Fase 2 — /op/ws.js (Central de P&P & Estoque).
   ws.js é browser-first mas NÃO toca o DOM ao carregar: dá pra exigir em node e
   testar os helpers puros (títulos, local, regra do Repor, chips e os builders de
   payload). Nada aqui abre janela, faz fetch ou renderiza. */
const fs = require('fs');
const path = require('path');

const WS_PATH = path.join(__dirname, '..', 'op', 'ws.js');
const SRC = fs.readFileSync(WS_PATH, 'utf8');
const WS = require(WS_PATH);
const H = WS._;

describe('op/ws.js — carrega fora do browser (sem DOM)', () => {
  test('module.exports + nenhum acesso a document/window no topo', () => {
    expect(typeof WS.init).toBe('function');
    expect(typeof WS.inner).toBe('function');
    expect(typeof WS.acts.wsSubmit).toBe('function');
    expect(SRC).toContain("typeof module !== 'undefined'");
    // nada de document.* fora das strings HTML: o único uso é win.document no print
    const docUses = SRC.match(/document\./g) || [];
    expect(docUses.length).toBe(2); // win.document.write + win.document.close
  });
  test('sem em dash em nenhum texto', () => {
    expect(SRC).not.toContain('—');
  });
});

describe('op/ws.js — títulos e local (formatação)', () => {
  test('cleanName tira marca, mg e contagem', () => {
    expect(H.cleanName({ product: 'HealthFare Benfotiamine 300mg' })).toBe('Benfotiamine');
    expect(H.cleanName({ title: 'Berberine HCL 500 mg | 120 Vegan Capsules | Best seller' })).toBe('Berberine HCL');
  });
  test('mgOf / capsOf / packOf', () => {
    expect(H.mgOf({ product: 'Benfotiamine 300mg' })).toBe('300mg');
    expect(H.capsOf({ content_desc: '200 capsules' })).toBe('200caps');
    expect(H.capsOf({ title: 'Rutin 60 tablets' })).toBe('60tabs');
    expect(H.packOf({ sku: 'HF-BENF-C2' })).toBe('C2');
    expect(H.packOf({ sku: 'HF-BENF' })).toBe('');
  });
  test('shortTitle = nome + mg + caps + casepack', () => {
    const g = { product: 'HealthFare Benfotiamine 300mg', content_desc: '200 capsules', sku: 'HF-BENF-C2' };
    expect(H.shortTitle(g)).toBe('Benfotiamine 300mg 200caps · C2');
  });
  test('printTitle é MAIÚSCULA com barra entre mg e caps', () => {
    const g = { product: 'Benfotiamine 300mg', content_desc: '200 caps' };
    expect(H.printTitle(g)).toBe('BENFOTIAMINE 300mg/200caps');
  });
  test('shortTitle cai pro SKU quando não dá pra limpar nada', () => {
    expect(H.shortTitle({ sku: 'HF-X1' })).toBe('HF-X1');
  });
  test('locationOf junta shelf/bin/pallet, senão avisa', () => {
    expect(H.locationOf({ location: { shelf: 'S2', bin: 'A03' } })).toBe('SHELF S2 · BIN A03');
    expect(H.locationOf({})).toBe('LOCAL A DEFINIR');
  });
  test('placeLabel distingue bin de caixa', () => {
    expect(H.placeLabel({ id: 1, bin_code: 'A03', shelf_code: 'S2' })).toBe('BIN A03 · S2');
    expect(H.placeLabel({ id: 9, box_number: 'CX12', area: 'MEZ' })).toBe('CAIXA CX12 · MEZ');
  });
});

describe('op/ws.js — regra de quantidade do Repor prateleira', () => {
  test('enche até 2x o mínimo, limitado pelo que a caixa tem', () => {
    // alvo 2*10 = 20, bin tem 4 → gap 16; caixa tem 100 → repõe 16
    expect(H.restockQty({ qty: 4, min_qty: 10 }, { qty: 100 })).toBe(16);
  });
  test('caixa menor que o gap manda a caixa inteira', () => {
    expect(H.restockQty({ qty: 4, min_qty: 10 }, { qty: 7 })).toBe(7);
  });
  test('sem mínimo cadastrado usa o alvo padrão 48', () => {
    expect(H.restockQty({ qty: 0, min_qty: 0 }, { qty: 500 })).toBe(48);
  });
  test('bin já cheio ainda repõe pelo menos 1 (nunca 0 ou negativo)', () => {
    expect(H.restockQty({ qty: 99, min_qty: 10 }, { qty: 30 })).toBe(1);
  });
  test('caixa vazia repõe 0 (não inventa estoque)', () => {
    expect(H.restockQty({ qty: 0, min_qty: 10 }, { qty: 0 })).toBe(0);
  });
  test('restockBody usa a regra e manda bin_id/box_id', () => {
    expect(H.restockBody({ id: 3, qty: 4, min_qty: 10 }, { id: 8, qty: 100 }))
      .toEqual({ bin_id: 3, box_id: 8, qty: 16 });
  });
});

describe('op/ws.js — status → chip e rótulo de tipo', () => {
  test('mapeamento dos 4 estados', () => {
    expect(H.statusChip('pending').label).toBe('pendente');
    expect(H.statusChip('approved').label).toBe('aprovado');
    expect(H.statusChip('rejected').label).toBe('recusado');
    expect(H.statusChip('applied').label).toBe('aplicado');
  });
  test('pendente é tom warn, recusado é tom bad, aprovado é tom ok', () => {
    expect(H.statusChip('pending').fg).toBe('#6b4c07');
    expect(H.statusChip('rejected').fg).toBe('#a02c20');
    expect(H.statusChip('approved').fg).toBe('#1e6b2e');
  });
  test('status desconhecido/ausente cai em aplicado (neutro)', () => {
    expect(H.statusChip(undefined).label).toBe('aplicado');
    expect(H.statusChip('whatever').label).toBe('aplicado');
  });
  test('rótulo do kind cobre os 5 tipos do plano', () => {
    expect(H.kindLabel('take')).toBe('Peguei');
    expect(H.kindLabel('damaged')).toBe('Danificada');
    expect(H.kindLabel('entrada')).toBe('Entrada');
    expect(H.kindLabel('count')).toBe('Contagem');
    expect(H.kindLabel('restock')).toBe('Reposição');
  });
});

describe('op/ws.js — builders de payload (contrato S15)', () => {
  const sel = { id: 42, canonical_name: 'Benfotiamine' };

  test('rota: pick/damaged → take · entrada/count → propose', () => {
    expect(H.submitPath('pick')).toBe('/api/v3/op/stock/take');
    expect(H.submitPath('damaged')).toBe('/api/v3/op/stock/take');
    expect(H.submitPath('entrada')).toBe('/api/v3/op/stock/propose');
    expect(H.submitPath('count')).toBe('/api/v3/op/stock/propose');
  });
  test('take body (pick)', () => {
    expect(H.submitBody({ sel, qty: '3', kind: 'pick', reason: '  extra pro 12-345 ' }))
      .toEqual({ product_id: 42, qty: 3, kind: 'pick', reason: 'extra pro 12-345' });
  });
  test('take body (damaged) com motivo vazio vira null', () => {
    expect(H.submitBody({ sel, qty: '1', kind: 'damaged', reason: '   ' }))
      .toEqual({ product_id: 42, qty: 1, kind: 'damaged', reason: null });
  });
  test('propose body (entrada) sem destino não manda bin/box', () => {
    expect(H.submitBody({ sel, qty: '24', kind: 'entrada', reason: '', dest: '' }))
      .toEqual({ product_id: 42, qty: 24, kind: 'entrada', reason: null });
  });
  test('propose body (count) com bin', () => {
    expect(H.submitBody({ sel, qty: '18', kind: 'count', reason: '', dest: 'bin:7' }))
      .toEqual({ product_id: 42, qty: 18, kind: 'count', reason: null, bin_id: 7 });
  });
  test('propose body (entrada) com caixa', () => {
    expect(H.submitBody({ sel, qty: '48', kind: 'entrada', reason: 'chegou hoje', dest: 'box:9' }))
      .toEqual({ product_id: 42, qty: 48, kind: 'entrada', reason: 'chegou hoje', box_id: 9 });
  });
  test('toasts do plano, sem em dash', () => {
    // toda confirmacao diz o que aconteceu E o que acontece depois
    expect(H.submitToast('pick')).toBe('Registrado. Vai pra aprovação do admin, já saiu do disponível.');
    expect(H.submitToast('damaged')).toBe('Registrado. Já saiu do vendável e foi pra Separadas.');
    expect(H.submitToast('entrada')).toBe('Enviado pra aprovação. O admin aprova e o número muda.');
    expect(H.submitToast('count')).toBe('Enviado pra aprovação. O admin aprova e o número muda.');
    expect(H.submitToast('restock')).toBe('Prateleira reposta. Saiu da caixa e entrou na prateleira.');
    Object.keys(H).length; // noop
  });
});

describe('op/ws.js — validação do formulário', () => {
  const sel = { id: 1 };
  test('sem produto pede o suplemento', () => {
    expect(H.validate({ qty: '1', kind: 'pick' })).toBe('Escolha o suplemento');
  });
  test('quantidade inválida ou fora do range', () => {
    expect(H.validate({ sel, qty: '0', kind: 'pick' })).toBe('Quantidade inválida');
    expect(H.validate({ sel, qty: 'abc', kind: 'pick' })).toBe('Quantidade inválida');
    expect(H.validate({ sel, qty: '5001', kind: 'pick' })).toBe('Quantidade muito alta');
  });
  test('contagem EXIGE local; entrada não', () => {
    expect(H.validate({ sel, qty: '5', kind: 'count', dest: '' })).toBe('Escolha onde você contou');
    expect(H.validate({ sel, qty: '5', kind: 'count', dest: 'bin:2' })).toBe(null);
    expect(H.validate({ sel, qty: '5', kind: 'entrada', dest: '' })).toBe(null);
  });
  test('os 4 tipos do segmento existem', () => {
    expect(H.KINDS).toEqual(['pick', 'damaged', 'entrada', 'count']);
  });
});

describe('op/ws.js — contexto: locais do produto e lista de reposição', () => {
  const ctx = {
    bins: [
      { id: 1, bin_code: 'A01', qty: 4, min_qty: 10, product_id: 42, product: 'Benfotiamine', needs_restock: true },
      { id: 2, bin_code: 'A02', qty: 50, min_qty: 10, product_id: 99, product: 'Rutin', needs_restock: false },
      { id: 3, bin_code: 'A03', qty: 1, min_qty: 5, product_id: 99, product: 'Rutin', needs_restock: true },
      { id: 4, bin_code: 'A04', qty: 0, min_qty: 0, product_id: null, product: null, needs_restock: false },
    ],
    boxes: [
      { id: 8, box_number: 'CX8', qty: 100, product_id: 42, product: 'Benfotiamine' },
      { id: 9, box_number: 'CX9', qty: 0, product_id: 99, product: 'Rutin' },
    ],
  };

  test('placesFor filtra pelo produto (e mantém locais sem produto)', () => {
    const p = H.placesFor(ctx, 42);
    expect(p.bins.map((b) => b.id)).toEqual([1, 4]);
    expect(p.boxes.map((b) => b.id)).toEqual([8]);
  });
  test('placesFor sem produto devolve tudo', () => {
    expect(H.placesFor(ctx, null).bins.length).toBe(4);
  });
  test('restockList = só bins needs_restock QUE têm caixa com estoque', () => {
    const rows = H.restockList(ctx);
    expect(rows.length).toBe(1);           // A03 sai: a caixa da Rutin está zerada
    expect(rows[0].bin.id).toBe(1);
    expect(rows[0].boxes.map((b) => b.id)).toEqual([8]);
  });
  test('contexto vazio não quebra', () => {
    expect(H.restockList(null)).toEqual([]);
    expect(H.placesFor(null, 1)).toEqual({ bins: [], boxes: [] });
  });
});

describe('op/ws.js — HTML do workspace (com deps mockadas, sem DOM real)', () => {
  const S = {
    workspaceOpen: true, myTasks: [{ slug: 'order_printing' }],
    ws: {
      picklist: { groups: [], total_orders: 0 }, recent: null, q: '', sel: null,
      qty: '1', kind: 'pick', reason: '', dest: '', ctx: null, busy: false, gaps: { items: [] },
    },
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const calls = [];
  beforeAll(() => {
    WS.init({
      S, CFG: { workspace: true }, DATA: { supplements: [{ id: 42, canonical_name: 'Benfotiamine' }] },
      api: (p, o) => { calls.push([p, o]); return Promise.resolve({ items: [] }); },
      toast: () => {}, render: () => {}, esc, isSandbox: () => false, typeMeta: () => ({}),
      openWindow: () => null,
    });
  });

  test('banner aparece com task de P&P aberta', () => {
    expect(WS.banner()).toContain('data-act="openWorkspace"');
    expect(WS.banner()).toContain('P&amp;P &amp; Estoque');
  });
  test('inner traz picklist, PRINT, sandbox-off e os cards novos', () => {
    const html = WS.inner();
    expect(html).toContain('data-act="wsPrint"');
    expect(html).toContain('picklist de hoje');
    expect(html).toContain('Repor prateleira');
    expect(html).toContain('Registrado hoje');
    expect(html).not.toContain('sandbox'); // isSandbox() = false
    expect(html).not.toContain('—'); // sem em dash
  });
  test('card "Falta de estoque" aparece quando o gaps traz item', () => {
    const keep = S.ws.gaps;
    S.ws.gaps = { items: [{ product: 'Rutin', needed: 10, stock: 0, status: 'out', severity: 'critical', advice: 'pedir agora' }], out_count: 1 };
    const html = WS.inner();
    expect(html).toContain('Falta de estoque');
    expect(html).toContain('ZERADO');
    expect(html).toContain('pedir agora');
    S.ws.gaps = keep;
  });
  test('escolhido o produto, o segmento tem os 4 tipos', () => {
    S.ws.sel = { id: 42, canonical_name: 'Benfotiamine' };
    const html = WS.inner();
    ['pick', 'damaged', 'entrada', 'count'].forEach((k) => expect(html).toContain('data-act="wsKind" data-arg="' + k + '"'));
    expect(html).toContain('Peguei do estoque');
    expect(html).toContain('Contagem');
  });
  test('entrada/contagem mostram o seletor de destino; pick não', () => {
    S.ws.kind = 'pick';
    expect(WS.inner()).not.toContain('Onde você contou');
    S.ws.kind = 'count';
    S.ws.ctx = { enabled: true, bins: [{ id: 1, bin_code: 'A01', qty: 4, min_qty: 10, product_id: 42 }], boxes: [] };
    const html = WS.inner();
    expect(html).toContain('Onde você contou (obrigatório)');
    expect(html).toContain('data-act="wsDest" data-arg="bin:1"');
    S.ws.kind = 'entrada';
    expect(WS.inner()).toContain('Onde guardou (opcional)');
  });
  test('card Repor gera botão com bin:box e a quantidade calculada', () => {
    S.ws.ctx = {
      enabled: true,
      bins: [{ id: 1, bin_code: 'A01', qty: 4, min_qty: 10, product_id: 42, product: 'Benfotiamine', needs_restock: true }],
      boxes: [{ id: 8, box_number: 'CX8', qty: 100, product_id: 42 }],
    };
    const html = WS.inner();
    expect(html).toContain('data-act="wsRestock" data-arg="1:8"');
    expect(html).toContain('Repor 16 ');
  });
  test('recentes desenham o chip de estado + o tipo', () => {
    S.ws.recent = [
      { id: 1, kind: 'take', qty: 3, product: 'Benfotiamine', status: 'pending' },
      { id: 2, kind: 'damaged', qty: 1, product: 'Rutin', status: 'applied' },
      { id: 3, kind: 'count', qty: 9, product: 'Rutin', status: 'rejected' },
    ];
    const html = WS.inner();
    expect(html).toContain('pendente');
    expect(html).toContain('aplicado');
    expect(html).toContain('recusado');
    expect(html).toContain('Peguei');
    expect(html).toContain('Danificada');
  });
  test('key muda quando o tipo/destino muda (força remount da camada)', () => {
    S.ws.kind = 'pick'; S.ws.dest = '';
    const k1 = WS.key();
    S.ws.kind = 'count'; S.ws.dest = 'bin:1';
    expect(WS.key()).not.toBe(k1);
  });
  test('load chama picklist + recent + context + gaps', () => {
    calls.length = 0;
    WS.load();
    const paths = calls.map((c) => c[0]);
    expect(paths).toContain('/api/v3/op/picklist');
    expect(paths).toContain('/api/v3/op/stock/recent');
    expect(paths).toContain('/api/v3/op/stock/context');
    expect(paths).toContain('/api/v3/op/stock-gaps');
  });
  test('wsSubmit posta no endpoint certo por tipo', () => {
    calls.length = 0;
    S.ws.sel = { id: 42 }; S.ws.qty = '2'; S.ws.kind = 'pick'; S.ws.dest = ''; S.ws.busy = false;
    WS.acts.wsSubmit();
    expect(calls[0][0]).toBe('/api/v3/op/stock/take');
    expect(calls[0][1].body).toEqual({ product_id: 42, qty: 2, kind: 'pick', reason: null });

    calls.length = 0;
    S.ws.sel = { id: 42 }; S.ws.qty = '5'; S.ws.kind = 'count'; S.ws.dest = 'box:8'; S.ws.busy = false;
    WS.acts.wsSubmit();
    expect(calls[0][0]).toBe('/api/v3/op/stock/propose');
    expect(calls[0][1].body).toEqual({ product_id: 42, qty: 5, kind: 'count', reason: null, box_id: 8 });
  });
  test('wsSubmit não posta contagem sem local', () => {
    calls.length = 0;
    S.ws.sel = { id: 42 }; S.ws.qty = '5'; S.ws.kind = 'count'; S.ws.dest = ''; S.ws.busy = false;
    WS.acts.wsSubmit();
    expect(calls.length).toBe(0);
  });
  test('wsRestock posta bin/box/qty', () => {
    calls.length = 0;
    S.ws.busy = false;
    S.ws.ctx = {
      enabled: true,
      bins: [{ id: 1, bin_code: 'A01', qty: 4, min_qty: 10, product_id: 42, needs_restock: true }],
      boxes: [{ id: 8, box_number: 'CX8', qty: 100, product_id: 42 }],
    };
    WS.acts.wsRestock('1:8');
    expect(calls[0][0]).toBe('/api/v3/op/stock/restock');
    expect(calls[0][1].body).toEqual({ bin_id: 1, box_id: 8, qty: 16 });
  });
  test('input() trata só os campos do workspace', () => {
    expect(WS.input('wsQty', '7')).toBe(true);
    expect(S.ws.qty).toBe('7');
    expect(WS.input('wsReason', 'oi')).toBe(true);
    expect(S.ws.reason).toBe('oi');
    expect(WS.input('note', 'x')).toBe(false);
  });
});
