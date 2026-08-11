'use strict';
/**
 * HEALTHFARE — cliente do NGTeco Office (relógio de ponto NG-TC2). Bruno 07-22.
 *
 * O TC2 é cloud-only (BEST-W push pra AWS da NGTeco; nenhuma porta local aberta),
 * então lemos o backend do dashboard deles: office-api.ngteco.com (API crackeada e
 * documentada em "NGTeco Timesheet Integration — API & Railway Plan" no Obsidian).
 *
 * Sessão em 3 passos (OBRIGATÓRIO — token do passo 1 NÃO é company-scoped e as
 * rotas de attendance devolvem 200-vazio/500 com ele):
 *   1. POST /oauth2/api/v1.0/token  {username, password}            → access
 *   2. GET  /auth/api/v1.0/companies/get_default_company/           → company_id
 *   3. PUT  /auth/api/v1.0/companies/switch_company_v2/ {company_id}→ access FINAL
 * Token vale ~24h — cacheamos ~23h e renovamos sozinho.
 *
 * Env: NGTECO_USER / NGTECO_PASS (Railway). Sem env → configured()=false e o
 * worker vira no-op (REGRA #0: nunca derruba nada).
 */

const BASE = 'https://office-api.ngteco.com';
const TZ = 'America/New_York';
const TOKEN_TTL_MS = 23 * 3600 * 1000;

let _tok = null;      // { access, at }
let _login = null;    // promise em voo (evita corrida de logins paralelos)

function configured() {
  return !!(process.env.NGTECO_USER && process.env.NGTECO_PASS);
}

function hdr(access) {
  const h = {
    'content-type': 'application/json',
    accessor: 'Web',
    timezone: TZ,
    accept: 'application/json',
  };
  if (access) h.authorization = 'Bearer ' + access;
  return h;
}

async function _doLogin() {
  const r1 = await fetch(BASE + '/oauth2/api/v1.0/token', {
    method: 'POST', headers: hdr(),
    body: JSON.stringify({ username: process.env.NGTECO_USER, password: process.env.NGTECO_PASS, verify_code: '', verify: false }),
  });
  const j1 = await r1.json().catch(() => ({}));
  const step1 = j1 && j1.data && j1.data.access;
  if (!r1.ok || !step1) throw new Error('ngteco login falhou: HTTP ' + r1.status + ' ' + JSON.stringify(j1).slice(0, 160));

  const r2 = await fetch(BASE + '/auth/api/v1.0/companies/get_default_company/', { headers: hdr(step1) });
  const j2 = await r2.json().catch(() => ({}));
  const companyId = j2.company_id || (j2.data && j2.data.company_id);
  if (!companyId) throw new Error('ngteco get_default_company sem company_id: ' + JSON.stringify(j2).slice(0, 160));

  // chave TEM que ser company_id (companyId → 400)
  const r3 = await fetch(BASE + '/auth/api/v1.0/companies/switch_company_v2/', {
    method: 'PUT', headers: hdr(step1), body: JSON.stringify({ company_id: companyId }),
  });
  const j3 = await r3.json().catch(() => ({}));
  const access = j3 && j3.data && j3.data.access;
  if (!r3.ok || !access) throw new Error('ngteco switch_company falhou: HTTP ' + r3.status);
  return access;
}

async function session() {
  if (!configured()) throw new Error('ngteco não configurado (NGTECO_USER/NGTECO_PASS)');
  if (_tok && Date.now() - _tok.at < TOKEN_TTL_MS) return _tok.access;
  if (!_login) {
    _login = _doLogin().then((access) => { _tok = { access, at: Date.now() }; _login = null; return access; })
      .catch((e) => { _login = null; throw e; });
  }
  return _login;
}

async function _get(path) {
  const access = await session();
  const r = await fetch(BASE + path, { headers: hdr(access) });
  if (r.status === 401 || r.status === 403) { _tok = null; throw new Error('ngteco auth expirou (HTTP ' + r.status + ')'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('ngteco GET ' + path.split('?')[0] + ' HTTP ' + r.status);
  return j;
}

function nyToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** As rotas devolvem envelope paginado {data:{total,page,data:[...]}} — normaliza pra array. */
function rows(j) {
  const d = j && j.data;
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.data)) return d.data;
  return [];
}

/** Punches por funcionário no dia (o feed principal).
 *  Cada item: employee_code, employee_name, first_name, last_name, att_date,
 *  attendance_status[] = [{status, punch_time}, ...] em ordem. */
async function aggregationDay(date) {
  const d = date || nyToday();
  const j = await _get(`/att/api/v1.0/records/aggregation_list/?current=1&pageSize=100&date_range=${d}&date_range=${d}`);
  return rows(j);
}

/** Presente/ausente de todo o roster no dia (traz também quem não bateu). */
async function currentDay(date) {
  const d = date || nyToday();
  const j = await _get(`/att/api/v1.0/records/current_day_list/?current=1&pageSize=100&date_range=${d}&date_range=${d}`);
  return rows(j);
}

/** Dispositivos (TC2 online?). */
async function devices() {
  const j = await _get('/dms/api/v2.0/devices/?current=1&pageSize=16');
  return rows(j);
}

module.exports = { configured, session, aggregationDay, currentDay, devices, nyToday, TZ };
