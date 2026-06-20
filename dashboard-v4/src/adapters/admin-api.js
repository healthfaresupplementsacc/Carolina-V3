/* HEALTHFARE V4 — cliente da API /api/adminpanel/* (painel admin).

   FASE 2 (unificação): o /admin vira uma SEÇÃO do dashboard, mas mantém a
   AUTH PRÓPRIA — login por PIN/senha de admin → cookie `hf_admin` (HttpOnly,
   setado pelo servidor). Mesma origem do dashboard, então o cookie vai junto
   automaticamente em cada fetch. RBAC (owner/manager) continua sendo
   ENFORÇADO no servidor — este cliente só guarda {id,name,role} pra UI.

   IMPORTANTE (segurança): isto é SEPARADO do PIN global do dashboard
   (?pin=/x-admin-pin, que segue valendo só pros cards/timeline em /api/v3/data).
   O PIN global NÃO dá acesso admin. Funções owner-only (admins, finance, audit
   export) seguem barradas no backend mesmo logado como manager.
*/

const BASE = '/api/adminpanel';
const ADMIN_ME_KEY = 'hf-admin-me';

/** {id,name,role} do admin logado (cache de UI), ou null. */
export function getAdminMe() {
  try { return JSON.parse(sessionStorage.getItem(ADMIN_ME_KEY) || 'null'); }
  catch { return null; }
}
function setAdminMe(me) {
  try {
    if (me) sessionStorage.setItem(ADMIN_ME_KEY, JSON.stringify(me));
    else sessionStorage.removeItem(ADMIN_ME_KEY);
  } catch { /* sessionStorage off */ }
}

// Mapinha de códigos de erro → PT (espelha o admin SPA legado).
const ERR_PT = {
  wrong_pin: 'PIN incorreto',
  wrong_password: 'Senha incorreta',
  rate_limited: 'Muitas tentativas — espera alguns minutos',
  no_pin: 'Informe o PIN',
  inactive: 'Admin inativo',
};

async function adminCall(method, path, body) {
  let r;
  try {
    r = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',   // mesma origem → manda o cookie hf_admin
      headers: body != null ? { 'content-type': 'application/json' } : {},
      body: body != null ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error('sem conexão com o painel admin');
  }
  if (r.status === 401) {
    setAdminMe(null);
    const e = new Error('sessão admin expirada ou ausente');
    e.unauthorized = true;
    throw e;
  }
  if (r.status === 403) {
    const e = new Error('sem permissão (requer owner)');
    e.forbidden = true;
    throw e;
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = typeof j.error === 'string' ? j.error : (j.error && j.error.message);
    throw new Error(ERR_PT[code] || code || ('erro ' + r.status));
  }
  return j;
}

export const adminGet    = (path)       => adminCall('GET',    path);
export const adminPost   = (path, body) => adminCall('POST',   path, body);
export const adminPut    = (path, body) => adminCall('PUT',    path, body);
export const adminDelete = (path, body) => adminCall('DELETE', path, body);

/** Login admin (PIN 4-8 dígitos OU senha de emergência). Seta cookie + cache. */
export async function adminLogin({ pin, password }) {
  const j = await adminCall('POST', '/auth/login', pin ? { pin } : { password });
  if (j.admin) setAdminMe(j.admin);
  return j;
}

export async function adminLogout() {
  try { await adminCall('POST', '/auth/logout'); } catch { /* já caiu */ }
  setAdminMe(null);
}
