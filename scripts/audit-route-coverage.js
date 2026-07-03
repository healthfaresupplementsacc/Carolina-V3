'use strict';
/**
 * AUDITORIA (Bruno 07-03): todo botão/feature funciona no front E no back?
 * Passo 1 mecânico: extrai TODAS as chamadas de API do frontend (dashboard-v4 +
 * /op + /admin SPA) e cruza com as rotas que o backend REALMENTE monta.
 * Chamada sem rota = botão quebrado. Sai com lista exata.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const walk = (dir, exts, out = []) => {
  for (const f of fs.readdirSync(path.join(ROOT, dir))) {
    const rel = dir + '/' + f;
    const st = fs.statSync(path.join(ROOT, rel));
    if (st.isDirectory()) { if (!/node_modules|assets/.test(f)) walk(rel, exts, out); }
    else if (exts.some((e) => f.endsWith(e))) out.push(rel);
  }
  return out;
};

// ── 1. BACKEND: rotas reais ──────────────────────────────────
const backend = new Set();
// v3 data API (ENDPOINTS exportado — fonte da verdade)
const { ENDPOINTS } = require(path.join(ROOT, 'src', 'v3', 'data', 'router.js'));
for (const ep of ENDPOINTS) backend.add((ep.method || 'get').toUpperCase() + ' ' + ep.path);
backend.add('GET /api/v3/data/snapshot');
// routers com app.get/post/put/delete literais
const ROUTE_RE = /router\.(get|post|put|delete)\(\s*\[?\s*['"`]([^'"`]+)['"`]/g;
for (const file of ['src/routes/op.js', 'src/routes/admin.js', 'src/routes/cameras.js', 'src/routes/api.js', 'src/v3/architect.js']) {
  let src; try { src = read(file); } catch { continue; }
  let m; while ((m = ROUTE_RE.exec(src))) backend.add(m[1].toUpperCase() + ' ' + m[2]);
  // arrays de paths: router.get(['/a','/b'], ...)
  const ARR_RE = /router\.(get|post|put|delete)\(\s*\[([^\]]+)\]/g;
  let a; while ((a = ARR_RE.exec(src))) {
    for (const p of a[2].match(/['"`]([^'"`]+)['"`]/g) || []) backend.add(a[1].toUpperCase() + ' ' + p.replace(/['"`]/g, ''));
  }
}

// ── 2. FRONTEND: chamadas ────────────────────────────────────
// dashboard-v4 (React): apiGet/apiPost/apiPatch/apiDelete usam BASE=/api/v3/data;
// adminGet/... usam BASE=/api/adminpanel; fetch() cru pega /api/... completo.
const calls = []; // {file, method, url}
const push = (file, method, url) => {
  url = url.split('?')[0].replace(/\$\{[^}]*\}/g, ':x').replace(/'\s*\+[^,)]+/g, ':x').trim();
  if (!url.startsWith('/')) return;
  calls.push({ file, method, url });
};
for (const f of walk('dashboard-v4/src', ['.jsx', '.js', '.cjs'])) {
  const src = read(f);
  let m;
  const API_RE = /api(Get|Post|Patch|Delete)\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = API_RE.exec(src))) push(f, m[1].toUpperCase().replace('GET', 'GET').replace('POST', 'POST').replace('PATCH', 'PATCH').replace('DELETE', 'DELETE'), '/api/v3/data' + m[2]);
  const APIVAR_RE = /api(Get|Post|Patch|Delete)\(\s*['"`]([^'"`]*)['"`]\s*\+/g; // apiGet('/x/' + id)
  while ((m = APIVAR_RE.exec(src))) push(f, m[1].toUpperCase(), '/api/v3/data' + m[2] + ':x');
  const ADM_RE = /admin(Get|Post|Put|Delete)\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = ADM_RE.exec(src))) push(f, m[1].toUpperCase(), '/api/adminpanel' + m[2]);
  const ADMV_RE = /admin(Get|Post|Put|Delete)\(\s*['"`]([^'"`]*)['"`]\s*\+/g;
  while ((m = ADMV_RE.exec(src))) push(f, m[1].toUpperCase(), '/api/adminpanel' + m[2] + ':x');
  const FETCH_RE = /fetch\(\s*['"`](\/api\/[^'"`]+)['"`](?:\s*,\s*\{[^}]*method:\s*['"`](\w+)['"`])?/g;
  while ((m = FETCH_RE.exec(src))) push(f, (m[2] || 'GET').toUpperCase(), m[1]);
  const FETCHC_RE = /fetch\(\s*['"`](\/api\/[^'"`]*)['"`]\s*\+/g;
  while ((m = FETCHC_RE.exec(src))) push(f, 'GET', m[1] + ':x');
  // usePoll/useFetch('/path') e useAdmin('/path') → GET nos respectivos BASEs
  const HOOK_RE = /use(Poll|Fetch)\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = HOOK_RE.exec(src))) push(f, 'GET', '/api/v3/data' + m[2]);
  const HOOKC_RE = /use(Poll|Fetch)\(\s*['"`]([^'"`]*)['"`]\s*\+/g;
  while ((m = HOOKC_RE.exec(src))) push(f, 'GET', '/api/v3/data' + m[2] + ':x');
  const UA_RE = /useAdmin\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = UA_RE.exec(src))) push(f, 'GET', '/api/adminpanel' + m[1]);
  const UAC_RE = /useAdmin\(\s*['"`]([^'"`]*)['"`]\s*\+/g;
  while ((m = UAC_RE.exec(src))) push(f, 'GET', '/api/adminpanel' + m[1] + ':x');
}
// /op app + /admin SPA (vanilla: api('/api/v3/op/...') e j('/api/adminpanel/...'))
for (const f of ['src/op/app.js', 'src/admin/app.js']) {
  const src = read(f);
  let m;
  const RAW_RE = /['"`](\/api\/(?:v3\/op|adminpanel|admin|cam)\/[^'"`]*)['"`]/g;
  while ((m = RAW_RE.exec(src))) {
    // método é difícil no vanilla — marca como ANY (checa só existência do path)
    push(f, 'ANY', m[1].replace(/'\s*\+.*$/, ''));
  }
}

// ── 3. MATCH ─────────────────────────────────────────────────
const norm = (p) => p.replace(/:[A-Za-z_]+/g, ':x').replace(/\/+$/, '');
const backendNorm = [...backend].map((b) => { const [me, pa] = b.split(' '); return { method: me, path: norm(pa) }; });
const misses = [];
for (const c of calls) {
  const cp = norm(c.url);
  const hit = backendNorm.some((b) => b.path === cp && (c.method === 'ANY' || b.method === c.method || (c.method === 'PUT' && b.method === 'PUT')));
  if (!hit) misses.push(c);
}
const uniq = [...new Map(misses.map((x) => [x.method + ' ' + x.url, x])).values()];
console.log('Backend: ' + backendNorm.length + ' rotas · Frontend: ' + calls.length + ' chamadas extraídas');
if (!uniq.length) console.log('\n✅ NENHUMA chamada de frontend sem rota no backend.');
else {
  console.log('\n❌ CHAMADAS SEM ROTA NO BACKEND (botão quebrado):');
  uniq.forEach((c) => console.log(`   ${c.method.padEnd(6)} ${c.url}   ← ${c.file}`));
}
