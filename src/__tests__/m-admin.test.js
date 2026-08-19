'use strict';
/*
 * ADMIN NO CELULAR (/m/, S15.29) — checagens ESTÁTICAS dos arquivos.
 *
 * testEnvironment=node, sem jsdom: m.js só faz boot quando existe document,
 * então aqui a gente lê o FONTE e garante as regras que não podem quebrar
 * sem ninguém perceber:
 *   - as regras de texto do Bruno (PT-BR com acento, sem travessão);
 *   - a página só fala com as rotas combinadas (nada de rota inventada);
 *   - NENHUMA escrita de estoque fora do warehouse (StockService é a porta
 *     única: SQL ou fetch cru aqui seria um segundo escritor);
 *   - a casca do PWA (manifest, ícone, meta do iOS) e os vendorados.
 * O fluxo com DOM fica no harness docs/architecture/_qa/qa-mobile.js.
 */
const path = require('path');
const fs = require('fs');

const MDIR = path.join(__dirname, '..', 'm');
const read = (...p) => fs.readFileSync(path.join(MDIR, ...p), 'utf8');

const JS = read('m.js');
const HTML = read('index.html');
const CSS = read('m.css');
const MANIFEST = JSON.parse(read('manifest.webmanifest'));

describe('/m/ — os arquivos existem', () => {
  test.each([
    ['index.html'], ['m.js'], ['m.css'], ['manifest.webmanifest'],
    ['icon.svg'], ['icon.png'],
    [path.join('vendor', 'code128.js')],
    [path.join('vendor', 'qrcode.min.js')],
    [path.join('vendor', 'zxing.min.js')],
  ])('%s', (f) => {
    expect(fs.existsSync(path.join(MDIR, f))).toBe(true);
  });

  test('os vendorados são CÓPIAS fiéis dos originais (mesmo desenho de etiqueta)', () => {
    const same = (a, b) => fs.readFileSync(a, 'utf8') === fs.readFileSync(b, 'utf8');
    expect(same(path.join(MDIR, 'vendor', 'code128.js'),
      path.join(__dirname, '..', 'op', 'vendor', 'code128.js'))).toBe(true);
    expect(same(path.join(MDIR, 'vendor', 'qrcode.min.js'),
      path.join(__dirname, '..', 'op', 'vendor', 'qrcode.min.js'))).toBe(true);
    expect(same(path.join(MDIR, 'vendor', 'zxing.min.js'),
      path.join(__dirname, '..', 'scan', 'vendor', 'zxing.min.js'))).toBe(true);
  });

  test('a licença do ZXing viaja junto com a cópia', () => {
    expect(fs.existsSync(path.join(MDIR, 'vendor', 'LICENSE.zxing.txt'))).toBe(true);
  });
});

/** Só o texto que o Bruno LÊ: as strings entre aspas, fora dos comentários.
    A regra do travessão é sobre a tela, não sobre a régua do cabeçalho. */
function uiStrings(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLine = noBlock.replace(/^\s*\/\/.*$/gm, '');
  return (noLine.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g) || []).join('\n');
}

describe('/m/ — texto de tela (regras do Bruno)', () => {
  test('sem travessão (em dash) em NADA que apareça na tela', () => {
    expect(uiStrings(JS)).not.toContain('—');
    // no html e no css o travessão só pode viver em comentário
    expect(HTML.replace(/<!--[\s\S]*?-->/g, '')).not.toContain('—');
    expect(CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('—');
  });

  test('PT-BR COM acento nas palavras do vocabulário do hub', () => {
    ['Disponível', 'Aprovações', 'atenção', 'Separadas', 'Etiquetas', 'Prateleira']
      .forEach((w) => expect(JS).toContain(w));
  });

  /* O vocabulário é o MESMO do hub do dashboard. Duas telas chamando a
     mesma coisa por nomes diferentes é como se ensina alguém a errar. */
  test('usa as palavras do hub, não sinônimos', () => {
    ['Total', 'Prateleira', 'Caixa', 'A organizar', 'Reservado', 'Disponível',
      'Separadas', 'Dias', 'Aprovações', 'Locais', 'Veeqo diferente']
      .forEach((w) => expect(JS).toContain(w));
  });

  test('o verbo técnico do banco não vai pra tela (storein vira Entrada)', () => {
    expect(JS).toMatch(/storein:\s*'Entrada'/);
    expect(JS).toMatch(/place:\s*'Organizado'/);
    expect(JS).toMatch(/take:\s*'Saiu'/);
  });

  test('os erros dizem o que fazer agora, não um código de status', () => {
    expect(JS).toContain('Nada foi perdido. Tente de novo.');
    expect(JS).toContain('Sem internet aqui');
    expect(JS).toContain('PIN inválido');
    expect(JS).toContain('Não reconheci. Digite o código ou cadastre.');
  });
});

describe('/m/ — só as rotas combinadas, e nenhuma escrita por fora', () => {
  /* Toda URL de API que aparece no fonte. Se alguém colar uma rota nova
     sem combinar, este teste é quem avisa. */
  const urls = (JS.match(/['"`](\/api\/[^'"`]*)['"`]/g) || [])
    .map((s) => s.slice(1, -1))
    .concat((JS.match(/(?:WH|PQ)\s*\+\s*'([^']+)'/g) || []).map((s) => s.replace(/.*'([^']+)'.*/, '$1')));

  test('a página não inventa rota fora de /api/v3/warehouse e /api/v3/print-queue', () => {
    const bases = (JS.match(/var (WH|PQ) = '([^']+)'/g) || []).join(' ');
    expect(bases).toContain("'/api/v3/warehouse'");
    expect(bases).toContain("'/api/v3/print-queue'");
    urls.filter((u) => u.startsWith('/api/')).forEach((u) => {
      expect(u.startsWith('/api/v3/warehouse') || u.startsWith('/api/v3/print-queue')).toBe(true);
    });
  });

  test('usa exatamente os caminhos do contrato do celular', () => {
    ['/mobile/bootstrap', '/mobile/scan/resolve', '/mobile/printers', '/mobile/print/submit',
      '/labels?', '/requests/', '/locations/', '/product/'].forEach((p) => expect(JS).toContain(p));
  });

  /* StockService é o ÚNICO escritor de quantidade. O celular escreve só
     pelas rotas que já existem; SQL aqui seria um segundo escritor. */
  test('nenhum SQL, nenhuma tabela, nenhum acesso a banco', () => {
    // SQL de verdade vem em MAIÚSCULAS no projeto inteiro; minúsculo é
    // HTML (<select data-input="from">) ou JS (delete obj[k]), não banco
    expect(JS).not.toMatch(/\bSELECT\b[\s\S]{0,80}\bFROM\b/);
    expect(JS).not.toMatch(/\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b/);
    expect(JS).not.toMatch(/v3\.stock_|v3\.products|\bknex\b|\brequire\(/i);
  });

  test('toda escrita de estoque passa por uma rota do warehouse', () => {
    ['/entrada', '/place', '/move', '/adjust', '/separate'].forEach((verb) => {
      expect(JS).toContain("WH + '/product/' + id + '" + verb + "'");
    });
  });

  test('todo pedido leva o PIN do admin no header', () => {
    expect(JS).toContain("'x-admin-pin'");
    /* O header é montado num lugar SÓ (pinHeaders) e o PIN literal aparece
       só lá dentro: é isso que garante que não existe caminho sem credencial.
       São 2 fetch: api() (JSON) e apiBlob() (o PDF das etiquetas de envio,
       que uma aba nova não conseguiria buscar porque não manda header). */
    expect((JS.match(/fetch\(/g) || []).length).toBe(2);
    expect((JS.match(/'x-admin-pin'/g) || []).length).toBe(1);
    expect(JS).toMatch(/function pinHeaders\(\)/);
    // as duas chamadas usam a mesma função de credencial
    expect((JS.match(/pinHeaders\(\)/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(JS).toMatch(/fetch\(pathname, \{ headers: pinHeaders\(\) \}\)/);
  });

  test('a escrita fica escondida sem manage_stock', () => {
    expect(JS).toContain("indexOf('manage_stock')");
    expect(JS).toContain("indexOf('*')");
  });
});

describe('/m/ — PIN guardado com validade', () => {
  test('12 horas em localStorage (sessionStorage morre com a aba no Safari)', () => {
    expect(JS).toContain('localStorage');
    expect(JS).toMatch(/PIN_TTL = 12 \* 60 \* 60 \* 1000/);
    // o PIN não pode ser GUARDADO em sessionStorage (citar o nome num
    // comentário explicando a decisão é outra coisa)
    expect(JS).not.toMatch(/sessionStorage\s*[.[]/);
  });
  test('401 apaga o PIN e volta pro teclado', () => {
    expect(JS).toMatch(/status === 401/);
    expect(JS).toContain('clearPin()');
  });
});

describe('/m/ — casca do iPhone (PWA)', () => {
  test('manifest com nome, standalone e start_url /m/', () => {
    expect(MANIFEST.name).toBe('HealthFare Admin');
    expect(MANIFEST.short_name).toBe('HF Admin');
    expect(MANIFEST.display).toBe('standalone');
    expect(MANIFEST.start_url).toBe('/m/');
    expect(MANIFEST.theme_color).toBe('#0d1f3c');
    expect(MANIFEST.icons.length).toBeGreaterThan(0);
  });

  test('as metas do iOS estão no html', () => {
    ['apple-mobile-web-app-capable', 'apple-mobile-web-app-status-bar-style',
      'apple-touch-icon', 'viewport-fit=cover', 'manifest'].forEach((m) => expect(HTML).toContain(m));
    expect(HTML).toContain('theme-color');
  });

  /* Cache velho num app de estoque é pior que recarregar: o número na
     tela precisa ser o número de agora. */
  test('NENHUM service worker', () => {
    expect(HTML).not.toMatch(/serviceWorker|sw\.js/);
    expect(JS).not.toMatch(/serviceWorker/);
  });

  test('o html carrega os vendorados locais e a folha de etiqueta, sem CDN', () => {
    ['/m/vendor/code128.js', '/m/vendor/qrcode.min.js', '/shared/label-sheet.js', '/m/m.js', '/m/m.css']
      .forEach((s) => expect(HTML).toContain(s));
    expect(HTML).not.toMatch(/src="https?:\/\//);
  });

  test('o ZXing (300 kB) só é baixado quando a câmera precisa', () => {
    expect(HTML).not.toContain('zxing');
    expect(JS).toContain('/m/vendor/zxing.min.js');
    expect(JS).toContain('loadZxing');
  });
});

describe('/m/ — desenho pra dedo (STYLE-KIT + alvos de toque)', () => {
  test('os tokens do STYLE-KIT estão no css', () => {
    ['#f4f8fc', '#0d1f3c', 'DM Serif Display', 'DM Mono', '--r-lg:18px']
      .forEach((t) => expect(CSS).toContain(t));
    expect(CSS).toContain('radial-gradient');          // fundo dot-grid
  });

  test('as safe areas do notch e do home bar são respeitadas', () => {
    expect(CSS).toContain('env(safe-area-inset-top');
    expect(CSS).toContain('env(safe-area-inset-bottom');
  });

  test('nada de alvo pequeno: botões e campos com 44 px+', () => {
    expect(CSS).toMatch(/\.btn\s*{[^}]*min-height:44px/);
    expect(CSS).toMatch(/\.tab\s*{[^}]*min-height:48px/);
    expect(CSS).toMatch(/\.input[^{]*{[^}]*min-height:48px/);
  });

  test('campo com 16px: abaixo disso o Safari dá zoom sozinho ao focar', () => {
    expect(CSS).toMatch(/button, input, select, textarea\s*{[^}]*font-size:16px/);
  });

  test('sem :hover mandando em nada (não existe hover no celular)', () => {
    expect(CSS).not.toContain(':hover');
  });

  test('as 5 abas do rodapé', () => {
    ['inicio', 'aprovar', 'produtos', 'locais', 'imprimir']
      .forEach((k) => expect(JS).toContain("k: '" + k + "'"));
  });
});
