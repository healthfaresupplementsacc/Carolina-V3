/* Cliente do hub de estoque — /api/v3/warehouse/*  (S15 Fase 1).
   Mesma lógica de PIN do from-api.js (header x-admin-pin, sessionStorage v3pin)
   e o mesmo envelope { data } / { error:{code,message} }.

   Reusa `getPin` do from-api.js pra não duplicar a fonte do PIN.
*/
import React from 'react';
import { getPin } from './from-api.js';

const BASE = '/api/v3/warehouse';

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
  if (r.status === 403) {
    const e = new Error('sem permissão pra essa ação');
    e.forbidden = true;
    throw e;
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error((j.error && j.error.message) || ('erro ' + r.status));
    err.code = j.error && j.error.code;
    throw err;
  }
  return j;
}

export const whGet = (path) => call('GET', path);
export const whPost = (path, body) => call('POST', path, body || {});

/** GET com loading/erro/data e poll opcional. `paused` congela o timer
 *  (usado enquanto um modal está aberto pra não trocar a linha embaixo do
 *  usuário). intervalMs=0 → busca 1x. */
export function useWarehouse(path, deps = [], intervalMs = 20000, paused = false) {
  const [st, setSt] = React.useState({ loading: true, data: null, error: null });
  const [bump, setBump] = React.useState(0);
  const refresh = React.useCallback(() => setBump((b) => b + 1), []);

  React.useEffect(() => {
    if (!path) { setSt({ loading: false, data: null, error: null }); return undefined; }
    let alive = true;
    let timer = null;
    const load = () => whGet(path).then(
      (j) => { if (alive) setSt({ loading: false, data: j.data, error: null }); },
      (e) => { if (alive) setSt((s) => ({ loading: false, data: s.data, error: e })); },
    );
    setSt((s) => ({ loading: !s.data, data: s.data, error: null }));
    load();
    if (intervalMs > 0 && !paused) timer = setInterval(load, intervalMs);
    return () => { alive = false; if (timer) clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, intervalMs, paused, bump, ...deps]);

  return { ...st, refresh };
}

// ── Endpoints do contrato (S15-BUILD-PLAN §API contract) ─────────
export const getOverview   = () => whGet('/overview');
export const getProduct    = (id) => whGet('/product/' + id);
export const getRequests   = (status) => whGet('/requests' + (status ? '?status=' + encodeURIComponent(status) : ''));
export const getLocations  = () => whGet('/locations');
export const getFamily     = (productId) => whGet('/family/' + productId);

export const postEntrada   = (id, body) => whPost('/product/' + id + '/entrada', body);
export const postPlace     = (id, body) => whPost('/product/' + id + '/place', body);
export const postMove      = (id, body) => whPost('/product/' + id + '/move', body);
export const postAdjust    = (id, body) => whPost('/product/' + id + '/adjust', body);
export const postSeparate  = (id, body) => whPost('/product/' + id + '/separate', body);
export const resolveIssue  = (issueId, body) => whPost('/issues/' + issueId + '/resolve', body);
export const proposeRequest = (body) => whPost('/requests', body);
export const approveRequest = (id, body) => whPost('/requests/' + id + '/approve', body || {});
export const rejectRequest  = (id, body) => whPost('/requests/' + id + '/reject', body || {});
export const addBin        = (body) => whPost('/locations/bin', body);
export const addBox        = (body) => whPost('/locations/box', body);
export const deactivateBin = (id) => whPost('/locations/bin/' + id + '/deactivate', {});
/** Cadastra várias prateleiras de uma vez (dia 1 do armazém). Máx 300 por
 *  chamada. Código que já existe é PULADO, nunca sobrescrito: o backend devolve
 *  { data:{ created:int, skipped:[bin_code] } } pra tela poder dizer quantas
 *  entraram e quantas já estavam lá. */
export const addBinsBulk = (bins) => whPost('/locations/bins/bulk', { bins });
export const attachSku     = (productId, body) => whPost('/family/' + productId + '/attach', body);
export const detachSku     = (skuId) => whPost('/family/detach', { sku_id: skuId });
export const mergeProduct  = (fromId, intoId) => whPost('/family/merge', { from_product_id: fromId, into_product_id: intoId });

// ── S15 Fase 3 (import Veeqo · pesos · etiquetas · drift) ─────────
/** Importa o total da Veeqo. Sem product_id = tudo (o backend limita a 500).
 *  Resposta: { data:{ imported:[{product_id,delta}], negative:[...], skipped:n } }
 *  Delta negativo NUNCA é aplicado sozinho: volta em `negative` pra revisão. */
export const importVeeqo   = (productId) => whPost('/import-veeqo', productId ? { product_id: productId } : {});

/** Pesos: unidade por produto, tara por prateleira/caixa e presets. */
export const getWeights    = () => whGet('/weights');
export const setProductWeight = (id, body) => whPost('/weights/product/' + id, body);
export const setTarePreset = (body) => whPost('/weights/tare', body);
export const setBinWeight  = (id, body) => whPost('/weights/bin/' + id, body);
export const setBoxWeight  = (id, body) => whPost('/weights/box/' + id, body);

/** Pesar pra contar: devolve qty + confiança sem gravar nada. */
export const computeCount  = (body) => whPost('/count/compute', body);

/** Dados das etiquetas escolhidas. bins/boxes = arrays de id. */
export const getLabels = (bins, boxes) => {
  const qs = [];
  if (bins && bins.length) qs.push('bins=' + bins.join(','));
  if (boxes && boxes.length) qs.push('boxes=' + boxes.join(','));
  return whGet('/labels' + (qs.length ? '?' + qs.join('&') : ''));
};
/** Carimba que a etiqueta da caixa foi impressa. */
export const markBoxLabelPrinted = (boxId) => whPost('/locations/box/' + boxId + '/label-printed', {});

/** Lista de produtos com diferença pra Veeqo (o mesmo que alimenta o alerta). */
export const getDrift      = () => whGet('/drift');
/** Copia o UPC da Veeqo pros SKUs mapeados. */
export const importUpc     = () => whPost('/skus/import-upc', {});
