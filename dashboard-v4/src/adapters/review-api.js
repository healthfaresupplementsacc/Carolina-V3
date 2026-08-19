/* Cliente da REVISÃO POR DIA — /api/v3/review/*  (Bruno 08-19).

   O pedido do Bruno: "quando eu clico em Revisão eu quero um mini calendário
   pra escolher o dia; segunda o Bruno e a Simone revisaram Charcoal, quero ver
   quantas garrafas deram conta, quanto tempo levaram, e se aquele Charcoal já
   rodou na linha". Mais a barra lateral com TUDO que saiu da encapsuladora e
   ainda está esperando revisão.

   Três leituras, todas GET, todas sob o mesmo PIN dos outros adapters
   (header x-admin-pin via getPin, envelope { data } / { error:{code,message} }):

     day(date)   → as revisões daquele dia, com quem, quanto, quanto tempo e
                   se o lote já rodou na linha (o ✓ do Bruno).
     calendar(m) → quantas revisões por dia no mês, pra pintar o mini calendário.
     waiting()   → o que a encapsuladora já entregou e a linha ainda não puxou.

   PORQUE O ERRO CARREGA `.code`: waiting() depende do EMS, que é um sistema de
   fora. Quando ele cai a resposta ainda vem 200 com ems_ok:false e o último
   estado conhecido do cache — a tela avisa em vez de ficar vazia. Só falha de
   rede/PIN vira exceção aqui.
*/
import React from 'react';
import { getPin } from './from-api.js';

const BASE = '/api/v3/review';

async function call(method, path) {
  let r;
  try {
    r = await fetch(BASE + path, { method, headers: { 'x-admin-pin': getPin() } });
  } catch (e) {
    throw new Error('sem conexão com a API');
  }
  if (r.status === 401) {
    const e = new Error('PIN inválido ou ausente');
    e.unauthorized = true;
    throw e;
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error((j.error && j.error.message) || ('erro ' + r.status));
    err.code = j.error && j.error.code;
    err.status = r.status;
    throw err;
  }
  return j;
}

/** GET /api/v3/review/day?date=YYYY-MM-DD
 *  { data:{ date, revisions:[…], totals:{…}, by_person:[…], by_product:[…] } } */
export const getReviewDay = (date) => call('GET', '/day?date=' + encodeURIComponent(date));

/** GET /api/v3/review/calendar?month=YYYY-MM
 *  { data:{ month, days:[{date, revisions, bottles}] } } — datas em NY. */
export const getReviewCalendar = (month) => call('GET', '/calendar?month=' + encodeURIComponent(month));

/** GET /api/v3/review/waiting
 *  { data:{ generated_at, ems_ok, items:[…], counts:{…} } } */
export const getReviewWaiting = () => call('GET', '/waiting');

/* ── Hook genérico de leitura ──────────────────────────────────────
   Um só pra os três, porque o comportamento é o mesmo: busca quando a chave
   muda, ignora resposta de chave velha (o clique rápido no calendário troca de
   dia antes da anterior voltar) e devolve {loading, data, error, refresh}.

   `key` null desliga a busca — é assim que o painel não pede nada enquanto o
   popover está fechado. */
export function useReviewFetch(fetcher, key) {
  const [st, setSt] = React.useState({ loading: !!key, data: null, error: null });
  const [bump, setBump] = React.useState(0);
  const refresh = React.useCallback(() => setBump((b) => b + 1), []);
  const fnRef = React.useRef(fetcher);
  fnRef.current = fetcher;

  React.useEffect(() => {
    if (!key) { setSt({ loading: false, data: null, error: null }); return undefined; }
    let alive = true;
    setSt((s) => ({ loading: true, data: s.data, error: null }));
    fnRef.current(key).then(
      (j) => { if (alive) setSt({ loading: false, data: j.data, error: null }); },
      (e) => { if (alive) setSt({ loading: false, data: null, error: e }); },
    );
    return () => { alive = false; };
  }, [key, bump]);

  return { ...st, refresh };
}

export default { getReviewDay, getReviewCalendar, getReviewWaiting, useReviewFetch };
