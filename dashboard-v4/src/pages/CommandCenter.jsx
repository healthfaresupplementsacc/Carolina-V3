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
import { FloatingPopover } from '../components/FloatingPopover.jsx';
import { V4_ALLOW_WRITES } from '../flags.js';
import nyTime from '../utils/ny-time.cjs';

const NOTIFS_VISIBLE_KEY = 'hf-notifs-visible';

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
  // gear = { which: 'producao'|'metas'|'pp'|'notifs'|'attention', anchor: {x,y} } | null
  const [gear, setGear] = React.useState(null);
  const gearOpen = gear ? gear.which : null;
  // Helper pra gear buttons: passa o evento do click pra capturar coords.
  const onGearToggle = (which) => (e) => {
    if (gear && gear.which === which) { setGear(null); return; }
    setGear({ which, anchor: { x: e.clientX, y: e.clientY } });
  };
  const closeGear = () => setGear(null);

  // E6 Leva A #3 — toggle do card de notificações (bell icon).
  const [notifsVisible, setNotifsVisible] = React.useState(() => {
    try { return sessionStorage.getItem(NOTIFS_VISIBLE_KEY) !== '0'; }
    catch { return true; }
  });
  React.useEffect(() => {
    try { sessionStorage.setItem(NOTIFS_VISIBLE_KEY, notifsVisible ? '1' : '0'); } catch {}
  }, [notifsVisible]);

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

  // E6 #6: gap click abre form flutuante pra preencher (não só notif lookup)
  const [gapFill, setGapFill] = React.useState(null);  // { opId, gap, coords, form }
  const openGapFill = (opId, gap, coords) => {
    setGapFill({ opId, gap, coords, form: { reasonCat: 'outro', note: '' } });
  };
  const closeGapFill = () => setGapFill(null);
  const saveGapFill = async () => {
    if (!gapFill) return;
    if (!V4_ALLOW_WRITES || !onCreateInGap) { ack('preview · V4_ALLOW_WRITES=0'); closeGapFill(); return; }
    await onCreateInGap(gapFill.opId, gapFill.gap, gapFill.form);
    closeGapFill();
  };

  // E6 #6: gap click → abre form flutuante pra registrar evento naquele intervalo.
  const onGapClick = React.useCallback((opId, gapItem, coords) => {
    openGapFill(opId, gapItem, coords);
  }, []);

  const onCorreioClick = React.useCallback(() => {
    if (correioNotif) setOpenNotifId((p) => (p === 'correio' ? null : 'correio'));
  }, [correioNotif]);
  const warnCount = allNotifs.filter((a) => a.severity === 'warn').length;
  const badCount = allNotifs.filter((a) => a.severity === 'bad').length;
  const infoCount = allNotifs.filter((a) => a.severity === 'info').length;

  // ── Handlers — E5/E6 #7: drag com CONFIRMAÇÃO DUPLA ──────
  // Drag horizontal/resize NÃO bate mais no banco direto. Acumula em
  // pendingDrags + UI otimista, e só PATCH /events após Bruno confirmar duas
  // vezes via banner no topo da timeline. Cancelar → refresh reverte UI.
  // Drag vertical (mudar lane) já foi BLOQUEADO no Timeline.
  const [pendingDrags, setPendingDrags] = React.useState([]);
  // pendingDrags: [{ id, started_min, ended_min, origStart, origEnd }]

  const updateEvent = (id, patch) => {
    // 1) captura original ANTES da otimista, pra saber o "from" do diff
    const cur = state.events.find((e) => e.id === id);
    const origStart = cur ? cur.started_min : null;
    const origEnd   = cur ? cur.ended_min   : null;
    // 2) atualização otimista local pra UI mostrar onde caiu
    setState((s) => ({ ...s, events: s.events.map((e) => e.id === id ? { ...e, ...patch } : e) }));
    // 3) sem writes ligados → preview puro, não enfileira
    if (!V4_ALLOW_WRITES || !writes) return;
    // 4) enfileira no lote pendente; se já existia, mantém o origStart/origEnd
    setPendingDrags((prev) => {
      const exists = prev.find((p) => p.id === id);
      if (exists) {
        return prev.map((p) => p.id === id ? { ...p, ...patch } : p);
      }
      return [...prev, {
        id,
        origStart, origEnd,
        started_min: patch.started_min != null ? patch.started_min : origStart,
        ended_min:   ('ended_min' in patch) ? patch.ended_min : origEnd,
      }];
    });
  };

  const confirmDrags = async () => {
    if (pendingDrags.length === 0) return;
    const n = pendingDrags.length;
    if (!window.confirm(`Tem certeza que quer aplicar ${n} mudança(s) na linha do tempo? Sim/Não`)) return;
    if (!window.confirm(`Confirme — isso vai mudar a linha do tempo de verdade. Sim/Não`)) return;
    let okCount = 0, errCount = 0;
    for (const pd of pendingDrags) {
      const changes = {
        started_at: nyTime.minutesToNyIso(date, pd.started_min),
        ended_at:   pd.ended_min == null ? null : nyTime.minutesToNyIso(date, pd.ended_min),
      };
      const res = await writes.patchEvent(pd.id, changes, 'drag/resize batch via /dashboard-v4');
      if (res.ok) okCount++;
      else { errCount++; ack(`ev${pd.id} erro: ${res.error.message || res.error}`); }
    }
    setPendingDrags([]);
    if (refresh) refresh();
    ack(`Aplicado ✓ — ${okCount} mudança(s)${errCount > 0 ? ` · ${errCount} falha(s)` : ''}`);
  };

  const cancelDrags = () => {
    if (pendingDrags.length === 0) return;
    if (!window.confirm(`Descartar ${pendingDrags.length} mudança(s) pendente(s)? A linha do tempo volta ao estado original.`)) return;
    setPendingDrags([]);
    if (refresh) refresh();   // servidor reverte UI
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
               <GearButton onClick={onGearToggle('producao')} active={gearOpen === 'producao'}/>
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
               <EditPopover open={gearOpen === 'producao'} anchor={gear?.anchor} onClose={closeGear}
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
               <GearButton onClick={onGearToggle('metas')} active={gearOpen === 'metas'}/>
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
               <EditPopover open={gearOpen === 'metas'} anchor={gear?.anchor} onClose={closeGear}
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

        {/* P&P — engrenagem (E6 #2: edita correio) */}
        <KPI label="P&P do dia" en="Pick & Pack"
             value={pp.total_minutes ? fmtDur(pp.total_minutes) : '—'}
             headRight={<div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
               <Icon name="pp" size={14}/>
               <GearButton onClick={onGearToggle('pp')} active={gearOpen === 'pp'}/>
             </div>}
             foot={<>
               <div style={{ display: 'flex', gap: 14, marginTop: 4 }}>
                 <div><div style={{ fontSize: 11, color: 'var(--text-3)' }}>ordens</div><b className="mono">{pp.orders || 0}</b></div>
                 <div><div style={{ fontSize: 11, color: 'var(--text-3)' }}>seg/ordem</div><b className="mono">{pp.seconds_per_order ? pp.seconds_per_order + 's' : '—'}</b></div>
                 {correioNotif && (
                   <div><div style={{ fontSize: 11, color: 'var(--text-3)' }}>corte</div>
                        <b className="mono" style={{ color: 'var(--hf-leaf-600)' }}>{fmtClock(correioNotif._minutes)}</b></div>
                 )}
               </div>
               <EditPopover open={gearOpen === 'pp'} anchor={gear?.anchor} onClose={closeGear}
                            title="Editar P&P · correio">
                 {correioNotif ? (
                   <div>
                     <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8 }}>
                       Corte do correio atual: <b>{fmtClock(correioNotif._minutes)}</b> · deadline #{correioNotif._deadline_id}
                     </div>
                     <button className="btn sm primary" style={{ width: '100%' }}
                             onClick={async () => {
                               const t = window.prompt('Novo horário do corte (HH:MM 24h NY):', correioNotif._deadline_hhmm || '13:00');
                               if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return;
                               if (!V4_ALLOW_WRITES || !writes) { ack('preview · sem writes'); return; }
                               const res = await writes.patchDeadline(correioNotif._deadline_id, { time_of_day: t + ':00' });
                               if (!res.ok) { ack(`Erro: ${res.error.message || res.error}`); return; }
                               if (refresh) refresh();
                               ack(`Correio atualizado ✓ ${t}`);
                               closeGear();
                             }}>
                       Editar horário do corte
                     </button>
                   </div>
                 ) : (
                   <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                     Sem deadline ativa configurada. Vai em Config pra criar um deadline novo.
                   </div>
                 )}
               </EditPopover>
             </>}/>

        {/* ATENÇÃO — engrenagem + bell toggle (E6 #3) */}
        <KPI label="Atenção" en="Attention"
             value={allNotifs.length}
             attn={badCount > 0}
             headRight={<div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
               <button
                 onClick={() => setNotifsVisible((v) => !v)}
                 className="icon-btn"
                 title={notifsVisible ? 'Esconder barra de notificações' : 'Mostrar barra de notificações'}
                 style={{
                   width: 22, height: 22, padding: 0,
                   background: notifsVisible ? 'transparent' : 'var(--surface-2)',
                   border: 'none', cursor: 'pointer',
                   color: notifsVisible ? 'var(--hf-leaf-600)' : 'var(--text-3)',
                 }}>
                 <Icon name="bell" size={14}/>
               </button>
               <GearButton onClick={onGearToggle('attention')} active={gearOpen === 'attention'}/>
             </div>}
             foot={<>
               <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                 {badCount} crítico · {warnCount} warning · {infoCount} info
                 {!notifsVisible && <span style={{ marginLeft: 8, color: 'var(--text-3)', fontStyle: 'italic' }}>(barra oculta)</span>}
               </div>
               <EditPopover open={gearOpen === 'attention'} anchor={gear?.anchor} onClose={closeGear}
                            title="Configurar atenção">
                 <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                   <p style={{ margin: '0 0 8px' }}>
                     Bell toggle (cima): <b>{notifsVisible ? 'ON — barra visível' : 'OFF — barra oculta'}</b>
                   </p>
                   <p style={{ margin: '0 0 8px' }}>
                     Thresholds (gap min, downtime, etc) ficam editáveis aqui no futuro — por ora hardcoded:
                   </p>
                   <ul style={{ fontSize: 11, color: 'var(--text-3)', margin: '0 0 0 16px', padding: 0 }}>
                     <li>Gap notificável: ≥ 25 min</li>
                     <li>Não-reportado: ≥ 60 min</li>
                     <li>Downtime: qualquer repair</li>
                   </ul>
                 </div>
               </EditPopover>
             </>}/>
      </div>

      {/* ── Notificações (E6 #3: oculta quando bell toggle OFF) ───────────── */}
      {notifsVisible && (
        <NotificationsCard
          notifs={allNotifs}
          visibleThreshold={GAP_VISIBLE_MIN}
          openNotifId={openNotifId}
          onNotifClick={onNotifClick}
          pendingDrafts={notifDrafts}
          onDraftChange={onNotifDraftChange}
          onDraftClear={onNotifDraftClear}
          gearOpen={gearOpen === 'notifs'}
          gearAnchor={gear?.anchor}
          onGear={onGearToggle('notifs')}
          onCloseGear={closeGear}
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
      )}

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

      {/* E6 #5 — TOTAIS calculados pelos filtros ativos */}
      {(filterFlows.size > 0 || filterOps.size > 0) && (() => {
        // Filtra eventos pelo cruzamento (interseção) dos chips ativos
        let filtered = state.events;
        if (filterFlows.size > 0) {
          filtered = filtered.filter((e) => {
            const a = HFD.activities && HFD.activities[e.activity];
            return a && filterFlows.has(a.flow);
          });
        }
        if (filterOps.size > 0) {
          filtered = filtered.filter((e) => filterOps.has(e.op));
        }
        // Total time wall (não soma duplicada cowork — usa union nas mesmas pessoas)
        // Simples por enquanto: soma cada event individualmente (pessoa-hora).
        let totalMin = 0;
        const byFlow = {};
        const byPerson = {};
        for (const e of filtered) {
          const end = e.ended_min == null ? now : e.ended_min;
          const dur = Math.max(0, end - e.started_min);
          totalMin += dur;
          const a = HFD.activities && HFD.activities[e.activity];
          const f = a ? a.flow : 'unknown';
          byFlow[f] = (byFlow[f] || 0) + dur;
          byPerson[e.op] = (byPerson[e.op] || 0) + dur;
        }
        return (
          <div className="card" style={{ marginTop: 8, padding: 12, background: 'var(--surface-2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.08, fontWeight: 700 }}>
                  Tempo total filtrado
                </div>
                <b className="mono" style={{ fontSize: 18, color: 'var(--hf-navy-700)' }}>{fmtDur(totalMin)}</b>
              </div>
              <div style={{ flex: 1, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
                <span style={{ color: 'var(--text-3)' }}>{filtered.length} event(s)</span>
                {Object.entries(byFlow).sort((a, b) => b[1] - a[1]).map(([f, mins]) => (
                  <span key={f} className={`pill ${f}`}>
                    <span className="dot"/>{(HFD.FLOWS && HFD.FLOWS[f] && HFD.FLOWS[f].label) || f}: {fmtDur(mins)}
                  </span>
                ))}
                {filterOps.size > 0 && Object.entries(byPerson).sort((a, b) => b[1] - a[1]).map(([opId, mins]) => {
                  const o = operators.find((x) => x.id === opId);
                  if (!o) return null;
                  return (
                    <span key={opId} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      fontSize: 11, padding: '2px 8px', borderRadius: 999,
                      background: 'var(--surface)', border: '1px solid var(--border)',
                    }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: o.c1, display: 'inline-block' }}/>
                      {o.short}: <b className="mono">{fmtDur(mins)}</b>
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}

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
            pendingDrags={pendingDrags}
            onConfirmDrags={confirmDrags}
            onCancelDrags={cancelDrags}
            fmtClock={fmtClock}
          />
        )}
      </div>

      {/* ── Resumo do dia ───────────────────────────────────── */}
      <div className="section-title" style={{ marginTop: 24 }}>
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Resumo do dia</h2><span className="en">· Day summary</span>
        <div className="rule"/>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 12 }}>
        <div className="card" style={{ padding: 16 }}>
          <Row label="Data"                value={date}/>
          <Row label="Operadores hoje"     value={`${operators.length} pessoa(s)`}/>
          <Row label="Eventos hoje"        value={`${state.events.length}`}/>
          <Row label="Em andamento (live)" value={`${state.events.filter((e) => e.ended_min == null).length}`}/>
          <Row label="Cowork ativos"       value={`${coworkActive}`}/>
          <Row label="Background ativos"   value={`${state.events.filter((e) => e._is_background && e.ended_min == null).length}`}/>
          <Row label="Tempo médio/ordem"   value={pp.seconds_per_order ? `${pp.seconds_per_order}s` : '—'}/>
          <Row label="Corte do correio"    value={correioNotif ? fmtClock(correioNotif._minutes) : '— sem deadline'}/>
        </div>

        {/* E6 #8 — barras scrolláveis */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          {/* Pessoas por tempo total ativo */}
          <ScrollStrip title="Pessoas · tempo ativo" en="People · active time">
            {(() => {
              const byOp = {};
              for (const e of state.events) {
                const end = e.ended_min == null ? now : e.ended_min;
                byOp[e.op] = (byOp[e.op] || 0) + Math.max(0, end - e.started_min);
              }
              const sorted = Object.entries(byOp).sort((a, b) => b[1] - a[1]);
              return sorted.map(([opId, mins]) => {
                const op = operators.find((x) => x.id === opId);
                if (!op) return null;
                return (
                  <div key={opId} className="strip-item" style={{
                    minWidth: 130, padding: 10, borderRadius: 8,
                    background: 'var(--surface-2)', border: '1px solid var(--border)',
                    flex: '0 0 auto',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: op.c1 }}/>
                      <b style={{ fontSize: 12.5 }}>{op.name}</b>
                    </div>
                    <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--hf-navy-700)', marginTop: 4 }}>{fmtDur(mins)}</div>
                  </div>
                );
              });
            })()}
          </ScrollStrip>

          {/* Lotes em produção do dia */}
          <ScrollStrip title="Lotes em produção" en="Batches in production">
            {(() => {
              const lotes = (raw && raw.production && raw.production.lotes) || [];
              return lotes.slice().sort((a, b) => (b.total_seconds || 0) - (a.total_seconds || 0)).map((lote) => {
                const pname = (lote.product && lote.product.canonical_name) || '(produto)';
                const dur = Math.round((lote.total_seconds || 0) / 60);
                return (
                  <div key={lote.batch_id || pname} className="strip-item" style={{
                    minWidth: 180, padding: 10, borderRadius: 8,
                    background: 'var(--surface-2)', border: '1px solid var(--border)',
                    flex: '0 0 auto',
                  }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {pname}
                    </div>
                    <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{lote.batch_number || '—'}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 }}>
                      <b className="mono" style={{ fontSize: 14, color: 'var(--flow-prod)' }}>{fmtDur(dur)}</b>
                      <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{(lote.people || []).length}p · {(lote.phases || []).length}f</span>
                    </div>
                  </div>
                );
              });
            })()}
          </ScrollStrip>

          {/* Fluxos com tempo */}
          <ScrollStrip title="Fluxos · totais" en="Flows · totals">
            {(() => {
              const byFlow = {};
              for (const e of state.events) {
                const a = HFD.activities && HFD.activities[e.activity];
                const f = a ? a.flow : 'unknown';
                const end = e.ended_min == null ? now : e.ended_min;
                byFlow[f] = (byFlow[f] || 0) + Math.max(0, end - e.started_min);
              }
              return Object.entries(byFlow).sort((a, b) => b[1] - a[1]).map(([f, mins]) => (
                <div key={f} className="strip-item" style={{
                  minWidth: 140, padding: 10, borderRadius: 8,
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  flex: '0 0 auto',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className={`pill ${f}`} style={{ fontSize: 10 }}><span className="dot"/>{(HFD.FLOWS && HFD.FLOWS[f] && HFD.FLOWS[f].label) || f}</span>
                  </div>
                  <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--hf-navy-700)', marginTop: 4 }}>{fmtDur(mins)}</div>
                </div>
              ));
            })()}
          </ScrollStrip>
        </div>
      </div>

      {/* E6 #6 — FloatingPopover pra preencher gap */}
      <FloatingPopover
        open={!!gapFill}
        anchor={gapFill?.coords}
        width={400}
        draggable={true}
        onClose={closeGapFill}
        anchorSelector=".tl-gap-zone, .exp-row-gap"
        header={gapFill && (() => {
          const op = operators.find((x) => x.id === gapFill.opId);
          return (
            <>
              <span style={{ color: 'var(--text-3)', fontSize: 14, fontWeight: 700 }}>⋮⋮</span>
              <Icon name="plus" size={14}/>
              <b style={{ fontSize: 13, flex: 1 }}>
                Preencher gap · {op?.name || '?'} · {fmtClock(gapFill.gap.start)}→{fmtClock(gapFill.gap.end)} ({fmtDur(gapFill.gap.dur)})
              </b>
              <button className="icon-btn" onClick={closeGapFill} style={{ padding: 4 }}><Icon name="x" size={11}/></button>
            </>
          );
        })()}>
        {gapFill && (
          <>
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-3)', marginBottom: 4 }}>
                Tipo de atividade
              </label>
              <select className="input" value={gapFill.form.reasonCat}
                      onChange={(e) => setGapFill((g) => ({ ...g, form: { ...g.form, reasonCat: e.target.value } }))}>
                <option value="almoco">Almoço (lunch)</option>
                <option value="pausa">Pausa curta (break)</option>
                <option value="limpeza">Limpeza (cleaning)</option>
                <option value="transicao">Transição/organização</option>
                <option value="outro">Outro motivo</option>
              </select>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-3)', marginBottom: 4 }}>
                Descrição livre
              </label>
              <textarea className="input" rows={3} value={gapFill.form.note}
                        onChange={(e) => setGapFill((g) => ({ ...g, form: { ...g.form, note: e.target.value } }))}
                        placeholder="ex.: foi limpar a linha 2 depois do encapsulamento"/>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn primary" onClick={saveGapFill}>Criar event no gap</button>
              <button className="btn ghost" onClick={closeGapFill}>Cancelar</button>
              <span style={{ flex: 1 }}/>
              <span style={{ fontSize: 10.5, color: 'var(--text-3)', fontStyle: 'italic', alignSelf: 'center' }}>
                {V4_ALLOW_WRITES ? 'persiste em prod (audit)' : 'preview · V4_ALLOW_WRITES=0'}
              </span>
            </div>
          </>
        )}
      </FloatingPopover>
    </div>
  );
}

/* E6 #8 — barra horizontal scrollável p/ tirinhas de info. */
function ScrollStrip({ title, en, children }) {
  return (
    <div className="card" style={{ padding: 10 }}>
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.08, fontWeight: 700, marginBottom: 6 }}>
        {title}{en && <span style={{ marginLeft: 6, opacity: 0.7, textTransform: 'none', fontWeight: 500 }}>· {en}</span>}
      </div>
      <div style={{
        display: 'flex', gap: 8, overflowX: 'auto', overflowY: 'hidden',
        paddingBottom: 4,
      }}>
        {children}
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
            className="icon-btn gear-btn"
            style={{
              width: 22, height: 22, fontSize: 14, padding: 0,
              background: active ? 'var(--surface-2)' : 'transparent',
              border: 'none', cursor: 'pointer', color: 'var(--text-3)',
            }}
            title="Editar">
      ⚙
    </button>
  );
}

/* E6 #1 — EditPopover usa FloatingPopover (position:fixed → não corta no
   overflow do card). Coords vêm do clique na engrenagem. */
function EditPopover({ open, anchor, onClose, title, children }) {
  return (
    <FloatingPopover
      open={open}
      anchor={anchor}
      width={360}
      onClose={onClose}
      anchorSelector=".gear-btn"
      header={
        <>
          <b style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-3)', flex: 1 }}>{title}</b>
          <button className="icon-btn" onClick={onClose} style={{ padding: 4 }}><Icon name="x" size={11}/></button>
        </>
      }>
      {children}
      <div style={{
        fontSize: 10.5, color: 'var(--text-3)', marginTop: 10, padding: '6px 8px',
        background: 'var(--surface-2)', borderRadius: 6, fontStyle: 'italic',
      }}>
        {V4_ALLOW_WRITES ? 'Edits persistem em prod (auditados via PIN)' : 'V4_ALLOW_WRITES=0 — save toasta preview'}
      </div>
    </FloatingPopover>
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
