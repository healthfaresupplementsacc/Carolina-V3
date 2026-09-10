/* HEALTHFARE V4 — RBAC por pessoa (Fase C, Bruno 09-10) — cliente de /api/v3/rbac/*.
   Reusa `getPin` do from-api.js (mesma fonte do PIN que o resto do dashboard).
   Envelope { data } / { error:{code,message} }. */
import React from 'react';
import { getPin } from './from-api.js';

const BASE = '/api/v3/rbac';

async function call(method, path, body) {
  let r;
  try {
    r = await fetch(BASE + path, {
      method,
      headers: { 'x-admin-pin': getPin(), ...(body != null ? { 'content-type': 'application/json' } : {}) },
      body: body != null ? JSON.stringify(body) : undefined,
    });
  } catch (e) { throw new Error('sem conexão com a API'); }
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  if (!r.ok) {
    const err = new Error((j && j.error && j.error.message) || ('erro ' + r.status));
    err.code = j && j.error && j.error.code; err.status = r.status; throw err;
  }
  return j;
}

export const getMe = () => call('GET', '/me');
export const getLoginFunctions = () => call('GET', '/login-functions');
export const setLoginFunction = (login_id, function_key, state) => call('POST', '/login-function', { login_id, function_key, state });
export const getInbox = () => call('GET', '/inbox');

/** Níveis de estoque do login atual (view/organize/propose/change/approve/receive_production/setup). */
export function useStockLevels() {
  const [levels, setLevels] = React.useState(null);
  React.useEffect(() => {
    let alive = true;
    getMe().then((r) => { if (alive) setLevels((r && r.data && r.data.stock_levels) || null); }).catch(() => { if (alive) setLevels(null); });
    return () => { alive = false; };
  }, []);
  return levels;
}

/* As seis funções "Controle de estoque" na ordem dos níveis, com o rótulo que
   diz o que a pessoa FAZ (nunca o que ela é). */
export const STOCK_FUNCTIONS = [
  ['view_stock',               'Ver estoque'],
  ['stock_organize',           'Organizar (mover, organizar, separar)'],
  ['stock_propose',            'Propor (entrada, saída, contagem viram proposta)'],
  ['stock_change',             'Mudar o total (direto, com motivo e Desfazer)'],
  ['stock_approve',            'Aprovar propostas dos outros'],
  ['stock_receive_production', 'Receber a produção'],
  ['stock_setup',              'Configurar (locais, etiquetas, produtos)'],
];
