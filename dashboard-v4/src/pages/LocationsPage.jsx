/* Página "Locais" (#estoque-locais) — cadastro de prateleiras (bins) e caixas.
   É o Blocker #1 do estudo S15: sem local cadastrado a picklist imprime
   "LOCAL A DEFINIR" e todo número fica zero.
   Duas tabelas com formulário inline. Desativar bin (nunca apagar).

   S15 Fase 3 acrescenta o que a contagem por peso e a etiqueta precisam:
     - prateleira: TARA (peso vazia, em gramas) e CAPACIDADE (cabe quantas);
     - caixa: TARA, LOTE (batch) e LACRADA;
     - seleção por caixinha nas duas tabelas → "Imprimir etiquetas" abre a
       página de etiquetas com a seleção no hash.
   Sem tara não dá pra pesar pra contar: a balança mede bruto, o sistema tira a
   tara e divide pelo peso da garrafa.

   STYLE-KIT global (kit.css). Sem travessão em texto de UI. */
import React from 'react';
import * as wh from '../adapters/warehouse-api.js';
import { canRead, canWrite, friendlyError } from './WarehousePage.jsx';

const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR'));
const fmtG = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString('pt-BR') + ' g');

/** Célula editável de número: salva no blur, só se mudou. Vazio = null. */
function NumCell({ value, suffix, width = 74, disabled, placeholder, onSave }) {
  const [v, setV] = React.useState(value == null ? '' : String(value));
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { setV(value == null ? '' : String(value)); }, [value]);
  const commit = async () => {
    const now = v.trim();
    const before = value == null ? '' : String(value);
    if (now === before) return;
    setBusy(true);
    try { await onSave(now === '' ? null : Number(now)); }
    finally { setBusy(false); }
  };
  if (disabled) return <span style={{ fontFamily: 'var(--font-mono)' }}>{value == null ? '—' : fmt(value) + (suffix || '')}</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input className="kit-input mono" type="number" style={{ width, padding: '4px 7px', fontSize: 12.5 }}
             value={v} placeholder={placeholder} disabled={busy}
             onChange={(e) => setV(e.target.value)}
             onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
             onBlur={commit} />
      {suffix ? <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{suffix}</span> : null}
    </span>
  );
}

export function LocationsPage() {
  const writable = canWrite();
  const loc = wh.useWarehouse('/locations', [], 30000);
  const ov = wh.useWarehouse('/overview', [], 0);
  const [toast, setToast] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [bin, setBin] = React.useState({ bin_code: '', shelf_code: '', area: '', product_id: '', min_qty: '', tare_g: '', capacity: '' });
  const [box, setBox] = React.useState({ box_number: '', area: '', product_id: '', qty: '', batch_number: '' });
  // seleção pra etiquetas: Sets de id
  const [selBins, setSelBins] = React.useState(() => new Set());
  const [selBoxes, setSelBoxes] = React.useState(() => new Set());

  const bins = (loc.data && loc.data.bins) || [];
  const boxes = (loc.data && loc.data.boxes) || [];
  const products = (ov.data && ov.data.products) || [];
  const nameOf = (id) => {
    const p = products.find((x) => x.product_id === id);
    return p ? (p.nickname || p.name) : (id ? '#' + id : '—');
  };

  const ack = (m, bad) => { setToast({ msg: m, bad: !!bad }); setTimeout(() => setToast(null), 2600); };

  const toggle = (setFn) => (id) => setFn((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const toggleBin = toggle(setSelBins);
  const toggleBox = toggle(setSelBoxes);
  const selCount = selBins.size + selBoxes.size;

  function printLabels() {
    const qs = [];
    if (selBins.size) qs.push('bins=' + [...selBins].join(','));
    if (selBoxes.size) qs.push('boxes=' + [...selBoxes].join(','));
    window.location.hash = '#estoque-etiquetas' + (qs.length ? '?' + qs.join('&') : '');
  }

  async function addBin() {
    setBusy(true);
    try {
      await wh.addBin({
        bin_code: bin.bin_code.trim(),
        shelf_code: bin.shelf_code.trim() || undefined,
        area: bin.area.trim() || undefined,
        product_id: bin.product_id ? Number(bin.product_id) : undefined,
        min_qty: bin.min_qty === '' ? undefined : Number(bin.min_qty),
        tare_g: bin.tare_g === '' ? undefined : Number(bin.tare_g),
        capacity: bin.capacity === '' ? undefined : Number(bin.capacity),
      });
      ack('Prateleira cadastrada');
      setBin({ bin_code: '', shelf_code: '', area: '', product_id: '', min_qty: '', tare_g: '', capacity: '' });
      loc.refresh();
    } catch (e) { ack(friendlyError(e), true); }
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
        batch_number: box.batch_number.trim() || undefined,
      });
      ack('Caixa cadastrada');
      setBox({ box_number: '', area: '', product_id: '', qty: '', batch_number: '' });
      loc.refresh();
    } catch (e) { ack(friendlyError(e), true); }
    finally { setBusy(false); }
  }

  async function deactivate(b) {
    setBusy(true);
    try { await wh.deactivateBin(b.id); ack('Prateleira desativada'); loc.refresh(); }
    catch (e) { ack(friendlyError(e), true); }
    finally { setBusy(false); }
  }

  async function saveBin(b, patch, okMsg) {
    try { await wh.setBinWeight(b.id, patch); ack(okMsg); loc.refresh(); }
    catch (e) { ack(friendlyError(e), true); }
  }
  async function saveBox(b, patch, okMsg) {
    try { await wh.setBoxWeight(b.id, patch); ack(okMsg); loc.refresh(); }
    catch (e) { ack(friendlyError(e), true); }
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
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {/* botão desabilitado tem que dizer o que falta, senão parece quebrado */}
          <button className="kit-btn primary" data-act="etiquetas" disabled={!selCount} onClick={printLabels}
                  title={selCount ? 'Abrir as etiquetas selecionadas' : 'Marque as caixinhas das prateleiras ou caixas que quer etiquetar'}>
            {selCount ? 'Imprimir etiquetas (' + selCount + ')' : 'Imprimir etiquetas'}
          </button>
          {!selCount && (
            <span style={{ fontSize: 12.5, color: 'var(--ink-dim)', alignSelf: 'center' }}>
              marque as caixinhas da esquerda pra liberar
            </span>
          )}
          <a className="kit-btn sec" href="#estoque">Voltar ao estoque</a>
        </div>
      </div>

      <div className="kit-card pad" style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="kit-mlabel">Tara e capacidade</span>
        <span style={{ fontSize: 12.5, color: 'var(--ink-dim)', flex: 1, minWidth: 240 }}>
          Tara é o peso da prateleira ou da caixa vazia, em gramas. É o que permite pesar pra contar em vez de contar garrafa por garrafa.
          Capacidade é quantas garrafas cabem.
        </span>
        <a className="kit-btn xs sec" href="#config-estoque">Taras padrão</a>
      </div>

      {loc.error && (
        <div className="kit-card pad bad" style={{ marginTop: 16 }}>
          Não deu pra carregar os locais. {friendlyError(loc.error)} A página tenta sozinha a cada 30 segundos.
        </div>
      )}

      {/* PRATELEIRAS */}
      <div className="kit-card pad" style={{ marginTop: 18 }}>
        <div className="kit-mlabel" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>Prateleiras (bins)</span>
          {selBins.size > 0 && <span className="kit-chip neutral">{selBins.size} selecionadas</span>}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="kit-table" data-table="bins">
            <thead><tr>
              <th style={{ width: 30 }} />
              <th>Bin</th><th>Prateleira</th><th>Área</th><th>Produto</th>
              <th className="num">Qtd</th><th className="num">Mín</th>
              <th className="num">Tara</th><th className="num">Cabe</th>
              <th>Status</th><th />
            </tr></thead>
            <tbody>
              {bins.map((b) => (
                <tr key={b.id} data-bin={b.id}>
                  <td>
                    <input type="checkbox" data-sel-bin={b.id} checked={selBins.has(b.id)}
                           onChange={() => toggleBin(b.id)} aria-label={'selecionar ' + b.bin_code} />
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{b.bin_code}</td>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{b.shelf_code || '—'}</td>
                  <td style={{ color: 'var(--ink-dim)' }}>{b.area || '—'}</td>
                  <td>{b.product || nameOf(b.product_id)}</td>
                  <td className="num">{fmt(b.qty)}</td>
                  <td className="num">{fmt(b.min_qty)}</td>
                  <td className="num" data-cell="tare">
                    <NumCell value={b.tare_g} suffix="g" placeholder="tara" disabled={!writable}
                             onSave={(v) => saveBin(b, { tare_g: v }, 'Tara salva')} />
                  </td>
                  <td className="num" data-cell="capacity">
                    <NumCell value={b.capacity} width={62} placeholder="48" disabled={!writable}
                             onSave={(v) => saveBin(b, { capacity: v }, 'Capacidade salva')} />
                  </td>
                  <td>{b.active === false
                    ? <span className="kit-chip neutral">desativada</span>
                    : b.needs_restock ? <span className="kit-chip warn">repor</span> : <span className="kit-chip ok">ok</span>}</td>
                  <td>{writable && b.active !== false && (
                    <button className="kit-btn xs sec" disabled={busy} onClick={() => deactivate(b)}>Desativar</button>
                  )}</td>
                </tr>
              ))}
              {!bins.length && !loc.loading && (
                <tr><td colSpan={11} style={{ color: 'var(--ink-faint)' }}>
                  Nenhuma prateleira cadastrada. Comece pela primeira aqui embaixo: código (ex: A03), prateleira (ex: S2) e o produto que mora nela.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {/* Cadastrar prateleira = 3 campos: código, prateleira, produto. Tara,
            mínimo e capacidade são ajuste fino e ficam dobrados: dá pra editar
            depois direto na tabela, e sete campos numa linha faziam o Bruno e o
            Henrique travarem no dia 1. */}
        {writable && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input className="kit-input mono" style={{ width: 110 }} placeholder="código, ex: A03" value={bin.bin_code}
                     onChange={(e) => setBin({ ...bin, bin_code: e.target.value })} />
              <input className="kit-input mono" style={{ width: 110 }} placeholder="prateleira, ex: S2" value={bin.shelf_code}
                     onChange={(e) => setBin({ ...bin, shelf_code: e.target.value })} />
              {productSelect(bin.product_id, (v) => setBin({ ...bin, product_id: v }))}
              <button className="kit-btn sm primary" disabled={busy || !bin.bin_code.trim()} onClick={addBin}>Adicionar prateleira</button>
            </div>
            <details data-more="bin" style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--ink-dim)' }}>
                área, mínimo, tara e capacidade (dá pra preencher depois)
              </summary>
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input className="kit-input" style={{ width: 120 }} placeholder="área" value={bin.area}
                       onChange={(e) => setBin({ ...bin, area: e.target.value })} />
                <input className="kit-input mono" type="number" style={{ width: 90 }} placeholder="mín" value={bin.min_qty}
                       onChange={(e) => setBin({ ...bin, min_qty: e.target.value })} />
                <input className="kit-input mono" type="number" style={{ width: 100 }} placeholder="tara g" value={bin.tare_g}
                       onChange={(e) => setBin({ ...bin, tare_g: e.target.value })} />
                <input className="kit-input mono" type="number" style={{ width: 90 }} placeholder="cabe" value={bin.capacity}
                       onChange={(e) => setBin({ ...bin, capacity: e.target.value })} />
              </div>
            </details>
          </div>
        )}
      </div>

      {/* CAIXAS */}
      <div className="kit-card pad" style={{ marginTop: 16 }}>
        <div className="kit-mlabel" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>Caixas</span>
          {selBoxes.size > 0 && <span className="kit-chip neutral">{selBoxes.size} selecionadas</span>}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="kit-table" data-table="boxes">
            <thead><tr>
              <th style={{ width: 30 }} />
              <th>Caixa</th><th>Área / palete</th><th>Produto</th><th className="num">Qtd</th>
              <th>Lote</th><th className="num">Tara</th><th>Lacrada</th><th>Etiqueta</th><th>Status</th>
            </tr></thead>
            <tbody>
              {boxes.map((b) => (
                <tr key={b.id} data-box={b.id}>
                  <td>
                    <input type="checkbox" data-sel-box={b.id} checked={selBoxes.has(b.id)}
                           onChange={() => toggleBox(b.id)} aria-label={'selecionar ' + b.box_number} />
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{b.box_number}</td>
                  <td style={{ color: 'var(--ink-dim)' }}>{b.area || '—'}</td>
                  <td>{b.product || nameOf(b.product_id)}</td>
                  <td className="num">{fmt(b.qty)}</td>
                  <td data-cell="batch">
                    {writable ? (
                      <input className="kit-input mono" style={{ width: 106, padding: '4px 7px', fontSize: 12.5 }}
                             defaultValue={b.batch_number || ''} placeholder="lote"
                             onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                             onBlur={(e) => {
                               const v = e.target.value.trim();
                               if (v === (b.batch_number || '')) return;
                               saveBox(b, { batch_number: v || null }, 'Lote salvo');
                             }} />
                    ) : (b.batch_number || '—')}
                  </td>
                  <td className="num" data-cell="tare">
                    <NumCell value={b.tare_g} suffix="g" placeholder="tara" disabled={!writable}
                             onSave={(v) => saveBox(b, { tare_g: v }, 'Tara salva')} />
                  </td>
                  <td data-cell="sealed">
                    {writable ? (
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink-dim)' }}>
                        <input type="checkbox" checked={!!b.sealed}
                               onChange={(e) => saveBox(b, { sealed: e.target.checked }, e.target.checked ? 'Caixa lacrada' : 'Lacre removido')} />
                        {b.sealed ? 'sim' : 'não'}
                      </label>
                    ) : (b.sealed ? <span className="kit-chip ok">lacrada</span> : <span className="kit-chip neutral">aberta</span>)}
                  </td>
                  <td>
                    {b.label_printed_at
                      ? <span className="kit-chip ok" title={String(b.label_printed_at)}>impressa</span>
                      : <span className="kit-chip warn">sem etiqueta</span>}
                  </td>
                  <td>{Number(b.qty) > 0 ? <span className="kit-chip ok">em estoque</span> : <span className="kit-chip neutral">vazia</span>}</td>
                </tr>
              ))}
              {!boxes.length && !loc.loading && (
                <tr><td colSpan={10} style={{ color: 'var(--ink-faint)' }}>
                  Nenhuma caixa cadastrada. As caixas que o operador registrar em Caixa nova aparecem aqui depois que você aprovar.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {writable && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input className="kit-input mono" style={{ width: 130 }} placeholder="número, ex: BX-0451" value={box.box_number}
                     onChange={(e) => setBox({ ...box, box_number: e.target.value })} />
              {productSelect(box.product_id, (v) => setBox({ ...box, product_id: v }))}
              <input className="kit-input mono" type="number" style={{ width: 110 }} placeholder="quantas" value={box.qty}
                     onChange={(e) => setBox({ ...box, qty: e.target.value })} />
              <button className="kit-btn sm primary" disabled={busy || !box.box_number.trim()} onClick={addBox}>Adicionar caixa</button>
            </div>
            <details data-more="box" style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--ink-dim)' }}>
                área e lote (dá pra preencher depois)
              </summary>
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input className="kit-input" style={{ width: 140 }} placeholder="área ou palete" value={box.area}
                       onChange={(e) => setBox({ ...box, area: e.target.value })} />
                <input className="kit-input mono" style={{ width: 130 }} placeholder="lote" value={box.batch_number}
                       onChange={(e) => setBox({ ...box, batch_number: e.target.value })} />
              </div>
            </details>
          </div>
        )}
      </div>

      {toast && <div className={'kit-toast ' + (toast.bad ? 'bad' : '')}>{toast.msg}</div>}
    </div>
  );
}
