// HEALTHFARE V3 — SPA — acesso à API de dados + helpers.
// Cliente PURO: só fala com /api/v3/data/*. Auth = PIN (header).
import { useState, useEffect } from 'react';

const BASE = '/api/v3/data';

export const getPin = () => sessionStorage.getItem('v3pin') || '';
export const setPin = (p) => sessionStorage.setItem('v3pin', p);
export const clearPin = () => sessionStorage.removeItem('v3pin');

/** GET na API. 401 → marca .unauthorized; erros → Error com a mensagem. */
export async function apiGet(path) {
  let r;
  try {
    r = await fetch(BASE + path, { headers: { 'x-admin-pin': getPin() } });
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

/** Hook de fetch com loading/erro. `path` null = não busca. */
export function useFetch(path, deps = []) {
  const [st, setSt] = useState({ loading: true, data: null, meta: null, error: null });
  useEffect(() => {
    if (!path) { setSt({ loading: false, data: null, meta: null, error: null }); return undefined; }
    let alive = true;
    setSt({ loading: true, data: null, meta: null, error: null });
    apiGet(path).then(
      (j) => { if (alive) setSt({ loading: false, data: j.data, meta: j.meta, error: null }); },
      (e) => { if (alive) setSt({ loading: false, data: null, meta: null, error: e }); },
    );
    return () => { alive = false; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return st;
}

/**
 * Como useFetch, mas re-busca a cada `intervalMs` (ao vivo). O refresh
 * é SILENCIOSO — não volta pra loading nem pisca a tela; em erro de
 * refresh mantém o último dado bom. intervalMs=0 → busca só uma vez.
 */
export function usePoll(path, deps = [], intervalMs = 12000) {
  const [st, setSt] = useState({ loading: true, data: null, meta: null, error: null });
  useEffect(() => {
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
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return st;
}

/** Relógio: re-renderiza a cada `intervalMs` quando `active`. Devolve ms. */
export function useNow(active, intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
}

// ── helpers de formatação ──────────────────────────────────
export function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}
export const fmtTime = (iso) => (iso ? String(iso).slice(11, 16) : '—');
export const fmtDateTime = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '—');

/** Data de hoje YYYY-MM-DD no fuso America/New_York. */
export function nyToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** Minuto-do-dia (0..1439) no fuso America/New_York pra um instante ms. */
export function nyMinutes(ms = Date.now()) {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  }).format(new Date(ms));
  return Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
}

/** Soma/desloca dias numa string YYYY-MM-DD. */
export function shiftDate(date, days) {
  const base = Date.parse(date + 'T12:00:00Z') + days * 86400000;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(base));
}
