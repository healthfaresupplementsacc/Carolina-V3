'use strict';
/**
 * S15 — estrutura da NAV do dashboard-v4 (Shell.jsx).
 * Lê o arquivo como TEXTO (o repo não tem toolchain de JSX no Jest; os testes
 * de UI existentes, ex. op-redesign.test.js, também usam regex sobre o fonte).
 *
 * Regras travadas aqui (Bruno 08-18, estudo S15 §5/§10):
 *  - Operação = Hoje, Roadmap, Produção, Metas, Planejamento, Produto, Pessoas
 *    (Planejamento + Produto logo DEPOIS de Metas; pp/picklist saíram daqui).
 *  - Seção nova "Estoque" (en "Warehouse Inventory") com o hub #estoque,
 *    Aprovações, Locais, Etiquetas (S15 fase 3, LOGO DEPOIS de Locais — é o
 *    destino do botão "Imprimir etiquetas" da própria página Locais), as duas
 *    páginas antigas rotuladas "(antigo)", Product Setup e Configurações.
 *  - Subgrupo "P&P" dentro da MESMA seção, com pp + picklist.
 *  - Seção Estoque gated por view_stock.
 */
const fs = require('fs');
const path = require('path');

const SHELL = path.join(__dirname, '..', '..', 'dashboard-v4', 'src', 'components', 'Shell.jsx');
const src = fs.readFileSync(SHELL, 'utf8');

/** Recorta o bloco de uma seção do array NAV pelo nome. */
function sectionBlock(name) {
  const start = src.indexOf(`section: "${name}"`);
  expect(start).toBeGreaterThan(-1);
  // até o próximo `{ section:` ou o fim do array NAV
  const rest = src.slice(start + 5);
  const next = rest.indexOf('{ section:');
  return next === -1 ? rest : rest.slice(0, next);
}

/** IDs de item na ordem em que aparecem no bloco. */
function idsIn(block) {
  return [...block.matchAll(/\{\s*id:\s*"([\w-]+)"/g)].map((m) => m[1]);
}

describe('dashboard-v4 Shell NAV — seção Estoque (S15)', () => {
  test('Operação tem a ordem certa e Planejamento/Produto logo depois de Metas', () => {
    const ids = idsIn(sectionBlock('Operação'));
    expect(ids).toEqual(['hoje', 'roadmap', 'producao', 'metas', 'planejamento', 'produto', 'pessoas']);
    expect(ids.indexOf('planejamento')).toBe(ids.indexOf('metas') + 1);
    expect(ids.indexOf('produto')).toBe(ids.indexOf('planejamento') + 1);
  });

  test('Operação não tem mais P&P nem Picklist', () => {
    const ids = idsIn(sectionBlock('Operação'));
    expect(ids).not.toContain('pp');
    expect(ids).not.toContain('picklist');
  });

  test('existe a seção Estoque · Warehouse Inventory com ícone product', () => {
    expect(src).toMatch(/section:\s*"Estoque",\s*en:\s*"Warehouse Inventory",\s*icon:\s*"product"/);
  });

  test('a seção Estoque é gated por view_stock', () => {
    const block = sectionBlock('Estoque');
    expect(block).toMatch(/fn:\s*"view_stock"/);
  });

  test('a seção Estoque tem hub, aprovações, locais, etiquetas, setup, config e o subgrupo P&P na ordem (sem as antigas, 08-19)', () => {
    const ids = idsIn(sectionBlock('Estoque'));
    expect(ids).toEqual([
      'estoque', 'estoque-aprovacoes', 'estoque-locais', 'estoque-etiquetas',
      'produto-setup', 'config-estoque',
      'pp', 'picklist',
    ]);
    // Etiquetas entra LOGO DEPOIS de Locais: é pra lá que vai o botão
    // "Imprimir etiquetas" da página Locais.
    expect(ids.indexOf('estoque-etiquetas')).toBe(ids.indexOf('estoque-locais') + 1);
  });

  test('as páginas antigas saíram do menu mas seguem alcançáveis por hash (HIDDEN_PAGES, 08-19)', () => {
    const block = sectionBlock('Estoque');
    expect(block).not.toMatch(/estoque-geral/);
    expect(block).not.toMatch(/\(antigo\)/);
    const hidden = src.slice(src.indexOf('const HIDDEN_PAGES'), src.indexOf('const ALL_PAGES'));
    expect(hidden).toMatch(/id:\s*"estoque-geral"/);
    expect(hidden).toMatch(/id:\s*"inventory"/);
  });

  test('pp e picklist estão no subgrupo P&P (sub: "P&P")', () => {
    const block = sectionBlock('Estoque');
    expect(block).toMatch(/id:\s*"pp",[^}]*sub:\s*"P&P"/);
    expect(block).toMatch(/id:\s*"picklist",[^}]*sub:\s*"P&P"/);
  });

  test('o Sidebar renderiza cabeçalho de subgrupo e respeita o gate da seção', () => {
    expect(src).toMatch(/nav-subgroup/);
    expect(src).toMatch(/sec\.fn\s*&&\s*!visible\(sec\.fn\)/);
    // fallback tolerante: login sem lista de funções continua vendo tudo
    expect(src).toMatch(/Array\.isArray\(l\.functions\)\)\s*return true/);
  });
});
