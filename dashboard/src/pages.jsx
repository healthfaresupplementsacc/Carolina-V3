// HEALTHFARE V3 — SPA — as telas. Hoje = centro de comando ao vivo.
import React, { useState } from 'react';
import {
  useFetch, usePoll, useNow, nyToday, nyMinutes,
  fmtDur, fmtTime, fmtDateTime, fmtClock, fmtMinutes, fmtHour12, fmt12hHHMM,
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
  const [sel, setSel] = useState(null);          // event selecionado p/ painel
  const [hov, setHov] = useState(null);          // hover tip ({payload,x,y} | null)

  const timeline = usePoll('/timeline?date=' + date, [date], POLL);
  const production = usePoll('/production?date=' + date, [date], POLL);
  const pp = usePoll('/pp?date=' + date, [date], POLL);
  const goals = usePoll('/goals?date=' + date, [date], POLL);
  const counts = usePoll('/counts?date=' + date, [date], POLL);
  const deadlines = usePoll('/deadlines', [], POLL);

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
      </div>
      <CCTopo people={people} counts={counts} goals={goals}
        pp={pp} deadlines={deadlines} production={production} />
      <CCTimeline people={people} allPeople={people} batchById={batchById} isToday={isToday}
        nowM={nowM} nowMs={nowMs} loading={timeline.loading} error={timeline.error}
        selected={sel} onSelect={setSel} onHover={setHov} />
      {sel ? (
        <CCDetail ev={sel.ev} person={sel.person} people={people}
          batchById={batchById} isToday={isToday} nowMs={nowMs}
          onClose={() => setSel(null)} />
      ) : null}
      {hov ? <CCHoverTip {...hov} /> : null}
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

// B.3 — Painel lateral de detalhe (360px desktop, fullscreen mobile).
// Read-only por enquanto (B.5 adiciona "editar"; B.6 adiciona "+ novo").
function CCDetail({ ev, person, people, batchById, isToday, nowMs, onClose }) {
  if (!ev) return null;
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

      <footer className="cc-detail-foot">
        <span className="muted small">Editar/apagar/criar — bloco B.EDIÇÃO (depois).</span>
      </footer>
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
