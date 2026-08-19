/* Página "Aprovações" (#estoque-aprovacoes) — a fila de propostas do estoque
   (S15 Fase 1). Quem, quando, idade, produto, tipo, qtd, motivo, nota, com
   Aprovar / Recusar (nota opcional). Abas pendentes / histórico.
   STYLE-KIT global (kit.css). Sem travessão em texto de UI. */
import React from 'react';
import * as wh from '../adapters/warehouse-api.js';
import { canRead, canWrite } from './WarehousePage.jsx';

const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR'));

const KIND_LABEL = {
  take: 'pegou do estoque', entrada: 'entrada', count: 'contagem',
  return_in: 'devolução pra estoque', issue_release: 'separada pra estoque', adjust: 'ajuste',
};

function age(created) {
  if (!created) return '—';
  const ms = Date.now() - Date.parse(created);
  if (Number.isNaN(ms)) return '—';
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return min + 'min';
  const h = Math.floor(min / 60);
  if (h < 48) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

export function ApprovalsPage() {
  const [tab, setTab] = React.useState('pending');
  const [note, setNote] = React.useState({});
  const [busy, setBusy] = React.useState(0);
  const [toast, setToast] = React.useState(null);
  const writable = canWrite();

  const st = wh.useWarehouse('/requests?status=' + (tab === 'pending' ? 'pending' : 'decided'), [tab], 30000);
  const list = (st.data && (st.data.requests || st.data.items || (Array.isArray(st.data) ? st.data : []))) || [];

  const ack = (m) => { setToast(m); setTimeout(() => setToast(null), 2600); };

  async function decide(r, action) {
    setBusy(r.id);
    try {
      await (action === 'approve' ? wh.approveRequest(r.id, { note: note[r.id] || undefined })
                                  : wh.rejectRequest(r.id, { note: note[r.id] || undefined }));
      ack(action === 'approve' ? 'Aprovado' : 'Recusado');
      st.refresh();
    } catch (e) { ack('erro: ' + (e.message || e)); }
    finally { setBusy(0); }
  }

  if (!canRead()) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-dim)' }}>
        <h2 className="kit-h2">Sem acesso</h2>
        <p className="kit-sub">Essa página precisa da função view_stock.</p>
      </div>
    );
  }

  const pendingCount = tab === 'pending' ? list.length : null;

  return (
    <div data-page="aprovacoes" style={{ paddingBottom: 60 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <span className="kit-eyebrow">● HEALTHFARE P&amp;P · APROVAÇÕES</span>
          <h1 className="kit-h1">Propostas <em>esperando</em> decisão</h1>
          <p className="kit-sub">
            Operador propõe, admin ou manager decide. Aprovar aplica o movimento de verdade. Recusar devolve a quantidade.
          </p>
        </div>
        <a className="kit-btn sec" href="#estoque">Voltar ao estoque</a>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
        <div className="kit-seg">
          <button className={tab === 'pending' ? 'on' : ''} onClick={() => setTab('pending')}>Pendentes</button>
          <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>Histórico</button>
        </div>
        {pendingCount != null && <span className="kit-chip warn">{pendingCount} na fila</span>}
      </div>

      {st.loading && !st.data && <div className="kit-card pad" style={{ marginTop: 16, color: 'var(--ink-dim)' }}>Carregando a fila…</div>}
      {st.error && <div className="kit-card pad bad" style={{ marginTop: 16 }}>Não deu pra carregar: {st.error.message}</div>}

      <div className="kit-card" style={{ marginTop: 14, padding: '8px 14px 4px', overflowX: 'auto' }}>
        <table className="kit-table" data-table="requests">
          <thead>
            <tr>
              <th>Quem</th><th>Quando</th><th className="num">Idade</th><th>Produto</th>
              <th>Tipo</th><th className="num">Qtd</th><th>Motivo</th><th>Status</th><th />
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td><b>{r.proposed_by || '—'}</b></td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{String(r.created_at || '').slice(0, 16).replace('T', ' ')}</td>
                <td className="num">{age(r.created_at)}</td>
                <td>{r.product || r.nickname || ('#' + r.product_id)}</td>
                <td><span className="kit-chip neutral">{KIND_LABEL[r.kind] || r.kind}</span></td>
                <td className="num">{r.direction === 'out' ? '−' : '+'}{fmt(r.qty)}</td>
                <td style={{ color: 'var(--ink-dim)', maxWidth: 260 }}>{r.reason || r.note || '—'}</td>
                <td>
                  <span className={'kit-chip ' + (r.status === 'pending' ? 'warn' : r.status === 'approved' ? 'ok' : 'bad')}>
                    {r.status === 'pending' ? 'pendente' : r.status === 'approved' ? 'aprovado' : 'recusado'}
                  </span>
                  {r.decided_by && <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 2 }}>por {r.decided_by}</div>}
                </td>
                <td>
                  {writable && r.status === 'pending' && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input className="kit-input" style={{ width: 130, padding: '4px 8px', fontSize: 12 }}
                             placeholder="nota (opcional)" value={note[r.id] || ''}
                             onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} />
                      <button className="kit-btn xs" disabled={busy === r.id} onClick={() => decide(r, 'approve')}>Aprovar</button>
                      <button className="kit-btn xs sec" disabled={busy === r.id} onClick={() => decide(r, 'reject')}>Recusar</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {!list.length && !st.loading && (
              <tr><td colSpan={9} style={{ color: 'var(--ink-faint)', padding: 20 }}>
                {tab === 'pending' ? 'Nenhuma proposta esperando decisão.' : 'Nenhuma decisão registrada ainda.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {toast && <div className={'kit-toast ' + (String(toast).startsWith('erro') ? 'bad' : '')}>{toast}</div>}
    </div>
  );
}
