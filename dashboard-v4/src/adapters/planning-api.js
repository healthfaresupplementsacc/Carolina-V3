/* Cliente da página PLANEJAMENTO — /api/v3/planning/* (Bruno 09-04).

   O funil da produção do EMS (7 colunas derivadas, só leitura) + o plano por
   dia (drag do quadro, lista ordenada) + anotações por data. Mesmo PIN dos
   outros adapters (header x-admin-pin via getPin), mesmo envelope
   { data } / { error:{code,message} }.

     getBoard()                → as 7 colunas do quadro
     getPlan(date)             → itens do dia, ordenados
     putPlan(date, items)      → regrava a lista ORDENADA inteira (drag)
     addPlanItem(item)         → 1 item no fim ({plan_date, custom_title|batch_number})
     deletePlanItem(id)        → remove
     getNotes(date)/putNotes   → anotações (autosave debounced na página)
     setBoxed(batch, flag)     → flag manual de Encaixotado no quadro
*/
import { getPin } from './from-api.js';

const BASE = '/api/v3/planning';

async function call(method, path, body) {
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
  if (!r.ok) {
    const err = new Error((j.error && j.error.message) || ('erro ' + r.status));
    err.code = j.error && j.error.code;
    err.status = r.status;
    throw err;
  }
  return j.data;
}

export const getBoard = () => call('GET', '/board');
export const getPlan = (date) => call('GET', '/plan?date=' + encodeURIComponent(date));
export const putPlan = (date, items) => call('PUT', '/plan?date=' + encodeURIComponent(date), { items });
export const addPlanItem = (item) => call('POST', '/plan/item', item);
export const deletePlanItem = (id) => call('DELETE', '/plan/item/' + id);
export const getNotes = (date) => call('GET', '/notes?date=' + encodeURIComponent(date));
export const putNotes = (date, body) => call('PUT', '/notes?date=' + encodeURIComponent(date), { body });
export const setBoxed = (batch_number, manual_boxed) => call('POST', '/board/boxed', { batch_number, manual_boxed });
