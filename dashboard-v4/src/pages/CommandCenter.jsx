/* Command Center — a tela "Hoje". E7-refine2:
   - Correio agora é uma NOTIFICAÇÃO attached na timeline a 1PM (deadline real),
     NÃO mais bloco dentro do P&P. Clicável/editável (preview).
   - Notif card: toggle, pending edits preservados, max 5 + scroll.
   - Person expand: gaps clicáveis pra preencher (preview).
   - Painel evento: ACIMA do cursor, ESC/click-outside/toggle, pending edits.
*/
import React from 'react';
import { Icon, Leaf } from '../components/Icons.jsx';
import { KPI, CapBar, FlowDot } from '../components/Primitives.jsx';
import { Timeline } from '../components/Timeline.jsx';
import { NotificationsCard } from '../components/NotificationsPanel.jsx';
import { V4_ALLOW_WRITES } from '../flags.js';
import nyTime from '../utils/ny-time.cjs';

const GAP_VISIBLE_MIN = 25;    // gaps >= isso aparecem no card; menores só editáveis via expand
const GAP_TRACKED_MIN = 5;     // gaps >= isso entram em allNotifs (mesmo invisíveis)

function CommandCenter({ state, setState, openPanel, ack, loading, error, hfdata, refresh, date, raw,
                          onMerge, onSplit, onCreateInGap, writes }) {
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
  const [gearOpen, setGearOpen] = React.useState(null);

  // E7-refine2 #4: lift notif state pra cá (compartilha com Correio na timeline)
  const [openNotifId, setOpenNotifId] = React.useState(null);
  const [notifDrafts, setNotifDrafts] = React.useState({});
  const onNotifClick = React.useCallback((id) => {
    setOpenNotifId((prev) => (prev === id ? null : id));
  }, []);
  const onNotifDraftChange = React.useCallback((id, d) => {
    setNotifDrafts((p) => ({ ...p, [id]: d }));
  }, []);
  const onNotifDraftClear = React.useCallback((id) => {
    setNotifDrafts((p) => { if (!(id in p)) return p; const c = { ...p }; delete c[id]; return c; });
  }, []);

  // ── Derivações reais ─────────────────────────────────────
  const liveProd = state.events
    .filter((ev) => HFD.activities && HFD.activities[ev.activity] && HFD.activities[ev.activity].flow === 'production' && ev.qty)
    .reduce((s, ev) => s + (Number(ev.qty) || 0), 0);
  const topLotes = goals.slice().sort((a, b) => (b.done || 0) - (a.done || 0)).slice(0, 3);
  const goalsActive = goals.filter((g) => !g.completed).length;
  const goalsHit = goals.filter((g) => g.completed).length;
  const coworkActive = state.events.filter((e) => e.cowork && e.cowork.length > 0 && e.ended_min == null).length;

  // Gap notifs — TODOS os gaps tracked (>=5min) entram em allNotifs pra Bruno
  // poder clicar/editar via PersonExpansion. O card visivelmente mostra só os
  // >=25min (filtrado client-side no NotificationsCard via `visibleThreshold`).
  const gapNotifs = React.useMemo(() => {
    const out = [];
    const byOp = {};
    for (const e of state.events) (byOp[e.op] = byOp[e.op] || []).push(e);
    for (const op of operators) {
      const evs = (byOp[op.id] || []).slice().sort((a, b) => a.started_min - b.started_min);
      for (let i = 0; i < evs.length - 1; i++) {
        const evEnd = evs[i].ended_min == null ? now : evs[i].ended_min;
        const gap = evs[i + 1].started_min - evEnd;
        if (gap >= GAP_TRACKED_MIN) {
          out.push({
            id: `gap-${op.id}-${i}`,
            _type: 'gap',
            severity: gap >= 60 ? 'warn' : (gap >= GAP_VISIBLE_MIN ? 'info' : 'info'),
            _dur_min: gap,
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

  // E7-refine2 #2: Correio = notif sintético attached à timeline no horário do deadline real.
  // O id é 'correio' fixo pra preservar pending entre re-renders. Pull do raw.deadlines
  // pra ter o id do row (pra futuramente PATCH /deadlines/:id no E5).
  const correioNotif = React.useMemo(() => {
    const dlList = (raw && raw.deadlines && raw.deadlines.deadlines) || [];
    const primary = dlList
      .filter((d) => d.active !== false && d.time_of_day)
      .sort((a, b) => String(a.time_of_day).localeCompare(String(b.time_of_day)))[0];
    if (!primary) return null;
    const [h, m] = String(primary.time_of_day).split(':').map(Number);
    const minutes = h * 60 + m;
    return {
      id: 'correio',
      _type: 'correio',
      severity: 'info',
      title: primary.label || 'Corte do correio',
      en: 'Mailing cut-off',
      detail: `Corte às ${fmtClock(minutes)} · ${minutes - Math.floor(now)}min até passar`,
      _deadline_id: primary.id,
      _deadline_hhmm: String(primary.time_of_day).slice(0, 5),
      _minutes: minutes,
      _label: primary.label || 'Corte do correio',
    };
  }, [raw, now, fmtClock]);

  const allNotifs = [...alerts, ...(correioNotif ? [correioNotif] : []), ...gapNotifs];

  // Gap click → abre a notif do gap (cria sintética se não tracked)
  const onGapClick = React.useCallback((opId, gapItem, coords) => {
    // tenta achar notif existente (same op + same start/end)
    const existing = allNotifs.find((n) =>
      n._type === 'gap' && n._op === opId && n._start === gapItem.start && n._end === gapItem.end);
    if (existing) {
      setOpenNotifId(existing.id);
    } else {
      // sintético — só pendurar o id e adicionar nos drafts pra NotifDetail
      // funcionar mesmo sem estar em allNotifs. Mas o NotifDetail busca em
      // allNotifs, então: pra simplicidade, ignora gaps abaixo do tracked
      // threshold (5min) — abaixo disso é "ruído".
      ack(`gap muito curto (${fmtDur(gapItem.dur)}) — sem notif pra editar`);
    }
  }, [allNotifs, ack, fmtDur]);

  const onCorreioClick = React.useCallback(() => {
    if (correioNotif) setOpenNotifId((p) => (p === 'correio' ? null : 'correio'));
  }, [correioNotif]);
  const warnCount = allNotifs.filter((a) => a.severity === 'warn').length;
  const badCount = allNotifs.filter((a) => a.severity === 'bad').length;
  const infoCount = allNotifs.filter((a) => a.severity === 'info').length;

  // ── Handlers — E5: API real ──────────────────────────────
  // Drag horizontal/resize → PATCH /events/:id (started_at e/ou ended_at).
  // Drag vertical (mudar lane) já foi BLOQUEADO no Timeline.
  const updateEvent = async (id, patch) => {
    // Feedback otimista local (UI move imediato, refresh confirma)
    setState((s) => ({ ...s, events: s.events.map((e) => e.id === id ? { ...e, ...patch } : e) }));
    if (!V4_ALLOW_WRITES || !writes) return;
    const changes = {};
    if (patch.started_min != null) changes.started_at = nyTime.minutesToNyIso(date, patch.started_min);
    if ('ended_min' in patch) changes.ended_at = patch.ended_min == null ? null : nyTime.minutesToNyIso(date, patch.ended_min);
    if (Object.keys(changes).length === 0) return;
    const res = await writes.patchEvent(id, changes, 'drag/resize via /dashboard-v4');
    if (!res.ok) {
      ack(`Erro ao salvar: ${res.error.message || res.error}`);
      if (refresh) refresh();   // reverte UI pro estado do servidor
      return;
    }
    if (refresh) refresh();
    ack(`Salvo ✓ — ev${id} horário ajustado`);
  };
  // Merge-on-drop: confirmação + chamada onMerge real
  const mergeRequest = (idA, idB) => {
    if (!onMerge) return;
    onMerge([idA, idB]);
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
                          onAdd={() => ack('Counts são geradas pela captura; não é possível adicionar manualmente')}
                          onEdit={async (it) => {
                            const cur = topLotes.find((g) => g.id === it.id);
                            const v = window.prompt(`Novo total de garrafas pra ${cur?._product_name || '?'}:`, String(cur?.done || 0));
                            if (v == null) return;
                            const n = Number(v);
                            if (!Number.isFinite(n) || n < 0) { ack('Valor inválido'); return; }
                            if (!V4_ALLOW_WRITES || !writes) { ack('preview · sem writes'); return; }
                            const res = await writes.patchCount(it.id, n);
                            if (!res.ok) { ack(`Erro: ${res.error.message || res.error}`); return; }
                            if (refresh) refresh();
                            ack(`Salvo ✓ — contagem ev${it.id} = ${n}`);
                          }}
                          onDelete={async (it) => {
                            if (!window.confirm(`Apagar contagem ${it.label}?`)) return;
                            if (!V4_ALLOW_WRITES || !writes) { ack('preview · sem writes'); return; }
                            const res = await writes.deleteCount(it.id, 'apagado via /dashboard-v4');
                            if (!res.ok) { ack(`Erro: ${res.error.message || res.error}`); return; }
                            if (refresh) refresh();
                            ack(`Apagado ✓ — contagem ${it.id}`);
                          }}/>
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
                          onAdd={async () => {
                            const product = window.prompt('Nome do produto (será resolvido pelo catálogo):');
                            if (!product) return;
                            const qty = Number(window.prompt('Meta (garrafas):', '500'));
                            if (!Number.isFinite(qty) || qty <= 0) { ack('Quantidade inválida'); return; }
                            if (!V4_ALLOW_WRITES || !writes) { ack('preview · sem writes'); return; }
                            const res = await writes.createGoal({ product_id: null, batch_number: null, expected_quantity: qty, unit: 'bottle' });
                            if (!res.ok) { ack(`Erro: ${res.error.message || res.error} — passa product_id direto via terminal se preciso`); return; }
                            if (refresh) refresh();
                            ack(`Meta criada ✓ — id ${res.data.id}`);
                          }}
                          onEdit={async (it) => {
                            const cur = goals.find((g) => g.id === it.id);
                            const v = window.prompt(`Nova meta pra ${cur?._product_name || '?'} (em garrafas):`, String(cur?.target || 500));
                            if (v == null) return;
                            const n = Number(v);
                            if (!Number.isFinite(n) || n <= 0) { ack('Valor inválido'); return; }
                            if (!V4_ALLOW_WRITES || !writes) { ack('preview · sem writes'); return; }
                            const res = await writes.patchGoal(it.id, { expected_quantity: n });
                            if (!res.ok) { ack(`Erro: ${res.error.message || res.error}`); return; }
                            if (refresh) refresh();
                            ack(`Salvo ✓ — meta ${it.id} = ${n}`);
                          }}
                          onDelete={async (it) => {
                            if (!window.confirm(`Apagar meta ${it.label}?`)) return;
                            if (!V4_ALLOW_WRITES || !writes) { ack('preview · sem writes'); return; }
                            const res = await writes.deleteGoal(it.id, 'apagado via /dashboard-v4');
                            if (!res.ok) { ack(`Erro: ${res.error.message || res.error}`); return; }
                            if (refresh) refresh();
                            ack(`Apagado ✓ — meta ${it.id}`);
                          }}/>
               </EditPopover>
             </>}/>

        {/* P&P — Correio movido pra timeline (E7-refine2 #2). Só ordens+seg/ordem aqui. */}
        <KPI label="P&P do dia" en="Pick & Pack"
             value={pp.total_minutes ? fmtDur(pp.total_minutes) : '—'}
             headRight={<Icon name="pp" size={14}/>}
             foot={
               <div style={{ display: 'flex', gap: 14, marginTop: 4 }}>
                 <div><div style={{ fontSize: 11, color: 'var(--text-3)' }}>ordens</div><b className="mono">{pp.orders || 0}</b></div>
                 <div><div style={{ fontSize: 11, color: 'var(--text-3)' }}>seg/ordem</div><b className="mono">{pp.seconds_per_order ? pp.seconds_per_order + 's' : '—'}</b></div>
                 {correioNotif && (
                   <div><div style={{ fontSize: 11, color: 'var(--text-3)' }}>corte</div>
                        <b className="mono" style={{ color: 'var(--hf-leaf-600)' }}>{fmtClock(correioNotif._minutes)}</b></div>
                 )}
               </div>
             }/>

        {/* ATENÇÃO — só contador (notif card está abaixo) */}
        <KPI label="Atenção" en="Attention"
             value={allNotifs.length}
             attn={badCount > 0}
             headRight={<Icon name="bell" size={14}/>}
             foot={<div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
               {badCount} crítico · {warnCount} warning · {infoCount} info
             </div>}/>
      </div>

      {/* ── Notificações (controlado pelo CommandCenter) ──────────────────── */}
      <NotificationsCard
        notifs={allNotifs}
        visibleThreshold={GAP_VISIBLE_MIN}
        openNotifId={openNotifId}
        onNotifClick={onNotifClick}
        pendingDrafts={notifDrafts}
        onDraftChange={onNotifDraftChange}
        onDraftClear={onNotifDraftClear}
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
        onCreateInGap={onCreateInGap}
        writes={writes}
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
            correio={correioNotif ? { minutes: correioNotif._minutes, label: correioNotif._label } : null}
            onCorreioClick={onCorreioClick}
            onGapClick={onGapClick}
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
        <Row label="Corte do correio"    value={correioNotif ? fmtClock(correioNotif._minutes) : '— sem deadline'}/>
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

// (E7-refine2) CorreioBlock removido — agora é notif attached na timeline.

window.CommandCenter = CommandCenter;

export { CommandCenter };
