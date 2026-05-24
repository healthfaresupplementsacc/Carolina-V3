// HEALTHFARE V3 — SPA — as telas. Hoje = centro de comando ao vivo.
import React, { useState, useEffect } from 'react';
import {
  useFetch, usePoll, useNow, nyToday, nyMinutes,
  fmtDur, fmtTime, fmtDateTime, fmtClock, fmtMinutes, fmtHour12, fmt12hHHMM,
  apiPost, apiPatch, apiDelete,
  isoToNyDatetimeLocal, nyDatetimeLocalToIso,
} from './api.js';
import { Loading, ErrorBox, Empty, Metric, ConfBadge, GoalBar, ActivityBlock, FlowLegend } from './ui.jsx';

/** Wrapper: trata loading/erro, senão chama render(data,meta). */
function View({ st, children }) {
  if (st.loading) return <Loading />;
  if (st.error) return <ErrorBox error={st.error} />;
  return children(st.data, st.meta);
}

// ── HOJE — CENTRO DE COMANDO (mapa vivo do dia) ────────────
// Uma tela só: topo = resumo do dia · centro = timeline de TODOS
// lado a lado. Ao vivo (poll 12s) quando a data é hoje.

const FLOW_COLOR = { production: 'var(--prod)', pnp: 'var(--pnp)', support: 'var(--support)' };

/** minuto-do-dia (0..1439) de um ISO com offset de NY. */
const hm = (iso) => (iso ? Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)) : null);

/** iniciais de um nome (até 2 letras). */
function initials(name) {
  const w = String(name || '?').trim().split(/\s+/);
  return ((w[0] || '?')[0] + (w[1] ? w[1][0] : '')).toUpperCase();
}

export function Hoje({ date }) {
  const isToday = date === nyToday();
  const nowMs = useNow(isToday);                 // tick 1s — só hoje
  const nowM = isToday ? nyMinutes(nowMs) : null;
  const POLL = isToday ? 12000 : 0;              // ao vivo só hoje
  const [sel, setSel] = useState(null);          // {ev, person, mode?} | null
  const [hov, setHov] = useState(null);          // hover tip ({payload,x,y} | null)
  const [refreshTick, setRefreshTick] = useState(0); // bump → re-fetch após write
  const [toast, setToast] = useState(null);      // {message, undo?, ttlMs?} | null
  const refresh = () => setRefreshTick((t) => t + 1);

  const timeline = usePoll('/timeline?date=' + date, [date, refreshTick], POLL);
  const production = usePoll('/production?date=' + date, [date, refreshTick], POLL);
  const pp = usePoll('/pp?date=' + date, [date, refreshTick], POLL);
  const goals = usePoll('/goals?date=' + date, [date, refreshTick], POLL);
  const counts = usePoll('/counts?date=' + date, [date, refreshTick], POLL);
  const deadlines = usePoll('/deadlines', [refreshTick], POLL);

  const people = (timeline.data && timeline.data.people) || [];
  const lotes = (production.data && production.data.lotes) || [];

  // batch_id → lote (nº + produto) — sem tocar o backend.
  const batchById = {};
  for (const l of lotes) if (l.batch_id != null) batchById[l.batch_id] = l;

  return (
    <div className={'cc' + (sel ? ' cc-with-detail' : '')}>
      <div className="cc-head">
        <h2>{isToday ? 'Centro de comando' : 'Centro de comando · ' + date}</h2>
        <span className="cc-legend">
          <i style={{ background: 'var(--prod)' }} />Produção
          <i style={{ background: 'var(--pnp)' }} />P&amp;P
          <i style={{ background: 'var(--support)' }} />Suporte
          <span className="muted">&nbsp;🔗 cowork · ⏱ em andamento · ⏰ passou esperado</span>
        </span>
        <button className="cc-btn cc-btn-primary cc-new-btn"
          onClick={() => setSel({ mode: 'create' })}
          title="Criar event novo (admin)">+ novo registro</button>
      </div>
      <CCTopo people={people} counts={counts} goals={goals}
        pp={pp} deadlines={deadlines} production={production} />
      <CCTimeline people={people} allPeople={people} batchById={batchById} isToday={isToday}
        nowM={nowM} nowMs={nowMs} loading={timeline.loading} error={timeline.error}
        selected={sel} onSelect={setSel} onHover={setHov} />
      {sel ? (
        <CCDetail
          initialMode={sel.mode || 'view'}
          ev={sel.ev} person={sel.person} people={people}
          batchById={batchById} isToday={isToday} nowMs={nowMs} date={date}
          onClose={() => setSel(null)}
          onChanged={refresh}
          onToast={setToast} />
      ) : null}
      {hov ? <CCHoverTip {...hov} /> : null}
      {toast ? (
        <CCToast toast={toast}
          onClose={() => setToast(null)}
          onUndo={async () => {
            try {
              await toast.undo();
              setToast({ message: 'Desfeito.', ttlMs: 3500 });
              refresh();
            } catch (e) {
              setToast({ message: 'Erro ao desfazer: ' + e.message, ttlMs: 6000 });
            }
          }} />
      ) : null}
    </div>
  );
}

/** Toast canto-inferior-direito, com botão "Desfazer" opcional + timeout. */
function CCToast({ toast, onClose, onUndo }) {
  useEffect(() => {
    const ttl = toast.ttlMs || 8000;
    const t = setTimeout(onClose, ttl);
    return () => clearTimeout(t);
  }, [toast, onClose]);
  return (
    <div className="cc-toast" role="status">
      <span className="cc-toast-msg">{toast.message}</span>
      {toast.undo ? (
        <button type="button" className="cc-toast-undo" onClick={onUndo}>Desfazer</button>
      ) : null}
      <button type="button" className="cc-toast-x" onClick={onClose} aria-label="fechar">×</button>
    </div>
  );
}

/** Pop-up pequeno que segue o mouse (essencial). Clique no bloco abre o painel. */
function CCHoverTip({ payload, x, y }) {
  const { personName, fn, prod, clockStr, live } = payload;
  // clamp pra direita/baixo da viewport (evita sair da tela)
  const w = 240; const h = 80;
  const left = (typeof window !== 'undefined' && x + 16 + w > window.innerWidth) ? x - w - 12 : x + 14;
  const top = (typeof window !== 'undefined' && y + 16 + h > window.innerHeight) ? y - h - 12 : y + 14;
  return (
    <div className="cc-hover" style={{ left, top }}>
      <strong>{personName}</strong>
      <div>{fn}{prod ? <> · <span className="cc-hover-prod">{prod}</span></> : null}</div>
      {clockStr ? <div className="cc-hover-clock">{live ? '⏱ ' : ''}{clockStr}</div> : null}
    </div>
  );
}

// ── TOPO — resumo do dia ───────────────────────────────────
function CCTopo({ people, counts, goals, pp, deadlines, production }) {
  const goalList = (goals.data && goals.data.goals) || [];

  // "começou HH:MM" por meta — 1º event do lote na timeline.
  const startByGoal = {};
  for (const g of goalList) {
    const bid = g.batch && g.batch.id;
    if (bid == null) continue;
    let min = null;
    for (const p of people) for (const e of p.events) {
      if (e.product_batch_id === bid && e.started_at && (!min || e.started_at < min)) min = e.started_at;
    }
    if (min) startByGoal[g.goal_id] = fmtTime(min);
  }

  // alertas — duplicatas, durações inválidas, conserto/parada.
  const alerts = [];
  for (const g of goalList) {
    const n = (g.duplicatas_suspeitas || []).length;
    if (n) alerts.push(n + ' contagem(ns) suspeita(s) de duplicata · '
      + (g.product.canonical_name || g.batch_number));
  }
  const invProd = ((production.data && production.data.lotes) || [])
    .reduce((s, l) => s + (l.invalid_event_count || 0), 0);
  const invPp = (pp.data && pp.data.invalid_event_count) || 0;
  if (invProd + invPp) alerts.push((invProd + invPp) + ' event(s) de duração inválida ignorados');
  for (const p of people) for (const e of p.events) {
    if (e.activity && e.activity.slug === 'repair') {
      alerts.push('Conserto/parada · ' + (p.display_name || '?') + ' ' + fmtTime(e.started_at));
    }
  }

  return (
    <div className="cc-topo">
      <CardProducao counts={counts} />
      <CardMetas goals={goals} startByGoal={startByGoal} />
      <CardPP pp={pp} deadlines={deadlines} />
      <CardAtencao alerts={alerts} loading={goals.loading || production.loading} />
    </div>
  );
}

function CardProducao({ counts }) {
  const totals = (counts.data && counts.data.totals_by_product) || {};
  const entries = Object.entries(totals);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  return (
    <div className="cc-card">
      <div className="cc-card-h">📦 Produção hoje</div>
      <div className="cc-big">{counts.loading ? '…' : total}<span className="cc-unit"> garrafas</span></div>
      <div className="cc-list">
        {entries.length
          ? entries.map(([p, v]) => <div key={p}><span>{p}</span><strong>{v}</strong></div>)
          : <span className="muted small">sem contagem ainda</span>}
      </div>
    </div>
  );
}

function CardMetas({ goals, startByGoal }) {
  const list = (goals.data && goals.data.goals) || [];
  return (
    <div className="cc-card">
      <div className="cc-card-h">🎯 Metas em andamento</div>
      {goals.loading ? <div className="cc-big">…</div>
        : !list.length ? <span className="muted small">nenhuma meta hoje</span>
          : list.map((g) => (
            <div key={g.goal_id} className="cc-goal">
              <div className="small">
                <strong>{g.product.canonical_name || '(produto ?)'}</strong>
                {' '}<span className="muted">{g.batch_number}</span>
              </div>
              <div className="cc-goal-n">
                {g.realizado}<span className="muted"> / {g.esperado}</span>
                {g.pct_atingido != null
                  ? <span style={{ color: g.bateu ? 'var(--ok)' : 'var(--accent)' }}> · {g.pct_atingido}%</span>
                  : null}
              </div>
              <GoalBar pct={g.pct_atingido} bateu={g.bateu} />
              <div className="small muted">
                {startByGoal[g.goal_id] ? 'começou ' + startByGoal[g.goal_id] : 'ainda não começou'}
              </div>
            </div>
          ))}
    </div>
  );
}

function CardPP({ pp, deadlines }) {
  const d = pp.data || {};
  const dl = ((deadlines.data && deadlines.data.deadlines) || []).find((x) => x.flow === 'pnp');
  const late = dl && dl.minutes_until_today != null && dl.minutes_until_today < 0;
  return (
    <div className="cc-card">
      <div className="cc-card-h">🚚 P&amp;P do dia</div>
      <div className="cc-big">{pp.loading ? '…' : fmtDur(d.total_seconds || 0)}</div>
      <div className="cc-list">
        <div><span>quantidade</span>
          <strong>{d.packages == null ? '— sem fonte' : d.packages}</strong></div>
        {dl ? (
          <div><span>correio {fmt12hHHMM(dl.time_of_day)}</span>
            <strong className={late ? 'downtime' : ''}>
              {dl.minutes_until_today == null ? '—'
                : dl.minutes_until_today >= 0 ? 'faltam ' + fmtMinutes(dl.minutes_until_today)
                  : 'passou há ' + fmtMinutes(-dl.minutes_until_today)}
            </strong>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CardAtencao({ alerts, loading }) {
  const n = alerts.length;
  return (
    <div className={'cc-card cc-atencao' + (n ? ' on' : '')}>
      <div className="cc-card-h">{n ? '⚠ Atenção' : '✓ Tudo certo'}</div>
      <div className="cc-big">{loading ? '…' : n}</div>
      <div className="cc-list">
        {n ? alerts.map((a, i) => <div key={i} className="cc-alert">{a}</div>)
          : <span className="muted small">nenhum alerta</span>}
      </div>
    </div>
  );
}

// ── CENTRO — timeline de TODOS lado a lado ─────────────────
function CCTimeline({ people, allPeople, batchById, isToday, nowM, nowMs, loading, error, selected, onSelect, onHover }) {
  if (error) return <ErrorBox error={error} />;
  if (loading && !people.length) return <Loading />;
  if (!people.length) return <Empty>Nenhuma atividade nesse dia ainda.</Empty>;

  // janela de horas — do 1º início ao último fim (ou agora).
  let minM = Infinity;
  let maxM = -Infinity;
  for (const p of people) {
    for (const e of p.events) {
      const s = hm(e.started_at);
      if (s == null) continue;
      if (s < minM) minM = s;
      const en = e.ended_at ? hm(e.ended_at) : (isToday ? nowM : s + 30);
      if (en > maxM) maxM = en;
    }
  }
  if (!Number.isFinite(minM)) { minM = 8 * 60; maxM = 18 * 60; }
  if (isToday && nowM > maxM) maxM = nowM;
  const startH = Math.floor(minM / 60);
  let endH = Math.ceil(maxM / 60);
  if (endH - startH < 2) endH = startH + 2;
  const rangeStart = startH * 60;
  const rangeEnd = endH * 60;
  const span = rangeEnd - rangeStart;
  const pct = (m) => ((m - rangeStart) / span) * 100;
  const hours = [];
  for (let h = startH; h <= endH; h++) hours.push(h);
  const showNow = isToday && nowM >= rangeStart && nowM <= rangeEnd;

  // Largura por hora FIXA (não comprime o dia inteiro na largura da tela).
  // CSS define o valor real via var(--cc-hour-px); aqui só passo o nº de horas.
  const hoursCount = endH - startH;

  return (
    <div className="cc-timeline">
      <div className="cc-grid" style={{ '--hp': (100 / hoursCount) + '%', '--hours': hoursCount }}>
        <div className="cc-axis">
          <div className="cc-name cc-axis-name">{isToday ? '● AO VIVO' : 'histórico'}</div>
          <div className="cc-track cc-axis-track">
            {hours.map((h) => (
              <span key={h} className="cc-tick" style={{ left: pct(h * 60) + '%' }}>{fmtHour12(h)}</span>
            ))}
            {showNow ? <span className="cc-now" style={{ left: pct(nowM) + '%' }} /> : null}
          </div>
        </div>
        {people.map((p) => (
          <CCRow key={p.person_id} person={p} allPeople={allPeople} batchById={batchById} isToday={isToday}
            nowM={nowM} nowMs={nowMs} pct={pct}
            rangeStart={rangeStart} rangeEnd={rangeEnd} showNow={showNow}
            selectedEvId={selected && selected.ev ? selected.ev.event_id : null}
            onSelect={onSelect} onHover={onHover} />
        ))}
      </div>
    </div>
  );
}

function CCRow({ person, allPeople, batchById, isToday, nowM, nowMs, pct, rangeStart, rangeEnd, showNow, selectedEvId, onSelect, onHover }) {
  // B.4 — idle distinguido em DOIS rótulos:
  //  idle           = soma dos gaps CURTOS (≤ threshold) — tempo parado real.
  //  não reportado  = gaps LONGOS (> threshold) OU trailing-até-fim-do-dia.
  // âmbar idle a partir de 30min (Bruno).
  const idleSec = person.idle_seconds || 0;
  const unreportedSec = person.unreported_seconds || 0;
  const unreportedSince = person.unreported_since || null;
  const idleHot = idleSec >= 30 * 60;
  return (
    <div className="cc-row">
      <div className="cc-name">
        <span className="cc-avatar">{initials(person.display_name)}</span>
        <div className="cc-pname-wrap">
          <span className="cc-pname">{person.display_name || ('#' + person.person_id)}</span>
          {idleSec > 0 ? (
            <span className={'cc-idle' + (idleHot ? ' hot' : '')} title="tempo ocioso entre atividades (gaps curtos)">
              idle {fmtDur(idleSec)}
            </span>
          ) : null}
          {unreportedSec > 0 ? (
            <span className="cc-unreported" title="gap longo ou parou de reportar">
              sem registro {fmtDur(unreportedSec)}
              {unreportedSince ? <> · desde {fmtTime(unreportedSince)}</> : null}
            </span>
          ) : null}
        </div>
      </div>
      <div className="cc-track">
        {person.events.map((e) => (
          <CCBlock key={e.event_id} ev={e} person={person} allPeople={allPeople}
            batchById={batchById} isToday={isToday}
            nowM={nowM} nowMs={nowMs} pct={pct} rangeStart={rangeStart} rangeEnd={rangeEnd}
            selected={selectedEvId === e.event_id} onSelect={onSelect} onHover={onHover} />
        ))}
        {showNow ? <span className="cc-now" style={{ left: pct(nowM) + '%' }} /> : null}
      </div>
    </div>
  );
}

// B.3+B.5+B.6 — Painel lateral de detalhe com modos view / edit / create.
//   view   — somente leitura (clique num bloco). botão "Editar" → edit.
//   edit   — PATCH /events/:id. botão "Apagar" → DELETE. botão "Cancelar" → view.
//   create — POST /events. inicia em branco (botão "+ novo" no topo da timeline).
function CCDetail({ initialMode = 'view', ev, person, people, batchById, isToday, nowMs, date, onClose, onChanged, onToast }) {
  const [mode, setMode] = useState(initialMode);
  const isCreate = mode === 'create';
  const isEdit = mode === 'edit';
  const isWrite = isCreate || isEdit;

  // catálogos só carregam quando entra em edit/create
  const personsCat = useFetch(isWrite ? '/catalog/persons' : null, [isWrite]);
  const atsCat = useFetch(isWrite ? '/catalog/activity-types' : null, [isWrite]);
  const batchesCat = useFetch(isWrite ? '/batches' : null, [isWrite]);

  const buildForm = () => {
    if (isCreate) {
      // create: começa com data do dia (12:00 PM NY como default razoável)
      const today = date || nyToday();
      const defaultStart = isoToNyDatetimeLocal(`${today}T16:00:00.000Z`); // 12:00 PM NY em maio
      return {
        person_id: '', activity_type_id: '', product_batch_id: '',
        started_at_local: defaultStart, ended_at_local: '', description: '',
        quantity: '', quantity_unit: '',
      };
    }
    return {
      person_id: String(person && person.person_id || ''),
      activity_type_id: ev && ev.activity ? String(ev.activity.id) : '',
      product_batch_id: ev && ev.product_batch_id != null ? String(ev.product_batch_id) : '',
      started_at_local: ev ? isoToNyDatetimeLocal(ev.started_at) : '',
      ended_at_local: ev && ev.ended_at ? isoToNyDatetimeLocal(ev.ended_at) : '',
      description: ev && ev.description ? ev.description : '',
      quantity: ev && ev.quantity != null ? String(ev.quantity) : '',
      quantity_unit: ev && ev.quantity_unit ? ev.quantity_unit : '',
    };
  };
  const [form, setForm] = useState(buildForm);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirmingOverlap, setConfirmingOverlap] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target ? e.target.value : e }));

  // Check de sobreposição com OUTROS foreground da mesma pessoa.
  // Background/meta coexistem (não alertam).
  const overlap = (() => {
    if (!isWrite) return [];
    const sLocal = form.started_at_local;
    if (!sLocal) return [];
    const startMs = Date.parse(nyDatetimeLocalToIso(sLocal));
    const endMs = form.ended_at_local
      ? Date.parse(nyDatetimeLocalToIso(form.ended_at_local))
      : Number.MAX_SAFE_INTEGER; // sem fim = "estende até infinito"
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return [];
    const pid = Number(form.person_id);
    const personRow = people.find((p) => p.person_id === pid);
    if (!personRow) return [];
    const out = [];
    const currentId = isEdit && ev ? ev.event_id : null;
    for (const o of personRow.events) {
      if (currentId && o.event_id === currentId) continue;
      const isBg = o.activity && o.activity.is_background;
      const isMeta = o.activity && o.activity.category === 'meta';
      if (isBg || isMeta) continue;
      const os = Date.parse(o.started_at);
      const oe = o.ended_at ? Date.parse(o.ended_at) : Date.now();
      if (Math.max(startMs, os) < Math.min(endMs, oe)) out.push(o);
    }
    return out;
  })();

  async function onSave(e) {
    e && e.preventDefault();
    setErr(null);
    if (!form.person_id) return setErr('Escolhe a pessoa.');
    if (!form.started_at_local) return setErr('Defina a hora de início.');
    if (overlap.length && !confirmingOverlap) {
      setConfirmingOverlap(true);
      return;
    }
    setBusy(true);
    try {
      const qtyN = form.quantity === '' ? null : Number(form.quantity);
      if (qtyN != null && !Number.isFinite(qtyN)) {
        setBusy(false); return setErr('Quantidade tem que ser número.');
      }
      const payload = {
        person_id: Number(form.person_id),
        activity_type_id: form.activity_type_id ? Number(form.activity_type_id) : null,
        product_batch_id: form.product_batch_id ? Number(form.product_batch_id) : null,
        started_at: nyDatetimeLocalToIso(form.started_at_local),
        ended_at: form.ended_at_local ? nyDatetimeLocalToIso(form.ended_at_local) : null,
        description: form.description || null,
        quantity: qtyN,
        quantity_unit: form.quantity_unit || null,
      };
      if (isCreate) {
        await apiPost('/events', payload);
      } else {
        // PATCH manda só os campos como `changes`
        await apiPatch('/events/' + ev.event_id, {
          changes: payload,
          note: 'edição via dashboard',
        });
      }
      onChanged && onChanged();
      onClose && onClose();
    } catch (e2) {
      setErr(e2.message);
      setConfirmingOverlap(false);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!ev || !ev.event_id) return;
    if (!confirmingDelete) { setConfirmingDelete(true); return; }
    setBusy(true); setErr(null);
    try {
      const evId = ev.event_id;
      await apiDelete('/events/' + evId, { reason: 'apagado via dashboard' });
      // Toast com Desfazer — chama POST /events/:id/restore (já existe).
      onToast && onToast({
        message: `Event ${evId} apagado.`,
        undo: () => apiPost('/events/' + evId + '/restore', { by_person_id: null }),
        ttlMs: 10000,
      });
      onChanged && onChanged();
      onClose && onClose();
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  }

  // ── view-only sub-render ──
  if (mode === 'view') {
    const live = !ev.ended_at && isToday;
    const elapsedSec = live
      ? (nowMs - Date.parse(ev.started_at)) / 1000
      : (ev.ended_at ? (Date.parse(ev.ended_at) - Date.parse(ev.started_at)) / 1000 : null);
    const batch = ev.product_batch_id != null ? batchById[ev.product_batch_id] : null;
    const prod = batch && batch.product ? batch.product.canonical_name : null;
    const cowork = (ev.cowork_with || []).map((id) => {
      const p = people.find((x) => x.person_id === id);
      return p ? p.display_name : ('#' + id);
    });
    const kind = ev.activity
      ? (ev.activity.category === 'meta' ? 'meta'
        : (ev.activity.is_background ? 'background' : 'foreground'))
      : 'foreground';
    const expected = ev.activity ? ev.activity.expected_seconds : null;
    const overrun = ev.activity && ev.activity.is_background && expected != null
      && elapsedSec != null && elapsedSec > expected;
    return (
      <aside className="cc-detail" role="dialog" aria-label="Detalhe do evento">
        <header className="cc-detail-h">
          <div>
            <div className="cc-detail-title">{person.display_name || ('#' + person.person_id)}</div>
            <div className="cc-detail-sub">
              <span className="cc-detail-kind" data-kind={kind}>{kind}</span>
              {' '}{ev.activity ? ev.activity.display_name : '(sem atividade)'}
              {ev.activity && ev.activity.slug ? <span className="muted small"> · {ev.activity.slug}</span> : null}
            </div>
          </div>
          <button className="cc-detail-close" onClick={onClose} aria-label="fechar">×</button>
        </header>

        <dl className="cc-detail-fields">
          <dt>Fluxo</dt><dd>{ev.flow || '—'}</dd>
          <dt>Entrada</dt><dd>{fmtTime(ev.started_at)} <span className="muted small">({fmtDateTime(ev.started_at)})</span></dd>
          <dt>Saída</dt><dd>{ev.ended_at ? fmtTime(ev.ended_at) : <em className="muted">em andamento</em>}</dd>
          <dt>Duração</dt><dd>
            {elapsedSec != null ? fmtClock(elapsedSec) : '—'}
            {live ? <span className="muted small"> · contando</span> : null}
          </dd>
          {prod ? (<><dt>Produto</dt><dd>{prod} <span className="muted small">/ {batch.batch_number}</span></dd></>) : null}
          {ev.quantity != null ? (<><dt>Quantidade</dt><dd>{ev.quantity} {ev.quantity_unit || ''}</dd></>) : null}
          {cowork.length ? (<><dt>Cowork</dt><dd>{cowork.join(', ')}</dd></>) : null}
          {expected != null ? (
            <><dt>Esperado</dt>
              <dd>
                {fmtClock(expected)}
                {overrun ? <strong className="downtime"> ⏰ passou {Math.round((elapsedSec - expected) / 60)}min</strong> : null}
              </dd></>
          ) : null}
          <dt>Confiança</dt><dd><ConfBadge value={ev.confidence} /></dd>
          {ev.phase_label ? (<><dt>Phase</dt><dd>{ev.phase_label}</dd></>) : null}
          {ev.description ? (<><dt>Descrição</dt><dd className="cc-detail-desc">{ev.description}</dd></>) : null}
          {ev.source_message_ts ? (<><dt>Slack ts</dt><dd className="muted small">{ev.source_message_ts}</dd></>) : null}
          {ev.closed_reason ? (<><dt>Fechamento</dt><dd className="muted">{ev.closed_reason}</dd></>) : null}
          <dt>ID</dt><dd className="muted small">ev {ev.event_id}</dd>
        </dl>

        <footer className="cc-detail-foot cc-detail-actions">
          <button className="cc-btn cc-btn-primary" onClick={() => setMode('edit')}>Editar</button>
        </footer>
      </aside>
    );
  }

  // ── edit / create render ──
  const persons = (personsCat.data && personsCat.data.persons) || [];
  const ats = (atsCat.data && atsCat.data.activity_types) || [];
  const batches = (batchesCat.data && batchesCat.data.batches) || [];
  // agrupa activity_types por flow (e separa bg/fg) pro select ficar legível.
  const atGroups = [
    { label: 'Produção', items: ats.filter((a) => a.flow === 'production') },
    { label: 'P&P',      items: ats.filter((a) => a.flow === 'pnp') },
    { label: 'Suporte',  items: ats.filter((a) => a.flow === 'support') },
    { label: '(sem fluxo)', items: ats.filter((a) => !a.flow) },
  ].filter((g) => g.items.length);

  return (
    <aside className="cc-detail" role="dialog" aria-label={isCreate ? 'Criar event' : 'Editar event'}>
      <header className="cc-detail-h">
        <div>
          <div className="cc-detail-title">
            {isCreate ? '+ novo registro' : 'Editar event ' + (ev && ev.event_id)}
          </div>
          <div className="cc-detail-sub muted small">
            {isCreate
              ? 'Criação manual (source_message_ts=null, actor=admin, auditado).'
              : 'Edição admin — auditada e reversível. Não ensina nada ao sistema.'}
          </div>
        </div>
        <button className="cc-detail-close" onClick={onClose} aria-label="fechar">×</button>
      </header>

      <form className="cc-form" onSubmit={onSave}>
        <label className="cc-field">
          <span>Pessoa</span>
          <select value={form.person_id} onChange={set('person_id')} required>
            <option value="">— escolher —</option>
            {persons.map((p) => (
              <option key={p.id} value={p.id}>{p.display_name} ({p.role || '?'})</option>
            ))}
          </select>
        </label>

        <label className="cc-field">
          <span>Função</span>
          <select value={form.activity_type_id} onChange={set('activity_type_id')}>
            <option value="">(sem atividade)</option>
            {atGroups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.items.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name}{a.is_background ? ' · bg' : ''}{a.category === 'meta' ? ' · meta' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="cc-field">
          <span>Produto / Lote</span>
          <select value={form.product_batch_id} onChange={set('product_batch_id')}>
            <option value="">(nenhum)</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>{b.product_name} / {b.batch_number}</option>
            ))}
          </select>
        </label>

        <div className="cc-field-row">
          <label className="cc-field">
            <span>Início (NY)</span>
            <input type="datetime-local" value={form.started_at_local} onChange={set('started_at_local')} required />
          </label>
          <label className="cc-field">
            <span>Fim (NY · vazio = aberto)</span>
            <input type="datetime-local" value={form.ended_at_local} onChange={set('ended_at_local')} />
          </label>
        </div>

        <div className="cc-field-row">
          <label className="cc-field">
            <span>Quantidade (opcional)</span>
            <input type="number" min="0" step="1" value={form.quantity} onChange={set('quantity')}
              placeholder="ex: 142 (ordens P&P) / 750 (garrafas)" />
          </label>
          <label className="cc-field">
            <span>Unidade</span>
            <select value={form.quantity_unit} onChange={set('quantity_unit')}>
              <option value="">(nenhuma)</option>
              <option value="order">order (P&amp;P)</option>
              <option value="bottle">bottle (garrafas)</option>
              <option value="box">box</option>
              <option value="uncertain">uncertain</option>
            </select>
          </label>
        </div>

        <label className="cc-field">
          <span>Descrição</span>
          <textarea rows="3" value={form.description} onChange={set('description')} placeholder="livre — contexto, motivo da correção, etc." />
        </label>

        {overlap.length ? (
          <div className="cc-warn">
            ⚠ {overlap.length === 1 ? 'Cria sobreposição com' : 'Cria sobreposição com'}:
            {overlap.map((o) => (
              <div key={o.event_id} className="small">
                · ev {o.event_id} {o.activity ? o.activity.display_name : '?'} {fmtTime(o.started_at)}→{o.ended_at ? fmtTime(o.ended_at) : 'aberto'}
              </div>
            ))}
            <div className="small muted" style={{ marginTop: 6 }}>
              {confirmingOverlap
                ? 'Clica Salvar de novo pra confirmar (admin manda).'
                : 'Apenas aviso — admin pode prosseguir. Clica Salvar de novo pra confirmar.'}
            </div>
          </div>
        ) : null}

        {err ? <div className="cc-err">erro: {err}</div> : null}

        <div className="cc-form-actions">
          <button type="submit" className={'cc-btn cc-btn-primary' + (overlap.length && !confirmingOverlap ? ' warn' : '')} disabled={busy}>
            {busy ? '…' : (overlap.length && confirmingOverlap ? 'Salvar mesmo assim' : 'Salvar')}
          </button>
          {isEdit ? (
            confirmingDelete ? (
              <>
                <button type="button" className="cc-btn cc-btn-danger" onClick={onDelete} disabled={busy}>
                  Confirmar apagar
                </button>
                <button type="button" className="cc-btn" onClick={() => setConfirmingDelete(false)} disabled={busy}>
                  cancelar apagar
                </button>
              </>
            ) : (
              <button type="button" className="cc-btn cc-btn-danger" onClick={onDelete} disabled={busy}>
                Apagar
              </button>
            )
          ) : null}
          <button type="button" className="cc-btn" onClick={() => {
            if (isCreate) { onClose(); }
            else { setMode('view'); setForm(buildForm); setErr(null); setConfirmingOverlap(false); setConfirmingDelete(false); }
          }} disabled={busy}>
            Cancelar
          </button>
        </div>
      </form>
    </aside>
  );
}

function CCBlock({ ev, person, allPeople, batchById, isToday, nowM, nowMs, pct, rangeStart, rangeEnd, selected, onSelect, onHover }) {
  const startM = hm(ev.started_at);
  if (startM == null) return null;
  const live = !ev.ended_at && isToday;
  let endM = ev.ended_at ? hm(ev.ended_at) : (isToday ? nowM : startM + 20);
  if (endM <= startM) endM = startM + 6;
  const left = Math.max(0, pct(Math.max(startM, rangeStart)));
  const right = Math.min(100, pct(Math.min(endM, rangeEnd)));
  const width = Math.max(1.4, right - left);

  const flow = ev.flow || (ev.activity && ev.activity.category) || null;
  const fn = ev.activity ? ev.activity.display_name : '?';
  const batch = ev.product_batch_id != null ? batchById[ev.product_batch_id] : null;
  const prod = batch && batch.product ? batch.product.canonical_name : null;
  // Cowork: chips de iniciais no canto direito (resolve id → nome via allPeople).
  const coworkBadges = (ev.cowork_with || []).map((id) => {
    const cp = (allPeople || []).find((x) => x.person_id === id);
    const name = cp ? cp.display_name : ('#' + id);
    return { id, name, initials: initials(name) };
  });
  const cowork = coworkBadges.length > 0;

  // B.2 — cronômetro h:mm:ss: live = tempo correndo; fechado = duração final congelada.
  const elapsedSec = live
    ? (nowMs - Date.parse(ev.started_at)) / 1000
    : (ev.ended_at ? (Date.parse(ev.ended_at) - Date.parse(ev.started_at)) / 1000 : null);
  const clockStr = (elapsedSec != null && elapsedSec > 0) ? fmtClock(elapsedSec) : null;

  // B.4 — alerta background passou do expected_seconds.
  const expected = ev.activity ? ev.activity.expected_seconds : null;
  const isBg = ev.activity ? ev.activity.is_background === true : false;
  const overrun = isBg && expected != null && elapsedSec != null && elapsedSec > expected;
  const overMin = overrun ? Math.round((elapsedSec - expected) / 60) : 0;

  // Payload pro hover popup (pessoa, função, produto, cronômetro).
  const hoverPayload = {
    personName: person.display_name || ('#' + person.person_id),
    fn, prod, clockStr, live,
  };
  const onEnter = (e) => onHover && onHover({ payload: hoverPayload, x: e.clientX, y: e.clientY });
  const onMove = (e) => onHover && onHover({ payload: hoverPayload, x: e.clientX, y: e.clientY });
  const onLeave = () => onHover && onHover(null);

  const cls = ['cc-block']
    .concat(live ? ['live'] : [])
    .concat(cowork ? ['cowork'] : [])
    .concat(selected ? ['selected'] : [])
    .concat(overrun ? ['overrun'] : [])
    .join(' ');

  // aria-label substitui o title nativo (sem tooltip duplicado em cima do hover popup)
  const ariaLabel = fn + (prod ? ' · ' + prod : '') + ' · '
    + fmtTime(ev.started_at) + '→' + (ev.ended_at ? fmtTime(ev.ended_at) : 'agora')
    + (clockStr ? ' · ' + clockStr : '')
    + (cowork ? ' · cowork com ' + coworkBadges.map((b) => b.name).join(', ') : '')
    + (overrun ? ' · passou ' + overMin + 'min do esperado' : '');

  return (
    <span className={cls}
      style={{ left: left + '%', width: width + '%', background: FLOW_COLOR[flow] || 'var(--panel2)' }}
      aria-label={ariaLabel}
      onClick={() => onSelect && onSelect({ ev, person })}
      onMouseEnter={onEnter} onMouseMove={onMove} onMouseLeave={onLeave}
      role="button">
      <span className="cc-bk-fn">{fn}</span>
      {prod ? <span className="cc-bk-pr">{prod}</span> : null}
      {cowork ? (
        <span className="cc-bk-cowork">
          {coworkBadges.map((b) => (
            <span key={b.id} className="cc-cw-chip" aria-label={'cowork com ' + b.name}>{b.initials}</span>
          ))}
        </span>
      ) : null}
      {overrun ? <span className="cc-bk-warn" aria-label={'passou ' + overMin + 'min do esperado'}>⏰</span> : null}
      {live && clockStr ? <span className="cc-bk-live">⏱ {clockStr}</span> : null}
      {!live && clockStr ? <span className="cc-bk-dur">{clockStr}</span> : null}
    </span>
  );
}

// ── PRODUÇÃO — esteira fase a fase, por lote ───────────────
export function Producao({ date }) {
  const prod = useFetch('/production?date=' + date, [date]);
  const goals = useFetch('/goals?date=' + date, [date]);

  return (
    <>
      <h2>Produção · {date}</h2>
      <p className="small muted">Fluxo ordenado — cada lote mede fase a fase.</p>
      <View st={prod}>{(data) => {
        if (!data.lotes.length) return <Empty>Nenhum lote de produção nesse dia.</Empty>;
        const goalByBatch = {};
        for (const g of (goals.data ? goals.data.goals : [])) goalByBatch[g.batch_number] = g;
        return data.lotes.map((lote, i) => {
          const g = goalByBatch[lote.batch_number];
          return (
            <div className="lote" key={lote.batch_id || i}>
              <div className="head">
                <strong>
                  Lote {lote.batch_number || '(sem nº)'}
                  {lote.product ? ' · ' + lote.product.canonical_name : ''}
                </strong>
                <span className="muted small">{(lote.people || []).join(', ')}</span>
              </div>
              {g ? (
                <div style={{ margin: '8px 0' }}>
                  <div className="small">
                    Meta <strong>{g.esperado}</strong> · Realizado <strong>{g.realizado}</strong>
                    {g.pct_atingido != null
                      ? <> · <strong>{g.pct_atingido}%</strong> {g.bateu ? '✓ bateu' : '✗ não bateu'}</>
                      : null}
                  </div>
                  <GoalBar pct={g.pct_atingido} bateu={g.bateu} />
                </div>
              ) : <div className="small muted" style={{ margin: '6px 0' }}>sem meta registrada</div>}
              <div className="esteira">
                {lote.phases.length
                  ? lote.phases.map((ph, j) => (
                    <React.Fragment key={j}>
                      {j > 0 ? <span className="arrow">→</span> : null}
                      <span className="fase">
                        <div className="nm">{ph.activity}</div>
                        <div className="tm">{fmtDur(ph.seconds)}</div>
                      </span>
                    </React.Fragment>
                  ))
                  : <span className="muted small">sem fases</span>}
              </div>
              <p className="small muted" style={{ marginBottom: 0 }}>
                tempo no lote: {fmtDur(lote.total_seconds)}
                {lote.invalid_event_count
                  ? ' · ⚠ ' + lote.invalid_event_count + ' event(s) de duração inválida ignorados'
                  : ''}
              </p>
            </div>
          );
        });
      }}</View>
    </>
  );
}

// ── P&P — UM bloco do dia ──────────────────────────────────
export function PP({ date }) {
  const pp = useFetch('/pp?date=' + date, [date]);
  const deadlines = useFetch('/deadlines', []);

  return (
    <>
      <h2>Picking &amp; Packing · {date}</h2>
      <p className="small muted">Fluxo bloco — os sub-passos somam num total único do dia.</p>
      <View st={pp}>{(d) => {
        const dl = (deadlines.data ? deadlines.data.deadlines : []).find((x) => x.flow === 'pnp');
        return (
          <div className="card" style={{ maxWidth: 460 }}>
            <div className="cards" style={{ marginBottom: 6 }}>
              <Metric label="Tempo total do bloco" value={fmtDur(d.total_seconds)} />
              <Metric label="Pacotes feitos" value={d.packages == null ? '—' : d.packages}
                sub={d.packages == null ? 'sem fonte ainda' : ''} />
              <Metric label="Tempo por pacote"
                value={d.seconds_per_package == null ? '—' : fmtDur(d.seconds_per_package)} />
            </div>
            <h3>Sub-passos</h3>
            {d.sub_steps.length
              ? d.sub_steps.map((s, i) => (
                <div key={i} className="small">✓ {s.activity} <span className="muted">· {fmtDur(s.seconds)}</span></div>
              ))
              : <Empty>Nenhum sub-passo registrado.</Empty>}
            {dl ? (
              <p className="small" style={{ marginTop: 10 }}>
                Deadline <strong>{dl.label}</strong> {dl.time_of_day}
                {dl.minutes_until_today != null
                  ? (dl.minutes_until_today >= 0
                    ? <span className="muted"> · faltam {dl.minutes_until_today} min</span>
                    : <span className="muted"> · passou há {-dl.minutes_until_today} min</span>)
                  : null}
              </p>
            ) : null}
            {d.invalid_event_count
              ? <p className="small muted">⚠ {d.invalid_event_count} event(s) de duração inválida ignorados.</p>
              : null}
          </div>
        );
      }}</View>
    </>
  );
}

// ── SUPORTE — ocorrências avulsas ──────────────────────────
export function Suporte({ date }) {
  const sup = useFetch('/support?date=' + date, [date]);
  return (
    <>
      <h2>Suporte · {date}</h2>
      <p className="small muted">Fluxo avulso — cada ocorrência medida separada.</p>
      <View st={sup}>{(d) => (
        !d.occurrences.length ? <Empty>Nenhuma ocorrência de suporte nesse dia.</Empty> : (
          <table>
            <thead><tr><th>atividade</th><th>pessoa</th><th>início</th><th>duração</th></tr></thead>
            <tbody>
              {d.occurrences.map((o) => (
                <tr key={o.event_id}>
                  <td className={o.is_downtime ? 'downtime' : ''}>
                    {o.activity}{o.is_downtime ? ' ⚠ downtime' : ''}
                  </td>
                  <td>{o.person || '—'}</td>
                  <td className="muted">{fmtTime(o.started_at)}</td>
                  <td>{o.seconds == null ? <span className="muted">—</span> : fmtDur(o.seconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}</View>
    </>
  );
}

// ── PESSOAS — timeline por pessoa ──────────────────────────
export function Pessoas({ date }) {
  const tl = useFetch('/timeline?date=' + date, [date]);
  return (
    <>
      <h2>Pessoas · {date}</h2>
      <View st={tl}>{(d) => (
        !d.people.length ? <Empty>Nenhum event nesse dia.</Empty> : (
          <>
            {d.people.map((p) => (
              <div className="person" key={p.person_id}>
                <strong>{p.display_name || ('person ' + p.person_id)}</strong>
                <span className="muted small"> · {p.events.length} atividade(s)</span>
                <div className="tl">
                  {p.events.map((e) => (
                    <ActivityBlock key={e.event_id}
                      name={fmtTime(e.started_at) + ' ' + (e.activity ? e.activity.display_name : '?')}
                      category={e.activity ? e.activity.category : null}
                      extra={((e.cowork_with || []).length ? ' 🔗' : '') + (e.ended_at ? '' : ' •')} />
                  ))}
                </div>
              </div>
            ))}
            <FlowLegend />
          </>
        )
      )}</View>
    </>
  );
}

// ── PRODUTO — histórico (busca) ────────────────────────────
export function Produto() {
  const products = useFetch('/catalog/products', []);
  const [pid, setPid] = useState('');
  const hist = useFetch(pid ? '/product/' + pid + '/history' : null, [pid]);

  return (
    <>
      <h2>Histórico por produto</h2>
      <View st={products}>{(d) => (
        <select value={pid} onChange={(e) => setPid(e.target.value)}>
          <option value="">— escolha um produto —</option>
          {d.products.map((p) => <option key={p.id} value={p.id}>{p.canonical_name}</option>)}
        </select>
      )}</View>
      {!pid ? <p className="small muted" style={{ marginTop: 12 }}>Escolha um produto pra ver o histórico.</p> : null}
      {pid ? (
        <View st={hist}>{(d) => (
          <div style={{ marginTop: 14 }}>
            <h3>{d.product.canonical_name} · {d.from} → {d.to}</h3>
            {d.counts.length ? (
              <table>
                <thead><tr><th>data</th><th>lote</th><th>garrafas</th><th>reportado por</th></tr></thead>
                <tbody>
                  {d.counts.map((c) => (
                    <tr key={c.id}>
                      <td className="muted">{c.production_date}</td>
                      <td>{c.batch ? c.batch.batch_number : '—'}</td>
                      <td>{c.bottles}</td>
                      <td>{c.reporter ? c.reporter.display_name : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty>Sem contagens no período.</Empty>}
            <p className="small muted">{d.batches.length} lote(s) no histórico.</p>
          </div>
        )}</View>
      ) : null}
    </>
  );
}

// ── METAS — esperado vs realizado + duplicatas ─────────────
export function Metas({ date }) {
  const goals = useFetch('/goals?date=' + date, [date]);
  return (
    <>
      <h2>Metas · {date}</h2>
      <p className="small muted">Esperado vs realizado por lote. (Criar/editar meta — Bloco 3c.)</p>
      <View st={goals}>{(d) => {
        if (!d.goals.length) return <Empty>Nenhuma meta registrada nesse dia.</Empty>;
        const dups = d.goals.flatMap((g) => g.duplicatas_suspeitas.map((x) => ({ g, x })));
        return (
          <>
            <div className="cards">
              {d.goals.map((g) => (
                <div className="card" key={g.goal_id} style={{ minWidth: 220 }}>
                  <strong>{g.product ? g.product.canonical_name : '(produto ?)'} · {g.batch_number}</strong>
                  <div className="small" style={{ margin: '6px 0' }}>
                    {g.esperado} → {g.realizado}
                    {g.pct_atingido != null
                      ? <> · <strong style={{ color: g.bateu ? 'var(--ok)' : 'var(--bad)' }}>
                        {g.pct_atingido}% {g.bateu ? '✓' : '✗'}</strong></>
                      : <span className="muted"> · sem realizado</span>}
                  </div>
                  <GoalBar pct={g.pct_atingido} bateu={g.bateu} />
                  {g.batch
                    ? <p className="small muted" style={{ marginBottom: 0 }}>
                      lote: {fmtDur(g.batch.total_seconds)}</p>
                    : null}
                </div>
              ))}
            </div>
            {dups.length ? (
              <>
                <h3>⚠ Possíveis duplicatas — revisar</h3>
                {dups.map(({ g, x }, i) => (
                  <div className="card" key={i} style={{ marginBottom: 8 }}>
                    <div className="small">
                      <strong>{g.product ? g.product.canonical_name : '?'} {g.batch_number}</strong>
                      {' — '}{x.bottles} reportado por {x.reporter || '?'} ({fmtDateTime(x.reported_at)})
                    </div>
                    <div className="small muted">
                      mesmo número já contado — confirmar duplicata/adicional é Bloco 3c.
                    </div>
                  </div>
                ))}
              </>
            ) : null}
          </>
        );
      }}</View>
    </>
  );
}

// ── placeholders — Blocos 4 e 5 ────────────────────────────
function Placeholder({ title, bloco, desc }) {
  return (
    <>
      <h2>{title}</h2>
      <div className="card">
        <p className="muted">Em construção — chega no <strong>Bloco {bloco}</strong>.</p>
        <p className="small muted">{desc}</p>
      </div>
    </>
  );
}
export function Planejamento() {
  return <Placeholder title="Planejamento" bloco={4}
    desc="Tasks futuras, o que vem pela frente, notificação opcional por task." />;
}
export function Carolina() {
  return <Placeholder title="Chat com a Carolina" bloco={5}
    desc="Conversa de aprendizado: a Carolina traz observações, você confirma/corrige, ela aprende." />;
}
