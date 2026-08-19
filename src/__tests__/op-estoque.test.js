'use strict';
/*
 * HUB DE ESTOQUE do operador (S15 Fase 3) — helpers PUROS.
 *
 * testEnvironment=node, sem jsdom: estoque.js e code128.js sao escritos pra
 * carregar sem tocar o DOM (o boot() so roda quando existe window.document).
 * O que este teste protege:
 *   - a conta da PESAGEM (o operador confirma um numero: se ele estiver
 *     errado, o estoque inteiro fica errado);
 *   - o palpite do tipo de codigo escaneado;
 *   - os corpos de POST (contrato do S15-PHASE3-PLAN);
 *   - o Code 128 (implementacao propria: checksum + padroes de referencia).
 * O fluxo com DOM fica no harness docs/architecture/_qa/qa-op-estoque.js.
 */
const path = require('path');
const fs = require('fs');

const EST = require(path.join(__dirname, '..', 'op', 'estoque.js'));
const C128 = require(path.join(__dirname, '..', 'op', 'vendor', 'code128.js'));
const H = EST._;

describe('estoque — pesagem vira quantidade (weighPreview)', () => {
  test('conta exata: 100 garrafas de 48g + tara 500g', () => {
    const r = H.weighPreview({ gross_g: 5300, tare_g: 500, unit_weight_g: 48 });
    expect(r.net_g).toBe(4800);
    expect(r.qty).toBe(100);
    expect(r.residual_g).toBe(0);
    expect(r.confidence).toBe('high');
  });
  test('sobra pequena (5g numa garrafa de 48g) ainda e confianca alta', () => {
    const r = H.weighPreview({ gross_g: 5305, tare_g: 500, unit_weight_g: 48 });
    expect(r.qty).toBe(100);
    expect(r.confidence).toBe('high');
  });
  test('sobra media (10g, ~21% da garrafa) → confianca media', () => {
    const r = H.weighPreview({ gross_g: 5310, tare_g: 500, unit_weight_g: 48 });
    expect(r.qty).toBe(100);
    expect(r.residual_g).toBe(10);
    expect(r.confidence).toBe('medium');
  });
  test('sobra grande (perto de meia garrafa) → confianca baixa', () => {
    // 5322 = 100 garrafas + 22g de sobra: quase meia garrafa, pode ser 100 ou 101.
    const r = H.weighPreview({ gross_g: 5322, tare_g: 500, unit_weight_g: 48 });
    expect(r.residual_g).toBe(22);
    expect(r.confidence).toBe('low');
  });
  test('a sobra nunca passa de meia garrafa (qty e arredondado)', () => {
    for (let g = 5000; g < 5400; g += 1) {
      const r = H.weighPreview({ gross_g: g, tare_g: 500, unit_weight_g: 48 });
      expect(r.residual_g / 48).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });
  test('sem peso unitario nao inventa quantidade', () => {
    const r = H.weighPreview({ gross_g: 5300, tare_g: 500, unit_weight_g: null });
    expect(r.qty).toBeNull();
    expect(r.confidence).toBe('low');
    expect(r.net_g).toBe(4800);           // ainda mostra o liquido pesado
  });
  test('bin vazio (bruto = tara) da 0 com confianca alta', () => {
    const r = H.weighPreview({ gross_g: 500, tare_g: 500, unit_weight_g: 48 });
    expect(r.qty).toBe(0);
    expect(r.confidence).toBe('high');
  });
  test('tara maior que o bruto nao vira quantidade negativa', () => {
    const r = H.weighPreview({ gross_g: 400, tare_g: 500, unit_weight_g: 48 });
    expect(r.qty).toBe(0);
    expect(r.confidence).toBe('low');     // algo esta errado: avisa
  });
  test('operador digita com virgula (4820,5)', () => {
    const r = H.weighPreview({ gross_g: '5300,5', tare_g: 500, unit_weight_g: 48 });
    expect(r.net_g).toBe(4800.5);
    expect(r.qty).toBe(100);
  });
  test('sem peso bruto nao calcula nada', () => {
    const r = H.weighPreview({ gross_g: '', tare_g: 500, unit_weight_g: 48 });
    expect(r.qty).toBeNull();
    expect(r.net_g).toBeNull();
  });
});

describe('estoque — tara vem do local, senao do preset', () => {
  test('tara do proprio bin ganha do preset', () => {
    expect(H.tareFor({ tare_g: '520' }, { tare_g: 100 })).toBe(520);
  });
  test('bin sem tara cai no preset escolhido', () => {
    expect(H.tareFor({ tare_g: null }, { tare_g: 100 })).toBe(100);
  });
  test('sem nada = 0 (pesagem sem tara ainda e pesagem)', () => {
    expect(H.tareFor(null, null)).toBe(0);
  });
});

describe('estoque — que codigo e esse (guessKind)', () => {
  test.each([
    ['A03B2', 'bin'], ['A03', 'bin'],
    ['BX-0451', 'box'], ['BX0451', 'box'],
    ['012345678905', 'upc'], ['7891234567895', 'upc'], ['12345670', 'upc'],
    ['HF-BENF-200', 'sku'],
    ['https://tracker/scan/?box=BX-0451', 'box'],
    ['https://tracker/op/estoque.html?bin=A03B2', 'bin'],
    ['', 'unknown'],
  ])('%s → %s', (input, kind) => {
    expect(H.guessKind(input)).toBe(kind);
  });
  test('normScan tira Enter e espaco do leitor USB', () => {
    expect(H.normScan('  BX-0451\r\n')).toBe('BX-0451');
  });
});

describe('estoque — corpos de POST (contrato Fase 3)', () => {
  const bin = { kind: 'bin', bin: { id: 3, bin_code: 'A03B2', tare_g: 520 } };
  const box = { kind: 'box', box: { id: 9, box_number: 'BX-0451' } };
  const prod = { id: 42, name: 'Rutin', unit_weight_g: 48 };

  test('organize manda product_id, qty e bin_id', () => {
    expect(H.organizeBody({ product: prod, qty: '12', target: bin }))
      .toEqual({ product_id: 42, qty: 12, bin_id: 3 });
  });
  test('organize numa caixa manda box_id (nunca os dois)', () => {
    const b = H.organizeBody({ product: prod, qty: '5', target: box });
    expect(b).toEqual({ product_id: 42, qty: 5, box_id: 9 });
    expect(b.bin_id).toBeUndefined();
  });
  test.each([
    [{}, 'sem destino'],
    [{ target: bin }, 'sem produto'],
    [{ target: bin, product: prod, qty: '0' }, 'qty zero'],
  ])('organizeError barra %#: %s', (state) => {
    expect(H.organizeError(state)).toBeTruthy();
  });
  test('organize valido nao tem erro', () => {
    expect(H.organizeError({ target: bin, product: prod, qty: '3' })).toBeNull();
  });

  test('count/weigh manda gross_g e a tara do bin', () => {
    expect(H.weighBody({ product: prod, gross_g: null, gross: '5300', target: bin }))
      .toEqual({ product_id: 42, gross_g: 5300, tare_g: 520, bin_id: 3 });
  });
  test('count/manual aceita 0 (contagem no zero)', () => {
    expect(H.manualBody({ product: prod, target: bin }, 0))
      .toEqual({ product_id: 42, qty: 0, bin_id: 3 });
  });
  test('countError exige local antes de tudo', () => {
    expect(H.countError({ product: prod, gross: '100' }, 'weigh')).toMatch(/prateleira|caixa/i);
  });
  test('countError exige peso no modo pesar', () => {
    expect(H.countError({ target: bin, product: prod, gross: '' }, 'weigh')).toMatch(/peso/i);
  });
  test('countError deixa passar qty 0 no manual', () => {
    expect(H.countError({ target: bin, product: prod, qty: '0' }, 'manual')).toBeNull();
  });

  test('box/new manda produto, qty e lote', () => {
    expect(H.boxNewBody({ product: prod, qty: '48', lot: 'L-22' }))
      .toEqual({ product_id: 42, qty: 48, batch_number: 'L-22' });
  });
  test('box/new sem lote nao manda batch_number', () => {
    expect(H.boxNewBody({ product: prod, qty: '48', lot: '  ' }).batch_number).toBeUndefined();
  });
  test('boxNewError cobra produto e quantidade', () => {
    expect(H.boxNewError({})).toMatch(/UPC|produto/i);
    expect(H.boxNewError({ product: prod, qty: '' })).toMatch(/garrafas/i);
    expect(H.boxNewError({ product: prod, qty: '48' })).toBeNull();
  });
});

describe('estoque — etiqueta da caixa (labelPayload)', () => {
  test('monta as 3 linhas + url do QR', () => {
    const L = H.labelPayload({ code: 'BX-0451', product: 'Rutin 500mg', qty: 48, lot: 'L-22' });
    expect(L.code).toBe('BX-0451');
    expect(L.line2).toBe('Rutin 500mg');
    expect(L.line3).toContain('48 garrafas');
    expect(L.line3).toContain('L-22');
    expect(L.url).toContain('BX-0451');
  });
  test('sem lote a linha 3 fica so com a quantidade', () => {
    const L = H.labelPayload({ code: 'BX-9', product: 'X', qty: 10 });
    expect(L.line3).toBe('10 garrafas');
  });
  test('respeita line2/line3/url ja prontos do servidor', () => {
    const L = H.labelPayload({ code: 'BX-1', line2: 'A', line3: 'B', url: '/x' });
    expect([L.line2, L.line3, L.url]).toEqual(['A', 'B', '/x']);
  });
});

describe('estoque — SSE do celular carrega a sessao na query', () => {
  test('streamUrl leva code e t (EventSource nao manda header)', () => {
    const u = H.streamUrl('AB12CD', 'sess-123');
    expect(u).toContain('/api/v3/scan/stream'); // fora do gate /api/v3/op: EventSource nao manda Bearer nem x-session-token
    expect(u).toContain('code=AB12CD');
    expect(u).toContain('t=sess-123');
  });
  test('escapa o que precisa', () => {
    expect(H.streamUrl('A B', 'a/b')).toContain('t=a%2Fb');
  });
});

describe('estoque — chips de estado e confianca', () => {
  test('confianca vira cor: alta verde, media amarela, baixa vermelha', () => {
    expect(H.confChip('high').label).toMatch(/alta/);
    expect(H.confChip('medium').label).toMatch(/média/);   // PT-BR com acento
    expect(H.confChip('low').label).toMatch(/baixa/);
    expect(H.confChip(undefined).label).toMatch(/baixa/);   // desconhecido = desconfia
  });
  test('status das linhas de Registrado hoje', () => {
    expect(H.statusChip('pending').label).toBe('pendente');
    expect(H.statusChip('approved').label).toBe('aprovado');
    expect(H.statusChip('rejected').label).toBe('recusado');
    expect(H.statusChip('applied').label).toBe('aplicado');
  });
});

describe('estoque — vocabulario do hub (regras do Bruno)', () => {
  /* "Caixa nova" chega da PRODUÇÃO, nunca de fornecedor: o galpão só recebe
     garrafa que a gente mesmo produziu (S15 §0.2). Errar isso ensina o
     operador a pensar no fluxo errado. */
  test('Caixa nova diz que veio da producao, nunca de fornecedor', () => {
    const ent = H.MENU.find((m) => m.k === 'entrada');
    expect(ent.title).toBe('Caixa nova');
    expect(ent.desc).toBe('Chegou da produção');
    H.MENU.forEach((m) => {
      expect((m.title + ' ' + m.desc).toLowerCase()).not.toMatch(/fornecedor/);
    });
  });

  test('verbos do menu batem com os do admin', () => {
    expect(H.MENU.map((m) => m.title))
      .toEqual(['Organizar', 'Contar', 'Repor', 'Caixa nova', 'Devolução', 'Danificada']);
  });

  test('nenhum texto do menu usa em dash', () => {
    H.MENU.forEach((m) => expect(m.title + m.desc).not.toContain('—'));
  });

  /* CONTAGEM CEGA: o rotulo do tipo de registro nunca pode virar um numero;
     e "Contagem" continua sendo a palavra usada nas duas telas. */
  test('kindLabel usa as mesmas palavras do admin, com acento', () => {
    expect(H.kindLabel('count')).toBe('Contagem');
    expect(H.kindLabel('entrada')).toBe('Caixa nova');
    expect(H.kindLabel('return_in')).toBe('Devolução');
    expect(H.kindLabel('restock')).toBe('Reposição');
  });
});

describe('code128 — implementacao propria', () => {
  test('padroes de referencia batem (START_B, STOP, valor 0)', () => {
    expect(C128.PATTERNS[103]).toBe('211412');   // START B
    expect(C128.PATTERNS[105]).toBe('211232');   // START C
    expect(C128.PATTERNS[106]).toBe('2331112');  // STOP (13 modulos)
    expect(C128.PATTERNS[0]).toBe('212222');
    expect(C128.PATTERNS.length).toBe(107);
  });
  test('texto usa START B com valores ASCII-32', () => {
    // 'CODE128' → C=35 O=47 D=36 E=37 1=17 ... (com troca pro modo C no '128'? nao: 3 digitos)
    const codes = C128.encode('CODE128');
    expect(codes[0]).toBe(103);
    expect(codes.slice(1, 5)).toEqual([35, 47, 36, 37]);
  });
  test('so digitos em par comeca no modo C (2 digitos por simbolo)', () => {
    expect(C128.encode('12345678')).toEqual([105, 12, 34, 56, 78]);
  });
  test('checksum modulo 103 confere', () => {
    const codes = C128.encode('12345678');
    // (105 + 12*1 + 34*2 + 56*3 + 78*4) % 103 = 47
    expect(C128.checksum(codes)).toBe(47);
  });
  test('BX-0451: texto + troca pro modo C nos digitos', () => {
    const codes = C128.encode('BX-0451');
    expect(codes[0]).toBe(103);
    expect(codes).toContain(99);       // troca pro modo C
  });
  test('bits comecam com barra e terminam no padrao do STOP', () => {
    const bits = C128.pattern('BX-0451');
    expect(bits[0]).toBe('1');
    expect(bits.endsWith('1100011101011')).toBe(true);   // STOP 2331112
    expect(bits.length % 1).toBe(0);
  });
  test('svg sai com rects pretos e a largura pedida', () => {
    const svg = C128.svg('BX-0451', { width: 400, height: 80 });
    expect(svg).toContain('<svg');
    expect(svg).toContain('width="400"');
    expect(svg).toContain('fill="#000"');
    expect(svg).not.toContain('<script');
  });
  test('texto vazio nao quebra', () => {
    expect(() => C128.svg('')).not.toThrow();
  });
});

describe('estoque — arquivos da casca (html + sw + vendor)', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  test('estoque.html carrega config, code128, qrcode e o app', () => {
    const html = read('op', 'estoque.html');
    ['/op/config.js', '/op/vendor/code128.js', '/op/vendor/qrcode.min.js', '/op/estoque.js']
      .forEach((s) => expect(html).toContain(s));
    expect(html).toContain('scanSink');   // input sempre focado (leitor USB)
  });
  test('sw cacheia a tela nova e subiu de versao', () => {
    const sw = read('op', 'sw.js');
    expect(sw).toContain("'hf-op-v41'");
    ['/op/estoque.html', '/op/estoque.js', '/op/vendor/code128.js', '/op/vendor/qrcode.min.js']
      .forEach((s) => expect(sw).toContain(s));
  });
  test('pagina do celular tem camera + fallback manual (REGRA #0)', () => {
    const html = read('scan', 'index.html');
    expect(html).toContain('id="video"');
    expect(html).toContain('id="manual"');       // digitar na mao SEMPRE existe
    expect(html).toContain('/scan/vendor/zxing.min.js');
    expect(html).toContain('/scan/scan.js');
  });
  test('scan.js posta em /api/v3/scan/push sem page token (rota fora do gate)', () => {
    const js = read('scan', 'scan.js');
    expect(js).toContain('/api/v3/scan/push');
    expect(js).toContain('navigator.vibrate');
    expect(js).not.toContain('HF_OP_CONFIG');    // o par E a credencial
    expect(js).toContain('BarcodeDetector');
    expect(js).toContain('ZXing');
  });
  test('libs vendoradas mantem o cabecalho MIT', () => {
    expect(read('op', 'vendor', 'qrcode.min.js').slice(0, 400)).toMatch(/MIT/i);
    expect(fs.existsSync(path.join(__dirname, '..', 'scan', 'vendor', 'zxing.min.js'))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '..', 'scan', 'vendor', 'LICENSE.zxing.txt'))).toBe(true);
  });
});

describe('estoque — texto de tela (regras do Bruno)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'op', 'estoque.js'), 'utf8');
  test('sem em dash em lugar nenhum', () => {
    expect(src.includes('—')).toBe(false);
  });
  test('as 6 acoes + parear existem no menu', () => {
    const keys = H.MENU.map((m) => m.k);
    expect(keys).toEqual(['organizar', 'contar', 'repor', 'entrada', 'devolucao', 'danificada']);
    expect(H.SCREENS).toContain('parear');
  });
});
