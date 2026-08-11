/* Página "Ver estoque" (Bruno 08-04): quanto temos de cada produto + EDITAR.
   Colunas: Bins + Caixas SOMAM no ARMAZÉM (=Total). VEEQO é SEPARADO, DEPOIS do
   total (o que está listado pra venda) — NÃO soma no total.
   Editar estoque = escreve no Veeqo (HealthFare Warehouse), com modal de confirmação
   à prova de erro (mostra produto+SKU+atual, set/add, preview, confirmação explícita).
   Fonte: /api/v3/data/stock-overview (SWR). Write: POST /stock/veeqo-set. */
import React from 'react';
import { usePoll, apiPost } from '../adapters/from-api.js';
import { V4_ALLOW_WRITES } from '../flags.js';

function Th({ children, right }) {
  return <th style={{ padding: '9px 12px', textAlign: right ? 'right' : 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.04, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{children}</th>;
}
function Chip({ label, value, tone }) {
  return (
    <div className="card" style={{ padding: '10px 14px', minWidth: 130 }}>
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.05, fontWeight: 700 }}>{label}</div>
      <div className="mono" style={{ fontSize: 20, fontWeight: 800, color: tone === 'bad' ? 'var(--bad)' : tone === 'good' ? 'var(--hf-leaf-700)' : 'var(--hf-navy-700)' }}>{value}</div>
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
    if (!V4_ALLOW_WRITES) { setErr('modo leitura (preview) — nada foi gravado'); return; }
    setBusy(true); setErr('');
    const res = await apiPost('/stock/veeqo-set', { product_id: product.id, sku, mode, qty: n })
      .catch((e) => ({ error: e.message }));
    setBusy(false);
    if (res && !res.error) { onDone(res.data || res); }
    else setErr(res && res.error ? res.error : 'erro ao gravar');
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: 'min(460px, 96vw)', padding: 20 }}>
        <div style={{ fontSize: 12, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.05, fontWeight: 700 }}>Editar estoque no Veeqo</div>
        <h3 style={{ margin: '4px 0 2px' }}>{product.product}</h3>
        {product.nickname && <div className="mono" style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>{product.nickname}</div>}

        {/* SKU alvo — se houver mais de um SKU Veeqo, escolhe qual */}
        <label style={{ fontSize: 12.5, fontWeight: 600 }}>SKU do Veeqo (o que vai mudar)</label>
        {veeqoSkus.length === 0 ? (
          <div style={{ padding: 10, color: 'var(--bad)', fontSize: 13 }}>Este produto não tem SKU do Veeqo mapeado — não dá pra escrever. Ligue um SKU no Product Setup primeiro.</div>
        ) : veeqoSkus.length === 1 ? (
          <div className="mono" style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, marginTop: 4, fontWeight: 700, background: 'var(--surface-2)' }}>{sku}</div>
        ) : (
          <select value={sku} onChange={(e) => setSku(e.target.value)} className="mono" style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', marginTop: 4, background: 'var(--surface)', color: 'var(--text)' }}>
            {veeqoSkus.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}

        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', marginTop: 14 }}>
          <div>
            <label style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>Modo</label>
            <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <button onClick={() => setMode('set')} style={{ padding: '7px 12px', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, background: mode === 'set' ? 'var(--hf-navy-700)' : 'var(--surface)', color: mode === 'set' ? '#fff' : 'var(--text-2)' }}>Contar (=)</button>
              <button onClick={() => setMode('add')} style={{ padding: '7px 12px', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, background: mode === 'add' ? 'var(--hf-navy-700)' : 'var(--surface)', color: mode === 'add' ? '#fff' : 'var(--text-2)' }}>Somar (+)</button>
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>{mode === 'set' ? 'Contagem exata' : 'Quantidade a somar'}</label>
            <input autoFocus value={amount} inputMode="numeric" onChange={(e) => { setAmount(e.target.value.replace(/[^\d]/g, '')); setConfirming(false); setErr(''); }}
              placeholder={mode === 'set' ? 'novo total' : '+ quantas'}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 15, background: 'var(--surface)', color: 'var(--text)' }} />
          </div>
        </div>

        {/* PREVIEW do resultado — deixa claro o que vai virar */}
        <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 10, background: 'var(--surface-2)', fontSize: 14 }}>
          Estoque Veeqo: <b className="mono">{cur == null ? '—' : cur}</b>
          {valid && <> → <b className="mono" style={{ color: 'var(--hf-navy-700)' }}>{preview}</b> {mode === 'add' && <span style={{ color: 'var(--text-3)', fontSize: 12 }}>(soma {n})</span>}</>}
        </div>

        {err && <div style={{ color: 'var(--bad)', fontSize: 12.5, marginTop: 8 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={{ padding: '8px 14px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', fontSize: 13 }}>Cancelar</button>
          {!confirming ? (
            <button disabled={!valid || !sku || veeqoSkus.length === 0} onClick={() => { setErr(''); setConfirming(true); }}
              style={{ padding: '8px 16px', borderRadius: 9, border: 'none', background: (valid && sku) ? 'var(--hf-navy-700)' : 'var(--border)', color: '#fff', cursor: (valid && sku) ? 'pointer' : 'default', fontSize: 13, fontWeight: 700 }}>
              Revisar…
            </button>
          ) : (
            <button disabled={busy} onClick={commit}
              style={{ padding: '8px 16px', borderRadius: 9, border: 'none', background: 'var(--bad)', color: '#fff', cursor: busy ? 'wait' : 'pointer', fontSize: 13, fontWeight: 700 }}>
              {busy ? 'Gravando…' : `Confirmar: ${sku} → ${preview}`}
            </button>
          )}
        </div>
        {confirming && !busy && <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 8, textAlign: 'right' }}>Isso grava no Veeqo (armazém HealthFare). Confira o produto e o SKU.</div>}
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
    <div style={{ padding: '18px 22px', maxWidth: 1050 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Ver estoque</h2>
        <span style={{ color: 'var(--text-3)', fontSize: 13 }}>Armazém (bins+caixas) = total. Veeqo = listado pra venda (separado). Editar grava no Veeqo.</span>
        {flash && <span style={{ fontSize: 12.5, color: 'var(--hf-leaf-700)', fontWeight: 700 }}>{flash}</span>}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '12px 0' }}>
        <Chip label="Armazém (bins+caixas)" value={totWh || 0} />
        <Chip label="Estoque Veeqo (total)" value={totVeeqo || '—'} tone="good" />
        <Chip label="Baixo no Veeqo (≤10)" value={lowN} tone={lowN ? 'bad' : undefined} />
      </div>

      {loading && (
        <div className="card" style={{ padding: 12, color: 'var(--text-3)', marginBottom: 10, fontSize: 12.5 }}>
          Carregando estoque do Veeqo em segundo plano — os números aparecem em alguns segundos.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="buscar produto…"
          style={{ flex: '1 1 240px', padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 14 }} />
        <label style={{ fontSize: 12.5, display: 'inline-flex', gap: 6, alignItems: 'center', color: 'var(--text-2)' }}>
          <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} /> só estoque baixo
        </label>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{list.length} produtos</span>
      </div>

      <div className="card" style={{ overflowX: 'auto', padding: 0 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead><tr style={{ background: 'var(--surface-2)' }}>
            <Th>Produto</Th><Th>Nickname</Th>
            <Th right>Bins</Th><Th right>Caixas</Th><Th right>Armazém (total)</Th>
            <Th right>Veeqo</Th><Th></Th>
          </tr></thead>
          <tbody>
            {list.map((p) => {
              const low = p.has_veeqo_sku && p.veeqo_stock != null && p.veeqo_stock <= 10;
              return (
                <tr key={p.id} style={{ borderTop: '1px solid var(--border)', opacity: p.active ? 1 : 0.5 }}>
                  <td style={{ padding: '8px 12px', fontWeight: 600, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.product}</td>
                  <td style={{ padding: '8px 12px' }} className="mono">{p.nickname || <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right' }} className="mono">{p.bin_qty || 0}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right' }} className="mono">{p.box_qty || 0}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right' }} className="mono"><b>{p.warehouse_stock || 0}</b></td>
                  {/* VEEQO — separado, DEPOIS do total, não soma */}
                  <td style={{ padding: '8px 12px', textAlign: 'right', borderLeft: '2px solid var(--border)' }} className="mono">
                    {p.veeqo_stock == null
                      ? <span style={{ color: 'var(--text-3)' }}>{p.has_veeqo_sku ? '…' : '—'}</span>
                      : <b style={{ color: low ? 'var(--bad)' : 'inherit' }}>{p.veeqo_stock}{low && <span style={{ fontSize: 10, marginLeft: 4 }}>BAIXO</span>}</b>}
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                    {p.has_veeqo_sku
                      ? <button disabled={ro} onClick={() => setEditing(p)} title={ro ? 'modo leitura' : 'editar estoque no Veeqo'}
                          style={{ fontSize: 12, padding: '5px 11px', borderRadius: 8, border: '1px solid var(--border)', cursor: ro ? 'default' : 'pointer', background: 'var(--surface-2)', color: 'var(--text)', opacity: ro ? 0.5 : 1 }}>editar</button>
                      : <span style={{ fontSize: 11, color: 'var(--text-3)' }}>sem SKU Veeqo</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>
        Bins + Caixas = <b>Armazém</b> (total físico do tracker). <b>Veeqo</b> = estoque vendável no marketplace (separado; editar grava lá, no armazém HealthFare). "—" = sem SKU Veeqo.
      </div>

      {editing && <EditStockModal product={editing} onClose={() => setEditing(null)} onDone={onDone} />}
    </div>
  );
}
