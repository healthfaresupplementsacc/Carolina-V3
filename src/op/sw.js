'use strict';
/* HEALTHFARE Operator Page — Service Worker (redesign FIEL ao design).
   - hf-op-v40: bump força clientes a pegar a nova versão (activate purga antigos).
   - Shell HTML/JS/CSS: NETWORK-FIRST (online sempre pega código novo; cai pro
     cache offline). API: network-first sem cache. Imagens/fontes: CACHE-FIRST
     (raramente mudam; carregam rápido + offline).
   - skipWaiting + clients.claim + postMessage 'sw-updated' pra UI avisar reload.
   - Quando trocar index.v4 → index ativo, este vira sw.js. */
const CACHE = 'hf-op-v43'; // v43: renderizador único da etiqueta + fila de impressão do celular
const SHELL = [
  '/op/', '/op/index.html', '/op/app.js', '/op/ws.js', '/op/nav.js', '/op/style.css',
  '/op/state-machine.js', '/op/offline-queue.js', '/op/fuse-data.js', '/op/config.js',
  '/op/manifest.json',
  // S15 Fase 3: hub de estoque (tela propria, mesma casca offline)
  '/op/estoque.html', '/op/estoque.js',
  '/op/vendor/code128.js', '/op/vendor/qrcode.min.js',
  '/shared/hf-design.css', '/shared/hf-design.js',
  // desenho único da etiqueta + fila de impressão do celular (Central, hub e /print)
  '/shared/label-sheet.js', '/shared/print-queue-card.js',
  '/op/assets/healthfare-logo.png',
];
const IMG_RE = /\.(png|webp|jpg|jpeg|svg|woff2?)$/i;
const FONT_RE = /fonts\.(googleapis|gstatic)\.com/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll())
      .then((cls) => cls.forEach((c) => { try { c.postMessage('sw-updated'); } catch (_) {} }))
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // POSTs → rede (offline queue é no app)
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(req).catch(() => new Response(JSON.stringify({ offline: true }), { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  // imagens + fontes: cache-first com atualização em background
  if (IMG_RE.test(url.pathname) || FONT_RE.test(url.host)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((resp) => {
      const copy = resp.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); return resp;
    }).catch(() => hit)));
    return;
  }
  // shell HTML/JS/CSS: network-first → cache → index
  e.respondWith(
    fetch(req).then((resp) => {
      const copy = resp.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); return resp;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('/op/index.html')))
  );
});
