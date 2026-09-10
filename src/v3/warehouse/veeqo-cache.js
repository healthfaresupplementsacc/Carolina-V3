'use strict';
/**
 * HEALTHFARE V3 — Warehouse hub — cache Veeqo (SWR 10 min) com SEMENTE do snapshot.
 *
 * Mesmo padrão do _stockCache do data/router.js: `listSellables()` é lento e pode
 * dar timeout; o hub NUNCA pode travar por causa disso. Devolve o que tem em cache
 * e atualiza em background.
 *
 * FASE A (Bruno 09-10, R1 da auditoria): antes, enquanto o 1º refresh não voltava
 * (e no Railway ele estourava o timeout com frequência), o mapa ficava VAZIO e as
 * 110 linhas do hub mostravam "sem Veeqo" — o alvo da carga sumia. Agora o cache
 * nasce SEMEADO pelo snapshot mais novo de `v3.veeqo_snapshots` (o veeqo-absorb
 * grava um a cada 6 h, com `wh.physical` por SKU). A coluna Veeqo nunca fica
 * vazia quando há snapshot; o hub mostra a idade e a origem (`source()`):
 *   'live'      = veio da API nesta execução (≤ TTL)
 *   'snapshot'  = semente do banco (idade = taken_at do snapshot)
 *   'none'      = nem snapshot nem API (só num banco zerado)
 *
 * Mapa: SKU (upper/trim) → { type:'kit'|'variant'|null, wh:{physical,allocated,available}|null,
 *                            upc:string|null }
 * Regra do estudo (V1 08-18): a comparação usa SÓ o SKU BASE; kits nunca somam.
 *
 * `upc` (S15 F3): o código de barras impresso na garrafa. É o que o operador vai
 * escanear no hub; sem ele o scan não resolve produto nenhum. Vem do sellable da
 * Veeqo quando o client expõe (upc_code/upc/barcode) — null quando não vem, e aí
 * o import-upc simplesmente não tem o que copiar (nunca inventa código).
 */

const TTL_MS = 10 * 60 * 1000;

/** Uma linha do listSellables → a entrada do mapa. Um lugar só (SWR, warm e semente). */
function _entryOf(s) {
  const upc = s.upc_code || s.upc || s.barcode || null;
  return {
    type: s.type || null,
    wh: s.wh || null,
    upc: upc ? String(upc).trim() : null,
  };
}

function _mapOf(rows) {
  const m = {};
  for (const s of (rows || [])) {
    if (!s || s.sku == null) continue;
    m[String(s.sku).trim().toUpperCase()] = _entryOf(s);
  }
  return m;
}

function createVeeqoCache(deps = {}) {
  const veeqo = deps.veeqo || null;
  const db = deps.db || null;                 // opcional: sem db, sem semente (comportamento antigo)
  const ttl = deps.ttlMs || TTL_MS;
  const now = deps.now || (() => Date.now());
  const state = { at: 0, bySku: null, refreshing: false, error: null, source: 'none', seeded: false, seeding: null };

  /** Semente: o snapshot mais novo do banco vira o mapa. Só roda uma vez; nunca derruba. */
  async function _seed() {
    if (state.seeded || !db) return;
    if (state.seeding) return state.seeding;
    state.seeding = (async () => {
      try {
        const r = await db.query(
          `SELECT taken_at, payload->'sellables' AS sellables
             FROM v3.veeqo_snapshots ORDER BY taken_at DESC LIMIT 1`);
        const row = r.rows[0];
        if (row && Array.isArray(row.sellables) && row.sellables.length && !state.bySku) {
          state.bySku = _mapOf(row.sellables);
          state.at = new Date(row.taken_at).getTime();
          state.source = 'snapshot';
        }
      } catch (e) {
        console.error('[warehouse] veeqo cache: semente do snapshot falhou:', e && e.message);
      } finally { state.seeded = true; state.seeding = null; }
    })();
    return state.seeding;
  }

  function _refresh() {
    if (state.refreshing || !veeqo || typeof veeqo.listSellables !== 'function') return;
    state.refreshing = true;
    Promise.resolve()
      .then(() => veeqo.listSellables())
      .then((rows) => {
        state.bySku = _mapOf(rows); state.at = now(); state.error = null; state.source = 'live';
      })
      .catch((e) => { state.error = e && e.message; console.error('[warehouse] veeqo cache:', e && e.message); })
      .finally(() => { state.refreshing = false; });
  }

  return {
    /** Mapa SKU→dado do Veeqo. Nunca bloqueia a API: semente do banco (1 query, uma vez) e atualiza em background. */
    async bySku() {
      if (!state.seeded) await _seed();
      const fresh = state.source === 'live' && state.bySku && (now() - state.at) < ttl;
      if (!fresh) _refresh();
      return state.bySku || {};
    },
    /** Quando o mapa foi preenchido pela última vez (ISO) ou null. Snapshot = taken_at dele. */
    checkedAt() { return state.at ? new Date(state.at).toISOString() : null; },
    /** 'live' | 'snapshot' | 'none' — o hub mostra a origem e a idade ao lado da coluna Veeqo. */
    source() { return state.bySku ? state.source : 'none'; },
    /** Espera o refresh corrente (usado em teste/smoke e no import; produção usa SWR puro). */
    async warm() {
      if (!state.seeded) await _seed();
      if (state.source !== 'live' && veeqo && typeof veeqo.listSellables === 'function') {
        try {
          const rows = await veeqo.listSellables();
          state.bySku = _mapOf(rows); state.at = now(); state.error = null; state.source = 'live';
        } catch (e) { state.error = e && e.message; }
      }
      return state.bySku || {};
    },
    _state: state,
  };
}

module.exports = { createVeeqoCache, TTL_MS };
