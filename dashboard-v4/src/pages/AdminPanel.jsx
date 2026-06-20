/* HEALTHFARE V4 — Painel Admin DENTRO do dashboard (FASE 2 — unificação).

   "Uma página só": o admin deixa de ser app separado (/admin SPA) e vira uma
   SEÇÃO do dashboard. Auth própria (login admin → cookie hf_admin, RBAC
   owner/manager preservado no servidor) — o PIN global do dashboard NÃO dá
   acesso aqui (segurança, decisão do Bruno: "PIN global + seção admin extra").

   FASE 2a: portadas nativas as abas que o Bruno citou ("as métricas agora no
   dashboard") — Hoje (realtime) + Analytics. As demais 10 abas abrem o painel
   admin completo (transição honesta) e serão portadas nas próximas levas.
*/
import React from 'react';
import { Icon, Leaf } from '../components/Icons.jsx';
import { adminGet, adminLogin, adminLogout, getAdminMe } from '../adapters/admin-api.js';

// ── Hook simples de fetch admin (cookie auth) ──────────────
function useAdmin(path, deps = [], pollMs = 0) {
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

// Abas ainda não portadas — abrem o painel admin completo (mesma origem).
const LAUNCH_TABS = [
  { id: 'notifs',    label: 'Notificações', en: 'Inbox',      icon: 'bell',    desc: 'Eventos do Slack, anomalias, idle/stale' },
  { id: 'ops',       label: 'Operadores',   en: 'Operators',  icon: 'people',  desc: 'PINs, auto-logoff, escala, retroativos' },
  { id: 'batches',   label: 'Lotes',        en: 'Batches',    icon: 'product', desc: 'Lotes desconhecidos pra revisar' },
  { id: 'gaps',      label: 'Gaps',         en: 'Gaps',       icon: 'clock',   desc: 'Gaps do dia (>20min) + justificativa' },
  { id: 'logs',      label: 'Ação Log',     en: 'Action log', icon: 'support', desc: 'Log de segurança (5 dias)' },
  { id: 'ems',       label: 'EMS',          en: 'EMS',        icon: 'factory', desc: 'Atividade EMS em tempo real' },
  { id: 'voices',    label: 'Voices',       en: 'Voice',      icon: 'chat',    desc: 'Gravações de voz dos operadores' },
  { id: 'audit',     label: 'Audit',        en: 'Audit',      icon: 'config',  desc: 'Log de auditoria + export CSV' },
  { id: 'admins',    label: 'Admins',       en: 'Admins',     icon: 'config',  desc: 'Gestão de admins (owner)' },
];

const NATIVE_TABS = [
  { id: 'realtime',  label: 'Hoje',      en: 'Realtime' },
  { id: 'analytics', label: 'Analytics', en: 'Analytics' },
];

function AdminPanel() {
  const [me, setMe] = React.useState(() => getAdminMe());
  const [tab, setTab] = React.useState('realtime');

  if (!me) return <AdminLogin onLogin={setMe}/>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.08, fontWeight: 700 }}>
            Painel Admin · sincronizado com o dashboard
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 2 }}>
            Logado como <b>{me.name}</b> · <span className="pill" style={{ background: me.role === 'owner' ? 'rgba(217,119,6,0.15)' : 'var(--surface-2)', color: me.role === 'owner' ? '#b45309' : 'var(--text-2)' }}>{me.role}</span>
          </div>
        </div>
        <button className="btn sm ghost" onClick={async () => { await adminLogout(); setMe(null); }}>
          <Icon name="x" size={13}/> Sair do admin
        </button>
      </div>

      {/* sub-nav de abas */}
      <div className="filters" style={{ marginBottom: 12 }}>
        {NATIVE_TABS.map((t) => (
          <button key={t.id} className={`filter-chip ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
            {t.label} <span style={{ opacity: 0.6, marginLeft: 4 }}>· {t.en}</span>
          </button>
        ))}
        <span style={{ flex: 1 }}/>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>+ {LAUNCH_TABS.length} abas no painel completo ↓</span>
      </div>

      {tab === 'realtime'  && <RealtimeTab/>}
      {tab === 'analytics' && <AnalyticsTab/>}

      {/* Launcher das abas ainda não portadas (transição honesta) */}
      <div className="section-title" style={{ marginTop: 24 }}>
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Mais ferramentas admin</h2><span className="en">· being ported · abrem o painel completo</span>
        <div className="rule"/>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
        {LAUNCH_TABS.map((t) => (
          <a key={t.id} href="/admin/" target="_blank" rel="noreferrer" className="card"
             style={{ padding: 12, textDecoration: 'none', color: 'inherit', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span className="nav-ico" style={{ marginTop: 2 }}><Icon name={t.icon} size={16}/></span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{t.label} <Icon name="link" size={11}/></div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{t.desc}</div>
            </div>
          </a>
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 8, fontStyle: 'italic' }}>
        As abas acima ainda abrem o /admin original (mesma origem, mesma sessão). Estão sendo portadas pro dashboard em levas verificadas.
      </div>
    </div>
  );
}

// ── Login gate ─────────────────────────────────────────────
function AdminLogin({ onLogin }) {
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

// ── Aba HOJE (realtime) — /api/adminpanel/metrics/realtime ──
function RealtimeTab() {
  const { data, loading, error } = useAdmin('/metrics/realtime', [], 20000);
  if (loading && !data) return <Loading/>;
  if (error && !data) return <ErrBox error={error}/>;
  const d = data || {};
  const ops = d.logged_in_operators || [];
  const openLong = d.tasks_open_long || [];
  return (
    <div>
      <div className="kpi-grid">
        <MiniKPI label="Garrafas hoje" value={(d.bottles_today || 0).toLocaleString()} suffix="garrafas"/>
        <MiniKPI label="Ordens hoje" value={(d.orders_today || 0).toLocaleString()} suffix="ordens"/>
        <MiniKPI label="Horas hoje" value={d.hours_today != null ? d.hours_today : '—'} suffix="h (s/ pausa)"/>
        <MiniKPI label="Operadores online" value={ops.length} suffix="logados"/>
      </div>
      <div className="card" style={{ marginTop: 12, padding: 14 }}>
        <SecTitle>Operadores logados agora</SecTitle>
        {ops.length === 0 ? <Empty msg="Ninguém logado"/> : (
          <table className="drill-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead><Tr head cols={['Operador', 'Tarefa atual', 'Última atividade', 'Idle (min)']}/></thead>
            <tbody>
              {ops.map((o) => (
                <tr key={o.person_id} style={{ borderTop: '1px dashed var(--border)' }}>
                  <td style={{ padding: '6px 6px 6px 0' }}><b>{o.display_name}</b></td>
                  <td style={{ padding: '6px' }}>{o.current_task || <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                  <td className="mono" style={{ padding: '6px' }}>{o.last_activity}</td>
                  <td className="mono" style={{ padding: '6px', textAlign: 'right', color: o.idle_min >= 15 ? 'var(--warn,#d97706)' : 'inherit' }}>{o.idle_min}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {openLong.length > 0 && (
        <div className="card" style={{ marginTop: 12, padding: 14 }}>
          <SecTitle>Tarefas abertas há +1h</SecTitle>
          <table className="drill-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead><Tr head cols={['Operador', 'Tarefa', 'Aberta há (h)']}/></thead>
            <tbody>
              {openLong.map((t) => (
                <tr key={t.id} style={{ borderTop: '1px dashed var(--border)' }}>
                  <td style={{ padding: '6px 6px 6px 0' }}><b>{t.display_name}</b></td>
                  <td style={{ padding: '6px' }}>{t.task || '—'}</td>
                  <td className="mono" style={{ padding: '6px', textAlign: 'right', color: 'var(--warn,#d97706)' }}>{t.hours_open}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <RefreshErr error={error}/>}
    </div>
  );
}

// ── Aba ANALYTICS — /api/adminpanel/analytics/summary ──────
function AnalyticsTab() {
  const [range, setRange] = React.useState('30d');
  const { data, loading, error } = useAdmin('/analytics/summary?range=' + range, [range]);
  if (loading && !data) return <Loading/>;
  if (error && !data) return <ErrBox error={error}/>;
  const d = data || {};
  const ops = d.top_operators || [];
  const sups = d.top_supplements || [];
  const slugs = d.avg_task_duration_minutes_by_slug || [];
  const maxOpEvents = Math.max(1, ...ops.map((o) => o.events || 0));
  return (
    <div>
      <div className="filters" style={{ marginBottom: 12 }}>
        <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 700, textTransform: 'uppercase', marginRight: 4 }}>Período:</span>
        {['7d', '30d', '90d'].map((r) => (
          <button key={r} className={`filter-chip ${range === r ? 'on' : ''}`} onClick={() => setRange(r)}>{r}</button>
        ))}
      </div>
      <div className="kpi-grid">
        <MiniKPI label="Eventos" value={(d.total_events_count || 0).toLocaleString()} suffix={`/ ${range}`}/>
        <MiniKPI label="Garrafas" value={(d.total_bottles || 0).toLocaleString()} suffix="garrafas"/>
        <MiniKPI label="Voz" value={(d.voice_usage && d.voice_usage.count) || 0} suffix="gravações"/>
        <MiniKPI label="Operadores ativos" value={ops.length} suffix="no top"/>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <div className="card" style={{ padding: 14 }}>
          <SecTitle>Top operadores · eventos & horas</SecTitle>
          {ops.length === 0 ? <Empty msg="Sem dados"/> : ops.map((o) => (
            <div key={o.id} style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 3 }}>
                <b>{o.display_name}</b>
                <span className="mono" style={{ color: 'var(--text-3)' }}>{o.events} ev · {o.hours}h</span>
              </div>
              <div className="cap" style={{ width: '100%' }}>
                <div className="cap-fill" style={{ width: `${Math.round((o.events / maxOpEvents) * 100)}%` }}/>
              </div>
            </div>
          ))}
        </div>
        <div className="card" style={{ padding: 14 }}>
          <SecTitle>Top suplementos · eventos</SecTitle>
          {sups.length === 0 ? <Empty msg="Sem dados"/> : (
            <table className="drill-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <tbody>
                {sups.map((s, i) => (
                  <tr key={i} style={{ borderTop: i ? '1px dashed var(--border)' : 'none' }}>
                    <td style={{ padding: '5px 6px 5px 0' }}>{s.product}</td>
                    <td className="mono" style={{ padding: '5px 0', textAlign: 'right', fontWeight: 700 }}>{s.events}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <div className="card" style={{ padding: 14, marginTop: 12 }}>
        <SecTitle>Tempo médio por tipo de tarefa</SecTitle>
        {slugs.length === 0 ? <Empty msg="Sem dados"/> : (
          <table className="drill-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead><Tr head cols={['Tarefa (slug)', 'n', 'Média (min)']}/></thead>
            <tbody>
              {slugs.map((s, i) => (
                <tr key={i} style={{ borderTop: '1px dashed var(--border)' }}>
                  <td style={{ padding: '5px 6px 5px 0' }} className="mono">{s.slug || '(?)'}</td>
                  <td className="mono" style={{ padding: '5px 6px', textAlign: 'right', color: 'var(--text-3)' }}>{s.n}</td>
                  <td className="mono" style={{ padding: '5px 0', textAlign: 'right', fontWeight: 700 }}>{s.avg_min != null ? s.avg_min : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {error && <RefreshErr error={error}/>}
    </div>
  );
}

// ── pequenos helpers de UI ─────────────────────────────────
const SecTitle = ({ children }) => (
  <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.08, fontWeight: 700, marginBottom: 8 }}>{children}</div>
);
const Tr = ({ head, cols }) => (
  <tr style={head ? { textAlign: 'left', color: 'var(--text-3)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.05 } : {}}>
    {cols.map((c, i) => <th key={i} style={{ padding: '4px 6px', textAlign: i === 0 ? 'left' : 'right' }}>{c}</th>)}
  </tr>
);
const Empty = ({ msg }) => <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 0', fontStyle: 'italic' }}>{msg}</div>;
const Loading = () => <div className="card" style={{ padding: 30, textAlign: 'center', color: 'var(--text-3)' }}>Carregando do painel admin…</div>;
const ErrBox = ({ error }) => (
  <div className="card" style={{ padding: 20, color: 'var(--bad)' }}>
    <b>Erro:</b> {error.message || String(error)}
    {error.unauthorized && <div style={{ marginTop: 6, fontSize: 12 }}>Faça login admin de novo.</div>}
  </div>
);
const RefreshErr = ({ error }) => (
  <div style={{ fontSize: 11, color: 'var(--warn,#d97706)', marginTop: 8 }}>Refresh falhou: {error.message}. Mostrando última leitura.</div>
);

function MiniKPI({ label, value, suffix }) {
  return (
    <div className="card kpi">
      <div className="label"><Leaf size={11} color="var(--hf-leaf-500)"/><span>{label}</span></div>
      <div className="value">{value}{suffix && <small>{suffix}</small>}</div>
    </div>
  );
}

window.AdminPanel = AdminPanel;
export { AdminPanel };
