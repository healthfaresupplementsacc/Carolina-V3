/* HEALTHFARE V4 — Busca universal (Bruno 06-26).
   Busca produto / lote / pessoa / tarefa → clicar abre o HISTÓRICO COMPLETO.
   Lote → todo o processo (formulação → envio): quem fez cada fase, quando,
   quanto tempo, o que foi feito (anotações), contagens e tempo total. */
import React from 'react';
import { Icon, Leaf } from './Icons.jsx';
import { apiGet } from '../adapters/from-api.js';

const fmtSec = (s) => {
  const n = Math.round(Number(s) || 0);
  if (n < 60) return n + 's';
  const m = Math.floor(n / 60), r = n % 60;
  if (m < 60) return m + 'm' + (r ? ' ' + r + 's' : '');
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
};
const fmtWhen = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export function SearchOverlay({ open, onClose }) {
  const [q, setQ] = React.useState('');
  const [res, setRes] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [detail, setDetail] = React.useState(null); // {type, loading, data, title}
  const inputRef = React.useRef(null);

  React.useEffect(() => { if (open) { setTimeout(() => inputRef.current && inputRef.current.focus(), 30); } else { setQ(''); setRes(null); setDetail(null); } }, [open]);

  React.useEffect(() => {
    if (!open) return undefined;
    const term = q.trim();
    if (term.length < 1) { setRes(null); setLoading(false); return undefined; }
    setLoading(true);
    const t = setTimeout(() => {
      apiGet('/search?q=' + encodeURIComponent(term)).then(
        (j) => { setRes(j.data); setLoading(false); },
        () => setLoading(false));
    }, 260);
    return () => clearTimeout(t);
  }, [q, open]);

  React.useEffect(() => {
    if (!open) return undefined;
    const h = (e) => { if (e.key === 'Escape') { if (detail) setDetail(null); else onClose(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, detail, onClose]);

  if (!open) return null;

  const load = (type, path, title) => {
    setDetail({ type, loading: true, data: null, title });
    apiGet(path).then((j) => setDetail({ type, loading: false, data: j.data, title }),
      (e) => setDetail({ type, loading: false, data: null, title, error: e.message }));
  };
  const openBatch = (id, title) => load('batch', '/history/batch/' + id, title);
  const openPerson = (id, title) => load('person', '/person/' + id + '/history', title);
  const openProduct = (id, title) => load('product', '/product/' + id + '/history', title);
  const openFamily = (ids, title) => load('family', '/history/product-family?ids=' + ids.join(','), title);

  return (
    <div className="search-overlay" onMouseDown={(e) => { if (e.target.classList.contains('search-overlay')) onClose(); }}>
      <div className="search-modal">
        <div className="search-head">
          {detail ? (
            <button className="icon-btn" onClick={() => setDetail(null)} title="Voltar"><Icon name="left" size={18}/></button>
          ) : <Icon name="search" size={18}/>}
          <input ref={inputRef} className="search-input" value={q} onChange={(e) => setQ(e.target.value)}
                 placeholder="Buscar produto, lote, pessoa ou tarefa…"/>
          <button className="icon-btn" onClick={onClose} title="Fechar (Esc)"><Icon name="x" size={16}/></button>
        </div>
        <div className="search-body">
          {detail
            ? <Detail detail={detail} openBatch={openBatch}/>
            : <Results res={res} loading={loading} q={q} openBatch={openBatch} openPerson={openPerson} openProduct={openProduct}/>}
        </div>
      </div>
    </div>
  );
}

function Group({ title, children }) {
  if (!children || (Array.isArray(children) && children.length === 0)) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.08, fontWeight: 700, marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  );
}
const Row = ({ icon, main, sub, onClick }) => (
  <button onClick={onClick} className="search-row">
    <span className="nav-ico"><Icon name={icon} size={15}/></span>
    <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
      <span style={{ fontWeight: 600, fontSize: 13 }}>{main}</span>
      {sub && <span style={{ color: 'var(--text-3)', fontSize: 11.5, marginLeft: 6 }}>{sub}</span>}
    </span>
    <Icon name="right" size={13}/>
  </button>
);

function Results({ res, loading, q, openBatch, openPerson, openProduct }) {
  if (q.trim().length < 1) return <div className="search-empty">Digite pra buscar — produto, lote (ex. 0234), pessoa ou tarefa. Clique num resultado pra ver o histórico completo.</div>;
  if (loading && !res) return <div className="search-empty">Buscando…</div>;
  if (!res) return null;
  const total = (res.batches || []).length + (res.products || []).length + (res.persons || []).length + (res.tasks || []).length;
  if (total === 0) return <div className="search-empty">Nada encontrado pra "{q}".</div>;
  return (
    <div>
      <Group title="Lotes">
        {(res.batches || []).map((b) => (
          <Row key={'b' + b.id} icon="product" main={b.batch_number || ('lote ' + b.id)}
               sub={`${b.product || 'sem produto'}${b.status ? ' · ' + b.status : ''}`}
               onClick={() => openBatch(b.id, (b.batch_number || ('lote ' + b.id)) + (b.product ? ' · ' + b.product : ''))}/>
        ))}
      </Group>
      <Group title="Produtos">
        {(res.products || []).map((p) => (
          <div key={'p' + p.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
            <Row icon="factory" main={p.name + (p.variant_label ? ' · ' + p.variant_label : '')} sub="ver lotes/contagens"
                 onClick={() => openProduct(p.id, p.name)}/>
            {(p.variants || []).map((v) => (
              <div key={v.id} style={{ paddingLeft: 16 }}>
                <Row icon="factory" main={'↳ ' + v.name} sub={(v.variant_label || 'variante') + ' · feito também'}
                     onClick={() => openProduct(v.id, v.name)}/>
              </div>
            ))}
            {p.parent && (
              <div style={{ paddingLeft: 16 }}>
                <Row icon="factory" main={'↳ ' + p.parent.name} sub="produto-pai"
                     onClick={() => openProduct(p.parent.id, p.parent.name)}/>
              </div>
            )}
            {p.has_family && (
              <button className="search-row" style={{ justifyContent: 'center', color: 'var(--hf-leaf-700)', fontWeight: 700, fontSize: 12, background: 'color-mix(in srgb, var(--hf-leaf-500) 8%, var(--surface-2))' }}
                      onClick={() => openFamily(p.family_ids, p.name + ' + variantes')}>
                <Icon name="merge" size={14}/>&nbsp;Calcular os {p.family_ids.length} juntos (foram feitos em datas/lotes próximos)
              </button>
            )}
          </div>
        ))}
      </Group>
      <Group title="Pessoas">
        {(res.persons || []).map((p) => (
          <Row key={'pe' + p.id} icon="people" main={p.name} sub={p.role}
               onClick={() => openPerson(p.id, p.name)}/>
        ))}
      </Group>
      <Group title="Tarefas">
        {(res.tasks || []).map((t) => (
          <div key={'t' + t.slug} className="search-row" style={{ cursor: 'default' }}>
            <span className="nav-ico"><Icon name="pp" size={15}/></span>
            <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{t.name}</span>
            <span className="mono" style={{ color: 'var(--text-3)', fontSize: 11 }}>{t.flow}</span>
          </div>
        ))}
      </Group>
    </div>
  );
}

function Detail({ detail, openBatch }) {
  if (detail.loading) return <div className="search-empty">Carregando histórico…</div>;
  if (detail.error || !detail.data) return <div className="search-empty" style={{ color: 'var(--bad)' }}>Não consegui carregar: {detail.error || 'sem dados'}</div>;
  if (detail.type === 'batch') return <BatchHistory d={detail.data}/>;
  if (detail.type === 'person') return <PersonHistory d={detail.data} title={detail.title}/>;
  if (detail.type === 'product') return <ProductHistory d={detail.data} openBatch={openBatch}/>;
  if (detail.type === 'family') return <FamilyHistory d={detail.data} title={detail.title} openBatch={openBatch}/>;
  return null;
}

function FamilyHistory({ d, title, openBatch }) {
  const counts = d.counts || {};
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 2 }}>{title}</div>
      <div style={{ color: 'var(--text-3)', fontSize: 12, marginBottom: 10 }}>
        Combinado: {(d.products || []).map((p) => p.name + (p.variant_label ? ' (' + p.variant_label + ')' : '')).join(' + ')}
      </div>
      <div className="card" style={{ padding: 12, marginBottom: 12, display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        <Stat label="Tempo total" value={fmtSec(d.span_seconds)} sub="1ª → última tarefa"/>
        <Stat label="Trabalho efetivo" value={fmtSec(d.total_work_seconds)} sub="todas as variantes"/>
        <Stat label="Tarefas" value={d.event_count}/>
        <Stat label="Pessoas" value={d.people_count}/>
        {counts.bottles != null && <Stat label="Garrafas" value={counts.bottles}/>}
        {counts.orders != null && <Stat label="Ordens" value={counts.orders}/>}
        {counts.clinic != null && <Stat label="Clínica" value={counts.clinic}/>}
      </div>
      <Group title="Lotes da família (clique pra ver o processo)">
        {(d.batches || []).map((b) => (
          <Row key={b.id} icon="product" main={(b.batch_number || ('lote ' + b.id)) + (b.variant_label ? ' · ' + b.variant_label : '')}
               sub={`${b.product || ''} · ${b.status || ''}`} onClick={() => openBatch(b.id, b.batch_number)}/>
        ))}
      </Group>
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div style={{ minWidth: 110 }}>
      <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.05, fontWeight: 700 }}>{label}</div>
      <div className="mono" style={{ fontSize: 17, fontWeight: 700, color: 'var(--hf-navy-700)' }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{sub}</div>}
    </div>
  );
}

function BatchHistory({ d }) {
  const b = d.batch || {};
  const counts = d.counts || {};
  return (
    <div>
      <div style={{ marginBottom: 4 }}>
        <span style={{ fontSize: 16, fontWeight: 800 }}>{b.batch_number || ('lote ' + b.id)}</span>
        <span style={{ color: 'var(--text-3)', marginLeft: 8 }}>{b.product || 'sem produto'}{b.status ? ' · ' + b.status : ''}</span>
      </div>
      <div className="card" style={{ padding: 12, marginBottom: 12, display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        <Stat label="Tempo total" value={fmtSec(d.span_seconds)} sub="início → fim (corrido)"/>
        <Stat label="Trabalho efetivo" value={fmtSec(d.total_work_seconds)} sub="soma das fases (s/ pausa)"/>
        <Stat label="Tarefas" value={d.event_count}/>
        <Stat label="Pessoas" value={(d.people || []).length} sub={(d.people || []).join(', ')}/>
        {counts.bottles && <Stat label="Garrafas" value={counts.bottles.total}/>}
        {counts.orders && <Stat label="Ordens" value={counts.orders.total}/>}
        {counts.clinic && <Stat label="Clínica" value={counts.clinic.total}/>}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.06, fontWeight: 700, marginBottom: 6 }}>
        Por fase
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {(d.by_stage || []).map((s, i) => (
          <span key={i} className="pill" style={{ fontSize: 11.5 }}>
            <span className="dot"/>{s.activity} · {fmtSec(s.seconds)} <span style={{ opacity: 0.6 }}>({s.events}×)</span>
          </span>
        ))}
      </div>
      {/* Impressões de label deste lote — quem imprimiu, quantos, quando, tempo
          físico. É o elo permanente batch↔impressão (Bruno 07-17). */}
      {(d.prints || []).length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.06, fontWeight: 700, marginBottom: 6 }}>
            Impressão de labels · {d.print_summary ? d.print_summary.labels : 0} labels em {d.prints.length} impressão(ões)
            {d.print_summary && d.print_summary.print_seconds > 0 && <span> · {fmtSec(d.print_summary.print_seconds)} imprimindo</span>}
            {d.print_summary && d.print_summary.operators && d.print_summary.operators.length > 0 && <span> · {d.print_summary.operators.join(', ')}</span>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {d.prints.map((pj) => (
              <div key={pj.id} className="card" style={{ padding: '8px 11px', borderLeft: '3px solid var(--flow-prod)' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 12.5 }}>{pj.operator || 'sem PIN'}</b>
                  <span style={{ color: 'var(--text-3)', fontSize: 12 }}>· {pj.sheets != null ? pj.sheets + ' labels' : '—'}</span>
                  {pj.document && <span style={{ color: 'var(--text-3)', fontSize: 11.5 }}>· {pj.document}</span>}
                  <span style={{ flex: 1 }}/>
                  {pj.print_seconds != null
                    ? <span className="mono" style={{ fontSize: 11.5, fontWeight: 700 }} title="tempo físico real (impressora imprimindo)">{fmtSec(pj.print_seconds)} 🖨️</span>
                    : pj.active_seconds != null
                      ? <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }} title="tempo ativo no PC">{fmtSec(pj.active_seconds)} no PC</span>
                      : null}
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                  {fmtWhen(pj.at)}{pj.printer ? ' · ' + pj.printer : ''}{pj.spool_seconds != null ? ' · spooler ' + pj.spool_seconds + 's' : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.06, fontWeight: 700, marginBottom: 6 }}>
        Linha do tempo — cada tarefa
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(d.events || []).map((e) => (
          <div key={e.event_id} className="card" style={{ padding: '9px 11px', borderLeft: `3px solid var(--flow-${e.flow || 'support'})` }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 13 }}>{e.activity}</b>
              <span style={{ color: 'var(--text-3)', fontSize: 12 }}>· {e.person || '?'}</span>
              {e.is_background && <span className="pill" style={{ fontSize: 10 }}>máquina</span>}
              {e.open && <span className="pill" style={{ fontSize: 10, color: 'var(--hf-leaf-700)' }}>aberta</span>}
              {e.exception && <span className="pill" style={{ fontSize: 10, color: 'var(--bad)' }}>exceção</span>}
              <span style={{ flex: 1 }}/>
              <span className="mono" style={{ fontSize: 11.5, fontWeight: 700 }}>{fmtSec(e.work_seconds)}</span>
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
              {fmtWhen(e.started_at)} → {e.open ? 'agora' : fmtWhen(e.ended_at)} · ev {e.event_id}
              {e.orders_printed != null ? ' · ' + e.orders_printed + ' ordens' : ''}
            </div>
            {(e.description || e.exception_reason) && (
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4, fontStyle: 'italic' }}>
                {e.exception_reason ? '⚠ ' + e.exception_reason : e.description}
              </div>
            )}
          </div>
        ))}
        {(d.events || []).length === 0 && <div className="search-empty">Sem tarefas registradas neste lote ainda.</div>}
      </div>
    </div>
  );
}

function PersonHistory({ d, title }) {
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 2 }}>{title}</div>
      <div style={{ color: 'var(--text-3)', fontSize: 12, marginBottom: 12 }}>{d.event_count} tarefas · {d.from} → {d.to}</div>
      {(d.days || []).slice().reverse().map((day) => (
        <div key={day.date} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--hf-navy-700)', marginBottom: 4 }}>{day.date}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {day.events.map((e) => (
              <div key={e.event_id} className="card" style={{ padding: '7px 10px', display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <b style={{ fontSize: 12.5 }}>{e.activity ? e.activity.display_name : '(?)'}</b>
                <span style={{ flex: 1 }}/>
                <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{fmtWhen(e.started_at)} → {e.ended_at ? fmtWhen(e.ended_at) : 'agora'}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      {(d.days || []).length === 0 && <div className="search-empty">Sem atividades no período.</div>}
    </div>
  );
}

function ProductHistory({ d, openBatch }) {
  const p = d.product || {};
  const ps = d.print_summary || null;
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 8 }}>{p.canonical_name || ('produto ' + p.id)}</div>
      {ps && ps.jobs > 0 && (
        <div className="card" style={{ padding: 12, marginBottom: 12, display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <Stat label="Labels impressos" value={ps.labels} sub={`${ps.jobs} impressão(ões)`}/>
          {ps.print_seconds > 0 && <Stat label="Tempo imprimindo" value={fmtSec(ps.print_seconds)} sub="físico real"/>}
          {ps.operators && ps.operators.length > 0 && <Stat label="Quem imprimiu" value={ps.operators.length} sub={ps.operators.join(', ')}/>}
        </div>
      )}
      <Group title="Lotes (clique pra ver o processo)">
        {(d.batches || []).map((b) => (
          <Row key={b.id} icon="product" main={b.batch_number || ('lote ' + b.id)} sub={b.status}
               onClick={() => openBatch(b.id, (b.batch_number || ('lote ' + b.id)) + ' · ' + (p.canonical_name || ''))}/>
        ))}
      </Group>
      {ps && ps.recent && ps.recent.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', fontWeight: 700, margin: '8px 0 6px' }}>Impressões recentes</div>
          {ps.recent.map((pj) => (
            <div key={pj.id} className="card" style={{ padding: '6px 10px', display: 'flex', gap: 10, fontSize: 12.5, alignItems: 'baseline' }}>
              <span className="mono" style={{ color: 'var(--text-3)' }}>{fmtWhen(pj.at)}</span>
              <span style={{ flex: 1 }}>{pj.operator || 'sem PIN'}{pj.batch ? ' · ' + pj.batch.batch_number : ''}</span>
              <b>{pj.sheets != null ? pj.sheets : '—'}</b>
              {pj.print_seconds != null && <span className="mono" style={{ color: 'var(--text-3)' }}>{fmtSec(pj.print_seconds)}</span>}
            </div>
          ))}
        </div>
      )}
      {(d.counts || []).length > 0 && (
        <div>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', fontWeight: 700, margin: '8px 0 6px' }}>Contagens recentes</div>
          {(d.counts || []).slice(-20).reverse().map((c) => (
            <div key={c.id} className="card" style={{ padding: '6px 10px', display: 'flex', gap: 10, fontSize: 12.5 }}>
              <span className="mono">{c.production_date}</span>
              <span style={{ flex: 1 }}>{c.batch ? c.batch.batch_number : '—'}</span>
              <b className="mono">{c.bottles}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

window.SearchOverlay = SearchOverlay;
