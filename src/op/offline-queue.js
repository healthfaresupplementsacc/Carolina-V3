'use strict';
/* HEALTHFARE Operator Page — fila offline (Fase F). UMD (browser + jest).
   Guarda POSTs que falharam por estar offline em localStorage; reenvia
   quando a internet volta. Mantém o fluxo ONLINE byte-a-byte igual (só
   entra em ação quando navigator.onLine é false OU o fetch lança rede).

   Itens: { id, path, body, sessionToken, ts }. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HFOfflineQueue = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const KEY = 'hf_op_offline_queue';
  // storage injetável (testes passam um fake); no browser usa localStorage
  function store() {
    try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (_) { return null; }
  }
  function read(st) {
    const s = st || store(); if (!s) return [];
    try { return JSON.parse(s.getItem(KEY) || '[]'); } catch (_) { return []; }
  }
  function write(items, st) {
    const s = st || store(); if (!s) return;
    try { s.setItem(KEY, JSON.stringify(items)); } catch (_) {}
  }
  function enqueue(item, st) {
    const items = read(st);
    items.push({ ...item, id: (item.id || (Date.now() + '-' + items.length)), ts: item.ts || Date.now() });
    write(items, st);
    return items.length;
  }
  function size(st) { return read(st).length; }
  function clear(st) { write([], st); }

  /**
   * Reenvia a fila. doFetch(path, {body, sessionToken}) → Promise resolve/reject.
   * Para no primeiro erro (provável ainda-offline) pra preservar ordem.
   * @returns {Promise<{sent:number, remaining:number}>}
   */
  async function flush(doFetch, st) {
    let items = read(st);
    let sent = 0;
    while (items.length) {
      const it = items[0];
      try {
        await doFetch(it.path, { body: it.body, sessionToken: it.sessionToken });
        items = items.slice(1);
        write(items, st);
        sent += 1;
      } catch (_) {
        break; // ainda offline / erro — tenta de novo depois
      }
    }
    return { sent, remaining: items.length };
  }

  return { KEY, read, write, enqueue, size, clear, flush };
}));
