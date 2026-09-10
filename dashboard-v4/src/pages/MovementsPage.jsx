import React from 'react';
import * as wh from '../adapters/warehouse-api.js';
import { canRead, canWrite, friendlyError, MOV_LABEL } from './WarehousePage.jsx';
import './pages-operacao.css';

/* Página "Movimentos" (#estoque-movimentos) — O LIVRO (Fase B, Bruno 09-10).
   "Toda ação tem que ficar anotada no log e salva" — e visível: aqui está
   tudo o que mexeu em quantidade, filtrável por produto, pessoa, motivo, verbo
   e período, com exportação CSV e o Desfazer (24 h) na linha.
   Só leitura + Desfazer; quantidade continua entrando só pelo StockService.
   STYLE-KIT. Sem travessão em texto de UI. */

const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR'));
const KIND_OPTIONS = [
  ['', 'todos os verbos'], ['store_in', 'entrada'], ['import', 'importado da Veeqo'], ['count', 'contagem'],
  ['adjust', 'ajuste'], ['take', 'saída'], ['transfer', 'transferência'], ['pick', 'saiu em pedido'],
  ['place', 'organizou'], ['move', 'moveu'], ['restock', 'repôs prateleira'], ['damaged', 'separou'],
];
const REVERSIBLE = new Set(['store_in', 'import', 'place', 'adjust', 'count', 'take', 'transfer']);
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const daysAgoIso = (d) => new Date(Date.now() - d * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

export function MovementsPage() {
  const [f, setF] = React.useState({ q: '', person: '', reason: '', kind: '', from: daysAgoIso(30), to: todayIso() });
  const [page, setPage] = React.useState(0);
  const [data, setData] = React.useState(null);
  const [reasons, setReasons] = React.useState([]);
  const [busy, setBusy] = React.useState(null);
  const [flash, setFlash] = React.useState(null);
  const [nonce, setNonce] = React.useState(0);
  const writable = canWrite();
  const LIMIT = 100;

  React.useEffect(() => { wh.getReasons().then((r) => setReasons((r && r.data && r.data.reasons) || [])).catch(() => {}); }, []);
  React.useEffect(() => {
    let alive = true;
    wh.getMovements({ ...f, limit: LIMIT, offset: page * LIMIT })
      .then((r) => { if (alive) setData((r && r.data) || { rows: [], total: 0 }); })
      .catch((e) => { if (alive) setFlash({ bad: true, msg: friendlyError(e) }); });
    return () => { alive = false; };
  }, [f, page, nonce]);

  const set = (k) => (e) => { setPage(0); setF((x) => ({ ...x, [k]: e.target.value })); };
  const undo = async (m) => {
    if (!window.confirm(`Desfazer o movimento ${m.id} (${MOV_LABEL[m.kind] || m.kind} ${m.qty > 0 ? '+' : ''}${m.qty} de ${m.product})?\n\nCria o movimento inverso no mesmo local. Nada é apagado.`)) return;
    setBusy(m.id);
    try { await wh.reverseMovement(m.id, {}); setFlash({ msg: 'Desfeito. O inverso está no livro.' }); setNonce((n) => n + 1); }
    catch (e) { setFlash({ bad: true, msg: friendlyError(e) }); }
    finally { setBusy(null); }
  };

  if (!canRead()) return <div className="opa-empty">Sem acesso ao estoque.</div>;
  const rows = (data && data.rows) || [];
  const total = (data && data.total) || 0;
  const pages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div data-page-op="estoque-movimentos">
      <div className="opa-head">
        <div className="opa-head-main">
          <span className="kit-eyebrow">● HEALTHFARE P&amp;P · MOVIMENTOS</span>
          <h1 className="kit-h1">O <em>livro</em> do estoque</h1>
          <p className="kit-sub">Tudo o que mexeu em quantidade: quem, quando, quanto, por quê e a referência. Nada é apagado; o que foi desfeito aparece com o inverso ligado.</p>
        </div>
        <div className="opa-head-side" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <a className="kit-btn sm sec" href={wh.movementsCsvUrl(f)} target="_blank" rel="noreferrer" data-act="csv">Exportar CSV</a>
          <a className="kit-btn sm sec" href="#estoque">Voltar ao estoque</a>
        </div>
      </div>

      {flash && <div className={'kit-card pad' + (flash.bad ? ' bad' : '')} style={{ marginBottom: 12 }}>{flash.msg}</div>}

      <div className="card" style={{ padding: 14, marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px' }}>
          <span className="kit-mlabel">Produto</span>
          <input className="kit-input" value={f.q} onChange={set('q')} placeholder="nome ou apelido" />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 150px' }}>
          <span className="kit-mlabel">Quem</span>
          <input className="kit-input" value={f.person} onChange={set('person')} placeholder="pessoa ou login" />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="kit-mlabel">Motivo</span>
          <select className="kit-input" value={f.reason} onChange={set('reason')}>
            <option value="">todos</option>
            {reasons.map((r) => <option key={r.code} value={r.code}>{r.label_pt}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="kit-mlabel">Verbo</span>
          <select className="kit-input" value={f.kind} onChange={set('kind')}>
            {KIND_OPTIONS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="kit-mlabel">De</span>
          <input className="kit-input mono" type="date" value={f.from} onChange={set('from')} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="kit-mlabel">Até</span>
          <input className="kit-input mono" type="date" value={f.to} onChange={set('to')} />
        </label>
        <span className="kit-mlabel" style={{ marginLeft: 'auto' }}>{fmt(total)} movimentos</span>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="kit-table" data-table="movimentos">
          <thead><tr>
            <th>Quando</th><th>Produto</th><th>Verbo</th><th className="num">Qtd</th><th>Motivo</th><th>Referência</th><th>Local</th><th>Quem</th><th>Origem</th><th /></tr></thead>
          <tbody>
            {!data && <tr><td colSpan={10} style={{ color: 'var(--ink-faint)', padding: 16 }}>Carregando o livro…</td></tr>}
            {data && !rows.length && <tr><td colSpan={10} style={{ color: 'var(--ink-faint)', padding: 16 }}>Nenhum movimento neste filtro.</td></tr>}
            {rows.map((m) => {
              const undoable = writable && m.within_24h && !m.reversed && !m.reverses_movement_id && REVERSIBLE.has(m.kind)
                && !['veeqo_ship', 'veeqo_import'].includes(m.source);
              return (
                <tr key={m.id} style={{ opacity: m.reversed ? 0.55 : 1 }} data-mov={m.id}>
                  <td className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{String(m.created_at || '').slice(0, 16).replace('T', ' ')}</td>
                  <td><a href={'#estoque'} style={{ fontWeight: 600 }}>{m.product}</a></td>
                  <td><span className="kit-chip neutral">{MOV_LABEL[m.kind] || m.kind}</span>{m.reverses_movement_id ? <span className="kit-chip info" style={{ marginLeft: 4 }} title={'desfaz o movimento ' + m.reverses_movement_id}>desfazer</span> : null}{m.reversed ? <span className="kit-chip warn" style={{ marginLeft: 4 }}>desfeito</span> : null}</td>
                  <td className="num mono" style={{ color: m.qty < 0 ? 'var(--bad-deep)' : 'var(--ok-deep)' }}>{m.qty > 0 ? '+' : ''}{fmt(m.qty)}</td>
                  <td>{m.reason_label || m.reason_code || <span style={{ color: 'var(--ink-faint)' }}>—</span>}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{m.ref_type ? (m.ref_type === 'movement' ? 'mov ' : m.ref_type + ' ') + m.ref_id : '—'}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{m.bin_code || m.box_number || (m.kind === 'store_in' || m.kind === 'import' ? 'a organizar' : '—')}</td>
                  <td>{m.person || <span style={{ color: 'var(--ink-faint)' }}>—</span>}</td>
                  <td style={{ color: 'var(--ink-faint)', fontSize: 12 }}>{m.source}</td>
                  <td>{undoable && <button className="kit-btn xs sec" disabled={busy === m.id} onClick={() => undo(m)} data-act="desfazer">Desfazer</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <button className="kit-btn sm sec" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Anteriores</button>
          <span className="kit-mlabel">página {page + 1} de {pages}</span>
          <button className="kit-btn sm sec" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Próximos</button>
        </div>
      )}
    </div>
  );
}
