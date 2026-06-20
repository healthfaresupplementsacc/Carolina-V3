/* HEALTHFARE V4 — cliente da API /api/v3/data/*.
   ESM wrapper (Vite). Importa o adapter puro (.cjs) e adiciona hooks React.

   Tudo aqui é LEITURA. Writes (E5+) entrarão atrás de V4_ALLOW_WRITES (flags.js).
*/
import React from 'react';
import adapter from './adapt-to-hfdata.cjs';

const { adaptToHFData } = adapter;

const BASE = '/api/v3/data';

// ── PIN ──────────────────────────────────────────────────
export const getPin = () => {
  try { return sessionStorage.getItem('v3pin') || ''; }
  catch { return ''; }
};
export const setPin = (p) => {
  try { sessionStorage.setItem('v3pin', p); } catch {}
};
export const clearPin = () => {
  try { sessionStorage.removeItem('v3pin'); } catch {}
};

// ── apiCall: GET/POST/PATCH/DELETE com x-admin-pin ─────
async function apiCall(method, path, body) {
  let r;
  try {
    r = await fetch(BASE + path, {
      method,
      headers: {
        'x-admin-pin': getPin(),
        ...(body != null ? { 'content-type': 'application/json' } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error('sem conexão com a API');
  }
  if (r.status === 401) {
    const e = new Error('PIN inválido ou ausente');
    e.unauthorized = true;
    throw e;
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('erro ' + r.status));
  return j;
}

export const apiGet    = (path) => apiCall('GET', path);
// E5+: descomenta quando V4_ALLOW_WRITES virar 1 — por ora deixa exportado
// pra reuso futuro sem mudar imports.
export const apiPost   = (path, body) => apiCall('POST',   path, body);
export const apiPatch  = (path, body) => apiCall('PATCH',  path, body);
export const apiDelete = (path, body) => apiCall('DELETE', path, body);

// ── Hooks ────────────────────────────────────────────────

/** GET com loading/erro/data. path=null → não busca. */
export function useFetch(path, deps = []) {
  const [st, setSt] = React.useState({ loading: true, data: null, meta: null, error: null });
  React.useEffect(() => {
    if (!path) { setSt({ loading: false, data: null, meta: null, error: null }); return undefined; }
    let alive = true;
    setSt({ loading: true, data: null, meta: null, error: null });
    apiGet(path).then(
      (j) => { if (alive) setSt({ loading: false, data: j.data, meta: j.meta, error: null }); },
      (e) => { if (alive) setSt({ loading: false, data: null, meta: null, error: e }); },
    );
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return st;
}

/** Polling silencioso: re-busca a cada intervalMs sem voltar a loading nem
 *  piscar; em erro de refresh mantém o último data bom. intervalMs=0 → 1×. */
export function usePoll(path, deps = [], intervalMs = 12000) {
  const [st, setSt] = React.useState({ loading: true, data: null, meta: null, error: null });
  React.useEffect(() => {
    if (!path) { setSt({ loading: false, data: null, meta: null, error: null }); return undefined; }
    let alive = true;
    let timer = null;
    const load = () => apiGet(path).then(
      (j) => { if (alive) setSt({ loading: false, data: j.data, meta: j.meta, error: null }); },
      (e) => { if (alive) setSt((s) => ({ loading: false, data: s.data, meta: s.meta, error: e })); },
    );
    setSt({ loading: true, data: null, meta: null, error: null });
    load();
    if (intervalMs > 0) timer = setInterval(load, intervalMs);
    return () => { alive = false; if (timer) clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return st;
}

// ── Date helpers (NY) ───────────────────────────────────

export function nyToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export function shiftDate(date, days) {
  const base = Date.parse(date + 'T12:00:00Z') + days * 86400000;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(base));
}

// ── useSnapshotAsHFData ─────────────────────────────────
/**
 * Hook principal do V4: polla os endpoints PIN-authed em paralelo e devolve
 * a HFData adaptada (compatível com `window.HFData` do template).
 *
 *   - 6 endpoints com poll 12s quando isToday: /timeline, /production,
 *     /pp, /goals, /counts, /deadlines (+ /support pra Atenção/downtime).
 *   - 3 endpoints com fetch único: /catalog/persons, /catalog/activity-types,
 *     /catalog/products — não mudam intra-sessão.
 *   - intervalMs=0 quando date != hoje (sem auto-refresh em datas passadas).
 *
 * @param {string} date 'YYYY-MM-DD'
 * @param {{ pollMs?: number }} opts
 * @returns {{
 *   hfdata: object,           // shape HFData
 *   loading: boolean,         // true só na primeira carga
 *   error: Error | null,      // erro da última carga (não derruba data antiga)
 *   refresh: () => void,      // bump manual (após write)
 *   raw: object,              // payloads brutos da API (debug)
 * }}
 */
export function useSnapshotAsHFData(date, opts = {}) {
  const isToday = date === nyToday();
  const pollMs = opts.pollMs != null ? opts.pollMs : (isToday ? 12000 : 0);

  const [bump, setBump] = React.useState(0);
  const refresh = React.useCallback(() => setBump((b) => b + 1), []);

  const timeline   = usePoll('/timeline?date='   + date, [date, bump], pollMs);
  const production = usePoll('/production?date=' + date, [date, bump], pollMs);
  const pp         = usePoll('/pp?date='         + date, [date, bump], pollMs);
  const support    = usePoll('/support?date='    + date, [date, bump], pollMs);
  const goals      = usePoll('/goals?date='      + date, [date, bump], pollMs);
  const counts     = usePoll('/counts?date='     + date, [date, bump], pollMs);
  const deadlines  = usePoll('/deadlines',                [bump],     pollMs);

  // Catálogo: fetch único; mudanças raras, refresh manual disponível.
  const persons    = useFetch('/catalog/persons',          [bump]);
  const acts       = useFetch('/catalog/activity-types',   [bump]);
  const products   = useFetch('/catalog/products',         [bump]);
  // Revisão: média histórica (30d) — slow-changing, fetch único + refresh manual.
  const review     = useFetch('/review-rate?range=30d',    [bump]);

  // Adaptado: memoizado pelos data refs (mudam quando algum poll resolve).
  const hfdata = React.useMemo(() => {
    return adaptToHFData({
      date,
      timeline: timeline.data,
      production: production.data,
      pp: pp.data,
      support: support.data,
      goals: goals.data,
      counts: counts.data,
      deadlines: deadlines.data,
      review: review.data,
      catalog: {
        persons: (persons.data && persons.data.persons) || [],
        activity_types: (acts.data && acts.data.activity_types) || [],
        products: (products.data && products.data.products) || [],
      },
    });
  }, [date,
      timeline.data, production.data, pp.data, support.data,
      goals.data, counts.data, deadlines.data, review.data,
      persons.data, acts.data, products.data]);

  // Side-effect: popula window.HFData pros componentes do template que
  // ainda leem do global (Timeline/SidePanel/Primitives/OtherPages).
  React.useEffect(() => {
    if (typeof window !== 'undefined') window.HFData = hfdata;
  }, [hfdata]);

  // loading só verdadeiro enquanto NADA chegou (timeline é o sinal-âncora).
  const loading = timeline.loading && !timeline.data;
  // erro mais recente — não bloqueia render se já temos data antiga.
  const error = timeline.error || production.error || pp.error
    || goals.error || counts.error || deadlines.error
    || persons.error || acts.error || products.error || null;

  return {
    hfdata,
    loading,
    error,
    refresh,
    raw: {
      timeline: timeline.data, production: production.data, pp: pp.data,
      support: support.data, goals: goals.data, counts: counts.data,
      deadlines: deadlines.data, review: review.data,
      persons: persons.data, acts: acts.data, products: products.data,
    },
  };
}

// Re-exporta o adapter puro pra quem quiser testar manualmente no devtools.
export { adaptToHFData };
