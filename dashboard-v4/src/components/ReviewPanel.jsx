/* ReviewPanel — o painel de REVISÃO do dia (Bruno 08-19).

   O pedido, na íntegra: "quando eu clico em Revisão eu quero um mini calendário
   onde eu clico e escolho a data que eu quero revisar; por exemplo segunda o
   Bruno e a Simone revisaram Charcoal: quero ver quantas garrafas de Charcoal
   eles deram conta de revisar, quanto tempo levaram, e também se o Charcoal já
   rodou na linha de produção (pra toda revisão que já rodou eu preciso de um
   check). Nesse popup eu também preciso de uma barra lateral com TODOS os
   produtos esperando revisão (já fabricados na encapsuladora) que ainda não
   passaram pela linha, scrollável."

   Três perguntas, três áreas:
     ① calendário no cabeçalho  → QUAL dia.
     ② tabela agrupada por produto → quem revisou o quê, quanto e em quanto
       tempo, com o ✓ de "rodou na linha".
     ③ barra lateral → a fila da encapsuladora que ainda espera.

   POR QUE AGRUPADO POR PRODUTO E NÃO POR EVENTO: o Bruno pergunta pelo
   Charcoal, não pelo evento 4812. Duas pessoas revisando o mesmo lote são duas
   linhas no banco e UMA resposta pra ele — por isso cada produto vira um bloco
   com subtotal, e as linhas de cada pessoa ficam embaixo.

   POR QUE A ETIQUETA 'lote' NA COLUNA DE GARRAFAS: quando o operador não
   informou a quantidade, o número vem do alvo do lote (target_bottles). É uma
   estimativa e tem que dizer que é, senão vira número oficial errado.

   A aba "Taxas" guarda o conteúdo antigo (cáps/seg por pessoa/produto em
   7d/30d/custom). Nada do que existia se perdeu; só deixou de ser a primeira
   coisa que aparece.
*/
import React from 'react';
import { Icon } from './Icons.jsx';
import { MiniCalendar, longDate, shortDate } from './MiniCalendar.jsx';
import { getReviewDay, getReviewCalendar, getReviewWaiting, useReviewFetch } from '../adapters/review-api.js';
import './review.css';

/* ── formatação ─────────────────────────────────────────────── */
const fmtDur = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
  if (m > 0) return `${m}min`;
  return `${s}s`;
};
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR'));

/** ✓ do Bruno: "rodou na linha". Inline porque o kit de ícones não tem check e
 *  Icons.jsx não é deste painel pra mexer. */
const Check = ({ size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5"/>
  </svg>
);

const STAGE_ORDER = ['yield_review', 'to_separate', 'to_count', 'label_printing', 'ready_for_line', 'on_line'];
const STAGE_PT = {
  yield_review: 'cápsulas prontas',
  to_separate: 'separar / revisar',
  to_count: 'contar',
  label_printing: 'imprimir labels',
  ready_for_line: 'pronto pra linha',
  on_line: 'na linha',
};

// ════════════════════════════════════════════════════════════════
// Painel
// ════════════════════════════════════════════════════════════════
export function ReviewPanel({ date, today, ratesView }) {
  const [tab, setTab] = React.useState('dia');
  const [day, setDay] = React.useState(date);
  const [month, setMonth] = React.useState((date || '').slice(0, 7));
  const [calOpen, setCalOpen] = React.useState(false);
  const [onlyPending, setOnlyPending] = React.useState(false);

  const dayQ = useReviewFetch(getReviewDay, tab === 'dia' ? day : null);
  const calQ = useReviewFetch(getReviewCalendar, tab === 'dia' ? month : null);
  const waitQ = useReviewFetch(getReviewWaiting, tab === 'dia' ? 'waiting' : null);

  /* O calendário só precisa de {n} por dia; converter aqui deixa o MiniCalendar
     genérico (ele não sabe o que é revisão). */
  const marks = React.useMemo(() => {
    const out = {};
    for (const d of (calQ.data && calQ.data.days) || []) {
      if (d && d.revisions > 0) out[d.date] = { n: d.revisions, bottles: d.bottles };
    }
    return out;
  }, [calQ.data]);

  const pick = (ymd) => {
    setDay(ymd);
    if (ymd.slice(0, 7) !== month) setMonth(ymd.slice(0, 7));
    setCalOpen(false);
  };

  /* Clicar num item já revisado da barra lateral pula o calendário pra aquele
     dia — é o caminho de volta de "esse Charcoal foi revisado quando?" pro
     detalhe do dia. */
  const jumpTo = (iso) => {
    if (!iso) return;
    const ymd = String(iso).slice(0, 10);
    setTab('dia');
    pick(ymd);
  };

  return (
    <div className="rev-panel" data-review-panel>
      {/* ── cabeçalho: data por extenso + calendário ─────────── */}
      <div className="rev-head">
        <div className="rev-head-main">
          <div className="kit-mlabel">Revisão</div>
          <h3 className="rev-title">
            {tab === 'dia'
              ? <>Revisão de <i>{longDate(day)}</i></>
              : <>Taxa de <i>revisão</i></>}
          </h3>
        </div>
        {tab === 'dia' && (
          <div className="rev-cal-wrap">
            <button className="kit-btn sm rev-cal-btn" data-review-cal-btn
                    aria-expanded={calOpen} aria-label="Escolher a data"
                    onClick={() => setCalOpen((v) => !v)}>
              <Icon name="calendar" size={14}/>
              <span className="mono">{shortDate(day)}</span>
            </button>
            {calOpen && (
              <div className="rev-cal-pop" data-review-cal-pop>
                <MiniCalendar month={month} onMonth={setMonth} selected={day}
                              today={date} marks={marks} onPick={pick}
                              loading={calQ.loading}/>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="kit-seg rev-tabs">
        {[['dia', 'Dia'], ['taxas', 'Taxas']].map(([id, label]) => (
          <button key={id} data-review-tab={id} className={tab === id ? 'on' : ''}
                  onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'taxas' ? (
        <div className="rev-rates">{ratesView}</div>
      ) : (
        <div className="rev-body">
          <div className="rev-main" data-review-day>
            <DayView q={dayQ} day={day}/>
          </div>
          <aside className="rev-side" data-review-waiting>
            <WaitingSide q={waitQ} onlyPending={onlyPending}
                         setOnlyPending={setOnlyPending} onJump={jumpTo}/>
          </aside>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// ① Dia — totais + tabela agrupada por produto
// ════════════════════════════════════════════════════════════════
function DayView({ q, day }) {
  if (q.loading && !q.data) return <div className="rev-empty">Carregando o dia…</div>;
  if (q.error) return <div className="rev-err">Erro ao ler o dia: {q.error.message}</div>;

  const d = q.data || {};
  const revisions = d.revisions || [];
  const t = d.totals || {};

  /* Agrupa por produto mantendo a ordem em que o backend mandou (cronológica).
     by_product vem pronto do backend, mas as LINHAS não; agrupo aqui pra não
     depender de duas listas casarem. */
  const groups = React.useMemo(() => {
    const map = new Map();
    for (const r of revisions) {
      const key = (r.product_id != null ? 'p' + r.product_id : 'n' + (r.product || '?'));
      if (!map.has(key)) {
        map.set(key, { key, name: r.nickname || r.product || '(sem produto)', rows: [],
          bottles: 0, hasBottles: false, work_sec: 0, people: new Set(), on_line: false });
      }
      const g = map.get(key);
      g.rows.push(r);
      /* Só soma garrafa que EXISTE. Revisão sem quantidade e sem lote (a Ana
         revisando avulso) não vale zero: vale "não informado". Somar como 0
         faria o subtotal mentir dizendo que ninguém revisou nada. */
      if (r.bottles != null) { g.bottles += Number(r.bottles) || 0; g.hasBottles = true; }
      g.work_sec += Number(r.work_sec) || 0;
      if (r.operator) g.people.add(r.operator);
      if (r.on_line) g.on_line = true;
    }
    return [...map.values()];
  }, [revisions]);

  if (!revisions.length) {
    return (
      <div className="rev-empty" data-review-empty>
        <b>Nenhuma revisão nesse dia</b>
        <span>{shortDate(day)} não tem revisão registrada. Escolha outro dia no calendário do topo.</span>
      </div>
    );
  }

  return (
    <>
      <div className="rev-totals" data-review-totals>
        <Stat label="Revisões" value={num(t.revisions)}/>
        <Stat label="Garrafas" value={num(t.bottles)} strong/>
        <Stat label="Tempo" value={fmtDur(t.work_sec)}/>
        <Stat label="Produtos" value={num(t.products)}/>
        <Stat label="Já na linha" value={<span className="rev-ok-inline"><Check size={16}/> {num(t.on_line)}</span>}/>
      </div>

      {groups.map((g) => (
        <div key={g.key} className="rev-group" data-review-group={g.name}>
          <div className="rev-group-head">
            <b className="rev-group-name">{g.name}</b>
            {g.on_line
              ? <span className="kit-chip ok rev-chip-ico"><Check size={12}/> rodou na linha</span>
              : <span className="kit-chip warn">ainda não rodou</span>}
            <span className="rev-group-sub">
              {g.hasBottles
                ? <><b>{num(g.bottles)}</b> garrafas · </>
                : <><b>sem quantidade</b> · </>}
              {fmtDur(g.work_sec)} · {[...g.people].join(', ') || '—'}
            </span>
          </div>
          <table className="kit-table rev-table">
            <thead>
              <tr>
                <th>Quem</th>
                <th>Lote</th>
                <th className="num">Garrafas</th>
                <th className="num">Tempo</th>
                <th className="num">seg/frasco</th>
                <th>Linha</th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r, i) => (
                <tr key={r.event_id != null ? r.event_id : i} data-review-row>
                  <td><b className="rev-who">{r.operator || '(?)'}</b></td>
                  <td className="mono rev-batch">{r.batch_number || '—'}</td>
                  <td className="num">
                    {num(r.bottles)}
                    {r.bottles != null && r.bottles_source === 'lote'
                      && <span className="rev-tag" title="Estimativa: o operador não informou a quantidade, veio do alvo do lote">lote</span>}
                  </td>
                  <td className="num">{r.work_sec != null ? fmtDur(r.work_sec) : '—'}</td>
                  <td className="num">{r.sec_per_bottle != null ? r.sec_per_bottle : '—'}</td>
                  <td>
                    {r.on_line ? (
                      <span className="rev-ok" data-review-online="1"
                            title={`Rodou na linha em ${r.on_line_at ? shortDate(String(r.on_line_at).slice(0, 10)) : '?'}`
                              + (r.line_bottles != null ? ` · ${num(r.line_bottles)} garrafas` : '')}>
                        <Check/>
                      </span>
                    ) : (
                      <span className="kit-chip neutral" data-review-online="0">ainda não</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <div className="kit-mlabel rev-note">
        Garrafas marcadas com <span className="rev-tag">lote</span> vieram do alvo do lote, não da contagem do operador.
        O tempo desconta as pausas. O ✓ diz que aquele lote já rodou na linha de produção.
      </div>
    </>
  );
}

function Stat({ label, value, strong }) {
  return (
    <div className="rev-stat">
      <div className="kit-mlabel">{label}</div>
      <div className={'rev-stat-v' + (strong ? ' strong' : '')}>{value}</div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// ② Barra lateral — a fila da encapsuladora
// ════════════════════════════════════════════════════════════════
function WaitingSide({ q, onlyPending, setOnlyPending, onJump }) {
  const d = q.data || {};
  const counts = d.counts || {};
  const all = d.items || [];
  const items = onlyPending ? all.filter((i) => !i.reviewed) : all;

  return (
    <>
      <div className="rev-side-head">
        <div className="kit-mlabel">Cápsulas esperando</div>
        <div className="rev-side-counts">
          <span className="kit-chip warn" data-count-pending>{counts.not_reviewed || 0} sem revisão</span>
          <span className="kit-chip info" data-count-waiting>{counts.reviewed_waiting_line || 0} esperando a linha</span>
          <span className="kit-chip ok rev-chip-ico" data-count-online><Check size={11}/> {counts.on_line || 0} na linha</span>
        </div>
        <button className={'kit-btn xs rev-filter' + (onlyPending ? ' primary' : '')}
                data-review-filter aria-pressed={onlyPending}
                onClick={() => setOnlyPending(!onlyPending)}>
          <Icon name="filter" size={11}/> só sem revisão
        </button>
        {q.data && q.data.ems_ok === false && (
          <div className="rev-ems-off" data-review-ems-off>
            EMS fora do ar: mostrando o último estado conhecido.
          </div>
        )}
      </div>

      <div className="rev-side-list">
        {q.loading && !q.data ? <div className="rev-empty sm">Carregando a fila…</div>
          : q.error ? <div className="rev-err">Erro ao ler o EMS: {q.error.message}</div>
          : items.length === 0 ? (
            <div className="rev-empty sm">
              {onlyPending ? 'Nada sem revisão. A fila está limpa.' : 'Nada esperando revisão agora.'}
            </div>
          ) : items.map((it, i) => (
            <div key={(it.batch_number || '') + i} className="rev-wait" data-review-wait-item
                 role={it.reviewed_at ? 'button' : undefined}
                 tabIndex={it.reviewed_at ? 0 : undefined}
                 onClick={() => it.reviewed_at && onJump(it.reviewed_at)}
                 onKeyDown={(e) => { if (it.reviewed_at && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onJump(it.reviewed_at); } }}
                 title={it.reviewed_at ? 'Ver o dia em que foi revisado' : undefined}>
              <div className="rev-wait-top">
                <b className="rev-wait-name">{it.nickname || it.product || '(?)'}</b>
                <span className="mono rev-wait-batch">{it.batch_number || '—'}</span>
              </div>
              <div className="rev-wait-mid">
                <span className="kit-chip neutral">{it.ems_stage_label || STAGE_PT[it.ems_stage] || it.ems_stage || '—'}</span>
                <span className="rev-wait-qty">{num(it.actual_bottles != null ? it.actual_bottles : it.target_bottles)} garrafas</span>
              </div>
              <div className="rev-wait-foot">
                {it.waiting_days != null && (
                  <span className={'rev-days' + (it.waiting_days >= 7 ? ' late' : '')}>
                    encapsulado há {it.waiting_days} {it.waiting_days === 1 ? 'dia' : 'dias'}
                  </span>
                )}
                {it.on_line ? (
                  <span className="kit-chip ok rev-chip-ico"><Check size={11}/> na linha</span>
                ) : it.reviewed ? (
                  <span className="kit-chip info">
                    revisado{(it.reviewed_by || []).length ? ' por ' + it.reviewed_by.join(', ') : ''}
                    {it.reviewed_at ? ' em ' + shortDate(String(it.reviewed_at).slice(0, 10)) : ''}
                  </span>
                ) : (
                  <span className="kit-chip warn">sem revisão</span>
                )}
              </div>
            </div>
          ))}
      </div>
    </>
  );
}

export default ReviewPanel;
