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
// (As com escrita ficam aqui até a próxima leva; as read-only já são nativas.)
const LAUNCH_TABS = [
  { id: 'notifs',    label: 'Notificações', en: 'Inbox',      icon: 'bell',    desc: 'Eventos do Slack, anomalias, idle/stale' },
  { id: 'ops',       label: 'Operadores',   en: 'Operators',  icon: 'people',  desc: 'PINs, auto-logoff, escala, retroativos' },
  { id: 'batches',   label: 'Lotes',        en: 'Batches',    icon: 'product', desc: 'Lotes desconhecidos pra revisar' },
  { id: 'audit',     label: 'Audit',        en: 'Audit',      icon: 'config',  desc: 'Log de auditoria + export CSV' },
  { id: 'admins',    label: 'Admins',       en: 'Admins',     icon: 'config',  desc: 'Gestão de admins (owner)' },
];

const NATIVE_TABS = [
  { id: 'realtime',  label: 'Hoje',      en: 'Realtime' },
  { id: 'metrics',   label: 'Métricas',  en: 'Metrics' },
  { id: 'analytics', label: 'Analytics', en: 'Analytics' },
  { id: 'gaps',      label: 'Gaps',      en: 'Gaps' },
  { id: 'logs',      label: 'Ação Log',  en: 'Action log' },
  { id: 'ems',       label: 'EMS',       en: 'EMS' },
  { id: 'voices',    label: 'Voices',    en: 'Voice' },
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
      {tab === 'metrics'   && <MetricsTab/>}
      {tab === 'analytics' && <AnalyticsTab/>}
      {tab === 'gaps'      && <GapsTab/>}
      {tab === 'logs'      && <LogsTab/>}
      {tab === 'ems'       && <EmsTab/>}
      {tab === 'voices'    && <VoicesTab/>}

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
        <MiniKPI label="Ordens P&P hoje" value={(d.orders_today || 0).toLocaleString()} suffix="ordens"/>
        <MiniKPI label="Clínica hoje" value={(d.clinic_today || 0).toLocaleString()} suffix="envios (separado)"/>
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

// ── Aba MÉTRICAS — sub-views read-only (Linha / Anomalias / Rankings) ──
function MetricsTab() {
  const [sub, setSub] = React.useState('linha');
  const SUBS = [['linha', 'Linha de Produção'], ['anomalias', 'Anomalias'], ['rankings', 'Rankings']];
  return (
    <div>
      <div className="filters" style={{ marginBottom: 12 }}>
        {SUBS.map(([id, label]) => (
          <button key={id} className={`filter-chip ${sub === id ? 'on' : ''}`} onClick={() => setSub(id)}>{label}</button>
        ))}
      </div>
      {sub === 'linha'     && <MetricsLinha/>}
      {sub === 'anomalias' && <MetricsAnomalias/>}
      {sub === 'rankings'  && <MetricsRankings/>}
    </div>
  );
}

// Linha de Produção (hoje) — /api/adminpanel/metrics/production-line
function MetricsLinha() {
  const { data, loading, error } = useAdmin('/metrics/production-line', [], 60000);
  if (loading && !data) return <Loading/>;
  if (error && !data) return <ErrBox error={error}/>;
  const d = data || {};
  const tp = d.throughput || {};
  const goals = d.goals_in_progress || [];
  const byProd = (d.production_today && d.production_today.by_product) || [];
  const exc = d.exceptions || [];
  return (
    <div>
      <div className="kpi-grid">
        <MiniKPI label="Garrafas hoje" value={((d.production_today && d.production_today.total) || 0).toLocaleString()} suffix="garrafas"/>
        <MiniKPI label="Throughput médio" value={tp.avg_bpm != null ? tp.avg_bpm : '—'} suffix="g/min"/>
        <MiniKPI label="Pico" value={tp.peak_bpm != null ? tp.peak_bpm : '—'} suffix="g/min"/>
        <MiniKPI label="Linhas rodando" value={goals.length} suffix="agora"/>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <div className="card" style={{ padding: 14 }}>
          <SecTitle>Metas em curso (produção aberta agora)</SecTitle>
          {goals.length === 0 ? <Empty msg="Nenhuma linha aberta"/> : (
            <table className="drill-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead><Tr head cols={['Operador', 'Produto / lote', 'Há (min)']}/></thead>
              <tbody>
                {goals.map((g) => (
                  <tr key={g.id} style={{ borderTop: '1px dashed var(--border)' }}>
                    <td style={{ padding: '5px 6px 5px 0' }}><b>{g.operator}</b></td>
                    <td style={{ padding: '5px 6px' }}>{g.product || '—'} <span className="mono" style={{ color: 'var(--text-3)' }}>{g.batch_number || ''}</span></td>
                    <td className="mono" style={{ padding: '5px 0', textAlign: 'right' }}>{g.elapsed_min}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card" style={{ padding: 14 }}>
          <SecTitle>Garrafas por produto (hoje)</SecTitle>
          {byProd.length === 0 ? <Empty msg="Sem contagens hoje"/> : (
            <table className="drill-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <tbody>
                {byProd.map((p, i) => (
                  <tr key={i} style={{ borderTop: i ? '1px dashed var(--border)' : 'none' }}>
                    <td style={{ padding: '5px 6px 5px 0' }}>{p.product}</td>
                    <td className="mono" style={{ padding: '5px 0', textAlign: 'right', fontWeight: 700 }}>{p.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {(tp.by_operator || []).length > 0 && (
        <div className="card" style={{ padding: 14, marginTop: 12 }}>
          <SecTitle>Throughput por operador (g/min · hoje)</SecTitle>
          <table className="drill-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead><Tr head cols={['Operador', 'g/min médio', 'Runs']}/></thead>
            <tbody>
              {tp.by_operator.map((o, i) => (
                <tr key={i} style={{ borderTop: '1px dashed var(--border)' }}>
                  <td style={{ padding: '5px 6px 5px 0' }}><b>{o.operator}</b></td>
                  <td className="mono" style={{ padding: '5px 6px', textAlign: 'right', fontWeight: 700, color: 'var(--flow-prod)' }}>{o.avg_bpm != null ? o.avg_bpm : '—'}</td>
                  <td className="mono" style={{ padding: '5px 0', textAlign: 'right', color: 'var(--text-3)' }}>{o.runs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {exc.length > 0 && (
        <div className="card" style={{ padding: 14, marginTop: 12, borderLeft: '4px solid var(--warn,#d97706)' }}>
          <SecTitle>Exceções sem contagem (precisam resolução)</SecTitle>
          <table className="drill-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead><Tr head cols={['Operador', 'Produto / lote', 'Motivo', 'Fim']}/></thead>
            <tbody>
              {exc.map((x) => (
                <tr key={x.id} style={{ borderTop: '1px dashed var(--border)' }}>
                  <td style={{ padding: '5px 6px 5px 0' }}><b>{x.operator}</b></td>
                  <td style={{ padding: '5px 6px' }}>{x.product || '—'} <span className="mono" style={{ color: 'var(--text-3)' }}>{x.batch_number || ''}</span></td>
                  <td style={{ padding: '5px 6px', color: 'var(--text-3)' }}>{x.exception_reason || '—'}</td>
                  <td className="mono" style={{ padding: '5px 0', textAlign: 'right' }}>{x.ended_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 6, fontStyle: 'italic' }}>
            Resolver (informar a contagem) por enquanto no painel completo — porta de escrita vem na próxima leva.
          </div>
        </div>
      )}
      {error && <RefreshErr error={error}/>}
    </div>
  );
}

// Anomalias — /api/adminpanel/metrics/anomalies
function MetricsAnomalias() {
  const { data, loading, error } = useAdmin('/metrics/anomalies', [], 60000);
  if (loading && !data) return <Loading/>;
  if (error && !data) return <ErrBox error={error}/>;
  const d = data || {};
  const idle = d.idle_operators || [];
  const stale = d.stale_events || [];
  return (
    <div>
      <div className="kpi-grid">
        <MiniKPI label="Checkouts esquecidos" value={d.forgotten_pending || 0} suffix="pendentes"/>
        <MiniKPI label="Idle (+2h)" value={idle.length} suffix="operadores"/>
        <MiniKPI label="Tarefas travadas (+3h)" value={stale.length} suffix="abertas"/>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <div className="card" style={{ padding: 14 }}>
          <SecTitle>Operadores ociosos (+2h sem atividade)</SecTitle>
          {idle.length === 0 ? <Empty msg="Ninguém ocioso ✓"/> : idle.map((o, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderTop: i ? '1px dashed var(--border)' : 'none', fontSize: 12.5 }}>
              <b>{o.display_name}</b><span className="mono" style={{ color: 'var(--warn,#d97706)' }}>{o.idle_min} min</span>
            </div>
          ))}
        </div>
        <div className="card" style={{ padding: 14 }}>
          <SecTitle>Tarefas abertas há +3h</SecTitle>
          {stale.length === 0 ? <Empty msg="Tudo em dia ✓"/> : stale.map((s) => (
            <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderTop: '1px dashed var(--border)', fontSize: 12.5 }}>
              <b>{s.display_name}</b><span className="mono" style={{ color: 'var(--warn,#d97706)' }}>{s.hours_open}h</span>
            </div>
          ))}
        </div>
      </div>
      {error && <RefreshErr error={error}/>}
    </div>
  );
}

// Rankings — /api/adminpanel/metrics/rankings
function MetricsRankings() {
  const [period, setPeriod] = React.useState('month');
  const { data, loading, error } = useAdmin('/metrics/rankings?period=' + period, [period]);
  if (loading && !data) return <Loading/>;
  if (error && !data) return <ErrBox error={error}/>;
  const d = data || {};
  const board = (title, rows, key, unit) => (
    <div className="card" style={{ padding: 14 }}>
      <SecTitle>{title}</SecTitle>
      {(!rows || rows.length === 0) ? <Empty msg="Sem dados"/> : rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderTop: i ? '1px dashed var(--border)' : 'none', fontSize: 12.5 }}>
          <span><b style={{ color: 'var(--text-3)', marginRight: 6 }}>{i + 1}.</b>{r.person_name}</span>
          <span className="mono" style={{ fontWeight: 700 }}>{r[key]}<span style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 500, marginLeft: 3 }}>{unit}</span></span>
        </div>
      ))}
    </div>
  );
  return (
    <div>
      <div className="filters" style={{ marginBottom: 12 }}>
        <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 700, textTransform: 'uppercase', marginRight: 4 }}>Período:</span>
        {[['week', 'Semana'], ['month', 'Mês']].map(([p, l]) => (
          <button key={p} className={`filter-chip ${period === p ? 'on' : ''}`} onClick={() => setPeriod(p)}>{l}</button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        {board('Volume · eventos', d.volume_leaders, 'events', 'ev')}
        {board('Horas trabalhadas', d.hours_leaders, 'hours', 'h')}
        {board('Mais ajudou (cowork)', d.most_helpful_cowork, 'helped', 'x')}
      </div>
      {error && <RefreshErr error={error}/>}
    </div>
  );
}

// ── Aba GAPS — /api/adminpanel/gaps?day= ───────────────────
function GapsTab() {
  const [day, setDay] = React.useState('');
  const { data, loading, error } = useAdmin('/gaps' + (day ? '?day=' + day : ''), [day]);
  if (loading && !data) return <Loading/>;
  if (error && !data) return <ErrBox error={error}/>;
  const d = data || {};
  const gaps = d.gaps || [];
  const totalMin = (d.summary || []).reduce((a, s) => a + (s.total_min || 0), 0);
  return (
    <div>
      <div className="filters" style={{ marginBottom: 12 }}>
        <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 700, textTransform: 'uppercase', marginRight: 4 }}>Dia:</span>
        <input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ width: 150 }}/>
        {day && <button className="btn sm ghost" onClick={() => setDay('')}>Hoje</button>}
      </div>
      <div className="kpi-grid">
        <MiniKPI label="Gaps" value={gaps.length} suffix="(>20min)"/>
        <MiniKPI label="Tempo total parado" value={totalMin} suffix="min"/>
        <MiniKPI label="Pessoas com gap" value={(d.summary || []).length} suffix=""/>
      </div>
      <div className="card" style={{ marginTop: 12, padding: 14 }}>
        <SecTitle>Gaps justificados</SecTitle>
        {gaps.length === 0 ? <Empty msg="Sem gaps no dia ✓"/> : (
          <table className="drill-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead><Tr head cols={['Operador', 'Início', 'Min', 'Tipo', 'Nota']}/></thead>
            <tbody>
              {gaps.map((g) => (
                <tr key={g.id} style={{ borderTop: '1px dashed var(--border)' }}>
                  <td style={{ padding: '6px 6px 6px 0' }}><b>{g.display_name}</b></td>
                  <td className="mono" style={{ padding: '6px' }}>{g.started_edt}</td>
                  <td className="mono" style={{ padding: '6px', textAlign: 'right', color: 'var(--warn,#d97706)' }}>{g.gap_minutes}</td>
                  <td style={{ padding: '6px' }}>{g.justification_type || '—'}</td>
                  <td style={{ padding: '6px', color: 'var(--text-3)' }}>{g.justification_note || '—'}</td>
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

// ── Aba AÇÃO LOG — /api/adminpanel/action-log ──────────────
function LogsTab() {
  const [applied, setApplied] = React.useState({ day: '', q: '' });
  const [day, setDay] = React.useState('');
  const [q, setQ] = React.useState('');
  const qs = new URLSearchParams();
  if (applied.day) qs.set('day', applied.day);
  if (applied.q) qs.set('q', applied.q);
  const { data, loading, error } = useAdmin('/action-log' + (qs.toString() ? '?' + qs.toString() : ''), [applied.day, applied.q]);
  const entries = (data && data.entries) || [];
  return (
    <div>
      <form className="filters" style={{ marginBottom: 12 }} onSubmit={(e) => { e.preventDefault(); setApplied({ day, q }); }}>
        <input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ width: 150 }}/>
        <input className="input" placeholder="buscar (pessoa, texto, payload)…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 160 }}/>
        <button className="btn sm primary" type="submit">Buscar</button>
        {(applied.day || applied.q) && <button className="btn sm ghost" type="button" onClick={() => { setDay(''); setQ(''); setApplied({ day: '', q: '' }); }}>Limpar</button>}
      </form>
      {loading && !data ? <Loading/> : error && !data ? <ErrBox error={error}/> : (
        <div className="card" style={{ padding: 14 }}>
          <SecTitle>{entries.length} ação(ões) · últimos 5 dias</SecTitle>
          {entries.length === 0 ? <Empty msg="Nada encontrado"/> : (
            <table className="drill-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><Tr head cols={['Quando', 'Pessoa', 'Ação', 'Origem', 'Detalhe']}/></thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} style={{ borderTop: '1px dashed var(--border)' }}>
                    <td className="mono" style={{ padding: '5px 6px 5px 0', whiteSpace: 'nowrap', color: 'var(--text-3)' }}>{e.at_edt}</td>
                    <td style={{ padding: '5px 6px' }}>{e.person_name}{e.is_test ? <span style={{ color: 'var(--text-3)' }}> (teste)</span> : ''}</td>
                    <td style={{ padding: '5px 6px' }}><span className="pill" style={{ fontSize: 10.5 }}>{e.action_type}</span></td>
                    <td style={{ padding: '5px 6px', color: 'var(--text-3)' }}>{e.source || '—'}</td>
                    <td style={{ padding: '5px 6px', color: 'var(--text-2)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.raw_text || (e.payload ? JSON.stringify(e.payload) : '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {error && <RefreshErr error={error}/>}
        </div>
      )}
    </div>
  );
}

// ── Aba EMS — /api/adminpanel/ems-activity (auto 60s) ──────
function EmsTab() {
  const { data, loading, error } = useAdmin('/ems-activity', [], 60000);
  if (loading && !data) return <Loading/>;
  if (error && !data) return <ErrBox error={error}/>;
  const d = data || {};
  const active = d.active || [];
  return (
    <div>
      <div className="kpi-grid">
        <MiniKPI label="Processos ativos" value={active.length} suffix="agora"/>
        <MiniKPI label="Máquinas hoje" value={(d.by_machine || []).length} suffix=""/>
        <MiniKPI label="Operadores hoje" value={(d.by_employee || []).length} suffix=""/>
      </div>
      <div className="card" style={{ marginTop: 12, padding: 14 }}>
        <SecTitle>Ativo agora (espelho EMS)</SecTitle>
        {active.length === 0 ? <Empty msg="Nada rodando no EMS"/> : (
          <table className="drill-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead><Tr head cols={['Máquina', 'Estágio', 'Suplemento / lote', 'Operador', 'Há']}/></thead>
            <tbody>
              {active.map((a, i) => (
                <tr key={i} style={{ borderTop: '1px dashed var(--border)' }}>
                  <td style={{ padding: '6px 6px 6px 0' }}><b>{a.machine || '—'}</b> <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{a.machine_type || ''}</span></td>
                  <td style={{ padding: '6px' }}>{a.stage || a.process_type || '—'}</td>
                  <td style={{ padding: '6px' }}>{a.supplement_name || '—'} <span className="mono" style={{ color: 'var(--text-3)' }}>{a.batch_number || ''}</span></td>
                  <td style={{ padding: '6px' }}>{a.tracker_name || a.employee_ems_name || '—'}</td>
                  <td className="mono" style={{ padding: '6px', textAlign: 'right' }}>{fmtSec(a.elapsed_seconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <div className="card" style={{ padding: 14 }}>
          <SecTitle>Por máquina (hoje)</SecTitle>
          {(d.by_machine || []).length === 0 ? <Empty msg="—"/> : (d.by_machine || []).map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderTop: i ? '1px dashed var(--border)' : 'none', fontSize: 12.5 }}>
              <span>{m.machine} <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{m.machine_type || ''}</span></span>
              <span className="mono">{fmtSec(m.total_seconds)} <span style={{ color: 'var(--text-3)' }}>· {m.runs}×</span></span>
            </div>
          ))}
        </div>
        <div className="card" style={{ padding: 14 }}>
          <SecTitle>Por operador (hoje)</SecTitle>
          {(d.by_employee || []).length === 0 ? <Empty msg="—"/> : (d.by_employee || []).map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderTop: i ? '1px dashed var(--border)' : 'none', fontSize: 12.5 }}>
              <span>{m.name}</span><span className="mono">{fmtSec(m.total_seconds)} <span style={{ color: 'var(--text-3)' }}>· {m.runs}×</span></span>
            </div>
          ))}
        </div>
      </div>
      {error && <RefreshErr error={error}/>}
    </div>
  );
}

// ── Aba VOICES — /api/adminpanel/voice/recent ──────────────
function VoicesTab() {
  const { data, loading, error } = useAdmin('/voice/recent?limit=30', []);
  if (loading && !data) return <Loading/>;
  if (error && !data) return <ErrBox error={error}/>;
  const voice = (data && data.voice) || [];
  return (
    <div>
      <div className="card" style={{ padding: 14 }}>
        <SecTitle>Gravações de voz recentes</SecTitle>
        {voice.length === 0 ? <Empty msg="Sem gravações"/> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {voice.map((v) => (
              <div key={v.id} style={{ padding: 10, borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                  <b style={{ fontSize: 12.5 }}>{v.person}</b>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{v.created_edt} · {fmtSec(v.audio_duration_seconds)}</span>
                </div>
                {v.transcript && <div style={{ fontSize: 12, color: 'var(--text-2)', fontStyle: 'italic', marginBottom: 6 }}>"{v.transcript}"</div>}
                <audio controls preload="none" src={'/api/adminpanel/voice/' + v.id} style={{ width: '100%', height: 32 }}/>
              </div>
            ))}
          </div>
        )}
      </div>
      {error && <RefreshErr error={error}/>}
    </div>
  );
}

const fmtSec = (s) => {
  const n = Number(s) || 0;
  if (n < 60) return n + 's';
  const m = Math.floor(n / 60); const r = n % 60;
  if (m < 60) return m + 'm' + (r ? ' ' + r + 's' : '');
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
};

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
