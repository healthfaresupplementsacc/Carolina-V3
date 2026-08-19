import React from 'react';
import { Icon, Leaf } from '../components/Icons.jsx';
import { KPI, CapBar, CountdownCard, OperatorAvatar } from '../components/Primitives.jsx';
import { FalarCarolina } from './CarolinaFalar.jsx';
import './pages-operacao.css';

/* Production, Goals, People + light placeholders for the rest.
   S15 fase 2 (Bruno 08-18): pele 100% STYLE-KIT. Só apresentação —
   nenhuma prop, handler, cálculo ou fluxo de dado mudou. */

/* Cabeçalho padrão do kit: eyebrow + h1 DM Serif com UMA palavra italica
   verde + subtitulo. `title` vem como [antes, <em>, depois]. */
function PageHead({ eyebrow, before, em, after, sub, side }) {
  return (
    <div className="opa-head">
      <div className="opa-head-main">
        <span className="kit-eyebrow">● HEALTHFARE · {eyebrow}</span>
        <h1 className="kit-h1">{before}<em>{em}</em>{after}</h1>
        {sub && <p className="kit-sub">{sub}</p>}
      </div>
      {side && <div className="opa-head-side">{side}</div>}
    </div>
  );
}

/* Seção interna: micro-label mono + régua. */
function Section({ label, right }) {
  return (
    <div className="opa-section">
      <span className="kit-mlabel">{label}</span>
      <div className="rule"/>
      {right}
    </div>
  );
}

// ============ Production ============
// E7-resto Leva 2: ligada em raw.production.lotes (vem direto do backend
// com o flow=production já filtrado e fase/duração calculadas).
function ProductionPage({ state, hfdata, raw, openPanel, loading, error, date }) {
  const HFD = hfdata || window.HFData;
  const { operators = [], activities = {}, goals: hfGoals = [] } = HFD;
  const lotes = (raw && raw.production && raw.production.lotes) || [];
  const now = window.HFH.useNow(true);
  const { fmtDur } = window.HFH;
  if (loading) return <div data-page-op="producao"><div className="opa-empty">Carregando lotes…</div></div>;

  // Sort: lotes com mais tempo primeiro (mais ativos)
  const sortedLotes = lotes.slice().sort((a, b) => (b.total_seconds || 0) - (a.total_seconds || 0));

  return (
    <div data-page-op="producao">
      <PageHead eyebrow="PRODUÇÃO" before="Lotes em " em="produção" sub="Cada lote com as fases já cumpridas, o tempo somado e quem está na linha agora."/>
      <Section label={`Lotes do dia · ${sortedLotes.length}`}/>
      {sortedLotes.length === 0 && (
        <div className="opa-empty">Sem lotes em produção em {date || 'hoje'}.</div>
      )}
      {sortedLotes.map((lote) => {
        const productName = (lote.product && lote.product.canonical_name) || '(sem produto)';
        const batchNumber = lote.batch_number || '(sem batch)';
        const totalMin = Math.round((lote.total_seconds || 0) / 60);
        // events do dia que apontam pra esse lote — pra derivar live state + crew
        const loteKey = lote.batch_id != null ? ('b' + lote.batch_id) : null;
        const loteEvents = loteKey ? state.events.filter((e) => e.product === loteKey) : [];
        const liveCount = loteEvents.filter((e) => e.ended_min == null).length;
        // Goal vinculado por chave 'b<batch_id>'
        const goal = hfGoals.find((g) => g.product === loteKey);
        const pct = goal && goal.target > 0 ? Math.min(100, Math.round((goal.done / goal.target) * 100)) : null;
        // Crew vem do backend (display_names); enriquece com avatar se bater pelo nome
        const crewNames = (lote.people || []);
        const crewOps = crewNames.map((name) => operators.find((o) => o.name === name)).filter(Boolean);
        // Phases vêm do backend: [{activity, seconds}]
        const phaseList = (lote.phases || []).slice().sort((a, b) => (b.seconds || 0) - (a.seconds || 0));
        // dc_shipment é flow=production — aparece nas phases se houver

        return (
          <div key={lote.batch_id || productName} className="card lote-card" style={{ marginBottom: 12 }}>
            <div className="head">
              <Leaf size={16} color="var(--green-d)"/>
              <h3>{productName}</h3>
              <span className="batch mono">{batchNumber}</span>
              {liveCount > 0 && <span className="kit-chip ok" style={{ marginLeft: 6 }}>{liveCount} ao vivo</span>}
              <span style={{ flex: 1 }}/>
              <div className="crew" style={{ display: 'flex', gap: 4 }}>
                {crewOps.slice(0, 5).map((o) => <OperatorAvatar key={o.id} op={o} size="md"/>)}
                {crewNames.length > crewOps.length && (
                  <span style={{ fontSize: 11, color: 'var(--ink-faint)', marginLeft: 4 }}>+{crewNames.length - crewOps.length}</span>
                )}
              </div>
            </div>
            {goal && (
              <div style={{ marginTop: 6 }}>
                <CapBar pct={pct} size="lg"
                        label={`Meta: ${goal.done}/${goal.target} ${goal.unit || 'bottle'}`}
                        sub={`${pct}% ${goal.completed ? 'batido' : 'em curso'}`}
                        color1={pct >= 100 ? 'var(--green)' : 'var(--primary)'}
                        color2={pct >= 100 ? 'var(--green-d)' : 'var(--green)'}/>
              </div>
            )}
            <div className="esteira" style={{ marginTop: 10 }}>
              {phaseList.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--ink-faint)', fontStyle: 'italic' }}>sem fases ainda</div>
              ) : phaseList.map((p, i) => {
                const phaseMin = Math.round((p.seconds || 0) / 60);
                return (
                  <React.Fragment key={p.activity}>
                    <div className="fase done">
                      <div className="ind"/>
                      <div className="nm">{p.activity}</div>
                      <div className="du">{fmtDur(phaseMin)}</div>
                    </div>
                    {i < phaseList.length - 1 && <div className="fase-arrow"><Icon name="right" size={14}/></div>}
                  </React.Fragment>
                );
              })}
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-dim)', marginTop: 10, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>Tempo total no lote · <b className="mono" style={{ color: 'var(--ink)' }}>{fmtDur(totalMin)}</b></span>
              {lote.invalid_event_count > 0 && (
                <span className="kit-chip warn">{lote.invalid_event_count} evento(s) com duração inválida</span>
              )}
              {loteEvents.length > 0 && (
                <span style={{ marginLeft: 'auto' }}>{loteEvents.length} eventos · clique no Hoje pra detalhe</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============ Goals ============
// E7-resto Leva 2: ligada em hfdata.goals (adapted) + raw.goals.goals (cru).
// hfdata.goals já tem pct/done/target/unit/completed/_product_name/_batch_number.
// Edição preview: V4_ALLOW_WRITES=0 → save toasta liga-no-E5.
function GoalsPage({ state, hfdata, ack, loading, error, date, writes, V4_ALLOW_WRITES, refresh }) {
  const HFD = hfdata || window.HFData;
  const { goals = [] } = HFD;
  const { fmtDur } = window.HFH;
  if (loading) return <div data-page-op="metas"><div className="opa-empty">Carregando metas…</div></div>;
  return (
    <div data-page-op="metas">
      <PageHead eyebrow="METAS" before="As metas de " em="hoje" sub="Quanto cada lote precisa entregar e quanto já saiu da linha."/>
      <Section label={`Metas do dia · ${goals.length}`}/>
      {goals.length === 0 && (
        <div className="opa-empty">Sem metas registradas em {date || 'hoje'}.</div>
      )}
      <div className="goals-grid">
        {goals.map((g) => {
          const productName = g._product_name || '(produto)';
          const batchNumber = g._batch_number || '';
          const pct = g.pct != null ? g.pct : (g.target > 0 ? Math.round((g.done / g.target) * 100) : 0);
          const hit = !!g.completed || pct >= 100;
          // events que viraram contagem (livre de duplicatas) — pra deduzir "iniciado às"
          // Não temos started_at por goal no adapter; mostra count de duplicatas se houver.
          const dupCount = (g.duplicatas_suspeitas || []).length;
          return (
            <div key={g.id} className="card goal-card">
              <div className="head">
                <Leaf size={14} color="var(--green-d)"/>
                <h3>{productName}</h3>
                {batchNumber && <span className="batch mono">{batchNumber}</span>}
                <span style={{ flex: 1 }}/>
                {hit && <span className="kit-chip ok">batido</span>}
                {!hit && pct >= 80 && <span className="kit-chip warn">quase lá</span>}
                {!hit && pct < 80 && <span className="kit-chip neutral">em curso</span>}
              </div>
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <div className="num">{(g.done || 0).toLocaleString()}<small> / {(g.target || 0).toLocaleString()} {g.unit || 'bottle'}</small></div>
                <span style={{ flex: 1 }}/>
                <div className={`num ${hit ? 'pct-ok' : pct >= 80 ? 'pct-warn' : ''}`}>{pct}%</div>
              </div>
              <div style={{ marginTop: 12 }}>
                <CapBar pct={pct} size="xl"
                        color1={hit ? 'var(--green)' : 'var(--primary)'}
                        color2={hit ? 'var(--green-d)' : 'var(--green)'}/>
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 12, fontSize: 12, color: 'var(--ink-dim)', alignItems: 'center' }}>
                {dupCount > 0 && (
                  <span className="kit-chip warn">{dupCount} contagem(ns) duplicada(s)</span>
                )}
                <span style={{ flex: 1 }}/>
                <button className="kit-btn sm" onClick={async () => {
                  const v = window.prompt(`Nova meta pra ${g._product_name || '?'} (em ${g.unit || 'bottles'}):`, String(g.target || 500));
                  if (v == null) return;
                  const n = Number(v);
                  if (!Number.isFinite(n) || n <= 0) { ack && ack('Valor inválido'); return; }
                  if (!V4_ALLOW_WRITES || !writes) { ack && ack('preview · sem writes'); return; }
                  const res = await writes.patchGoal(g.id, { expected_quantity: n });
                  if (!res.ok) { ack && ack(`Erro: ${res.error.message || res.error}`); return; }
                  if (refresh) refresh();
                  ack && ack(`Salvo · meta ${g.id} = ${n}`);
                }}>
                  <Icon name="edit" size={12}/>Editar
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============ People ============
// E7-resto Leva 1: ligada em hfdata real (operators só dos que postaram —
// admins filtrados no adapter). Cada lane mini-tl mostra todos os events
// do dia da pessoa; o título de cada person-card destaca a atividade ATUAL
// (live) com produto+batch resolvidos.
function PeoplePage({ state, hfdata, openPanel, ack, loading, error, date }) {
  const HFD = hfdata || window.HFData;
  const { operators = [], activities = {}, products = {}, DAY_START = 480, DAY_END = 1260, _gaps = {} } = HFD;
  const now = window.HFH.useNow(true);
  const { fmtCron, fmtDur, fmtClock } = window.HFH;
  const dayMin = DAY_END - DAY_START;
  if (loading) {
    return <div data-page-op="pessoas"><div className="opa-empty">Carregando equipe…</div></div>;
  }
  if (operators.length === 0) {
    return (
      <div data-page-op="pessoas">
        <PageHead eyebrow="PESSOAS" before="A " em="equipe" after=" hoje" sub="Quem está na linha, o que cada pessoa faz agora e o dia inteiro em miniatura."/>
        <div className="opa-empty">Sem operadores postando em {date || 'hoje'} · (admins filtrados)</div>
      </div>
    );
  }

  return (
    <div data-page-op="pessoas">
      <PageHead eyebrow="PESSOAS" before="A " em="equipe" after=" hoje" sub="Quem está na linha, o que cada pessoa faz agora e o dia inteiro em miniatura."/>
      <Section label={`Equipe do dia · ${operators.length} pessoa(s)`}/>
      <div className="people-grid">
        {operators.map(op => {
          const opEvents = (state.events || []).filter(e => e.op === op.id)
            .sort((a, b) => a.started_min - b.started_min);
          const live = opEvents.find(e => e.ended_min == null && !e._is_background);
          const liveBg = opEvents.filter(e => e.ended_min == null && e._is_background);
          const closed = opEvents.filter(e => e.ended_min != null);
          const totalActive = closed.reduce((s, e) => s + (e.ended_min - e.started_min), 0)
            + (live ? (now - live.started_min) : 0);
          const productsCount = new Set(opEvents.filter(e => e.product).map(e => e.product)).size;
          const last = opEvents[opEvents.length - 1];
          const cur = live || last;
          const curAct = cur ? activities[cur.activity] : null;
          const curProd = cur?.product ? products[cur.product] : null;
          const gap = _gaps[op.id] || {};

          return (
            <div key={op.id} className="card person-card" style={{ padding: '16px 18px' }}>
              <div className="head">
                <OperatorAvatar op={op} size="lg"/>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, color: 'var(--primary-deep)', lineHeight: 1.15 }}>{op.name}</div>
                  <div className="kit-mlabel" style={{ marginTop: 2 }}>{op.role}</div>
                </div>
                {live
                  ? <span className="kit-chip ok">ao vivo</span>
                  : <span className="kit-chip neutral">parado</span>}
              </div>
              <div className="opa-now-box">
                <div className="kit-mlabel">{live ? 'Agora' : 'Último'}</div>
                {curAct ? (
                  <>
                    <div className="opa-now-act">{curAct.name}</div>
                    {curProd && <div style={{ fontSize: 12.5, color: 'var(--ink-dim)', marginTop: 1 }}>
                      {curProd.name}{curProd.batch && <span className="mono" style={{ marginLeft: 6, color: 'var(--ink-faint)' }}>· {curProd.batch}</span>}
                    </div>}
                    <div className="opa-now-clock">
                      {live
                        ? fmtCron(now - cur.started_min)
                        : `${fmtDur((cur.ended_min || 0) - (cur.started_min || 0))} (encerrou ${fmtClock(cur.ended_min)})`}
                    </div>
                  </>
                ) : <div style={{ fontSize: 13, color: 'var(--ink-faint)' }}>sem registros</div>}
                {liveBg.length > 0 && (
                  <div style={{ fontSize: 11.5, color: 'var(--ink-dim)', marginTop: 6 }}>
                    + {liveBg.length} background ativo(s): {liveBg.map(e => activities[e.activity]?.name || e.activity).join(', ')}
                  </div>
                )}
              </div>
              <div className="stats">
                <div className="stat"><div className="label">Eventos</div><div className="value">{opEvents.length}</div></div>
                <div className="stat"><div className="label">Tempo ativo</div><div className="value">{fmtDur(totalActive)}</div></div>
                <div className="stat"><div className="label">Produtos</div><div className="value">{productsCount}</div></div>
              </div>
              {(gap.idle_seconds || gap.unreported_seconds) ? (
                <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {gap.idle_seconds > 0 && <span className="kit-chip neutral">idle {fmtDur(Math.round(gap.idle_seconds / 60))}</span>}
                  {gap.unreported_seconds > 0 && <span className="kit-chip warn">não reportado {fmtDur(Math.round(gap.unreported_seconds / 60))}</span>}
                </div>
              ) : null}
              <div className="mini-tl" style={{ marginTop: 10 }}>
                {opEvents.map(ev => {
                  const a = activities[ev.activity]; if (!a) return null;
                  const end = ev.ended_min == null ? now : ev.ended_min;
                  const left = ((ev.started_min - DAY_START) / dayMin) * 100;
                  const width = Math.max(0.5, ((end - ev.started_min) / dayMin) * 100);
                  const productName = ev.product ? (products[ev.product]?.name || '') : '';
                  return (
                    <button key={ev.id} className="mini-bk"
                            style={{ left: `${left}%`, width: `${width}%`,
                                     background: `var(--flow-${a.flow})`,
                                     border: 'none', cursor: 'pointer', padding: 0 }}
                            onClick={(e) => openPanel && openPanel(ev, { x: e.clientX, y: e.clientY })}
                            title={`${a.name}${productName ? ' · ' + productName : ''} · ${fmtClock(ev.started_min)}`}/>
                  );
                })}
                <div className="mini-now" style={{ left: `${((now - DAY_START) / dayMin) * 100}%` }}/>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============ Placeholders (Planejamento, Carolina) ============
function PlaceholderPage({ icon, pt, en, subtitle, body, eyebrow, before, em, after }) {
  return (
    <div data-page-op="placeholder">
      <PageHead eyebrow={eyebrow || String(pt || '').toUpperCase()}
                before={before != null ? before : ''} em={em != null ? em : pt} after={after || ''}
                sub={subtitle}/>
      <div className="opa-placeholder">
        <div className="opa-ph-ic"><Icon name={icon} size={26}/></div>
        <div className="kit-h2">{pt}</div>
        <p>Em construção. A tela vem numa próxima leva.</p>
        {body}
      </div>
    </div>
  );
}

function PickPackPage({ state, hfdata, raw, openPanel, loading, error, date }) {
  // E7-resto Leva 1: ligada em hfdata real.
  // Sub-passos reais do /api/v3/data/pp:
  //   pp.sub_steps = [{activity, seconds (pessoa-hora soma), wall_seconds (união)}]
  //   pp.person_seconds = [{person, seconds}]
  //   pp.total_seconds = união do tempo de parede (sem dupla contagem cowork)
  // ANTES estava com 4 sub-passos HARDCODED ("Impressão 20m feito, Etiquetagem
  // 105m feito…") — agora vem do backend.
  const HFD = hfdata || window.HFData;
  const { pp = {}, activities = {}, products = {} } = HFD;
  const ppRaw = (raw && raw.pp) || pp._raw || {};
  const now = window.HFH.useNow(true);
  const { fmtDur, fmtClock } = window.HFH;
  const events = state.events || [];

  if (loading) {
    return <div data-page-op="pp"><div className="opa-empty">Carregando P&amp;P…</div></div>;
  }

  // Sub-passos: usa wall_seconds (união) — Bruno pediu específico "não soma".
  const subSteps = (ppRaw.sub_steps || []).slice().sort((a, b) => (b.wall_seconds || 0) - (a.wall_seconds || 0));
  const personSeconds = ppRaw.person_seconds || [];
  // Cowork: events de P&P (flow=pnp) com cowork.length > 0
  const ppEvents = events.filter((e) => (activities[e.activity] || {}).flow === 'pnp');
  const coworkEvents = ppEvents.filter((e) => e.cowork && e.cowork.length > 0);
  const liveCount = ppEvents.filter((e) => e.ended_min == null).length;
  // Correio: do pp.deadline_min real
  const correioMin = pp.deadline_min;
  return (
    <div data-page-op="pp">
      <PageHead eyebrow="PICK &amp; PACK" before="O bloco de " em="P&amp;P" after=" do dia"
                sub="Tempo de parede (sem contar duas vezes quando tem gente junto), ordens fechadas e o corte do correio."/>
      <div className="card" style={{ padding: 22 }}>
        {correioMin != null && (
          <CountdownCard deadlineMin={correioMin} now={now}
                         label="Correio" en="Mailing cut-off"
                         title={`Próximo corte às ${fmtClock(correioMin)}`}/>
        )}
        <div className="kpi-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginTop: 18 }}>
          <KPI label="Tempo total (união)" en="Wall time"
               value={pp.total_minutes ? fmtDur(pp.total_minutes) : '—'}
               foot={<div style={{ fontSize: 11.5, color: 'var(--ink-faint)' }}>
                 {liveCount > 0 ? `${liveCount} ao vivo` : 'sem live'}
               </div>}/>
          <KPI label="Ordens" en="Orders"
               value={pp.orders ? pp.orders.toLocaleString() : '—'}/>
          <KPI label="Tempo/ordem" en="Per order"
               value={pp.seconds_per_order ? `${pp.seconds_per_order}s` : '—'}/>
        </div>
        <Section label="Sub-passos · tempo de parede"/>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {subSteps.length === 0 ? (
            <div style={{ padding: '10px 0', color: 'var(--ink-faint)', fontSize: 13 }}>
              Nenhum sub-passo de P&amp;P registrado em {date || 'hoje'}.
            </div>
          ) : subSteps.map((s) => {
            const wallMin = Math.round((s.wall_seconds || 0) / 60);
            const sumMin = Math.round((s.seconds || 0) / 60);
            const cowork = sumMin > wallMin;   // pessoa-hora > parede → houve cowork
            return (
              <div key={s.activity} className="opa-row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>{s.activity}</div>
                  <div className="mono" style={{ fontSize: 11.5, color: 'var(--ink-dim)', marginTop: 2 }}>
                    parede {fmtDur(wallMin)}{cowork && <> · pessoa-hora {fmtDur(sumMin)} <span style={{ color: 'var(--green-d)' }}>(cowork)</span></>}
                  </div>
                </div>
                <span className="kit-chip neutral">{fmtDur(wallMin)}</span>
              </div>
            );
          })}
        </div>
        {personSeconds.length > 0 && (
          <>
            <Section label="Carga por pessoa · pessoa-hora"/>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 8 }}>
              {personSeconds.sort((a, b) => b.seconds - a.seconds).map((ps) => (
                <div key={ps.person} className="opa-strip-item">
                  <div className="kit-mlabel">{ps.person}</div>
                  <div className="opa-strip-num">{fmtDur(Math.round(ps.seconds / 60))}</div>
                </div>
              ))}
            </div>
          </>
        )}
        {coworkEvents.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <span className="kit-chip dispute">{coworkEvents.length} evento(s) com cowork ativo no P&amp;P</span>
          </div>
        )}
      </div>
    </div>
  );
}

// E7-resto Leva 2: usa raw.support.occurrences (vem do flow-views-repo,
// já com is_downtime calculado pra slug=repair). Inclui também
// clinic_shipment (injeções) que é flow=support.
function SupportPage({ state, hfdata, raw, openPanel, loading, date }) {
  const HFD = hfdata || window.HFData;
  const { operators = [] } = HFD;
  const occurrences = (raw && raw.support && raw.support.occurrences) || [];
  const { fmtClock, fmtDur } = window.HFH;
  const now = window.HFH.useNow(true);
  if (loading) return <div data-page-op="suporte"><div className="opa-empty">Carregando suporte…</div></div>;
  // Sorted by started_at asc
  const sorted = occurrences.slice().sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  // Mapping ISO NY → minutes-since-midnight pra reutilizar fmtClock
  const isoToMin = (iso) => {
    if (!iso) return null;
    const s = String(iso);
    return Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16));
  };
  // Agrega contagens por tipo
  const counts = sorted.reduce((m, o) => { m[o.activity] = (m[o.activity] || 0) + 1; return m; }, {});
  const downtimeCount = sorted.filter((o) => o.is_downtime).length;

  return (
    <div data-page-op="suporte">
      <PageHead eyebrow="SUPORTE" before="Ocorrências de " em="suporte"
                sub="Limpeza, manutenção, conserto e clínica. Conserto conta como parada da linha."/>
      <div className="kit-card pad" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="kit-chip neutral">{sorted.length} ocorrência(s) em {date || 'hoje'}</span>
          {downtimeCount > 0 && <span className="kit-chip bad">{downtimeCount} downtime (conserto)</span>}
          {Object.entries(counts).slice(0, 6).map(([act, c]) => (
            <span key={act} className="kit-chip info">{c} {act}</span>
          ))}
        </div>
      </div>
      <div className="kit-card pad">
        <div className="kit-mlabel" style={{ marginBottom: 8 }}>Registro do dia</div>
        <table className="kit-table">
          <thead>
            <tr>
              <th>Atividade</th>
              <th>Pessoa</th>
              <th className="num">Início</th>
              <th className="num">Duração</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--ink-faint)' }}>
                Sem ocorrências de suporte registradas.
              </td></tr>
            )}
            {sorted.map((o) => {
              const op = operators.find((x) => x.name === o.person);
              const startMin = isoToMin(o.started_at);
              const endMin = o.ended_at ? isoToMin(o.ended_at) : null;
              const durMin = o.seconds != null ? Math.round(o.seconds / 60) : (endMin != null ? endMin - startMin : (now - startMin));
              const live = !o.ended_at;
              return (
                <tr key={o.event_id} className={openPanel ? 'clickable' : ''}
                    onClick={(e) => {
                      if (!openPanel) return;
                      const ev = state.events.find((x) => x.id === o.event_id);
                      if (ev) openPanel(ev, { x: e.clientX, y: e.clientY });
                    }}>
                  <td>
                    <span className="kit-chip dispute">{o.activity}</span>
                    {o.is_downtime && <span className="kit-chip bad" style={{ marginLeft: 6 }}>downtime</span>}
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {op && <OperatorAvatar op={op} size="md"/>}
                      <b style={{ fontWeight: 600 }}>{o.person || '—'}</b>
                    </div>
                  </td>
                  <td className="num">{startMin != null ? fmtClock(startMin) : '—'}</td>
                  <td className="num">{fmtDur(durMin)}</td>
                  <td>
                    {live
                      ? <span className="kit-chip ok">ao vivo</span>
                      : <span className="kit-chip neutral">fechado</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============ Produto (E7-resto Leva 3) ============
// Lista produtos do catálogo + agrega events do dia por produto.
// Counts do dia: raw.counts (vem do production_counts).
function ProductPage({ state, hfdata, raw, openPanel, loading, date }) {
  const HFD = hfdata || window.HFData;
  const { products = {}, activities = {}, operators = [] } = HFD;
  const catalogProducts = (raw && raw.products) || [];
  const countsRaw = (raw && raw.counts) || {};
  const { fmtDur, fmtClock } = window.HFH;
  const now = window.HFH.useNow(true);
  if (loading) return <div data-page-op="produto"><div className="opa-empty">Carregando produtos…</div></div>;

  // Agrega events por product key (b<batch_id>)
  const eventsByProduct = {};
  for (const ev of state.events) {
    if (!ev.product) continue;
    (eventsByProduct[ev.product] = eventsByProduct[ev.product] || []).push(ev);
  }
  // Produtos com atividade hoje
  const activeProductKeys = Object.keys(eventsByProduct);
  const activeProducts = activeProductKeys.map((k) => {
    const p = products[k] || {};
    const evs = eventsByProduct[k].slice().sort((a, b) => a.started_min - b.started_min);
    const totalMin = evs.reduce((s, e) => {
      const end = e.ended_min == null ? now : e.ended_min;
      return s + (end - e.started_min);
    }, 0);
    const phases = Array.from(new Set(evs.map((e) => activities[e.activity]?.name || e.activity)));
    const crew = Array.from(new Set([
      ...evs.map((e) => e.op),
      ...evs.flatMap((e) => e.cowork || []),
    ]));
    const liveCount = evs.filter((e) => e.ended_min == null).length;
    return { key: k, product: p, events: evs, totalMin: Math.round(totalMin), phases, crew, liveCount };
  }).sort((a, b) => b.totalMin - a.totalMin);

  // Counts totals (totals_by_product do backend)
  const totalsByProduct = countsRaw.totals_by_product || {};
  const countsRows = countsRaw.counts || countsRaw.rows || [];

  return (
    <div data-page-op="produto">
      <PageHead eyebrow="PRODUTO" before="Produtos do " em="dia"
                sub="Cada produto com tempo somado, fases percorridas e os eventos que geraram o número."/>
      <Section label={`Com atividade hoje · ${activeProducts.length}`}/>
      {activeProducts.length === 0 && (
        <div className="opa-empty">Nenhum produto com atividade em {date || 'hoje'}.</div>
      )}
      {activeProducts.map((ap) => (
        <div key={ap.key} className="card lote-card" style={{ marginBottom: 12 }}>
          <div className="head">
            <Leaf size={16} color="var(--green-d)"/>
            <h3>{ap.product.name || '(?)'}</h3>
            {ap.product.batch && <span className="batch mono">{ap.product.batch}</span>}
            {ap.liveCount > 0 && <span className="kit-chip ok" style={{ marginLeft: 6 }}>{ap.liveCount} ao vivo</span>}
            <span style={{ flex: 1 }}/>
            <div style={{ display: 'flex', gap: 4 }}>
              {ap.crew.slice(0, 5).map((cwId) => {
                const o = operators.find((x) => x.id === cwId);
                return o ? <OperatorAvatar key={cwId} op={o} size="md"/> : null;
              })}
            </div>
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 16, fontSize: 12.5, color: 'var(--ink-dim)', flexWrap: 'wrap' }}>
            <span>Tempo total · <b className="mono" style={{ color: 'var(--ink)' }}>{fmtDur(ap.totalMin)}</b></span>
            <span>Eventos · <b style={{ color: 'var(--ink)' }}>{ap.events.length}</b></span>
            <span>Fases · <b style={{ color: 'var(--ink)' }}>{ap.phases.length}</b></span>
          </div>
          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {ap.phases.map((ph) => (
              <span key={ph} className="kit-chip neutral">{ph}</span>
            ))}
          </div>
          {ap.events.length > 0 && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dotted var(--dotline)' }}>
              <div className="kit-mlabel" style={{ marginBottom: 6 }}>Eventos do dia</div>
              <table className="kit-table">
                <thead>
                  <tr><th>Horário</th><th>Quem</th><th>Atividade</th><th className="num">Duração</th></tr>
                </thead>
                <tbody>
                  {ap.events.map((ev) => {
                    const op = operators.find((o) => o.id === ev.op);
                    const act = activities[ev.activity];
                    const end = ev.ended_min == null ? now : ev.ended_min;
                    return (
                      <tr key={ev.id} className="clickable"
                          onClick={(e) => openPanel && openPanel(ev, { x: e.clientX, y: e.clientY })}>
                        <td className="num" style={{ textAlign: 'left' }}>
                          {fmtClock(ev.started_min)} → {ev.ended_min == null ? 'live' : fmtClock(ev.ended_min)}
                        </td>
                        <td>{op?.short || '?'}</td>
                        <td>
                          {act?.name || ev.activity}
                          {ev._is_background && <span className="kit-mlabel" style={{ marginLeft: 6 }}>bg</span>}
                        </td>
                        <td className="num">{fmtDur(end - ev.started_min)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {ap.product._product_id && totalsByProduct[ap.product._product_id] != null && (
            <div style={{ marginTop: 12 }}>
              <span className="kit-chip info">Contagens registradas hoje · {totalsByProduct[ap.product._product_id]}</span>
            </div>
          )}
        </div>
      ))}

      {/* Catálogo expandido: produtos sem atividade hoje */}
      {catalogProducts.length > 0 && (
        <>
          <Section label={`Catálogo · ${catalogProducts.length} produtos ativos`}/>
          <div className="kit-card pad">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {catalogProducts.filter((p) => p.active !== false).map((p) => (
                <span key={p.id} className="kit-chip neutral">{p.canonical_name}</span>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FalarPage({ ack }) {
  // Bloco 28/mai noite Leva B — porta completa do /dashboard atual.
  return (
    <div data-page-op="falar">
      <PageHead eyebrow="FALAR" before="Falar como " em="Carolina"
                sub="Porta de saída manual: posta no Slack só quando você clica Enviar. Fica auditado. Independente do Observer, que continua shadow e não posta sozinho."/>
      <div className="kit-card pad">
        <FalarCarolina ack={ack}/>
      </div>
    </div>
  );
}
function PlanPage() {
  return <PlaceholderPage icon="plan" eyebrow="PLANEJAMENTO"
                          before="O que vem pela " em="frente" pt="Planejamento" en="Planning"
                          subtitle="Tasks futuras, o que vem pela frente, notificação opcional por task. Em construção."/>;
}

// ============ Config (E7-resto Leva 3) ============
// CRUD de deadlines (preview · liga no E5). Lista os reais do backend.
function ConfigPage({ raw, ack, loading, V4_ALLOW_WRITES, writes, refresh }) {
  const deadlines = (raw && raw.deadlines && raw.deadlines.deadlines) || [];
  const { fmtMinutes } = window.HFH || {};
  if (loading) return <div data-page-op="config"><div className="opa-empty">Carregando configurações…</div></div>;
  const ackPreview = (msg) => ack && ack(msg);
  return (
    <div data-page-op="config">
      <PageHead eyebrow="CONFIGURAÇÕES" before="Ajustes do " em="sistema"
                sub="Cortes (deadlines) que a linha do tempo e os avisos usam. O resto ainda vive no banco."
                side={(
                  <button className="kit-btn primary" onClick={async () => {
                    const label = window.prompt('Label do deadline (ex.: "Corte do correio"):');
                    if (!label) return;
                    const time = window.prompt('Horário HH:MM (24h NY):', '13:00');
                    if (!time || !/^\d{1,2}:\d{2}$/.test(time)) { ack('Horário inválido'); return; }
                    const flow = window.prompt('Flow (pnp | production | support | vazio):', 'pnp') || null;
                    if (!V4_ALLOW_WRITES || !writes) { ack('preview · sem writes'); return; }
                    const res = await writes.createDeadline({
                      label, time_of_day: time + ':00', flow: flow || null,
                      kind: 'recurring', weekdays: [1, 2, 3, 4, 5], active: true,
                    });
                    if (!res.ok) { ack(`Erro: ${res.error.message || res.error}`); return; }
                    if (refresh) refresh();
                    ack(`Deadline criado · ${label} ${time}`);
                  }}>
                    + Adicionar deadline
                  </button>
                )}/>
      <div className="kit-card pad">
        <div className="kit-mlabel" style={{ marginBottom: 8 }}>Deadlines (cortes) · {deadlines.length} ativo(s)</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {deadlines.length === 0 && <div style={{ padding: '10px 0', color: 'var(--ink-faint)', fontSize: 13 }}>Sem deadlines configurados.</div>}
          {deadlines.map((d) => {
            const wd = (d.weekdays && d.weekdays.length === 7) ? 'todo dia'
              : (d.weekdays && d.weekdays.length === 5) ? 'seg-sex'
              : (d.weekdays && d.weekdays.length > 0) ? d.weekdays.map((n) => 'DSTQQSS'[n] || '?').join(',')
              : '—';
            return (
              <div key={d.id} className="opa-row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>{d.label || '(sem label)'}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-dim)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    {d.flow ? <span className="kit-chip neutral">{d.flow}</span> : null}
                    <span className="mono">{d.time_of_day || d.due_date || '—'}</span>
                    <span>{[d.kind, wd].filter(Boolean).join(' · ')}</span>
                    {!d.active && <span className="kit-chip bad">inativo</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: '0 0 auto' }}>
                  <button className="kit-btn xs" onClick={async () => {
                    const time = window.prompt(`Novo horário HH:MM (24h NY) pra "${d.label}":`, (d.time_of_day || '').slice(0, 5));
                    if (!time || !/^\d{1,2}:\d{2}$/.test(time)) return;
                    if (!V4_ALLOW_WRITES || !writes) { ack('preview · sem writes'); return; }
                    const res = await writes.patchDeadline(d.id, { time_of_day: time + ':00' });
                    if (!res.ok) { ack(`Erro: ${res.error.message || res.error}`); return; }
                    if (refresh) refresh();
                    ack(`Salvo · ${d.label} ${time}`);
                  }} title="Editar horário">
                    <Icon name="edit" size={12}/>
                  </button>
                  <button className="kit-btn xs" onClick={async () => {
                    if (!window.confirm(`Apagar deadline "${d.label}"?`)) return;
                    if (!V4_ALLOW_WRITES || !writes) { ack('preview · sem writes'); return; }
                    const res = await writes.deleteDeadline(d.id);
                    if (!res.ok) { ack(`Erro: ${res.error.message || res.error}`); return; }
                    if (refresh) refresh();
                    ack(`Apagado · deadline ${d.id}`);
                  }} title="Apagar">
                    <Icon name="trash" size={12}/>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="kit-mlabel" style={{ marginTop: 14 }}>
          {V4_ALLOW_WRITES ? 'Edições persistem.' : 'V4_ALLOW_WRITES=0 · edições toastam preview, persistem no E5.'}
        </div>
      </div>
      {/* outras configs ficam pro E5+ — threshold de gap notif, expediente, etc */}
      <div className="kit-card pad" style={{ marginTop: 12 }}>
        <div className="kit-mlabel" style={{ marginBottom: 6 }}>Ainda no banco</div>
        <div style={{ fontSize: 13, color: 'var(--ink-dim)' }}>
          Threshold de gap notificável, expediente NY e expected_seconds dos backgrounds ficam pro E5+.
          Configurável em <span className="mono">v3.settings</span> por ora.
        </div>
      </div>
    </div>
  );
}

function CarolinaPage() {
  return <PlaceholderPage icon="chat" eyebrow="CAROLINA"
                          before="Aprendizado da " em="Carolina" pt="Carolina" en="Carolina"
                          subtitle="Chat de aprendizado da Carolina (Bloco 5). Placeholder no E0, a UI vem depois."/>;
}

Object.assign(window, { ProductionPage, GoalsPage, PeoplePage, PickPackPage, SupportPage, ProductPage, FalarPage, PlanPage, ConfigPage, CarolinaPage });

export { ProductionPage, GoalsPage, PeoplePage, PickPackPage, SupportPage, ProductPage, FalarPage, PlanPage, ConfigPage, CarolinaPage, PlaceholderPage };
