/* HEALTHFARE V4 — primitivos compartilhados do painel admin.

   Estavam privados dentro de pages/AdminPanel.jsx. Foram movidos pra cá
   (VERBATIM, mesmo markup e mesmos estilos) quando a aba Operadores virou
   arquivo próprio: assim as abas portadas reusam EXATAMENTE os mesmos
   componentes do resto do painel, sem duplicar visual e sem import circular
   (AdminPanel importa OperatorsTab, que importaria AdminPanel de volta).

   Regra pra próximas levas de port: use estes — não redesenhe loading, erro,
   título de seção ou KPI na sua aba.
*/
import React from 'react';
import { Icon, Leaf } from './Icons.jsx';
import { adminGet, adminLogin, adminLogout, getAdminMe } from '../adapters/admin-api.js';

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

export const SecTitle = ({ children }) => (
  <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.08, fontWeight: 700, marginBottom: 8 }}>{children}</div>
);
export const Tr = ({ head, cols }) => (
  <tr style={head ? { textAlign: 'left', color: 'var(--text-3)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.05 } : {}}>
    {cols.map((c, i) => <th key={i} style={{ padding: '4px 6px', textAlign: i === 0 ? 'left' : 'right' }}>{c}</th>)}
  </tr>
);
export const Empty = ({ msg }) => <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 0', fontStyle: 'italic' }}>{msg}</div>;
export const Loading = () => <div className="card" style={{ padding: 30, textAlign: 'center', color: 'var(--text-3)' }}>Carregando do painel admin…</div>;
export const ErrBox = ({ error }) => (
  <div className="card" style={{ padding: 20, color: 'var(--bad)' }}>
    <b>Erro:</b> {error.message || String(error)}
    {error.unauthorized && <div style={{ marginTop: 6, fontSize: 12 }}>Faça login admin de novo.</div>}
  </div>
);
export const RefreshErr = ({ error }) => (
  <div style={{ fontSize: 11, color: 'var(--warn,#d97706)', marginTop: 8 }}>Refresh falhou: {error.message}. Mostrando última leitura.</div>
);

export function MiniKPI({ label, value, suffix }) {
  return (
    <div className="card kpi">
      <div className="label"><Leaf size={11} color="var(--hf-leaf-500)"/><span>{label}</span></div>
      <div className="value">{value}{suffix && <small>{suffix}</small>}</div>
    </div>
  );
}

// ── Login gate do admin ────────────────────────────────────
// Estava dentro de AdminPanel.jsx; virou wrapper pra que CADA página do menu
// Admin (Admin, Operadores, …) tenha o MESMO login sem duplicar o form.
// Uso: <AdminGate>{(me) => <SuaPagina/>}</AdminGate>
export function AdminGate({ title, children }) {
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
    if (!autoTried) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Entrando no painel admin…</div>;
    return <AdminLogin onLogin={setMe}/>;
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.08, fontWeight: 700 }}>
            {title || 'Painel Admin'} · sincronizado com o dashboard
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 2 }}>
            Logado como <b>{me.name}</b> · <span className="pill" style={{ background: me.role === 'owner' ? 'rgba(217,119,6,0.15)' : 'var(--surface-2)', color: me.role === 'owner' ? '#b45309' : 'var(--text-2)' }}>{me.role}</span>
          </div>
        </div>
        <button className="btn sm ghost" onClick={async () => { await adminLogout(); setMe(null); }}>
          <Icon name="x" size={13}/> Sair do admin
        </button>
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
    <div className="card" style={{ maxWidth: 380, margin: '40px auto', padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <Icon name="config" size={18}/>
        <h2 style={{ margin: 0, fontSize: 16 }}>Painel Admin</h2>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--text-3)', margin: '0 0 16px' }}>
        Login admin próprio (PIN por usuário · owner/manager). Separado do PIN do dashboard.
      </p>
      <form onSubmit={submit}>
        <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-3)', marginBottom: 4 }}>
          {mode === 'pin' ? 'PIN do admin' : 'Senha de emergência'}
        </label>
        <input className="input" type="password" inputMode={mode === 'pin' ? 'numeric' : 'text'}
               autoFocus value={val} onChange={(e) => setVal(e.target.value)}
               placeholder={mode === 'pin' ? '4–8 dígitos' : 'senha'} style={{ width: '100%' }}/>
        {err && <div style={{ color: 'var(--bad)', fontSize: 12, marginTop: 8 }}>{err}</div>}
        <button className="btn primary" type="submit" disabled={busy || !val} style={{ width: '100%', marginTop: 12 }}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
      <button className="btn sm ghost" style={{ marginTop: 10, width: '100%' }}
              onClick={() => { setMode((m) => m === 'pin' ? 'password' : 'pin'); setErr(null); setVal(''); }}>
        {mode === 'pin' ? 'Usar senha de emergência' : 'Usar PIN'}
      </button>
    </div>
  );
}
