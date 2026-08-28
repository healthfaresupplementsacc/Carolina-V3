/* Cliente do freight cost watch — /api/v3/freight/* (Bruno 08-28).
   Mesma lógica de PIN do warehouse-api.js (header x-admin-pin via getPin do
   from-api.js) e o mesmo envelope { data } / { error:{code,message} }.

   useFreight() entrega numa chamada de hook tudo que o card Frete da página
   P&P precisa: summary (14 dias + média 30d) e os outliers de hoje. */
import React from 'react';
import { getPin } from './from-api.js';

const BASE = '/api/v3/freight';

async function fGet(path) {
  let r;
  try {
    r = await fetch(BASE + path, { headers: { 'x-admin-pin': getPin() } });
  } catch (e) {
    throw new Error('sem conexão com a API');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error((j.error && j.error.message) || ('erro ' + r.status));
    err.code = j.error && j.error.code;
    err.unauthorized = r.status === 401;
    err.forbidden = r.status === 403;
    throw err;
  }
  return j.data;
}

/** Summary (14d) + outliers de hoje, com poll leve (2 min). */
export function useFreight(intervalMs = 120000) {
  const [st, setSt] = React.useState({ loading: true, summary: null, outliers: null, error: null });

  React.useEffect(() => {
    let alive = true;
    let timer = null;
    const load = () => Promise.all([fGet('/summary?days=14'), fGet('/outliers')]).then(
      ([summary, out]) => { if (alive) setSt({ loading: false, summary, outliers: (out && out.outliers) || [], error: null }); },
      (e) => { if (alive) setSt((p) => ({ ...p, loading: false, error: e.message })); },
    );
    load();
    if (intervalMs > 0) timer = setInterval(load, intervalMs);
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [intervalMs]);

  return st;
}

export { fGet as freightGet };
