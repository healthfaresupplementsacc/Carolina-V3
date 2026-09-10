'use strict';
/*
 * TODA ROTA DO PAINEL ADMIN TEM GATE — análise estática de src/routes/admin.js.
 *
 * O QUE ACONTECEU (09-09, deploy 54df6478): o requireAdmin do painel é aplicado
 * POR PREFIXO (`router.use('/api/adminpanel/operators', requireAdmin)`). Duas
 * rotas novas com prefixos novos (/roles, /persons) nasceram sem gate e ficaram
 * PÚBLICAS por ~10 minutos: qualquer um podia ler e TROCAR o responsável pelo
 * P&P. O teste do drift não pega isso (só olha routers montados), e nenhum
 * mock de teste bate na cadeia real de middleware.
 *
 * Este teste lê o arquivo e exige que cada rota /api/adminpanel/<prefixo>
 * esteja coberta por um destes:
 *   (a) `router.use('/api/adminpanel/<prefixo>', requireAdmin|requireRole…)`
 *   (b) middleware inline na própria rota (requireAdmin / requireRole)
 *   (c) lista explícita de rotas PÚBLICAS por desenho (login, logout, me).
 * Prefixo novo sem gate → falha aqui, não em produção.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');

// Rotas públicas POR DESENHO (auth flui sem sessão). Qualquer outra precisa de gate.
const PUBLIC_BY_DESIGN = new Set([
  'auth/login', 'auth/logout', 'auth/me',
]);

function gatedPrefixes() {
  const set = new Set();
  const re = /router\.use\(\s*'\/api\/adminpanel\/([^'/]+)'\s*,\s*(requireAdmin|requireRole)/g;
  let m; while ((m = re.exec(SRC))) set.add(m[1]);
  return set;
}

function routes() {
  const out = [];
  const re = /router\.(get|post|put|delete|patch)\(\s*'\/api\/adminpanel\/([^']+)'\s*,([^\n]*)/g;
  let m;
  while ((m = re.exec(SRC))) {
    const full = m[2];
    const prefix = full.split('/')[0];
    const inlineGate = /requireAdmin|requireRole/.test(m[3]);
    out.push({ method: m[1].toUpperCase(), path: full, prefix, inlineGate });
  }
  return out;
}

describe('src/routes/admin.js — toda rota /api/adminpanel/* tem gate de admin', () => {
  const gated = gatedPrefixes();
  const all = routes();

  test('encontrou as rotas e os gates (sanidade do parser)', () => {
    expect(all.length).toBeGreaterThan(40);
    expect(gated.has('operators')).toBe(true);
  });

  test.each(all.map((r) => [r.method + ' /api/adminpanel/' + r.path, r]))('%s', (_label, r) => {
    const covered = gated.has(r.prefix) || r.inlineGate || PUBLIC_BY_DESIGN.has(r.path);
    if (!covered) {
      throw new Error(
        `Rota SEM gate: ${r.method} /api/adminpanel/${r.path}\n` +
        `  → adicione router.use('/api/adminpanel/${r.prefix}', requireAdmin) perto dos outros gates,\n` +
        `    ou requireAdmin inline na rota, ou (só se for pública por desenho) em PUBLIC_BY_DESIGN.`);
    }
  });

  test('os prefixos do caso de 09-09 estão gateados', () => {
    expect(gated.has('roles')).toBe(true);
    expect(gated.has('persons')).toBe(true);
  });
});
