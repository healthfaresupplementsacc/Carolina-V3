/* Cliente das PREFERÊNCIAS POR CONTA — /api/v3/prefs/*  (Bruno 08-19).

   "Como eu salvo os widgets do jeito que eu quero?" — na CONTA. Este adapter é a
   metade cliente disso: chave/valor por login, genérico, pra qualquer coisa que
   a pessoa ajusta e espera reencontrar (layout da Hoje hoje; amanhã tema,
   colunas de tabela, filtros favoritos).

   Mesma lógica de PIN dos outros adapters (header x-admin-pin, sessionStorage
   v3pin via getPin) e o mesmo envelope { data } / { error:{code,message} }.

   O CÓDIGO 'no_account' É ESPERADO, NÃO É BUG. Quem entrou pelo PIN de
   emergência não tem conta no banco pra pendurar preferência; a tela mostra "Só
   neste navegador" e segue salvando em localStorage. Por isso o erro carrega
   `.code` e `.noAccount` em vez de virar um erro genérico.
*/
import { getPin } from './from-api.js';

const BASE = '/api/v3/prefs';

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
    err.noAccount = err.code === 'no_account';
    throw err;
  }
  return j;
}

/** Tudo de uma vez: { data:{ prefs:{key:value,...}, account:{id,name,role}|null } } */
export const getPrefs = () => call('GET', '');

/** Uma chave: { data:{ key, value|null, updated_at|null, account } } */
export const getPref = (key) => call('GET', '/' + encodeURIComponent(key));

/** Salva (upsert): { data:{ key, updated_at, account } }. 409 no_account se
 *  quem está logado entrou pelo PIN de emergência. */
export const putPref = (key, value) => call('PUT', '/' + encodeURIComponent(key), { value });

/** Apaga: { data:{ key, deleted:boolean } }. Apagar o que não existe é 200
 *  deleted:false — o estado final é o pedido. */
export const deletePref = (key) => call('DELETE', '/' + encodeURIComponent(key));

export default { getPrefs, getPref, putPref, deletePref };
