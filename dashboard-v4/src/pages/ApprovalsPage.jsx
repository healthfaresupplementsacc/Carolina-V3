/* Página "Aprovações" (#estoque-aprovacoes) — a fila de propostas do estoque
   (S15 Fase 1). Quem, quando, idade, produto, tipo, qtd, motivo, nota, com
   Aprovar / Recusar (nota opcional). Abas pendentes / histórico.
   STYLE-KIT global (kit.css). Sem travessão em texto de UI. */
import React from 'react';
import * as wh from '../adapters/warehouse-api.js';
import { canRead, canWrite, friendlyError } from './WarehousePage.jsx';

const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR'));

const KIND_LABEL = {
  take: 'pegou do estoque', entrada: 'caixa nova', count: 'contagem',
  return_in: 'devolução', issue_release: 'voltou de Separadas', adjust: 'ajuste',
};

const CONF_LABEL = { high: 'confiança alta', medium: 'confiança média', low: 'confiança baixa' };
const CONF_TONE = { high: 'ok', medium: 'warn', low: 'bad' };
const g = (v) => (v == null || v === '' ? null : Number(v).toLocaleString('pt-BR') + ' g');

/* Detalhe do `meta` da proposta (S15 Fase 3).
   Contagem por PESO: quem aprova precisa ver a conta, não só o número final.
   Bruto menos tara, dividido pelo peso da unidade, dá a quantidade; o resto
   (residual) é o que sobrou da divisão. Residual alto quer dizer que alguma
   coisa está errada: tara velha, garrafa a mais deitada, peso não calibrado.
   Entrada de CAIXA NOVA: mostra lote e área, porque o número da caixa só é
   sorteado na aprovação e não dá pra conferir depois. */
function RequestMeta({ r }) {
  const m = r.meta;
  if (!m || typeof m !== 'object') return null;

  const isWeigh = m.gross_g != null || m.unit_weight_g != null;
  const isBox = m.box === true || m.batch_number != null || m.area != null || m.new_box === true;
  if (!isWeigh && !isBox) return null;

  const cell = (label, value) => (value == null ? null : (
    <span key={label} style={{ display: 'inline-flex', gap: 4, alignItems: 'baseline' }}>
      <span className="kit-mlabel">{label}</span>
      <b style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{value}</b>
    </span>
  ));

  /* A conta da pesagem fica DOBRADA atrás de "ver como foi contado": quem
     aprova pelo celular precisa ler quem·o quê·quanto·onde numa linha só, e a
     conta em gramas empurrava tudo pra baixo. A confiança fica FORA da dobra:
     é ela que diz se vale abrir. */
  if (isWeigh) {
    return (
      <details data-meta="weigh" style={{ marginTop: 5, paddingTop: 5, borderTop: '1px dotted var(--dotline)' }}>
        <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--ink-dim)', display: 'flex', gap: 8, alignItems: 'center', listStyle: 'revert' }}>
          <span>ver como foi contado</span>
          {m.confidence && (
            <span className={'kit-chip ' + (CONF_TONE[m.confidence] || 'neutral')}>
              {CONF_LABEL[m.confidence] || m.confidence}
            </span>
          )}
        </summary>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline', marginTop: 6 }}>
          {cell('Bruto', g(m.gross_g))}
          {cell('Tara', g(m.tare_g))}
          {cell('Líquido', g(m.net_g != null ? m.net_g : (m.gross_g != null && m.tare_g != null ? m.gross_g - m.tare_g : null)))}
          {cell('Unidade', g(m.unit_weight_g))}
          {cell('Contou', m.computed_qty)}
          {cell('Sobra', g(m.residual_g))}
        </div>
      </details>
    );
  }

  return (
    <div data-meta="box"
         style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline',
                  marginTop: 5, paddingTop: 5, borderTop: '1px dotted var(--dotline)' }}>
      <span className="kit-chip info">caixa nova</span>
      {cell('Lote', m.batch_number)}
      {cell('Área', m.area)}
      {cell('Qtd', m.qty != null ? m.qty : r.qty)}
      {m.box_number ? cell('Caixa', m.box_number) : (
        <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>o número da caixa sai na aprovação</span>
      )}
    </div>
  );
}

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

  const ack = (m, bad) => { setToast({ msg: m, bad: !!bad }); setTimeout(() => setToast(null), 2600); };

  async function decide(r, action) {
    setBusy(r.id);
    try {
      await (action === 'approve' ? wh.approveRequest(r.id, { note: note[r.id] || undefined })
                                  : wh.rejectRequest(r.id, { note: note[r.id] || undefined }));
      // diz o que mudou de verdade, não só "ok"
      ack(action === 'approve'
        ? 'Aprovado. O número do produto já mudou.'
        : 'Recusado. Nada mudou no estoque.');
      st.refresh();
    } catch (e) { ack(friendlyError(e), true); }
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
            O operador propõe, você decide. Aprovar muda o número do produto de verdade. Recusar não mexe em nada.
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
      {st.error && (
        <div className="kit-card pad bad" style={{ marginTop: 16 }}>
          Não deu pra carregar a fila. {friendlyError(st.error)} Ela tenta sozinha a cada 30 segundos.
        </div>
      )}

      <div className="kit-card" style={{ marginTop: 14, padding: '8px 14px 4px', overflowX: 'auto' }}>
        <table className="kit-table" data-table="requests">
          <thead>
            <tr>
              <th>Quem</th><th>Quando</th><th className="num">Esperando</th><th>Produto</th>
              <th>O que</th><th className="num">Quantas</th><th>Onde e por quê</th><th>Status</th><th />
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
                <td style={{ color: 'var(--ink-dim)', maxWidth: 340, minWidth: 200 }}>
                  {(r.bin_code || r.box_number) ? (
                    <span className="kit-chip neutral" style={{ fontFamily: 'var(--font-mono)' }}>
                      {r.bin_code ? 'prateleira ' + r.bin_code : 'caixa ' + r.box_number}
                    </span>
                  ) : <span className="kit-chip neutral">sem local</span>}
                  <div style={{ marginTop: 3 }}>{r.reason || r.note || 'sem motivo escrito'}</div>
                  <RequestMeta r={r} />
                </td>
                <td>
                  <span className={'kit-chip ' + (r.status === 'pending' ? 'warn' : r.status === 'approved' ? 'ok' : 'bad')}>
                    {r.status === 'pending' ? 'pendente' : r.status === 'approved' ? 'aprovado' : 'recusado'}
                  </span>
                  {r.decided_by && <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 2 }}>por {r.decided_by}</div>}
                </td>
                <td>
                  {/* alvo de toque >=44px: quem aprova costuma estar no celular */}
                  {writable && r.status === 'pending' && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <input className="kit-input" style={{ width: 130, padding: '6px 8px', fontSize: 12 }}
                             placeholder="nota (opcional)" value={note[r.id] || ''}
                             onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} />
                      <button className="kit-btn sm" style={{ minHeight: 44 }} disabled={busy === r.id} onClick={() => decide(r, 'approve')}>Aprovar</button>
                      <button className="kit-btn sm sec" style={{ minHeight: 44 }} disabled={busy === r.id} onClick={() => decide(r, 'reject')}>Recusar</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {!list.length && !st.loading && (
              <tr><td colSpan={9} style={{ color: 'var(--ink-faint)', padding: 20 }}>
                {tab === 'pending'
                  ? 'Fila vazia, nada esperando você. Quando o operador contar, registrar caixa nova ou devolução, cai aqui.'
                  : 'Nenhuma decisão registrada ainda. O que você aprovar ou recusar aparece nesta aba.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {toast && <div className={'kit-toast ' + (toast.bad ? 'bad' : '')}>{toast.msg}</div>}
    </div>
  );
}
