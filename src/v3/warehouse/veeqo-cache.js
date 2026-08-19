'use strict';
/**
 * HEALTHFARE V3 — Warehouse hub — cache Veeqo (SWR 10 min).
 *
 * Mesmo padrão do _stockCache do data/router.js: `listSellables()` é lento e pode
 * dar timeout; o hub NUNCA pode travar por causa disso. Devolve o que tem em cache
 * e atualiza em background. Enquanto o 1º refresh não volta, o mapa é vazio → a
 * coluna Veeqo mostra 'unknown' (nunca um número errado).
 *
 * Mapa: SKU (upper/trim) → { type:'kit'|'variant'|null, wh:{physical,allocated,available}|null }
 * Regra do estudo (V1 08-18): a comparação usa SÓ o SKU BASE; kits nunca somam.
 */

const TTL_MS = 10 * 60 * 1000;

function createVeeqoCache(deps = {}) {
  const veeqo = deps.veeqo || null;
  const ttl = deps.ttlMs || TTL_MS;
  const now = deps.now || (() => Date.now());
  const state = { at: 0, bySku: null, refreshing: false, error: null };

  function _refresh() {
    if (state.refreshing || !veeqo || typeof veeqo.listSellables !== 'function') return;
    state.refreshing = true;
    Promise.resolve()
      .then(() => veeqo.listSellables())
      .then((rows) => {
        const m = {};
        for (const s of (rows || [])) {
          if (!s || s.sku == null) continue;
          m[String(s.sku).trim().toUpperCase()] = {
            type: s.type || null,
            wh: s.wh || null,
          };
        }
        state.bySku = m; state.at = now(); state.error = null;
      })
      .catch((e) => { state.error = e && e.message; console.error('[warehouse] veeqo cache:', e && e.message); })
      .finally(() => { state.refreshing = false; });
  }

  return {
    /** Mapa SKU→dado do Veeqo. Nunca bloqueia: devolve o cache (ou {}) e atualiza. */
    async bySku() {
      const fresh = state.bySku && (now() - state.at) < ttl;
      if (!fresh) _refresh();
      return state.bySku || {};
    },
    /** Quando o cache foi preenchido pela última vez (ISO) ou null. */
    checkedAt() { return state.at ? new Date(state.at).toISOString() : null; },
    /** Espera o refresh corrente (usado em teste/smoke; produção usa SWR puro). */
    async warm() {
      if (!state.bySku && veeqo && typeof veeqo.listSellables === 'function') {
        try {
          const rows = await veeqo.listSellables();
          const m = {};
          for (const s of (rows || [])) {
            if (!s || s.sku == null) continue;
            m[String(s.sku).trim().toUpperCase()] = { type: s.type || null, wh: s.wh || null };
          }
          state.bySku = m; state.at = now();
        } catch (e) { state.error = e && e.message; }
      }
      return state.bySku || {};
    },
    _state: state,
  };
}

module.exports = { createVeeqoCache, TTL_MS };
