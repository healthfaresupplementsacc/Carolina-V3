'use strict';
/* HEALTHFARE Operator Page — Service Worker (Fase F; rev. network-first).
   - Shell estático: NETWORK-FIRST (online sempre pega o código novo; cai pro
     cache só offline). Antes era cache-first, o que servia app.js velho pra
     sempre — operadores não viam updates. Bump de CACHE invalida o antigo.
   - API: network-first sem cache (dados frescos).
   - POST offline: tratado no app (offline-queue.js). */
const CACHE = 'hf-op-v2';
const SHELL = [
  '/op/', '/op/index.html', '/op/style.css', '/op/app.js',
  '/op/state-machine.js', '/op/fuse-data.js', '/op/offline-queue.js',
  '/op/config.js', '/op/manifest.json', '/op/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.filter(Boolean))).then(() => self.skipWaiting()).catch(() => {}));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // POSTs vão direto pra rede (queue é no app)
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) {
    // network-first: tenta rede, sem cache de API (dados sempre frescos)
    e.respondWith(fetch(req).catch(() => new Response(JSON.stringify({ offline: true }), { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  // estáticos: NETWORK-FIRST (atualiza o cache) → cache → index.html (offline)
  e.respondWith(
    fetch(req).then((resp) => {
      const copy = resp.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return resp;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('/op/index.html')))
  );
});
