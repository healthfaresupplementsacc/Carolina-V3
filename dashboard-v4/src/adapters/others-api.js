/* HEALTHFARE V4 — "Outros pra reclassificar" (Bruno 09-11) — cliente de /api/v3/kiosk/others. */
import { getPin } from './from-api.js';

async function call(method, path, body) {
  let r;
  try { r = await fetch('/api/v3/kiosk' + path, { method, headers: { 'x-admin-pin': getPin(), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { throw new Error('sem conexão com a API'); }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && j.error && j.error.message) || ('erro ' + r.status));
  return j.data;
}
export const getOthers = () => call('GET', '/others');
export const resolveOther = (id, activity_slug, note) => call('POST', '/others/' + id + '/resolve', { activity_slug: activity_slug || null, note: note || null });
/* TILE NOVO pela tela (Bruno 09-12): cria a atividade e (opcional) reclassifica um "Outros". */
export const createType = (payload) => call('POST', '/types', payload);
export const getCustomTypes = () => call('GET', '/types');
export const KIOSK_GROUP_OPTIONS = [['linha', 'Linha de Produção'], ['formulacao', 'Formulação'], ['limpeza', 'Limpeza / Organização'], ['embalagem', 'Envio de Pacotes'], ['envio', 'Envio de Caixas'], ['outros', 'Outros']];
export const FLOW_OPTIONS = [['production', 'Produção (garrafas)'], ['pnp', 'P&P (pedidos)'], ['support', 'Apoio / geral']];
