// HEALTHFARE V3 — SPA — as telas (Bloco 3b: somente leitura).
import React, { useState } from 'react';
import { useFetch, fmtDur, fmtTime, fmtDateTime } from './api.js';
import { Loading, ErrorBox, Empty, Metric, ConfBadge, GoalBar, ActivityBlock, FlowLegend } from './ui.jsx';

/** Wrapper: trata loading/erro, senão chama render(data,meta). */
function View({ st, children }) {
  if (st.loading) return <Loading />;
  if (st.error) return <ErrorBox error={st.error} />;
  return children(st.data, st.meta);
}

// ── HOJE — visão consolidada ───────────────────────────────
export function Hoje({ date }) {
  const metrics = useFetch('/metrics?date=' + date, [date]);
  const timeline = useFetch('/timeline?date=' + date, [date]);
  const goals = useFetch('/goals?date=' + date, [date]);
  const prod = useFetch('/production?date=' + date, [date]);
  const pp = useFetch('/pp?date=' + date, [date]);
  const sup = useFetch('/support?date=' + date, [date]);

  const m = metrics.data || {};
  const conf = m.by_confidence || {};
  const withConf = ['high', 'medium', 'low', 'unconfirmed'].reduce((s, k) => s + (conf[k] || 0), 0);
  const hm = (conf.high || 0) + (conf.medium || 0);
  const pct = withConf ? Math.round((hm / withConf) * 100) : null;
  const eventCount = (timeline.data ? timeline.data.people : []).reduce((s, p) => s + p.events.length, 0);
  const goalList = goals.data ? goals.data.goals : [];
  const bateu = goalList.filter((g) => g.bateu === true).length;

  return (
    <>
      <h2>Resumo do dia · {date}</h2>
      <div className="cards">
        <Metric label="Processadas" value={metrics.loading ? '…' : (m.total_processed || 0)}
          sub={'erros: ' + (m.errors || 0)} />
        <Metric label="Events criados" value={timeline.loading ? '…' : eventCount} />
        <Metric label="Alta+média confiança" value={pct == null ? '—' : pct + '%'}
          sub={withConf + ' c/ confiança'} />
        <Metric label="Custo do dia" value={metrics.loading ? '…' : '$' + Number(m.cost_estimate_usd || 0).toFixed(4)} />
      </div>

      <h2>Os 3 fluxos</h2>
      <div className="cards">
        <Metric label="Produção" value={prod.loading ? '…' : (prod.data.lotes.length)}
          sub="lotes trabalhados" />
        <Metric label="Picking & Packing" value={pp.loading ? '…' : fmtDur(pp.data.total_seconds)}
          sub="bloco do dia" />
        <Metric label="Suporte" value={sup.loading ? '…' : (sup.data.occurrences.length)}
          sub="ocorrências" />
        <Metric label="Metas" value={goals.loading ? '…' : goalList.length}
          sub={bateu + ' bateram'} />
      </div>
      <p className="small muted">Navegue pelas abas pra ver cada fluxo em detalhe.</p>
    </>
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
