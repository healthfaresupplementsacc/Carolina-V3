'use strict';
/* S15 Fase 2 — /op/ws.js (Central de P&P & Estoque).
   ws.js é browser-first mas NÃO toca o DOM ao carregar: dá pra exigir em node e
   testar os helpers puros (títulos, local, regra do Repor, chips e os builders de
   payload). Nada aqui abre janela, faz fetch ou renderiza. */
const fs = require('fs');
const path = require('path');

const WS_PATH = path.join(__dirname, '..', 'op', 'ws.js');
const SRC = fs.readFileSync(WS_PATH, 'utf8');
// nav.js precisa existir ANTES do ws.js: o banner() da home chama HF_NAV.strip().
// Em node o require expoe window.HF_NAV via global (mesmo UMD do ws.js).
const NAV = require(path.join(__dirname, '..', 'op', 'nav.js'));
global.HF_NAV = NAV;
const WS = require(WS_PATH);
const H = WS._;

describe('op/ws.js — carrega fora do browser (sem DOM)', () => {
  test('module.exports + nenhum acesso a document/window no topo', () => {
    expect(typeof WS.init).toBe('function');
    expect(typeof WS.inner).toBe('function');
    expect(typeof WS.acts.wsSubmit).toBe('function');
    expect(SRC).toContain("typeof module !== 'undefined'");
    // nada de document.* fora das strings HTML: os únicos usos são as janelas de
    // impressão (picklist 4x6 + etiqueta de caixa), 2 chamadas cada.
    const docUses = SRC.match(/document\./g) || [];
    expect(docUses.length).toBe(4); // print(): write+close · printLabel(): write+close
  });
  test('a etiqueta vem do renderizador ÚNICO (/shared/label-sheet.js)', () => {
    // ws.js NÃO pode ter uma segunda cópia do desenho: duas cópias = duas
    // etiquetas diferentes da mesma caixa no palete.
    expect(SRC).toContain('HF_LABELS');
    expect(SRC).toContain('sheetHtml');
    expect(SRC).not.toContain('@page { size: 4in 6in; margin: 0.15in; }');
    expect(SRC).not.toContain('HF_CODE128');
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
    expect(html).toContain('Picklist de hoje');
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

describe('op/nav.js — menu persistente do operador', () => {
  test('as 3 abas na ordem do dia: Linha · Central de P&P · Estoque', () => {
    expect(NAV.ITEMS.map((i) => i.k)).toEqual(['linha', 'central', 'estoque']);
    expect(NAV.ITEMS.map((i) => i.label)).toEqual(['Linha', 'Central de P&P', 'Estoque']);
  });
  test('no /op a Central e a Linha são camadas (acts), só Estoque navega', () => {
    const h = NAV.strip('linha', { page: 'op' });
    expect(h).toContain('data-act="openWorkspace"');
    expect(h).toContain('data-act="closeWorkspace"');
    expect(h).toContain('href="/op/estoque.html"');
  });
  test('no hub tudo é link de volta pro /op, com o deep link da Central', () => {
    const h = NAV.strip('estoque', { page: 'hub' });
    expect(h).toContain('href="/op/"');
    expect(h).toContain('href="/op/?ws=1"');
    expect(h).not.toContain('data-act="openWorkspace"');   // lá a Central não é camada
  });
  test('a aba ativa vira pill navy e marca aria-current', () => {
    const h = NAV.strip('central', { page: 'op' });
    const central = h.slice(h.indexOf('data-nav-item="central"'));
    expect(central).toContain('aria-current="page"');
    expect(h.slice(h.indexOf('data-nav-item="linha"'), h.indexOf('data-nav-item="central"'))).not.toContain('aria-current');
  });
  test('alvo de toque de 44px em todos os itens (galpão, com luva)', () => {
    const hits = NAV.strip('linha', { page: 'op' }).match(/min-height:44px/g) || [];
    expect(hits.length).toBe(3);
  });
  test('active desconhecido cai em Linha, nunca quebra', () => {
    expect(NAV.strip('lua', { page: 'op' })).toContain('aria-current');
    expect(NAV._.hintOf('lua')).toBe('Linha de produção');
  });
  test('crossLink leva o hub pra Central', () => {
    expect(NAV.crossLink()).toContain('/op/?ws=1');
    expect(NAV.crossLink()).toContain('Central de P&amp;P');
  });
  test('sem em dash', () => {
    expect(fs.readFileSync(path.join(__dirname, '..', 'op', 'nav.js'), 'utf8')).not.toContain('—');
  });
});

describe('op/ws.js — Central SEMPRE disponível (menu, não recompensa)', () => {
  const mk = (cfg, sandbox) => {
    WS.init({
      S: { workspaceOpen: false, myTasks: [], ws: null }, CFG: cfg, DATA: { supplements: [] },
      api: () => Promise.resolve({}), toast: () => {}, render: () => {},
      esc: (s) => String(s == null ? '' : s), isSandbox: () => !!sandbox,
      typeMeta: () => ({}), openWindow: () => null,
    });
    return WS.allowed();
  };
  test('flag ligado libera', () => expect(mk({ workspace: true })).toBe(true));
  test('flag AUSENTE libera (config velho em cache não pode esconder o menu)', () => {
    expect(mk({})).toBe(true);
    expect(mk({ workspace: undefined })).toBe(true);
  });
  test('só workspace === false desliga', () => expect(mk({ workspace: false })).toBe(false));
  test('sandbox abre mesmo com o flag desligado', () => expect(mk({ workspace: false }, true)).toBe(true));
});

describe('op/ws.js — home: menu no topo + banner só com task de P&P', () => {
  const S = { workspaceOpen: false, myTasks: [], ws: null };
  const boot = () => WS.init({
    S, CFG: { workspace: true }, DATA: { supplements: [] },
    api: () => Promise.resolve({}), toast: () => {}, render: () => {},
    esc: (s) => String(s == null ? '' : s), isSandbox: () => false,
    typeMeta: () => ({}), openWindow: () => null,
  });

  test('sem task de P&P: o menu aparece, o box grande não', () => {
    boot(); S.myTasks = [];
    const h = WS.banner();
    expect(h).toContain('data-nav="op"');
    expect(h).toContain('data-act="openWorkspace"');
    expect(h).not.toContain('Picklist do dia');   // texto do box grande
  });
  test('com task de P&P: menu + box grande', () => {
    boot(); S.myTasks = [{ slug: 'order_printing' }];
    const h = WS.banner();
    expect(h).toContain('data-nav="op"');
    expect(h).toContain('Picklist do dia');
  });
  test('Central aberta marca a aba Central como ativa', () => {
    boot(); S.myTasks = []; S.workspaceOpen = true;
    const h = WS.banner();
    const central = h.slice(h.indexOf('data-nav-item="central"'));
    expect(central).toContain('aria-current="page"');
    S.workspaceOpen = false;
  });
  test('flag desligado esconde o menu inteiro (nada de botão morto)', () => {
    WS.init({ S, CFG: { workspace: false }, DATA: { supplements: [] },
      api: () => Promise.resolve({}), toast: () => {}, render: () => {},
      esc: (s) => String(s), isSandbox: () => false, typeMeta: () => ({}), openWindow: () => null });
    expect(WS.banner()).toBe('');
  });
});

describe('op/ws.js — "Você está fazendo P&P agora?" (nunca bloqueia)', () => {
  const S = { workspaceOpen: true, myTasks: [], ws: null };
  const calls = [];
  const toasts = [];
  beforeEach(() => {
    calls.length = 0; toasts.length = 0;
    S.myTasks = []; S.ws = null;
    WS.init({
      S, CFG: { workspace: true }, DATA: { supplements: [] },
      api: (p, o) => { calls.push([p, o]); return Promise.resolve({ ok: true, event: { id: 1 } }); },
      toast: (m) => toasts.push(m), render: () => {},
      esc: (s) => String(s == null ? '' : s), isSandbox: () => false,
      typeMeta: () => ({}), openWindow: () => null,
    });
  });

  test('sem task de P&P a pergunta aparece com as duas saídas', () => {
    const h = WS.inner();
    expect(h).toContain('Você está fazendo P&amp;P agora?');
    expect(h).toContain('data-act="wsStartPP"');
    expect(h).toContain('data-act="wsJustLook"');
  });
  test('com task de P&P aberta a pergunta some (ele já marcou)', () => {
    S.myTasks = [{ slug: 'order_printing' }];
    expect(WS.inner()).not.toContain('data-act="wsStartPP"');
  });
  test('picklist e PRINT existem MESMO sem task (REGRA #0: nunca trava)', () => {
    const h = WS.inner();
    expect(h).toContain('data-act="wsPrint"');
    expect(h).toContain('Picklist de hoje');
  });
  test('"Só olhar" some a pergunta e não posta nada', () => {
    WS.acts.wsJustLook();
    expect(calls.length).toBe(0);
    expect(WS.inner()).not.toContain('data-act="wsStartPP"');
  });
  test('"Iniciar Impressão de ordens" posta event/start com o slug certo', () => {
    WS.acts.wsStartPP();
    expect(calls[0][0]).toBe('/api/v3/op/event/start');
    expect(calls[0][1].method).toBe('POST');
    expect(calls[0][1].body.activity_slug).toBe('order_printing');
    // mesmo corpo do postStart do app.js: os opcionais vão explícitos
    expect(calls[0][1].body).toEqual({
      activity_slug: 'order_printing', batch_number: null, cowork_with: [],
      note: null, product_id: null, product_name: null,
    });
  });
  test('start com erro avisa mas NÃO fecha a Central', () => {
    WS.init({
      S, CFG: { workspace: true }, DATA: { supplements: [] },
      api: () => Promise.reject(new Error('concurrent_open')),
      toast: (m) => toasts.push(m), render: () => {},
      esc: (s) => String(s == null ? '' : s), isSandbox: () => false,
      typeMeta: () => ({}), openWindow: () => null,
    });
    WS.acts.wsStartPP();
    return new Promise((r) => setTimeout(r, 0)).then(() => {
      expect(S.workspaceOpen).toBe(true);
      expect(toasts.join(' ')).toContain('A picklist continua aqui');
    });
  });
  test('a key muda quando a pergunta é respondida (força remount da camada)', () => {
    const k1 = WS.key();
    WS.acts.wsJustLook();
    expect(WS.key()).not.toBe(k1);
  });
});

describe('op/ws.js — Registrado hoje: caixa + etiqueta (contrato 2)', () => {
  test('só entrada aprovada/aplicada COM box_number oferece a etiqueta', () => {
    expect(H.boxOf({ kind: 'entrada', status: 'approved', box_number: 'BX-0451' })).toBe('BX-0451');
    expect(H.boxOf({ kind: 'entrada', status: 'applied', box_number: 'BX-0451' })).toBe('BX-0451');
    // pendente ainda não virou caixa: botão seria promessa falsa
    expect(H.boxOf({ kind: 'entrada', status: 'pending', box_number: 'BX-0451' })).toBe(null);
    expect(H.boxOf({ kind: 'entrada', status: 'rejected', box_number: 'BX-0451' })).toBe(null);
    expect(H.boxOf({ kind: 'entrada', status: 'approved', box_number: null })).toBe(null);
    expect(H.boxOf({ kind: 'take', status: 'approved', box_number: 'BX-0451' })).toBe(null);
    expect(H.boxOf(null)).toBe(null);
  });
  test('labelPayload monta código, produto, quantidade/lote e a URL do QR', () => {
    const L = H.labelPayload({ code: 'BX-0451', product: 'Rutin 500mg', qty: 100, lot: 'L-22' });
    expect(L.code).toBe('BX-0451');
    expect(L.line2).toBe('Rutin 500mg');
    expect(L.line3).toBe('100 garrafas · lote L-22');
    expect(L.url).toBe('/scan/?box=BX-0451');
  });
  test('a linha do recente mostra a caixa e o botão de imprimir', () => {
    const S = { workspaceOpen: true, myTasks: [{ slug: 'order_printing' }], ws: null };
    WS.init({
      S, CFG: { workspace: true }, DATA: { supplements: [] },
      api: () => Promise.resolve({}), toast: () => {}, render: () => {},
      esc: (s) => String(s == null ? '' : s), isSandbox: () => false,
      typeMeta: () => ({}), openWindow: () => null,
    });
    WS.state().recent = [
      { id: 1, kind: 'entrada', qty: 48, product: 'Rutin', status: 'approved', box_id: 8, box_number: 'BX-0451' },
      { id: 2, kind: 'entrada', qty: 48, product: 'Rutin', status: 'pending' },
    ];
    const h = WS.inner();
    expect(h).toContain('Caixa BX-0451');
    expect(h).toContain('data-act="wsPrintLabel" data-arg="8"');
    expect((h.match(/wsPrintLabel/g) || []).length).toBe(1);   // a pendente não ganha botão
  });
  test('wsPrintLabel busca a etiqueta no endpoint do contrato', () => {
    const calls = [];
    WS.init({
      S: { workspaceOpen: true, myTasks: [], ws: null }, CFG: { workspace: true }, DATA: { supplements: [] },
      api: (p) => { calls.push(p); return Promise.resolve({ label: { code: 'BX-0451' } }); },
      toast: () => {}, render: () => {}, esc: (s) => String(s == null ? '' : s),
      isSandbox: () => false, typeMeta: () => ({}), openWindow: () => null,
    });
    WS.acts.wsPrintLabel('8');
    expect(calls[0]).toBe('/api/v3/op/stock/box/label?box_id=8');
  });
});

/* ══════════════════════════════════════════════════════════════════
   S15.29 · FILA DE IMPRESSÃO DO CELULAR + RENDERIZADOR ÚNICO
   O admin pede a etiqueta do iPhone; o papel sai onde tem impressora.
   As duas peças novas são compartilhadas (Central + hub de estoque +
   estação /print), então os testes moram junto do primeiro cliente.
   ══════════════════════════════════════════════════════════════════ */
const LABELS = require(path.join(__dirname, '..', 'shared', 'label-sheet.js'));
const PQ = require(path.join(__dirname, '..', 'shared', 'print-queue-card.js'));

describe('shared/label-sheet.js — o desenho da etiqueta mora num lugar só', () => {
  const L = { kind: 'box', code: 'BX-0451', line2: 'Rutin 500mg', line3: '100 garrafas · lote L-22', url: '/scan/?box=BX-0451' };

  test('carrega em node e expõe sheetHtml/labelHtml', () => {
    expect(typeof LABELS.sheetHtml).toBe('function');
    expect(typeof LABELS.labelHtml).toBe('function');
  });
  test('a folha é 4x6 e imprime sozinha ao abrir', () => {
    const doc = LABELS.sheetHtml([L]);
    expect(doc).toContain('@page { size: 4in 6in; margin: 0.15in; }');
    expect(doc).toContain('window.print()');
    expect(doc.indexOf('<!doctype html>')).toBe(0);
  });
  test('mostra código gigante, produto, quantidade/lote e a marca', () => {
    const doc = LABELS.sheetHtml([L]);
    expect(doc).toContain('BX-0451');
    expect(doc).toContain('Rutin 500mg');
    expect(doc).toContain('100 garrafas');
    expect(doc).toContain('HEALTHFARE');
    expect(doc).toContain('font-size: 54px');   // o código lido a 3 metros
  });
  test('uma etiqueta por folha quando vêm várias', () => {
    const doc = LABELS.sheetHtml([L, Object.assign({}, L, { code: 'BX-0452' }), Object.assign({}, L, { code: 'A03B2', kind: 'bin' })]);
    expect((doc.match(/class="sheet-page"/g) || []).length).toBe(3);
    expect(doc).toContain('page-break-after: always');
  });
  test('sem Code128/QR carregados a etiqueta AINDA sai (REGRA #0)', () => {
    // o papel com o código humano já serve; papel nenhum não serve
    const doc = LABELS.sheetHtml([L]);
    expect(doc).toContain('BX-0451');
    expect(doc).not.toContain('undefined');
  });
  test('escapa o que vem do banco (nada de HTML injetado na etiqueta)', () => {
    const doc = LABELS.sheetHtml([{ code: 'BX<1>', line2: '"x"&y' }]);
    expect(doc).toContain('BX&lt;1&gt;');
    expect(doc).toContain('&quot;x&quot;&amp;y');
  });
  test('lista vazia não gera folha em branco muda', () => {
    expect(LABELS.sheetHtml([])).toContain('Nenhuma etiqueta');
  });
  test('sem em dash', () => {
    expect(LABELS.sheetHtml([L]).includes('—')).toBe(false);
    expect(fs.readFileSync(path.join(__dirname, '..', 'shared', 'label-sheet.js'), 'utf8').includes('—')).toBe(false);
  });
});

describe('shared/print-queue-card.js — fila do celular (helpers puros)', () => {
  test('tipo de job em PT-BR', () => {
    expect(PQ.kindLabel('bin_labels')).toBe('Etiquetas de prateleira');
    expect(PQ.kindLabel('box_label')).toBe('Etiqueta de caixa');
    expect(PQ.kindLabel('picklist')).toBe('Picklist de hoje');
    expect(PQ.kindLabel('coisa-nova')).toBe('Impressão');
  });
  test('conta quantas folhas o job manda pro papel', () => {
    expect(PQ.jobCount({ kind: 'bin_labels', payload: { labels: [1, 2, 3] } })).toBe(3);
    expect(PQ.jobCount({ kind: 'picklist', payload: { date: '2026-08-19' } })).toBe(1);
    expect(PQ.jobCount({ kind: 'box_label', payload: {} })).toBe(0);
  });
  test('idade em português de gente', () => {
    expect(PQ.ageText(0)).toBe('agora mesmo');
    expect(PQ.ageText(2)).toBe('há 2 min');
    expect(PQ.ageText(75)).toBe('há 1 h 15 min');
    expect(PQ.ageText(120)).toBe('há 2 h');
  });
  test('job travado há 10+ min volta a ser oferecido', () => {
    // quem pegou pode ter fechado a aba: a etiqueta não pode ficar presa
    expect(PQ.isTakeable({ status: 'queued', age_min: 0 })).toBe(true);
    expect(PQ.isTakeable({ status: 'taken', age_min: 3 })).toBe(false);
    expect(PQ.isTakeable({ status: 'taken', age_min: 12 })).toBe(true);
    expect(PQ.isTakeable({ status: 'done', age_min: 99 })).toBe(false);
    expect(PQ.isTakeable(null)).toBe(false);
  });
  test('o botão avisa que é 2a tentativa e a linha diz por quê', () => {
    expect(PQ.actionLabel({ status: 'queued' })).toBe('Imprimir');
    expect(PQ.actionLabel({ status: 'taken' })).toBe('Tentar de novo');
    expect(PQ.stateNote({ status: 'taken', age_min: 14 })).toBe('travado há 14 min · tentar de novo');
    expect(PQ.stateNote({ status: 'taken', age_min: 2, taken_by: 'Simone' })).toBe('imprimindo em Simone');
    expect(PQ.stateNote({ status: 'queued' })).toBe('');
  });
  test('done e cancelled somem da tela do operador', () => {
    const list = PQ.visibleJobs([
      { id: 1, status: 'queued' }, { id: 2, status: 'taken' },
      { id: 3, status: 'done' }, { id: 4, status: 'cancelled' }, { id: 5, status: 'error' },
    ]);
    expect(list.map((j) => j.id)).toEqual([1, 2]);
  });
  test('o motivo do erro chega em texto de gente, nunca "[object Object]"', () => {
    // o backend da fila responde {error:{code,message}} e o api() do kiosk monta
    // a Error com j.detail || j.error: sem peneira o admin lia [object Object]
    const e = new Error('[object Object]');
    e.body = { error: { code: 'not_queued', message: 'Este trabalho não está esperando.' } };
    expect(PQ.errNote(e)).toBe('Este trabalho não está esperando.');
    expect(PQ.errNote(Object.assign(new Error('[object Object]'), { body: { detail: 'sem papel' } }))).toBe('sem papel');
    expect(PQ.errNote(new Error('[object Object]'))).toBe('falhou na estação');
    expect(PQ.errNote(new Error('não deu pra abrir a janela'))).toBe('não deu pra abrir a janela');
    expect(PQ.errNote(null)).toBe('falhou na estação');
  });
  test('sem em dash no módulo inteiro', () => {
    expect(fs.readFileSync(path.join(__dirname, '..', 'shared', 'print-queue-card.js'), 'utf8').includes('—')).toBe(false);
  });
});

describe('shared/print-queue-card.js — take: pega, imprime e marca como feito', () => {
  const JOB = { id: 7, kind: 'bin_labels', status: 'queued', age_min: 1, requested_by: 'Bruno',
    payload: { labels: [{ kind: 'bin', code: 'A03B2', line2: 'S4', line3: 'cabe 48', url: '/scan/?bin=A03B2' }] } };

  function mk(overrides) {
    const calls = [];
    const toasts = [];
    const win = { document: { written: '', write(s) { this.written += s; }, close() {} } };
    const base = {
      api: (p, o) => {
        calls.push({ p, method: (o && o.method) || 'GET', body: o && o.body });
        if (/\?status=/.test(p)) return Promise.resolve({ data: { jobs: [JOB] } });
        return Promise.resolve({ data: { job: {} } });
      },
      by: () => 'QA Operadora',
      onChange: () => {},
      toast: (m) => toasts.push(m),
      openWindow: () => win,
    };
    const q = PQ.create(Object.assign(base, overrides || {}));
    return { q, calls, toasts, win };
  }

  beforeAll(() => { global.HF_LABELS = LABELS; });
  afterAll(() => { delete global.HF_LABELS; });

  test('o poll só pede o que está na fila', async () => {
    const { q, calls } = mk();
    q.start();
    await new Promise((r) => setTimeout(r, 5));
    q.stop();
    expect(calls[0].p).toBe('/api/v3/print-queue?status=queued&limit=50');
    expect(q.jobs.length).toBe(1);
  });

  test('take → POST /take, abre a janela com a etiqueta, POST /done', async () => {
    const { q, calls, toasts, win } = mk();
    q.start();
    await new Promise((r) => setTimeout(r, 5));
    calls.length = 0;
    await q.take(7);
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.p);
    expect(posts[0]).toBe('/api/v3/print-queue/7/take');
    expect(posts[1]).toBe('/api/v3/print-queue/7/done');
    // quem imprimiu vai no corpo: o admin precisa saber quem pegou o papel
    expect(calls.find((c) => /\/take$/.test(c.p)).body).toEqual({ by: 'QA Operadora' });
    // a janela recebeu a etiqueta DO RENDERIZADOR ÚNICO
    expect(win.document.written).toContain('A03B2');
    expect(win.document.written).toContain('@page { size: 4in 6in');
    expect(toasts.join(' ')).toContain('Pode tirar do papel');
    q.stop();
  });

  test('popup bloqueado vira POST /error com o motivo (ninguém fica esperando papel)', async () => {
    const { q, calls, toasts } = mk({ openWindow: () => null });
    q.start();
    await new Promise((r) => setTimeout(r, 5));
    calls.length = 0;
    await q.take(7);
    const errPost = calls.find((c) => /\/error$/.test(c.p));
    expect(errPost).toBeTruthy();
    expect(String(errPost.body.note)).toMatch(/janela/i);
    expect(calls.find((c) => /\/done$/.test(c.p))).toBeFalsy();
    expect(toasts.join(' ')).toContain('já foi avisado');
    q.stop();
  });

  test('409 (outro PC pegou antes) não vira erro do job', async () => {
    const calls = [];
    const toasts = [];
    const q = PQ.create({
      api: (p, o) => {
        calls.push({ p, method: (o && o.method) || 'GET' });
        if (/\?status=/.test(p)) return Promise.resolve({ data: { jobs: [JOB] } });
        if (/\/take$/.test(p)) { const e = new Error('not_queued'); e.status = 409; return Promise.reject(e); }
        return Promise.resolve({});
      },
      by: () => 'QA', onChange: () => {}, toast: (m) => toasts.push(m),
      openWindow: () => ({ document: { write() {}, close() {} } }),
    });
    q.start();
    await new Promise((r) => setTimeout(r, 5));
    await q.take(7);
    expect(calls.find((c) => /\/error$/.test(c.p))).toBeFalsy();
    expect(toasts.join(' ')).toContain('pegou esse pedido primeiro');
    q.stop();
  });

  test('picklist usa o print() da Central, não o desenho de etiqueta', async () => {
    let usedPicklist = 0;
    const calls = [];
    const q = PQ.create({
      api: (p, o) => {
        calls.push({ p, method: (o && o.method) || 'GET' });
        if (/\?status=/.test(p)) return Promise.resolve({ data: { jobs: [{ id: 9, kind: 'picklist', status: 'queued', age_min: 0, payload: { date: '2026-08-19' } }] } });
        return Promise.resolve({});
      },
      by: () => 'QA', onChange: () => {}, toast: () => {},
      openWindow: () => ({ document: { write() {}, close() {} } }),
      printPicklist: () => { usedPicklist += 1; return true; },
    });
    q.start();
    await new Promise((r) => setTimeout(r, 5));
    await q.take(9);
    expect(usedPicklist).toBe(1);
    expect(calls.filter((c) => /\/done$/.test(c.p)).length).toBe(1);
    q.stop();
  });

  test('fila fora do ar não atrapalha quem está trabalhando (REGRA #0)', async () => {
    const q = PQ.create({
      api: () => Promise.reject(new Error('offline')),
      by: () => 'QA', onChange: () => {}, toast: () => {},
    });
    q.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(q.jobs).toEqual([]);
    q.stop();
  });
});

describe('op/ws.js — cartão da fila do celular na Central', () => {
  function boot(jobs) {
    global.HF_PRINT_QUEUE = PQ;
    global.HF_LABELS = LABELS;
    const calls = [];
    const S = { workspaceOpen: true, myTasks: [{ slug: 'order_printing' }], ws: null, person: { display_name: 'QA Operadora' } };
    WS.init({
      S, CFG: { workspace: true }, DATA: { supplements: [] },
      api: (p, o) => {
        calls.push({ p, method: (o && o.method) || 'GET', body: o && o.body });
        if (/print-queue\?/.test(p)) return Promise.resolve({ data: { jobs } });
        return Promise.resolve({});
      },
      toast: () => {}, render: () => {}, esc: (s) => String(s == null ? '' : s),
      isSandbox: () => false, typeMeta: () => ({}), openWindow: () => ({ document: { write() {}, close() {} } }),
      loadData: () => Promise.resolve(null),
    });
    return { S, calls };
  }
  afterEach(() => { WS.stopQueue(); delete global.HF_PRINT_QUEUE; delete global.HF_LABELS; });

  test('abrir a Central começa a puxar a fila', async () => {
    const { calls } = boot([]);
    WS.acts.openWorkspace();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.some((c) => c.p === '/api/v3/print-queue?status=queued&limit=50')).toBe(true);
  });

  test('fila vazia NÃO desenha cartão nenhum', async () => {
    boot([]);
    WS.acts.openWorkspace();
    await new Promise((r) => setTimeout(r, 5));
    expect(WS.inner()).not.toContain('data-card="print-queue"');
  });

  test('com pedido: cartão com tipo em PT, quem pediu, idade e botão', async () => {
    boot([{ id: 7, kind: 'bin_labels', status: 'queued', age_min: 2, requested_by: 'Bruno',
      payload: { labels: [{ kind: 'bin', code: 'A03B2' }, { kind: 'bin', code: 'A04' }] } }]);
    WS.acts.openWorkspace();
    await new Promise((r) => setTimeout(r, 5));
    const h = WS.inner();
    expect(h).toContain('data-card="print-queue"');
    expect(h).toContain('Etiquetas de prateleira');
    expect(h).toContain('2 folhas');
    expect(h).toContain('Bruno');
    expect(h).toContain('há 2 min');
    expect(h).toContain('data-act="wsPrintJob" data-arg="7"');
  });

  test('job travado há 12 min oferece "Tentar de novo"', async () => {
    boot([{ id: 8, kind: 'box_label', status: 'taken', age_min: 12, requested_by: 'Bruno', taken_by: 'Simone',
      payload: { labels: [{ kind: 'box', code: 'BX-0451' }] } }]);
    WS.acts.openWorkspace();
    await new Promise((r) => setTimeout(r, 5));
    const h = WS.inner();
    expect(h).toContain('Tentar de novo');
    expect(h).toContain('travado há 12 min');
  });

  test('a key muda quando um pedido chega (senão o cartão não aparece sozinho)', async () => {
    boot([]);
    WS.acts.openWorkspace();
    await new Promise((r) => setTimeout(r, 5));
    const k1 = WS.key();
    WS.stopQueue();
    boot([{ id: 7, kind: 'bin_labels', status: 'queued', age_min: 0, payload: { labels: [{ code: 'A03B2' }] } }]);
    WS.acts.openWorkspace();
    await new Promise((r) => setTimeout(r, 5));
    expect(WS.key()).not.toBe(k1);
  });

  test('fechar a Central para de puxar a fila', async () => {
    const { calls } = boot([]);
    WS.acts.openWorkspace();
    await new Promise((r) => setTimeout(r, 5));
    WS.acts.closeWorkspace();
    calls.length = 0;
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.filter((c) => /print-queue/.test(c.p)).length).toBe(0);
  });
});
