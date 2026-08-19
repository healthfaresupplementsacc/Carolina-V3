/* HEALTHFARE V4 — Painel Admin DENTRO do dashboard (FASE 2 — unificação).

   "Uma página só": o admin deixa de ser app separado (/admin SPA) e vira uma
   SEÇÃO do dashboard. Auth própria (login admin → cookie hf_admin, RBAC
   owner/manager preservado no servidor) — o PIN global do dashboard NÃO dá
   acesso aqui (segurança, decisão do Bruno: "PIN global + seção admin extra").

   FASE 2a: portadas nativas as abas que o Bruno citou ("as métricas agora no
   dashboard") — Hoje (realtime) + Analytics. As demais abas abrem o painel
   admin completo (transição honesta) e serão portadas nas próximas levas.

   S15 Fase 2 (grupo C): visual 100% STYLE-KIT (kit.css + pages-admin.css).
   Endpoints, polling, props e RBAC iguais — só o markup mudou.
*/
import React from 'react';
import { Icon } from '../components/Icons.jsx';
import { useAdmin, AdminGate, SecTitle, Tr, Empty, Loading, ErrBox, RefreshErr, MiniKPI } from '../components/AdminBits.jsx';
import './pages-admin.css';

// Abas ainda não portadas — abrem o painel admin completo (mesma origem).
// (As com escrita ficam aqui até a próxima leva; as read-only já são nativas.)
const LAUNCH_TABS = [
  { id: 'notifs',    label: 'Notificações', en: 'Inbox',      icon: 'bell',    desc: 'Eventos do Slack, anomalias, idle e stale' },
  { id: 'batches',   label: 'Lotes',        en: 'Batches',    icon: 'product', desc: 'Lotes desconhecidos pra revisar' },
  { id: 'audit',     label: 'Audit',        en: 'Audit',      icon: 'config',  desc: 'Log de auditoria e export CSV' },
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
  const [tab, setTab] = React.useState('realtime');

  return (
    <AdminGate eyebrow="PAINEL ADMIN"
               h1={<>Painel <em>admin</em></>}
               sub="Métricas do dia, produção, anomalias, gaps e o log de ações. Tudo dentro do dashboard, mesma sessão.">
      {/* sub-nav de abas */}
      <div className="adm-bar" data-tabs="admin">
        <div className="kit-seg">
          {NATIVE_TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>
        <span className="grow"/>
        <span className="adm-note faint">mais {LAUNCH_TABS.length} abas no painel completo, logo abaixo</span>
      </div>

      {tab === 'realtime'  && <RealtimeTab/>}
      {tab === 'metrics'   && <MetricsTab/>}
      {tab === 'analytics' && <AnalyticsTab/>}
      {tab === 'gaps'      && <GapsTab/>}
      {tab === 'logs'      && <LogsTab/>}
      {tab === 'ems'       && <EmsTab/>}
      {tab === 'voices'    && <VoicesTab/>}

      {/* Launcher das abas ainda não portadas (transição honesta) */}
      <div style={{ marginTop: 26 }}>
        <SecTitle>Mais ferramentas admin · abrem o painel completo</SecTitle>
        <div className="adm-grid tiles">
          {LAUNCH_TABS.map((t) => (
            <a key={t.id} href="/admin/" target="_blank" rel="noreferrer" className="adm-launch">
              <span className="ico"><Icon name={t.icon} size={16}/></span>
              <div style={{ minWidth: 0 }}>
                <div className="t">{t.label} <Icon name="link" size={11}/></div>
                <div className="adm-note faint" style={{ marginTop: 3 }}>{t.desc}</div>
              </div>
            </a>
          ))}
        </div>
        <div className="adm-note faint" style={{ marginTop: 10 }}>
          As abas acima ainda abrem o /admin original (mesma origem, mesma sessão). Estão sendo portadas pro dashboard em levas verificadas.
        </div>
      </div>
    </AdminGate>
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
      <div className="adm-kpis">
        <MiniKPI label="Garrafas hoje" value={(d.bottles_today || 0).toLocaleString('pt-BR')} suffix="garrafas"/>
        <MiniKPI label="Ordens P&P hoje" value={(d.orders_today || 0).toLocaleString('pt-BR')} suffix="ordens"/>
        <MiniKPI label="Clínica hoje" value={(d.clinic_today || 0).toLocaleString('pt-BR')} suffix="envios"/>
        <MiniKPI label="Horas hoje" value={d.hours_today != null ? d.hours_today : '—'} suffix="h sem pausa"/>
        <MiniKPI label="Operadores online" value={ops.length} suffix="logados"/>
      </div>
      <div className="kit-card pad">
        <SecTitle>Operadores logados agora</SecTitle>
        {ops.length === 0 ? <Empty msg="Ninguém logado"/> : (
          <table className="kit-table" data-table="realtime-ops">
            <thead><Tr head cols={['Operador', 'Tarefa atual', { t: 'Última atividade', num: true }, { t: 'Idle (min)', num: true }]}/></thead>
            <tbody>
              {ops.map((o) => (
                <tr key={o.person_id}>
                  <td><b>{o.display_name}</b></td>
                  <td>{o.current_task || <span style={{ color: 'var(--ink-faint)' }}>—</span>}</td>
                  <td className="num">{o.last_activity}</td>
                  <td className="num">
                    {o.idle_min >= 15 ? <span className="kit-chip warn">{o.idle_min}</span> : o.idle_min}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {openLong.length > 0 && (
        <div className="kit-card pad warn" style={{ marginTop: 12 }}>
          <SecTitle>Tarefas abertas há mais de 1h</SecTitle>
          <table className="kit-table">
            <thead><Tr head cols={['Operador', 'Tarefa', { t: 'Aberta há (h)', num: true }]}/></thead>
            <tbody>
              {openLong.map((t) => (
                <tr key={t.id}>
                  <td><b>{t.display_name}</b></td>
                  <td>{t.task || '—'}</td>
                  <td className="num"><span className="kit-chip warn">{t.hours_open}h</span></td>
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
      <div className="adm-bar">
        <span className="kit-mlabel">Período</span>
        <div className="kit-seg">
          {['7d', '30d', '90d'].map((r) => (
            <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
      </div>
      <div className="adm-kpis">
        <MiniKPI label="Eventos" value={(d.total_events_count || 0).toLocaleString('pt-BR')} suffix={'/ ' + range}/>
        <MiniKPI label="Garrafas" value={(d.total_bottles || 0).toLocaleString('pt-BR')} suffix="garrafas"/>
        <MiniKPI label="Voz" value={(d.voice_usage && d.voice_usage.count) || 0} suffix="gravações"/>
        <MiniKPI label="Operadores ativos" value={ops.length} suffix="no top"/>
      </div>
      <div className="adm-grid two">
        <div className="kit-card pad">
          <SecTitle>Top operadores · eventos e horas</SecTitle>
          {ops.length === 0 ? <Empty msg="Sem dados"/> : ops.map((o) => (
            <div key={o.id} style={{ marginBottom: 9 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                <b>{o.display_name}</b>
                <span style={{ font: '500 11.5px var(--font-mono)', color: 'var(--ink-faint)' }}>{o.events} ev · {o.hours}h</span>
              </div>
              <div className="adm-bar-track">
                <div className="adm-bar-fill" style={{ width: `${Math.round((o.events / maxOpEvents) * 100)}%` }}/>
              </div>
            </div>
          ))}
        </div>
        <div className="kit-card pad">
          <SecTitle>Top suplementos · eventos</SecTitle>
          {sups.length === 0 ? <Empty msg="Sem dados"/> : (
            <table className="kit-table">
              <tbody>
                {sups.map((s, i) => (
                  <tr key={i}><td>{s.product}</td><td className="num"><b>{s.events}</b></td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <div className="kit-card pad" style={{ marginTop: 12 }}>
        <SecTitle>Tempo médio por tipo de tarefa</SecTitle>
        {slugs.length === 0 ? <Empty msg="Sem dados"/> : (
          <table className="kit-table">
            <thead><Tr head cols={['Tarefa (slug)', { t: 'n', num: true }, { t: 'Média (min)', num: true }]}/></thead>
            <tbody>
              {slugs.map((s, i) => (
                <tr key={i}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{s.slug || '(?)'}</td>
                  <td className="num" style={{ color: 'var(--ink-faint)' }}>{s.n}</td>
                  <td className="num"><b>{s.avg_min != null ? s.avg_min : '—'}</b></td>
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
      <div className="adm-bar">
        <div className="kit-seg">
          {SUBS.map(([id, label]) => (
            <button key={id} className={sub === id ? 'on' : ''} onClick={() => setSub(id)}>{label}</button>
          ))}
        </div>
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
      <div className="adm-kpis">
        <MiniKPI label="Garrafas hoje" value={((d.production_today && d.production_today.total) || 0).toLocaleString('pt-BR')} suffix="garrafas"/>
        <MiniKPI label="Throughput médio" value={tp.avg_bpm != null ? tp.avg_bpm : '—'} suffix="g/min"/>
        <MiniKPI label="Pico" value={tp.peak_bpm != null ? tp.peak_bpm : '—'} suffix="g/min"/>
        <MiniKPI label="Linhas rodando" value={goals.length} suffix="agora"/>
      </div>
      <div className="adm-grid two">
        <div className="kit-card pad">
          <SecTitle>Metas em curso · produção aberta agora</SecTitle>
          {goals.length === 0 ? <Empty msg="Nenhuma linha aberta"/> : (
            <table className="kit-table">
              <thead><Tr head cols={['Operador', 'Produto / lote', { t: 'Há (min)', num: true }]}/></thead>
              <tbody>
                {goals.map((g) => (
                  <tr key={g.id}>
                    <td><b>{g.operator}</b></td>
                    <td>
                      {g.product || '—'}{g.batch_number ? <span className="kit-chip neutral" style={{ marginLeft: 6 }}>{g.batch_number}</span> : null}
                    </td>
                    <td className="num">{g.elapsed_min}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="kit-card pad">
          <SecTitle>Garrafas por produto · hoje</SecTitle>
          {byProd.length === 0 ? <Empty msg="Sem contagens hoje"/> : (
            <table className="kit-table">
              <tbody>
                {byProd.map((p, i) => (
                  <tr key={i}><td>{p.product}</td><td className="num"><b>{p.total}</b></td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {(tp.by_operator || []).length > 0 && (
        <div className="kit-card pad" style={{ marginTop: 12 }}>
          <SecTitle>Throughput por operador · g/min hoje</SecTitle>
          <table className="kit-table">
            <thead><Tr head cols={['Operador', { t: 'g/min médio', num: true }, { t: 'Runs', num: true }]}/></thead>
            <tbody>
              {tp.by_operator.map((o, i) => (
                <tr key={i}>
                  <td><b>{o.operator}</b></td>
                  <td className="num"><b style={{ color: 'var(--ok-deep)' }}>{o.avg_bpm != null ? o.avg_bpm : '—'}</b></td>
                  <td className="num" style={{ color: 'var(--ink-faint)' }}>{o.runs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {exc.length > 0 && (
        <div className="kit-card pad warn" style={{ marginTop: 12 }}>
          <SecTitle>Exceções sem contagem · precisam resolução</SecTitle>
          <table className="kit-table">
            <thead><Tr head cols={['Operador', 'Produto / lote', 'Motivo', { t: 'Fim', num: true }]}/></thead>
            <tbody>
              {exc.map((x) => (
                <tr key={x.id}>
                  <td><b>{x.operator}</b></td>
                  <td>
                    {x.product || '—'}{x.batch_number ? <span className="kit-chip neutral" style={{ marginLeft: 6 }}>{x.batch_number}</span> : null}
                  </td>
                  <td style={{ color: 'var(--ink-dim)' }}>{x.exception_reason || '—'}</td>
                  <td className="num">{x.ended_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="adm-note faint" style={{ marginTop: 8 }}>
            Resolver (informar a contagem) por enquanto no painel completo. A porta de escrita vem na próxima leva.
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
      <div className="adm-kpis">
        <MiniKPI label="Checkouts esquecidos" value={d.forgotten_pending || 0} suffix="pendentes"/>
        <MiniKPI label="Idle mais de 2h" value={idle.length} suffix="operadores"/>
        <MiniKPI label="Tarefas travadas +3h" value={stale.length} suffix="abertas"/>
      </div>
      <div className="adm-grid two">
        <div className="kit-card pad">
          <SecTitle>Operadores ociosos · mais de 2h sem atividade</SecTitle>
          {idle.length === 0 ? <div className="kit-chip ok">Ninguém ocioso</div> : idle.map((o, i) => (
            <div key={i} className="kit-dotted-row">
              <b style={{ flex: 1 }}>{o.display_name}</b>
              <span className="kit-chip warn">{o.idle_min} min</span>
            </div>
          ))}
        </div>
        <div className="kit-card pad">
          <SecTitle>Tarefas abertas há mais de 3h</SecTitle>
          {stale.length === 0 ? <div className="kit-chip ok">Tudo em dia</div> : stale.map((s) => (
            <div key={s.id} className="kit-dotted-row">
              <b style={{ flex: 1 }}>{s.display_name}</b>
              <span className="kit-chip warn">{s.hours_open}h</span>
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
    <div className="kit-card pad">
      <SecTitle>{title}</SecTitle>
      {(!rows || rows.length === 0) ? <Empty msg="Sem dados"/> : rows.map((r, i) => (
        <div key={i} className="kit-dotted-row">
          <span style={{ font: '500 11px var(--font-mono)', color: 'var(--ink-faint)', width: 18 }}>{i + 1}</span>
          <span style={{ flex: 1 }}>{r.person_name}</span>
          <span style={{ font: '500 13px var(--font-mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--primary-deep)' }}>
            {r[key]}<span style={{ fontSize: 10, color: 'var(--ink-faint)', marginLeft: 3 }}>{unit}</span>
          </span>
        </div>
      ))}
    </div>
  );
  return (
    <div>
      <div className="adm-bar">
        <span className="kit-mlabel">Período</span>
        <div className="kit-seg">
          {[['week', 'Semana'], ['month', 'Mês']].map(([p, l]) => (
            <button key={p} className={period === p ? 'on' : ''} onClick={() => setPeriod(p)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="adm-grid three">
        {board('Volume · eventos', d.volume_leaders, 'events', 'ev')}
        {board('Horas trabalhadas', d.hours_leaders, 'hours', 'h')}
        {board('Mais ajudou · cowork', d.most_helpful_cowork, 'helped', 'x')}
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
      <div className="adm-bar">
        <span className="kit-mlabel">Dia</span>
        <input className="kit-input" type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ width: 160 }}/>
        {day && <button className="kit-btn sec sm" onClick={() => setDay('')}>Hoje</button>}
      </div>
      <div className="adm-kpis">
        <MiniKPI label="Gaps" value={gaps.length} suffix="acima de 20min"/>
        <MiniKPI label="Tempo total parado" value={totalMin} suffix="min"/>
        <MiniKPI label="Pessoas com gap" value={(d.summary || []).length} suffix="pessoas"/>
      </div>
      <div className="kit-card pad">
        <SecTitle>Gaps justificados</SecTitle>
        {gaps.length === 0 ? <div className="kit-chip ok">Sem gaps no dia</div> : (
          <table className="kit-table">
            <thead><Tr head cols={['Operador', { t: 'Início', num: true }, { t: 'Min', num: true }, 'Tipo', 'Nota']}/></thead>
            <tbody>
              {gaps.map((g) => (
                <tr key={g.id}>
                  <td><b>{g.display_name}</b></td>
                  <td className="num">{g.started_edt}</td>
                  <td className="num"><span className="kit-chip warn">{g.gap_minutes}</span></td>
                  <td>{g.justification_type || '—'}</td>
                  <td style={{ color: 'var(--ink-dim)' }}>{g.justification_note || '—'}</td>
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
      <form className="adm-bar" onSubmit={(e) => { e.preventDefault(); setApplied({ day, q }); }}>
        <input className="kit-input" type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ width: 160 }}/>
        <input className="kit-input" placeholder="buscar por pessoa, texto ou payload" value={q} onChange={(e) => setQ(e.target.value)}
               style={{ flex: 1, minWidth: 180 }}/>
        <button className="kit-btn primary sm" type="submit">Buscar</button>
        {(applied.day || applied.q) && (
          <button className="kit-btn sec sm" type="button" onClick={() => { setDay(''); setQ(''); setApplied({ day: '', q: '' }); }}>Limpar</button>
        )}
      </form>
      {loading && !data ? <Loading/> : error && !data ? <ErrBox error={error}/> : (
        <div className="kit-card pad">
          <SecTitle>{entries.length} ação(ões) · últimos 5 dias</SecTitle>
          {entries.length === 0 ? <Empty msg="Nada encontrado"/> : (
            <table className="kit-table">
              <thead><Tr head cols={['Quando', 'Pessoa', 'Ação', 'Origem', 'Detalhe']}/></thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td style={{ font: '500 12px var(--font-mono)', whiteSpace: 'nowrap', color: 'var(--ink-faint)' }}>{e.at_edt}</td>
                    <td>{e.person_name}{e.is_test ? <span className="kit-chip neutral" style={{ marginLeft: 6 }}>teste</span> : null}</td>
                    <td><span className="kit-chip info">{e.action_type}</span></td>
                    <td style={{ color: 'var(--ink-dim)' }}>{e.source || '—'}</td>
                    <td style={{ color: 'var(--ink-dim)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
      <div className="adm-kpis">
        <MiniKPI label="Processos ativos" value={active.length} suffix="agora"/>
        <MiniKPI label="Máquinas hoje" value={(d.by_machine || []).length} suffix="máquinas"/>
        <MiniKPI label="Operadores hoje" value={(d.by_employee || []).length} suffix="pessoas"/>
      </div>
      <div className="kit-card pad">
        <SecTitle>Ativo agora · espelho EMS</SecTitle>
        {active.length === 0 ? <Empty msg="Nada rodando no EMS"/> : (
          <table className="kit-table">
            <thead><Tr head cols={['Máquina', 'Estágio', 'Suplemento / lote', 'Operador', { t: 'Há', num: true }]}/></thead>
            <tbody>
              {active.map((a, i) => (
                <tr key={i}>
                  <td><b>{a.machine || '—'}</b> <span className="adm-note faint">{a.machine_type || ''}</span></td>
                  <td>{a.stage || a.process_type || '—'}</td>
                  <td>
                    {a.supplement_name || '—'}{a.batch_number ? <span className="kit-chip neutral" style={{ marginLeft: 6 }}>{a.batch_number}</span> : null}
                  </td>
                  <td>{a.tracker_name || a.employee_ems_name || '—'}</td>
                  <td className="num">{fmtSec(a.elapsed_seconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="adm-grid two" style={{ marginTop: 12 }}>
        <div className="kit-card pad">
          <SecTitle>Por máquina · hoje</SecTitle>
          {(d.by_machine || []).length === 0 ? <Empty msg="Sem dados"/> : (d.by_machine || []).map((m, i) => (
            <div key={i} className="kit-dotted-row">
              <span style={{ flex: 1 }}>{m.machine} <span className="adm-note faint">{m.machine_type || ''}</span></span>
              <span style={{ font: '500 12.5px var(--font-mono)' }}>{fmtSec(m.total_seconds)}</span>
              <span className="kit-chip neutral">{m.runs}x</span>
            </div>
          ))}
        </div>
        <div className="kit-card pad">
          <SecTitle>Por operador · hoje</SecTitle>
          {(d.by_employee || []).length === 0 ? <Empty msg="Sem dados"/> : (d.by_employee || []).map((m, i) => (
            <div key={i} className="kit-dotted-row">
              <span style={{ flex: 1 }}>{m.name}</span>
              <span style={{ font: '500 12.5px var(--font-mono)' }}>{fmtSec(m.total_seconds)}</span>
              <span className="kit-chip neutral">{m.runs}x</span>
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
      <div className="kit-card pad">
        <SecTitle>Gravações de voz recentes</SecTitle>
        {voice.length === 0 ? <Empty msg="Sem gravações"/> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {voice.map((v) => (
              <div key={v.id} style={{ padding: '12px 14px', borderRadius: 'var(--r-md)', background: 'var(--kit-surface-2)', border: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                  <b style={{ fontSize: 13 }}>{v.person}</b>
                  <span style={{ font: '500 11.5px var(--font-mono)', color: 'var(--ink-faint)' }}>{v.created_edt} · {fmtSec(v.audio_duration_seconds)}</span>
                </div>
                {v.transcript && <div style={{ fontSize: 12.5, color: 'var(--ink-dim)', fontStyle: 'italic', marginBottom: 8 }}>"{v.transcript}"</div>}
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
// Moradia dos primitivos = components/AdminBits.jsx, pra que as abas portadas
// em arquivo próprio (ex. OperatorsTab) reusem os MESMOS sem import circular.

window.AdminPanel = AdminPanel;
export { AdminPanel };
