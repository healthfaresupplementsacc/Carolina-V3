/* Página "Ver estoque" (Bruno 08-04): quanto temos de cada produto + EDITAR.
   Colunas: Bins + Caixas SOMAM no ARMAZÉM (=Total). VEEQO é SEPARADO, DEPOIS do
   total (o que está listado pra venda) — NÃO soma no total.
   Editar estoque = escreve no Veeqo (HealthFare Warehouse), com modal de confirmação
   à prova de erro (mostra produto+SKU+atual, set/add, preview, confirmação explícita).
   Fonte: /api/v3/data/stock-overview (SWR). Write: POST /stock/veeqo-set.

   Pele: STYLE-KIT 100% (S15 fase 2). O modal protegido virou kit-modal de 2
   passos (Revisar → Confirmar), a mecânica é a mesma de antes. */
import React from 'react';
import { usePoll, apiPost } from '../adapters/from-api.js';
import { V4_ALLOW_WRITES } from '../flags.js';
import { LegacyBanner } from '../components/Primitives.jsx';
import './pages-inventory.css';

function Chip({ label, value, tone }) {
  return (
    <div className="kit-kpi-card pgi-kpi-card">
      <span className="kit-mlabel pgi-kpi-label">{label}</span>
      <div className={'kit-kpi' + (tone === 'bad' ? ' bad' : tone === 'good' ? ' ok' : '')}>{value}</div>
    </div>
  );
}

/* Modal de edição PROTEGIDO. Mostra exatamente QUE produto e QUE SKU vão mudar,
   o valor atual, set/add, e um PREVIEW do novo valor. Só grava no Confirmar. */
function EditStockModal({ product, onClose, onDone }) {
  const veeqoSkus = product.veeqo_skus || [];
  const [sku, setSku] = React.useState(veeqoSkus[0] || '');
  const [mode, setMode] = React.useState('set');   // 'set' | 'add'
  const [amount, setAmount] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [confirming, setConfirming] = React.useState(false);

  const cur = product.veeqo_stock;                   // estoque atual (total dos SKUs veeqo)
  const n = Number(amount);
  const valid = amount !== '' && Number.isFinite(n) && n >= 0;
  const preview = !valid ? null : (mode === 'add' ? (cur == null ? n : cur + n) : n);

  async function commit() {
    if (!valid || !sku) { setErr('escolha o SKU e um valor válido'); return; }
    if (!V4_ALLOW_WRITES) { setErr('modo leitura (preview), nada foi gravado'); return; }
    setBusy(true); setErr('');
    const res = await apiPost('/stock/veeqo-set', { product_id: product.id, sku, mode, qty: n })
      .catch((e) => ({ error: e.message }));
    setBusy(false);
    if (res && !res.error) { onDone(res.data || res); }
    else setErr(res && res.error ? res.error : 'erro ao gravar');
  }

  return (
    <div className="kit-modal-back" onClick={onClose}>
      <div className="kit-modal" data-modal="editar-veeqo" onClick={(e) => e.stopPropagation()}>
        <span className="kit-eyebrow">● EDITAR ESTOQUE NO VEEQO</span>
        <div className="title">{product.product}</div>
        {product.nickname && <div className="kit-mlabel" style={{ marginTop: 4 }}>{product.nickname}</div>}

        {/* SKU alvo — se houver mais de um SKU Veeqo, escolhe qual */}
        <div style={{ marginTop: 16 }}>
          <span className="kit-mlabel pgi-modal-lbl">SKU do Veeqo (o que vai mudar)</span>
          {veeqoSkus.length === 0 ? (
            <div className="kit-card pad bad" style={{ fontSize: 13, color: 'var(--bad-deep)' }}>
              Este produto não tem SKU do Veeqo mapeado, não dá pra escrever. Ligue um SKU no Product Setup primeiro.
            </div>
          ) : veeqoSkus.length === 1 ? (
            <div className="pgi-modal-sku">{sku}</div>
          ) : (
            <select className="kit-input mono" value={sku} onChange={(e) => setSku(e.target.value)} style={{ width: '100%', marginTop: 5 }}>
              {veeqoSkus.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
        </div>

        <div className="pgi-modal-grid">
          <div>
            <span className="kit-mlabel pgi-modal-lbl">Modo</span>
            <div className="kit-seg">
              <button className={mode === 'set' ? 'on' : ''} onClick={() => setMode('set')}>Contar (=)</button>
              <button className={mode === 'add' ? 'on' : ''} onClick={() => setMode('add')}>Somar (+)</button>
            </div>
          </div>
          <div className="grow">
            <span className="kit-mlabel pgi-modal-lbl">{mode === 'set' ? 'Contagem exata' : 'Quantidade a somar'}</span>
            <input className="kit-input mono" autoFocus value={amount} inputMode="numeric"
              onChange={(e) => { setAmount(e.target.value.replace(/[^\d]/g, '')); setConfirming(false); setErr(''); }}
              placeholder={mode === 'set' ? 'novo total' : '+ quantas'}
              style={{ width: '100%', fontSize: 15 }} />
          </div>
        </div>

        {/* PREVIEW do resultado — deixa claro o que vai virar */}
        <div className="preview">
          Estoque Veeqo: <b>{cur == null ? '—' : cur}</b>
          {valid && <> → <b>{preview}</b>{mode === 'add' ? ' (soma ' + n + ')' : ''}</>}
        </div>

        {err && <div className="pgi-modal-err">{err}</div>}

        <div className="foot">
          <button className="kit-btn sec" onClick={onClose}>Cancelar</button>
          {!confirming ? (
            <button className="kit-btn primary" data-act="revisar" disabled={!valid || !sku || veeqoSkus.length === 0}
              onClick={() => { setErr(''); setConfirming(true); }}>
              Revisar
            </button>
          ) : (
            <button className="kit-btn danger" data-act="confirmar" disabled={busy} onClick={commit}>
              {busy ? 'Gravando…' : 'Confirmar: ' + sku + ' → ' + preview}
            </button>
          )}
        </div>
        {confirming && !busy && (
          <div className="pgi-modal-hint">Passo 2 de 2. Isso grava no Veeqo (armazém HealthFare). Confira o produto e o SKU.</div>
        )}
      </div>
    </div>
  );
}

export function StockOverviewPage() {
  const ov = usePoll('/stock-overview', [], 60000);
  const [q, setQ] = React.useState('');
  const [onlyLow, setOnlyLow] = React.useState(false);
  const [editing, setEditing] = React.useState(null);   // product being edited
  const [flash, setFlash] = React.useState('');
  const [localStock, setLocalStock] = React.useState({}); // id -> new veeqo_stock (otimista)
  const rows = (ov.data || []).map((p) => localStock[p.id] != null ? { ...p, veeqo_stock: localStock[p.id] } : p);
  const loading = ov.loading || (ov.meta && ov.meta.stock_loading);
  const ro = !V4_ALLOW_WRITES;

  const list = rows.filter((p) => {
    if (onlyLow && !(p.has_veeqo_sku && p.veeqo_stock != null && p.veeqo_stock <= 10)) return false;
    if (!q) return true;
    return (p.product + ' ' + (p.nickname || '')).toLowerCase().includes(q.toLowerCase());
  });
  const totVeeqo = rows.reduce((n, p) => n + (p.veeqo_stock || 0), 0);
  const totWh = rows.reduce((n, p) => n + (p.warehouse_stock || 0), 0);
  const lowN = rows.filter((p) => p.has_veeqo_sku && p.veeqo_stock != null && p.veeqo_stock <= 10).length;

  function onDone(res) {
    setLocalStock((m) => ({ ...m, [editing.id]: res.after }));
    setFlash(`✓ ${res.sku}: ${res.before} → ${res.after} no Veeqo`);
    setTimeout(() => setFlash(''), 4000);
    setEditing(null);
  }

  return (
    <div className="pgi-page" data-page="inv-ver-estoque">
      <LegacyBanner />
      <div className="pgi-head">
        <div className="pgi-head-main">
          <span className="kit-eyebrow">● HEALTHFARE · VER ESTOQUE</span>
          <h1 className="kit-h1">Quanto temos de <em>cada</em> produto</h1>
          <p className="kit-sub">
            Armazém (bins + caixas) é o total físico. Veeqo é o que está listado pra venda, separado. Editar grava no Veeqo.
          </p>
        </div>
        <div className="pgi-head-actions">
          {flash && <span className="pgi-flash">{flash}</span>}
          <a className="kit-btn sm sec" href="#estoque">Abrir o hub novo</a>
        </div>
      </div>

      <div className="pgi-kpis">
        <Chip label="Armazém (bins+caixas)" value={totWh || 0} />
        <Chip label="Estoque Veeqo (total)" value={totVeeqo || '—'} tone="good" />
        <Chip label="Baixo no Veeqo (≤10)" value={lowN} tone={lowN ? 'bad' : undefined} />
      </div>

      {loading && (
        <div className="kit-card pad pgi-loading">
          Carregando estoque do Veeqo em segundo plano, os números aparecem em alguns segundos.
        </div>
      )}

      <div className="pgi-toolbar">
        <input className="kit-input grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="buscar produto…" />
        <label className="pgi-check">
          <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} /> só estoque baixo
        </label>
        <span className="pgi-count">{list.length} produtos</span>
        {ro && <span className="kit-chip neutral">somente leitura</span>}
      </div>

      <div className="kit-card pgi-tablecard">
        <table className="kit-table" data-table="ver-estoque">
          <thead><tr>
            <th>Produto</th><th>Nickname</th>
            <th className="num">Bins</th><th className="num">Caixas</th><th className="num">Armazém (total)</th>
            <th className="num sep">Veeqo</th><th />
          </tr></thead>
          <tbody>
            {list.map((p) => {
              const low = p.has_veeqo_sku && p.veeqo_stock != null && p.veeqo_stock <= 10;
              return (
                <tr key={p.id} className={p.active === false ? 'off' : undefined}>
                  <td className="wrapmax strong">{p.product}</td>
                  <td className="mono">{p.nickname || <span style={{ color: 'var(--ink-faint)' }}>—</span>}</td>
                  <td className="num">{p.bin_qty || 0}</td>
                  <td className="num">{p.box_qty || 0}</td>
                  <td className="num strong">{p.warehouse_stock || 0}</td>
                  {/* VEEQO — separado, DEPOIS do total, não soma */}
                  <td className={'num sep strong' + (low ? ' badnum' : '')}>
                    {p.veeqo_stock == null
                      ? <span style={{ color: 'var(--ink-faint)' }}>{p.has_veeqo_sku ? '…' : '—'}</span>
                      : <>{p.veeqo_stock}{low && <span className="kit-chip bad" style={{ marginLeft: 6 }}>baixo</span>}</>}
                  </td>
                  <td className="num">
                    {p.has_veeqo_sku
                      ? <button className="kit-btn xs sec" disabled={ro} onClick={() => setEditing(p)}
                          title={ro ? 'modo leitura' : 'editar estoque no Veeqo'}>editar</button>
                      : <span className="kit-chip neutral">sem SKU Veeqo</span>}
                  </td>
                </tr>
              );
            })}
            {!list.length && !loading && (
              <tr><td colSpan={7} className="pgi-empty">Nenhum produto pra mostrar.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="pgi-note">
        Bins + Caixas = <b>Armazém</b>, o total físico do tracker. <b>Veeqo</b> = estoque vendável no marketplace (separado; editar grava lá, no armazém HealthFare). "—" = sem SKU Veeqo.
      </div>

      {editing && <EditStockModal product={editing} onClose={() => setEditing(null)} onDone={onDone} />}
    </div>
  );
}
