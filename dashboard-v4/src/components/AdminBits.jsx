/* HEALTHFARE V4 — primitivos compartilhados do painel admin.

   Estavam privados dentro de pages/AdminPanel.jsx. Foram movidos pra cá
   quando a aba Operadores virou arquivo próprio: assim as abas portadas
   reusam EXATAMENTE os mesmos componentes do resto do painel, sem duplicar
   visual e sem import circular (AdminPanel importa OperatorsTab, que
   importaria AdminPanel de volta).

   S15 Fase 2 (grupo C): o markup foi trocado pras classes do STYLE-KIT
   (kit.css + pages/pages-admin.css). A API dos componentes é a MESMA — nenhum
   prop mudou, nenhuma chamada mudou. Quem importava continua importando igual.

   Regra pra próximas levas de port: use estes — não redesenhe loading, erro,
   título de seção ou KPI na sua aba.
*/
import React from 'react';
import { Icon } from './Icons.jsx';
import { adminGet, adminLogin, adminLogout, getAdminMe } from '../adapters/admin-api.js';
import '../pages/pages-admin.css';

// Hook de fetch admin (cookie auth). pollMs>0 = auto-refresh.
export function useAdmin(path, deps = [], pollMs = 0) {
  const [st, setSt] = React.useState({ loading: true, data: null, error: null });
  React.useEffect(() => {
    if (!path) { setSt({ loading: false, data: null, error: null }); return undefined; }
    let alive = true, timer = null;
    const load = () => adminGet(path).then(
      (j) => { if (alive) setSt({ loading: false, data: j, error: null }); },
      (e) => { if (alive) setSt((s) => ({ loading: false, data: s.data, error: e })); },
    );
    load();
    if (pollMs > 0) timer = setInterval(load, pollMs);
    return () => { alive = false; if (timer) clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return st;
}

/* Título de seção: micro-label DM Mono do kit + régua fina. */
export const SecTitle = ({ children }) => (
  <div className="adm-sec">
    <span className="kit-mlabel">{children}</span>
    <span className="rule"/>
  </div>
);

/* Cabeçalho de tabela do kit.
   `cols` aceita string (coluna de texto) ou { t, num:true } (coluna numérica,
   que ganha a fonte mono tabular e alinha à direita, como manda o kit). */
export const Tr = ({ head, cols }) => (
  <tr>
    {cols.map((c, i) => {
      const o = (c && typeof c === 'object') ? c : { t: c, num: false };
      return <th key={i} className={o.num ? 'num' : ''}>{o.t}</th>;
    })}
  </tr>
);

export const Empty = ({ msg }) => <div className="adm-empty">{msg}</div>;

export const Loading = () => <div className="adm-state">Carregando do painel admin…</div>;

export const ErrBox = ({ error }) => (
  <div className="adm-state bad">
    <b>Erro:</b> {error.message || String(error)}
    {error.unauthorized && <div style={{ marginTop: 6, fontSize: 12.5 }}>Faça login admin de novo.</div>}
  </div>
);

export const RefreshErr = ({ error }) => (
  <div style={{ marginTop: 10 }}>
    <span className="kit-chip warn">refresh falhou · mostrando última leitura</span>
    <span className="adm-note faint" style={{ marginLeft: 8 }}>{error.message}</span>
  </div>
);

export function MiniKPI({ label, value, suffix }) {
  return (
    <div className="adm-kpi">
      <div className="kit-mlabel">{label}</div>
      <div className="v">{value}{suffix ? <small>{suffix}</small> : null}</div>
    </div>
  );
}

// ── Login gate do admin ────────────────────────────────────
// Estava dentro de AdminPanel.jsx; virou wrapper pra que CADA página do menu
// Admin (Admin, Operadores, …) tenha o MESMO login sem duplicar o form.
// Uso: <AdminGate>{(me) => <SuaPagina/>}</AdminGate>
export function AdminGate({ title, eyebrow, h1, sub, children }) {
  const [me, setMe] = React.useState(() => getAdminMe());
  const [autoTried, setAutoTried] = React.useState(false);

  // Auto-login (Bruno 08-03): já logado no dashboard como ADMIN → reusa o MESMO
  // PIN (existe em app_logins e admin_users), sem pedir de novo.
  React.useEffect(() => {
    if (me || autoTried) return;
    setAutoTried(true);
    try {
      const login = JSON.parse(sessionStorage.getItem('v3login') || 'null');
      const pin = sessionStorage.getItem('v3pin') || '';
      if (login && login.role === 'admin' && pin) {
        adminLogin({ pin }).then((j) => setMe(j.admin)).catch(() => { /* cai no form manual */ });
      }
    } catch (_) { /* ignora → form manual */ }
  }, [me, autoTried]);

  if (!me) {
    if (!autoTried) return <div className="adm-state">Entrando no painel admin…</div>;
    return <AdminLogin onLogin={setMe}/>;
  }

  return (
    <div>
      <div className="adm-head">
        <div className="lead">
          <span className="kit-eyebrow">● HEALTHFARE · {(eyebrow || title || 'PAINEL ADMIN').toUpperCase()}</span>
          <h1 className="kit-h1">{h1 || <>Painel <em>admin</em></>}</h1>
          <p className="kit-sub">
            {sub || 'Tudo do /admin dentro do dashboard, mesma sessão e mesma auditoria.'}
          </p>
        </div>
        <div className="acts">
          <span className="adm-note">Logado como <b>{me.name}</b></span>
          <span className={'kit-chip ' + (me.role === 'owner' ? 'warn' : 'neutral')}>{me.role}</span>
          <button className="kit-btn sec sm" onClick={async () => { await adminLogout(); setMe(null); }}>
            <Icon name="x" size={13}/> Sair do admin
          </button>
        </div>
      </div>
      {typeof children === 'function' ? children(me) : children}
    </div>
  );
}

export function AdminLogin({ onLogin }) {
  const [mode, setMode] = React.useState('pin'); // 'pin' | 'password'
  const [val, setVal] = React.useState('');
  const [err, setErr] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const j = await adminLogin(mode === 'pin' ? { pin: val } : { password: val });
      onLogin(j.admin);
    } catch (ex) {
      setErr(ex.message || 'falha no login');
    } finally { setBusy(false); }
  };

  return (
    <div className="kit-card pad" style={{ maxWidth: 400, margin: '48px auto' }}>
      <span className="kit-eyebrow">● HEALTHFARE · ACESSO ADMIN</span>
      <h1 className="kit-h1" style={{ fontSize: 26 }}>Painel <em>admin</em></h1>
      <p className="kit-sub" style={{ margin: '4px 0 18px' }}>
        Login admin próprio (PIN por usuário, owner ou manager). Separado do PIN do dashboard.
      </p>
      <form onSubmit={submit} className="adm-field">
        <span className="kit-mlabel">{mode === 'pin' ? 'PIN do admin' : 'Senha de emergência'}</span>
        <input className="kit-input mono" type="password" inputMode={mode === 'pin' ? 'numeric' : 'text'}
               autoFocus value={val} onChange={(e) => setVal(e.target.value)}
               placeholder={mode === 'pin' ? '4 a 8 dígitos' : 'senha'}/>
        {err && <span className="kit-chip bad" style={{ alignSelf: 'flex-start' }}>{err}</span>}
        <button className="kit-btn primary" type="submit" disabled={busy || !val} style={{ width: '100%', marginTop: 6 }}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
      <button className="kit-btn sec sm" style={{ marginTop: 10, width: '100%' }}
              onClick={() => { setMode((m) => m === 'pin' ? 'password' : 'pin'); setErr(null); setVal(''); }}>
        {mode === 'pin' ? 'Usar senha de emergência' : 'Usar PIN'}
      </button>
    </div>
  );
}
