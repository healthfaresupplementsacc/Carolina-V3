/* Command Center — a tela "Hoje". E7: redesign do template adaptado pra HF.
   - Operadores reais (admins filtrados via adapter)
   - SidePanel agora é flutuante (abre perto do clique, sem backdrop)
   - Background events viram mini-tabs na timeline
   - "Correio · 1PM" fica DENTRO do P&P (checkbox + horário)
   - Painel "Notificações" no lugar do antigo CountdownCard, derivado de:
       alerts do adapter + gaps grandes por pessoa (E7 #6)
   - Engrenagem em Produção, Metas, Notificações abre popover de
     edição em MODO PREVIEW — V4_ALLOW_WRITES=0 não persiste
   - Click no nome do operador na timeline expande detalhes inline

   Tudo leitura (com preview local pra edits). Liga writes no E5.
*/
import React from 'react';
import { Icon, Leaf } from '../components/Icons.jsx';
import { KPI, CapBar, FlowDot } from '../components/Primitives.jsx';
import { Timeline } from '../components/Timeline.jsx';
import { NotificationsCard } from '../components/NotificationsPanel.jsx';
import { V4_ALLOW_WRITES } from '../flags.js';

const GAP_NOTIFY_THRESHOLD_MIN = 25;  // gaps maiores que isso viram notificação
const CORREIO_KEY = 'hf-correio-active';
const CORREIO_TIME_KEY = 'hf-correio-time';

function CommandCenter({ state, setState, openPanel, ack, loading, error, hfdata, refresh, date }) {
  const now = window.HFH.useNow(true);
  const HFD = hfdata || window.HFData;
  const { operators = [], goals = [], alerts = [], pp = {}, _gaps = {} } = HFD;
  const { fmtClock, fmtDur } = window.HFH;

  // ── State local ──────────────────────────────────────────
  const [filterOps, setFilterOps] = React.useState(new Set());
  const [filterFlows, setFilterFlows] = React.useState(new Set());
  const [hourPx] = React.useState(140);
  const [expandedOpIds, setExpandedOpIds] = React.useState(new Set());
  const toggleExpand = (id) => setExpandedOpIds((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  // Engrenagens — qual popover está aberto
  const [gearOpen, setGearOpen] = React.useState(null);
  // Correio (E7 #3) — checkbox + horário, persistido em sessionStorage
  const [correioActive, setCorreioActive] = React.useState(() => {
    try { return sessionStorage.getItem(CORREIO_KEY) === '1'; } catch { return false; }
  });
  const [correioTime, setCorreioTime] = React.useState(() => {
    try { return sessionStorage.getItem(CORREIO_TIME_KEY) || '13:00'; } catch { return '13:00'; }
  });
  React.useEffect(() => { try { sessionStorage.setItem(CORREIO_KEY, correioActive ? '1' : '0'); } catch {} }, [correioActive]);
  React.useEffect(() => { try { sessionStorage.setItem(CORREIO_TIME_KEY, correioTime); } catch {} }, [correioTime]);

  // ── Derivações reais ─────────────────────────────────────
  // 1) Produção viva: soma qty de events de production com unit "bottle"
  const liveProd = state.events
    .filter((ev) => HFD.activities && HFD.activities[ev.activity] && HFD.activities[ev.activity].flow === 'production' && ev.qty)
    .reduce((s, ev) => s + (Number(ev.qty) || 0), 0);

  // 2) Top goals
  const topLotes = goals.slice().sort((a, b) => (b.done || 0) - (a.done || 0)).slice(0, 3);
  const goalsActive = goals.filter((g) => !g.completed).length;
  const goalsHit = goals.filter((g) => g.completed).length;

  // 3) Cowork chains ativos
  const coworkActive = state.events.filter((e) => e.cowork && e.cowork.length > 0 && e.ended_min == null).length;

  // 4) Gap notifications — por pessoa, calcula gaps entre eventos consecutivos.
  //    Threshold: GAP_NOTIFY_THRESHOLD_MIN minutos. (Distinto do limite de
  //    "unreported" do backend — esse é só pra notificar visualmente.)
  const gapNotifs = React.useMemo(() => {
    const out = [];
    const byOp = {};
    for (const e of state.events) (byOp[e.op] = byOp[e.op] || []).push(e);
    for (const op of operators) {
      const evs = (byOp[op.id] || []).slice().sort((a, b) => a.started_min - b.started_min);
      for (let i = 0; i < evs.length - 1; i++) {
        const evEnd = evs[i].ended_min == null ? now : evs[i].ended_min;
        const gap = evs[i + 1].started_min - evEnd;
        if (gap >= GAP_NOTIFY_THRESHOLD_MIN) {
          out.push({
            id: `gap-${op.id}-${i}`,
            _type: 'gap',
            severity: gap >= 60 ? 'warn' : 'info',
            title: `Gap em ${op.name}`,
            en: `Gap for ${op.name}`,
            detail: `${fmtClock(evEnd)} → ${fmtClock(evs[i + 1].started_min)} (${fmtDur(gap)})`,
            _op: op.id, _start: evEnd, _end: evs[i + 1].started_min,
          });
        }
      }
    }
    return out;
  }, [state.events, operators, now, fmtClock, fmtDur]);

  const allNotifs = [...alerts, ...gapNotifs];
  const warnCount = allNotifs.filter((a) => a.severity === 'warn').length;
  const badCount = allNotifs.filter((a) => a.severity === 'bad').length;
  const infoCount = allNotifs.filter((a) => a.severity === 'info').length;

  // ── Handlers preview ─────────────────────────────────────
  const updateEvent = (id, patch) => {
    setState((s) => ({ ...s, events: s.events.map((e) => e.id === id ? { ...e, ...patch } : e) }));
  };
  const mergeRequest = (idA, idB) => {
    const evA = state.events.find((e) => e.id === idA);
    const evB = state.events.find((e) => e.id === idB);
    if (!evA || !evB) return;
    if (!window.confirm(`Juntar ev${idA} com ev${idB}? (preview — não persiste)`)) return;
    const start = Math.min(evA.started_min, evB.started_min);
    const end = (evA.ended_min == null || evB.ended_min == null) ? null : Math.max(evA.ended_min, evB.ended_min);
    setState((s) => ({ ...s, events: s.events.filter((e) => e.id !== idB).map((e) => e.id === idA ? { ...e, started_min: start, ended_min: end } : e) }));
    ack(`merge preview ev${idA}+${idB}`);
  };

  // ── Loading / erro fatal ─────────────────────────────────
  if (loading) {
    return (
      <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
        <div style={{ fontSize: 14 }}>Carregando dado real do servidor…</div>
        <div style={{ fontSize: 11, marginTop: 6 }}>/api/v3/data/timeline · /production · /pp · /goals · /deadlines · /catalog</div>
      </div>
    );
  }
  if (error && state.events.length === 0) {
    return (
      <div className="card" style={{ padding: 30, color: 'var(--bad)' }}>
        <b>Erro carregando dado:</b> {error.message || String(error)}
        <div style={{ marginTop: 12 }}>
          <button className="btn sm" onClick={refresh}>Tentar de novo</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {error && state.events.length > 0 && (
        <div className="alert-row warn" style={{ marginBottom: 10 }}>
          <div className="ico"><Icon name="bell" size={14}/></div>
          <div><b>Refresh falhou:</b> {error.message || String(error)}. Mostrando última leitura.</div>
        </div>
      )}

      {/* ── KPI strip ──────────────────────────────────────── */}
      <div className="kpi-grid">

        {/* PRODUÇÃO HOJE — engrenagem */}
        <KPI label="Produção hoje" en="Production today"
             value={liveProd.toLocaleString()} suffix="garrafas"
             headRight={<div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
               <FlowDot flow="production"/>
               <GearButton onClick={() => setGearOpen(gearOpen === 'producao' ? null : 'producao')} active={gearOpen === 'producao'}/>
             </div>}
             foot={<>
               {topLotes.length ? (
                 <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                   {topLotes.map((g) => (
                     <span key={g.id} className="pill prod">
                       <span className="dot"/>{g._product_name || g.product || '(?)'} {g.done}
                     </span>
                   ))}
                 </div>
               ) : <div style={{ fontSize: 12, color: 'var(--text-3)' }}>sem contagens hoje</div>}
               <EditPopover open={gearOpen === 'producao'} onClose={() => setGearOpen(null)}
                            title="Editar produção · contagens">
                 <EditList items={topLotes.map((g) => ({
                              id: g.id,
                              label: `${g._product_name || '(?)'} · ${g.done} ${g.unit}`,
                            }))}
                          emptyMsg="Sem contagens registradas hoje"
                          onAdd={() => ack('preview · POST /counts liga no E5')}
                          onEdit={(it) => ack(`preview · PATCH /counts/${it.id} liga no E5`)}
                          onDelete={(it) => ack(`preview · DELETE /counts/${it.id} liga no E5`)}/>
               </EditPopover>
             </>}/>

        {/* METAS — engrenagem */}
        <KPI label="Metas em curso" en="Goals in progress"
             value={goalsActive} suffix={`/ ${goalsActive + goalsHit}`}
             headRight={<div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
               <Icon name="target" size={14}/>
               <GearButton onClick={() => setGearOpen(gearOpen === 'metas' ? null : 'metas')} active={gearOpen === 'metas'}/>
             </div>}
             foot={<>
               {goals.length ? (
                 <>
                   {goals.slice(0, 2).map((g) => (
                     <React.Fragment key={g.id}>
                       <CapBar pct={g.pct}
                               label={g._product_name || g.product || '(?)'}
                               sub={`${g.done}/${g.target}`}/>
                       <div style={{ height: 6 }}/>
                     </React.Fragment>
                   ))}
                 </>
               ) : <div style={{ fontSize: 12, color: 'var(--text-3)' }}>sem metas registradas</div>}
               <EditPopover open={gearOpen === 'metas'} onClose={() => setGearOpen(null)}
                            title="Editar metas do dia">
                 <EditList items={goals.map((g) => ({
                              id: g.id,
                              label: `${g._product_name || '(?)'} · ${g.target} ${g.unit} (feito ${g.done})`,
                            }))}
                          emptyMsg="Sem metas registradas"
                          onAdd={() => ack('preview · POST /goals liga no E5')}
                          onEdit={(it) => ack(`preview · PATCH /goals/${it.id} liga no E5`)}
                          onDelete={(it) => ack(`preview · DELETE /goals/${it.id} liga no E5`)}/>
               </EditPopover>
             </>}/>

        {/* P&P — com CORREIO embutido (E7 #3) */}
        <KPI label="P&P do dia" en="Pick & Pack"
             value={pp.total_minutes ? fmtDur(pp.total_minutes) : '—'}
             headRight={<Icon name="pp" size={14}/>}
             foot={<>
               <div style={{ display: 'flex', gap: 14, marginTop: 4 }}>
                 <div><div style={{ fontSize: 11, color: 'var(--text-3)' }}>ordens</div><b className="mono">{pp.orders || 0}</b></div>
                 <div><div style={{ fontSize: 11, color: 'var(--text-3)' }}>seg/ordem</div><b className="mono">{pp.seconds_per_order ? pp.seconds_per_order + 's' : '—'}</b></div>
               </div>
               <CorreioBlock active={correioActive} onToggleActive={setCorreioActive}
                             time={correioTime} onTime={setCorreioTime}/>
             </>}/>

        {/* ATENÇÃO — só contador (notif card está abaixo) */}
        <KPI label="Atenção" en="Attention"
             value={allNotifs.length}
             attn={badCount > 0}
             headRight={<Icon name="bell" size={14}/>}
             foot={<div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
               {badCount} crítico · {warnCount} warning · {infoCount} info
             </div>}/>
      </div>

      {/* ── Notificações ──────────────────────────────────── */}
      <NotificationsCard
        notifs={allNotifs}
        gearOpen={gearOpen === 'notifs'}
        onGear={() => setGearOpen(gearOpen === 'notifs' ? null : 'notifs')}
        onCloseGear={() => setGearOpen(null)}
        ack={ack}
        operators={operators}
        events={state.events}
        GearButton={GearButton}
        EditPopover={EditPopover}
        EditList={EditList}
        V4_ALLOW_WRITES={V4_ALLOW_WRITES}
      />

      {/* ── Filters ─────────────────────────────────────────── */}
      <div className="section-title">
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Filtros</h2><span className="en">· Filter view</span>
        <div className="rule"/>
      </div>
      <div className="filters">
        <span style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: 0.05, textTransform: 'uppercase', fontWeight: 700, marginRight: 4 }}>Fluxo:</span>
        {['production', 'pnp', 'support'].map((f) => {
          const on = filterFlows.has(f);
          return (
            <button key={f} className={`filter-chip flow-${f} ${on ? 'on' : ''}`}
                    onClick={() => setFilterFlows((s) => { const n = new Set(s); n.has(f) ? n.delete(f) : n.add(f); return n; })}>
              <span className="dot"/>{(HFD.FLOWS && HFD.FLOWS[f] && HFD.FLOWS[f].label) || f}
            </button>
          );
        })}
        <span style={{ width: 16 }}/>
        <span style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: 0.05, textTransform: 'uppercase', fontWeight: 700, marginRight: 4 }}>Pessoa:</span>
        {operators.map((o) => {
          const on = filterOps.has(o.id);
          return (
            <button key={o.id} className={`filter-chip ${on ? 'on' : ''}`}
                    onClick={() => setFilterOps((s) => { const n = new Set(s); n.has(o.id) ? n.delete(o.id) : n.add(o.id); return n; })}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: o.c1, display: 'inline-block' }}/>
              {o.short}
            </button>
          );
        })}
        {(filterOps.size > 0 || filterFlows.size > 0) && (
          <button className="btn sm ghost" onClick={() => { setFilterOps(new Set()); setFilterFlows(new Set()); }}>
            Limpar
          </button>
        )}
      </div>

      {/* ── Timeline ────────────────────────────────────────── */}
      <div style={{ marginTop: 12 }}>
        {operators.length === 0 ? (
          <div className="card" style={{ padding: 30, color: 'var(--text-3)', textAlign: 'center' }}>
            Sem operadores postando hoje · (admins filtrados, /timeline?date={date} sem eventos)
          </div>
        ) : (
          <Timeline
            operators={operators}
            events={state.events}
            now={now}
            hourPx={hourPx}
            filterOps={filterOps}
            filterFlows={filterFlows}
            onUpdateEvent={updateEvent}
            onMergeRequest={mergeRequest}
            onSelectEvent={(id, coords) => openPanel(state.events.find((e) => e.id === id), coords)}
            selectedId={state.selectedEventId}
            expandedOpIds={expandedOpIds}
            onToggleExpand={toggleExpand}
            gaps={_gaps}
          />
        )}
      </div>

      {/* ── Resumo do dia ───────────────────────────────────── */}
      <div className="section-title" style={{ marginTop: 24 }}>
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Resumo do dia</h2><span className="en">· Day summary</span>
        <div className="rule"/>
      </div>
      <div className="card" style={{ padding: 16, maxWidth: 540 }}>
        <Row label="Data"                value={date}/>
        <Row label="Operadores hoje"     value={`${operators.length} pessoa(s)`}/>
        <Row label="Eventos hoje"        value={`${state.events.length}`}/>
        <Row label="Em andamento (live)" value={`${state.events.filter((e) => e.ended_min == null).length}`}/>
        <Row label="Cowork ativos"       value={`${coworkActive}`}/>
        <Row label="Background ativos"   value={`${state.events.filter((e) => e._is_background && e.ended_min == null).length}`}/>
        <Row label="Tempo médio/ordem"   value={pp.seconds_per_order ? `${pp.seconds_per_order}s` : '—'}/>
        <Row label="Correio configurado" value={correioActive ? `${correioTime} (Carolina avisa)` : '— desligado'}/>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Subcomponentes inline
// ────────────────────────────────────────────────────────────

const Row = ({ label, value }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px dashed var(--border)', fontSize: 13 }}>
    <span style={{ color: 'var(--text-3)' }}>{label}</span>
    <b className="mono tabnum">{value}</b>
  </div>
);

function GearButton({ onClick, active }) {
  return (
    <button onClick={onClick}
            className="icon-btn"
            style={{
              width: 22, height: 22, fontSize: 14, padding: 0,
              background: active ? 'var(--surface-2)' : 'transparent',
              border: 'none', cursor: 'pointer', color: 'var(--text-3)',
            }}
            title="Editar (preview · liga no E5)">
      ⚙
    </button>
  );
}

function EditPopover({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div className="card" style={{
      position: 'absolute', top: 'calc(100% + 6px)', right: 8,
      minWidth: 320, maxWidth: 380, padding: 12, zIndex: 50,
      boxShadow: 'var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.18))',
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <b style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-3)' }}>{title}</b>
        <button className="icon-btn" onClick={onClose} style={{ padding: 4 }}><Icon name="x" size={11}/></button>
      </div>
      {children}
      <div style={{
        fontSize: 10.5, color: 'var(--text-3)', marginTop: 10, padding: '6px 8px',
        background: 'var(--surface-2)', borderRadius: 6, fontStyle: 'italic',
      }}>
        {V4_ALLOW_WRITES ? 'salvar persiste' : 'modo leitura · save liga no E5'}
      </div>
    </div>
  );
}

function EditList({ items, emptyMsg, onAdd, onEdit, onDelete }) {
  return (
    <div>
      {items.length === 0
        ? <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 0' }}>{emptyMsg}</div>
        : items.map((it) => (
          <div key={it.id} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0',
            borderBottom: '1px dashed var(--border)',
          }}>
            <span style={{ flex: 1, fontSize: 12 }}>{it.label}</span>
            <button className="icon-btn" onClick={() => onEdit(it)} title="Editar" style={{ padding: 4 }}>
              <Icon name="edit" size={12}/>
            </button>
            <button className="icon-btn" onClick={() => onDelete(it)} title="Apagar" style={{ padding: 4 }}>
              <Icon name="trash" size={12}/>
            </button>
          </div>
        ))}
      <button className="btn sm primary" onClick={onAdd} style={{ marginTop: 8, width: '100%' }}>
        + Adicionar
      </button>
    </div>
  );
}

function CorreioBlock({ active, onToggleActive, time, onTime }) {
  return (
    <div style={{
      marginTop: 12, paddingTop: 10, borderTop: '1px dashed var(--border)',
      display: 'flex', gap: 8, alignItems: 'center',
    }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
        <input type="checkbox" checked={active} onChange={(e) => onToggleActive(e.target.checked)}/>
        Correio
      </label>
      <input type="time" value={time} onChange={(e) => onTime(e.target.value)}
             disabled={!active}
             style={{
               border: '1px solid var(--border)', borderRadius: 6, padding: '3px 6px',
               fontFamily: 'monospace', fontSize: 12, background: 'var(--surface)',
               color: active ? 'var(--text)' : 'var(--text-3)',
             }}/>
      <span style={{ fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic', flex: 1 }}>
        {active
          ? <>Carolina avisa Simone <span title="envio real liga no Bloco 5">📝</span></>
          : '— desligado'}
      </span>
    </div>
  );
}

window.CommandCenter = CommandCenter;

export { CommandCenter };
