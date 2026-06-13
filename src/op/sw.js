'use strict';
/* HEALTHFARE Operator Page — Service Worker (Fase F).
   - Cacheia o shell estático (carrega offline).
   - Network-first pras chamadas de API (sempre tenta a rede; cai pro cache
     só pra navegação/estáticos offline).
   - O fluxo de POST offline é tratado no app (offline-queue.js) — não aqui,
     pra ficar simples e confiável (Background Sync é instável). */
const CACHE = 'hf-op-v1';
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
  // estáticos: cache-first com atualização em background
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((resp) => {
      const copy = resp.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return resp;
    }).catch(() => caches.match('/op/index.html')))
  );
});
