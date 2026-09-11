/* HEALTHFARE V4 — Operadores e kiosk (Bruno 09-11) — cliente de /api/v3/kiosk-admin/operators. */
import { getPin } from './from-api.js';

async function call(method, path, body) {
  let r;
  try { r = await fetch('/api/v3/kiosk-admin' + path, { method, headers: { 'x-admin-pin': getPin(), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { throw new Error('sem conexão com a API'); }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && j.error && j.error.message) || ('erro ' + r.status));
  return j.data;
}
export const getOperators = () => call('GET', '/operators');
export const setOperatorPin = (id, pin) => call('POST', '/operators/' + id + '/pin', { pin });
export const setKioskPrefs = (id, hidden_groups) => call('POST', '/operators/' + id + '/kiosk-prefs', { hidden_groups });
export const impersonate = (id) => call('POST', '/operators/' + id + '/impersonate');
export const KIOSK_GROUPS = [['linha', 'Linha de Produção'], ['formulacao', 'Formulação'], ['limpeza', 'Limpeza / Organização'], ['embalagem', 'Envio de Pacotes'], ['envio', 'Envio de Caixas'], ['outros', 'Outros']];
