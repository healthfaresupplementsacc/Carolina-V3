/* Página "Locais" (#estoque-locais) — cadastro de prateleiras (bins) e caixas.
   É o Blocker #1 do estudo S15: sem local cadastrado a picklist imprime
   "LOCAL A DEFINIR" e todo número fica zero.
   Duas tabelas com formulário inline. Desativar bin (nunca apagar).
   STYLE-KIT global (kit.css). Sem travessão em texto de UI. */
import React from 'react';
import * as wh from '../adapters/warehouse-api.js';
import { canRead, canWrite } from './WarehousePage.jsx';

const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR'));

export function LocationsPage() {
  const writable = canWrite();
  const loc = wh.useWarehouse('/locations', [], 30000);
  const ov = wh.useWarehouse('/overview', [], 0);
  const [toast, setToast] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [bin, setBin] = React.useState({ bin_code: '', shelf_code: '', area: '', product_id: '', min_qty: '' });
  const [box, setBox] = React.useState({ box_number: '', area: '', product_id: '', qty: '' });

  const bins = (loc.data && loc.data.bins) || [];
  const boxes = (loc.data && loc.data.boxes) || [];
  const products = (ov.data && ov.data.products) || [];
  const nameOf = (id) => {
    const p = products.find((x) => x.product_id === id);
    return p ? (p.nickname || p.name) : (id ? '#' + id : '—');
  };

  const ack = (m) => { setToast(m); setTimeout(() => setToast(null), 2600); };

  async function addBin() {
    setBusy(true);
    try {
      await wh.addBin({
        bin_code: bin.bin_code.trim(),
        shelf_code: bin.shelf_code.trim() || undefined,
        area: bin.area.trim() || undefined,
        product_id: bin.product_id ? Number(bin.product_id) : undefined,
        min_qty: bin.min_qty === '' ? undefined : Number(bin.min_qty),
      });
      ack('Prateleira cadastrada');
      setBin({ bin_code: '', shelf_code: '', area: '', product_id: '', min_qty: '' });
      loc.refresh();
    } catch (e) { ack('erro: ' + (e.message || e)); }
    finally { setBusy(false); }
  }

  async function addBox() {
    setBusy(true);
    try {
      await wh.addBox({
        box_number: box.box_number.trim(),
        area: box.area.trim() || undefined,
        product_id: box.product_id ? Number(box.product_id) : undefined,
        qty: box.qty === '' ? undefined : Number(box.qty),
      });
      ack('Caixa cadastrada');
      setBox({ box_number: '', area: '', product_id: '', qty: '' });
      loc.refresh();
    } catch (e) { ack('erro: ' + (e.message || e)); }
    finally { setBusy(false); }
  }

  async function deactivate(b) {
    setBusy(true);
    try { await wh.deactivateBin(b.id); ack('Prateleira desativada'); loc.refresh(); }
    catch (e) { ack('erro: ' + (e.message || e)); }
    finally { setBusy(false); }
  }

  if (!canRead()) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-dim)' }}>
        <h2 className="kit-h2">Sem acesso</h2>
        <p className="kit-sub">Essa página precisa da função view_stock.</p>
      </div>
    );
  }

  const productSelect = (value, onChange) => (
    <select className="kit-input" value={value} onChange={(e) => onChange(e.target.value)} style={{ minWidth: 150 }}>
      <option value="">sem produto</option>
      {products.map((p) => <option key={p.product_id} value={p.product_id}>{p.nickname || p.name}</option>)}
    </select>
  );

  return (
    <div data-page="locais" style={{ paddingBottom: 60 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <span className="kit-eyebrow">● HEALTHFARE P&amp;P · LOCAIS</span>
          <h1 className="kit-h1">Prateleiras e <em>caixas</em></h1>
          <p className="kit-sub">
            Uma prateleira guarda um produto só, cerca de 48 garrafas. Caixa é numerada, fica no palete e guarda mais de 110.
            Sem local cadastrado a picklist não sabe pra onde mandar o operador.
          </p>
        </div>
        <a className="kit-btn sec" href="#estoque">Voltar ao estoque</a>
      </div>

      {loc.error && <div className="kit-card pad bad" style={{ marginTop: 16 }}>Não deu pra carregar os locais: {loc.error.message}</div>}

      {/* PRATELEIRAS */}
      <div className="kit-card pad" style={{ marginTop: 18 }}>
        <div className="kit-mlabel" style={{ marginBottom: 10 }}>Prateleiras (bins)</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="kit-table" data-table="bins">
            <thead><tr><th>Bin</th><th>Prateleira</th><th>Área</th><th>Produto</th><th className="num">Qtd</th><th className="num">Mín</th><th>Status</th><th /></tr></thead>
            <tbody>
              {bins.map((b) => (
                <tr key={b.id}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{b.bin_code}</td>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{b.shelf_code || '—'}</td>
                  <td style={{ color: 'var(--ink-dim)' }}>{b.area || '—'}</td>
                  <td>{b.product || nameOf(b.product_id)}</td>
                  <td className="num">{fmt(b.qty)}</td>
                  <td className="num">{fmt(b.min_qty)}</td>
                  <td>{b.active === false
                    ? <span className="kit-chip neutral">desativada</span>
                    : b.needs_restock ? <span className="kit-chip warn">repor</span> : <span className="kit-chip ok">ok</span>}</td>
                  <td>{writable && b.active !== false && (
                    <button className="kit-btn xs sec" disabled={busy} onClick={() => deactivate(b)}>Desativar</button>
                  )}</td>
                </tr>
              ))}
              {!bins.length && !loc.loading && (
                <tr><td colSpan={8} style={{ color: 'var(--ink-faint)' }}>Nenhuma prateleira cadastrada. Cadastre a primeira no formulário abaixo.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {writable && (
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="kit-input mono" style={{ width: 110 }} placeholder="A03" value={bin.bin_code}
                   onChange={(e) => setBin({ ...bin, bin_code: e.target.value })} />
            <input className="kit-input mono" style={{ width: 90 }} placeholder="S2" value={bin.shelf_code}
                   onChange={(e) => setBin({ ...bin, shelf_code: e.target.value })} />
            <input className="kit-input" style={{ width: 120 }} placeholder="área" value={bin.area}
                   onChange={(e) => setBin({ ...bin, area: e.target.value })} />
            {productSelect(bin.product_id, (v) => setBin({ ...bin, product_id: v }))}
            <input className="kit-input mono" type="number" style={{ width: 90 }} placeholder="mín" value={bin.min_qty}
                   onChange={(e) => setBin({ ...bin, min_qty: e.target.value })} />
            <button className="kit-btn sm primary" disabled={busy || !bin.bin_code.trim()} onClick={addBin}>Adicionar prateleira</button>
          </div>
        )}
      </div>

      {/* CAIXAS */}
      <div className="kit-card pad" style={{ marginTop: 16 }}>
        <div className="kit-mlabel" style={{ marginBottom: 10 }}>Caixas</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="kit-table" data-table="boxes">
            <thead><tr><th>Caixa</th><th>Área / palete</th><th>Produto</th><th className="num">Qtd</th><th>Status</th></tr></thead>
            <tbody>
              {boxes.map((b) => (
                <tr key={b.id}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{b.box_number}</td>
                  <td style={{ color: 'var(--ink-dim)' }}>{b.area || '—'}</td>
                  <td>{b.product || nameOf(b.product_id)}</td>
                  <td className="num">{fmt(b.qty)}</td>
                  <td>{Number(b.qty) > 0 ? <span className="kit-chip ok">em estoque</span> : <span className="kit-chip neutral">vazia</span>}</td>
                </tr>
              ))}
              {!boxes.length && !loc.loading && (
                <tr><td colSpan={5} style={{ color: 'var(--ink-faint)' }}>Nenhuma caixa cadastrada.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {writable && (
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="kit-input mono" style={{ width: 130 }} placeholder="BOX-045" value={box.box_number}
                   onChange={(e) => setBox({ ...box, box_number: e.target.value })} />
            <input className="kit-input" style={{ width: 120 }} placeholder="área" value={box.area}
                   onChange={(e) => setBox({ ...box, area: e.target.value })} />
            {productSelect(box.product_id, (v) => setBox({ ...box, product_id: v }))}
            <input className="kit-input mono" type="number" style={{ width: 90 }} placeholder="qtd" value={box.qty}
                   onChange={(e) => setBox({ ...box, qty: e.target.value })} />
            <button className="kit-btn sm primary" disabled={busy || !box.box_number.trim()} onClick={addBox}>Adicionar caixa</button>
          </div>
        )}
      </div>

      {toast && <div className={'kit-toast ' + (String(toast).startsWith('erro') ? 'bad' : '')}>{toast}</div>}
    </div>
  );
}
