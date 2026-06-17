'use strict';
/**
 * EMS Production API (read-only) — client server-side.
 *
 * Consome a Edge Function Supabase do EMS:
 *   /overview /formulas /pipeline /line /products /employees
 * (estado vivo da fábrica: fórmulas, fila/linha de produção, produtos, funcionários).
 *
 * SEGURANÇA:
 *  - A chave vive SÓ no servidor: process.env.EMS_PRODUCTION_API_KEY (segredo do Railway).
 *  - NUNCA é logada, nem aparece em código/commit/resposta. CORS do EMS é '*', então
 *    a chave jamais pode ir pro browser (/op ou /admin client). Tudo aqui é server-side.
 *  - Read-only: nenhum endpoint do EMS escreve/modifica dado.
 */
const config = require('../../config');

const ENDPOINTS = ['overview', 'formulas', 'pipeline', 'line', 'products', 'employees'];

function createEmsClient(opts = {}) {
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : config.ems.apiKey;
  const baseUrl = String(opts.baseUrl || config.ems.baseUrl).replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || 10000;

  function configured() { return !!apiKey; }

  async function get(path) {
    if (!apiKey) { const e = new Error('EMS_PRODUCTION_API_KEY não configurada'); e.code = 'no_key'; throw e; }
    const p = '/' + String(path).replace(/^\/+/, '');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let r;
    try {
      r = await fetchImpl(baseUrl + p, {
        method: 'GET',
        headers: { 'x-api-key': apiKey, accept: 'application/json' },
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const err = new Error(e && e.name === 'AbortError' ? ('EMS timeout (' + timeoutMs + 'ms)') : ('EMS inacessível: ' + (e && e.message)));
      err.code = e && e.name === 'AbortError' ? 'timeout' : 'network';
      throw err; // erro NÃO inclui a chave
    }
    clearTimeout(timer);
    let body = null;
    try { body = await r.json(); } catch (_) { body = null; }
    if (r.status === 401) { const e = new Error('EMS recusou a chave (401) — verifique EMS_PRODUCTION_API_KEY'); e.code = 'unauthorized'; e.status = 401; throw e; }
    if (!r.ok) { const e = new Error('EMS HTTP ' + r.status + ' em ' + p); e.code = 'http_error'; e.status = r.status; throw e; }
    return body;
  }

  const api = { configured: configured, baseUrl: baseUrl, get: get };
  ENDPOINTS.forEach((name) => { api[name] = function () { return get(name); }; });
  return api;
}

// singleton padrão (usa a chave/base do config → env)
const ems = createEmsClient();

module.exports = { ems: ems, createEmsClient: createEmsClient, ENDPOINTS: ENDPOINTS };
