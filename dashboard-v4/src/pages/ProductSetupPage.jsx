/* Página "Product Setup" (Bruno 08-03).
   Fundação do RODAPÉ de shipping label + compilação de labels pra impressão (.246).
   Mostra CADA produto com: nickname (editável, pré-preenchido pela regra strip-HF),
   cor da garrafa (Black / White / Other→texto), e TODOS os SKUs mapeados por canal
   (eBay/Amazon/Walmart/TikTok/Veeqo — vários SKUs podem apontar pro MESMO produto).
   A cor + nº de garrafas → tamanho do pacote (v3.bottle_size_tiers).
   Admin-only. Fontes: /api/v3/data/product-setup* .

   Pele: STYLE-KIT 100% (S15 fase 2). Classes .kit-* + complementos .pgi-*
   de pages-inventory.css. Lógica, endpoints e props iguais. */
import React from 'react';
import { usePoll, apiPost, apiGet } from '../adapters/from-api.js';
import { V4_ALLOW_WRITES } from '../flags.js';
import './pages-inventory.css';

const CHANNELS = ['veeqo', 'amazon', 'ebay', 'walmart', 'tiktok', 'shopify', 'other'];
// nickname sugerido = SKU sem HF-/HFC- (regra do Bruno), do 1º SKU veeqo/HF
function suggestNick(skus) {
  const pick = (skus || []).find((s) => /^HFC?-/i.test(s.sku)) || (skus || [])[0];
  if (!pick) return '';
  const m = String(pick.sku).match(/^HFC?-(.+)$/i);
  return m ? m[1] : '';
}

function ColorPicker({ value, onChange, disabled }) {
  const known = value === 'black' || value === 'white' || !value;
  const [mode, setMode] = React.useState(known ? (value || '') : 'other');
  React.useEffect(() => { setMode(value === 'black' || value === 'white' || !value ? (value || '') : 'other'); }, [value]);
  const sel = (
    <select className="kit-input" value={mode} disabled={disabled} onChange={(e) => {
      const v = e.target.value; setMode(v);
      if (v === 'other') return;             // espera o texto
      onChange(v || null);
    }} style={{ padding: '5px 9px' }}>
      <option value="">—</option>
      <option value="black">Black</option>
      <option value="white">White</option>
      <option value="other">Other…</option>
    </select>
  );
  if (mode !== 'other') return sel;
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      {sel}
      <input className="kit-input" defaultValue={known ? '' : value} placeholder="cor…" disabled={disabled}
        onKeyDown={(e) => { if (e.key === 'Enter') onChange(e.target.value.trim() || null); }}
        onBlur={(e) => onChange(e.target.value.trim() || null)}
        style={{ width: 92, padding: '5px 9px' }} />
    </span>
  );
}

// cache module-level dos SKUs por canal (1 fetch por canal a cada 10min,
// compartilhado entre todas as linhas da tabela)
const _chSkuCache = {};
async function channelSkus(channel) {
  const c = _chSkuCache[channel];
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.items;
  const r = await apiGet('/product-setup/channel-skus?channel=' + encodeURIComponent(channel));
  const items = (r && r.data && r.data.items) || (r && r.items) || [];
  _chSkuCache[channel] = { at: Date.now(), items };
  return items;
}

/* Dropdown pesquisável (Bruno 08-03): escolher o canal lista TODOS os SKUs
   daquele canal; digitar filtra por "contém" (qualquer trecho, em qualquer
   posição, no SKU ou no título) — pra ligar o SKU no item CERTO, sem digitar
   às cegas. SKU já ligado a outro produto aparece marcado e não é clicável
   (desligue lá primeiro). Fallback: usar o texto digitado como SKU novo. */
function SkuPicker({ channel, onPick, onFree, onClose }) {
  const [q, setQ] = React.useState('');
  const [items, setItems] = React.useState(null);   // null = carregando
  const [err, setErr] = React.useState('');
  React.useEffect(() => {
    let on = true;
    setItems(null); setErr('');
    channelSkus(channel).then((it) => { if (on) setItems(it); })
      .catch((e) => { if (on) { setItems([]); setErr(e.message || 'erro'); } });
    return () => { on = false; };
  }, [channel]);
  const t = q.trim().toLowerCase();
  const filt = (items || []).filter((i) =>
    !t || (i.sku + ' ' + (i.title || '')).toLowerCase().includes(t));
  const shown = filt.slice(0, 60);
  const exact = (items || []).some((i) => i.sku.toLowerCase() === t);
  const pickFirst = () => {
    const first = shown.find((i) => !i.attached_product_id);
    if (first) onPick(first.sku);
    else if (q.trim() && !exact) onFree(q.trim());
  };
  return (
    <div className="pgi-picker">
      <input className="kit-input mono" autoFocus value={q} onChange={(e) => setQ(e.target.value)}
        placeholder={items === null ? 'carregando SKUs…' : 'filtrar ' + (items || []).length + ' SKUs…'}
        onKeyDown={(e) => { if (e.key === 'Enter') pickFirst(); if (e.key === 'Escape') onClose(); }}
        style={{ width: 200, padding: '5px 9px', fontSize: 12.5 }} />
      <div className="pgi-picker-list">
        {items === null && <div className="pgi-picker-msg">carregando catálogo do canal…</div>}
        {err && <div className="pgi-picker-msg bad">{err}</div>}
        {items !== null && !err && shown.length === 0 && (
          <div className="pgi-picker-msg">
            {t ? 'nenhum SKU com "' + q + '"' : 'nenhum SKU conhecido neste canal ainda'}
          </div>
        )}
        {shown.map((i) => {
          const taken = !!i.attached_product_id;
          return (
            <div key={i.sku} className={'pgi-picker-item' + (taken ? ' taken' : '')}
              onClick={() => { if (!taken) onPick(i.sku); }}
              title={taken ? 'já ligado a ' + i.attached_product : (i.title || i.sku)}>
              <span className="sku">{i.sku}</span>
              <span className="ttl">{(i.title || '').split('|')[0].trim()}</span>
              {taken && <span className="flag">já em {i.attached_product}</span>}
            </div>
          );
        })}
        {filt.length > 60 && <div className="pgi-picker-msg">mais {filt.length - 60}, continue digitando pra afinar</div>}
        {q.trim() && !exact && (
          <div className="pgi-picker-free" onClick={() => onFree(q.trim())}>
            + usar “{q.trim()}” como SKU novo deste canal
          </div>
        )}
      </div>
    </div>
  );
}

function SkuChips({ skus, onDetach, onAdd, disabled }) {
  const [adding, setAdding] = React.useState(false);
  const [ch, setCh] = React.useState('amazon');
  const close = () => setAdding(false);
  const add = (sku) => { onAdd(sku, ch); setAdding(false); };
  return (
    <div className="pgi-skuwrap">
      {(skus || []).map((s) => (
        <span key={s.id} className={'pgi-ch ' + (CHANNELS.includes(s.channel) ? s.channel : 'other')}
          title={s.channel + (s.units_per_pack > 1 ? ' · casepack ' + s.units_per_pack : '')}>
          {s.sku}
          {!disabled && <button className="x" onClick={() => onDetach(s)} title="remover">×</button>}
        </span>
      ))}
      {!disabled && !adding && <button className="pgi-addsku" onClick={() => setAdding(true)}>+ SKU</button>}
      {!disabled && adding && (
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          <select className="kit-input" value={ch} onChange={(e) => setCh(e.target.value)} style={{ padding: '5px 8px', fontSize: 12.5 }}>
            {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <SkuPicker channel={ch} onPick={add} onFree={add} onClose={close} />
          <button className="kit-btn xs sec" onClick={close} title="fechar">fechar</button>
        </span>
      )}
    </div>
  );
}

function Row({ p, ro, onSave, onAddSku, onDetachSku }) {
  const [nick, setNick] = React.useState(p.nickname || '');
  const [saving, setSaving] = React.useState('');
  React.useEffect(() => { setNick(p.nickname || ''); }, [p.nickname]);
  const suggested = suggestNick(p.skus);
  const dirty = nick !== (p.nickname || '');
  const saveNick = async () => {
    if (!dirty) return;
    setSaving('nick');
    await onSave(p.id, { nickname: nick });
    setSaving('');
  };
  return (
    <tr className={p.active === false ? 'off' : undefined}>
      <td className="wrapmax strong">
        {p.canonical_name}
        {!p.active && <span className="kit-chip neutral" style={{ marginLeft: 8 }}>inativo</span>}
        {p.on_hold && <span className="kit-chip bad" style={{ marginLeft: 8 }} title="Catálogo 08-04: HOLD, não imprimir">hold, não imprimir</span>}
      </td>
      <td>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input className="kit-input mono" value={nick} disabled={ro} onChange={(e) => setNick(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveNick(); }} onBlur={saveNick}
            placeholder={suggested || 'nickname…'}
            style={{ width: 150, padding: '5px 9px', borderColor: dirty ? 'var(--primary-line)' : undefined }} />
          {saving === 'nick' && <span style={{ color: 'var(--ink-faint)', fontSize: 11 }}>…</span>}
          {!ro && !nick && suggested && (
            <button className="pgi-addsku" title="usar sugestão"
              onClick={() => { setNick(suggested); onSave(p.id, { nickname: suggested }); }}>← {suggested}</button>
          )}
        </span>
      </td>
      <td>
        <ColorPicker value={p.bottle_color} disabled={ro} onChange={(v) => onSave(p.id, { bottle_color: v })} />
      </td>
      <td className={'num' + (p.veeqo_stock != null && p.veeqo_stock <= 0 ? ' badnum strong' : '')}>
        {p.veeqo_stock == null ? <span style={{ color: 'var(--ink-faint)' }}>—</span> : p.veeqo_stock}
      </td>
      {/* Validade do rótulo (catálogo 08-04, mig 066) — MIN entre as variantes.
          <12 meses = âmbar, <6 = vermelho. Título mostra caps/porções. */}
      <td style={{ whiteSpace: 'nowrap' }}
        title={(p.content_desc ? p.content_desc + ' · ' : '') + (p.servings_per_container ? p.servings_per_container + ' porções' : '')}>
        {(() => {
          if (!p.expiry_date) return <span style={{ color: 'var(--ink-faint)' }}>—</span>;
          const d = new Date(p.expiry_date);
          const months = (d - Date.now()) / (30.44 * 24 * 3600 * 1000);
          const tone = months < 6 ? 'bad' : months < 12 ? 'warn' : 'neutral';
          return <span className={'kit-chip ' + tone}>
            {String(d.getUTCMonth() + 1).padStart(2, '0')}/{d.getUTCFullYear()}
          </span>;
        })()}
      </td>
      <td>
        <SkuChips skus={p.skus} disabled={ro}
          onAdd={(sku, ch) => onAddSku(p.id, sku, ch)}
          onDetach={(s) => onDetachSku(s)} />
      </td>
    </tr>
  );
}

export function ProductSetupPage() {
  const setup = usePoll('/product-setup', [], 0);   // load once (no poll — it's an editor)
  const [rows, setRows] = React.useState(null);
  const [tiers, setTiers] = React.useState([]);
  const [q, setQ] = React.useState('');
  const [flash, setFlash] = React.useState('');
  const ro = !V4_ALLOW_WRITES;

  React.useEffect(() => { if (Array.isArray(setup.data)) setRows(setup.data); }, [setup.data]);
  React.useEffect(() => { apiGet('/product-setup/tiers').then((r) => setTiers(Array.isArray(r) ? r : (r && r.data) || [])).catch(() => {}); }, []);

  const patchRow = (id, patch) => setRows((rs) => rs.map((r) => r.id === id ? { ...r, ...patch } : r));

  const onSave = async (id, fields) => {
    const r = await apiPost('/product-setup/' + id, fields).catch((e) => ({ error: e.message }));
    if (r && !r.error) { patchRow(id, fields); setFlash('salvo'); setTimeout(() => setFlash(''), 900); }
    else setFlash('erro: ' + (r && r.error));
  };
  const onAddSku = async (id, sku, channel) => {
    const r = await apiPost('/product-setup/' + id + '/sku', { sku, channel }).catch((e) => ({ error: e.message }));
    if (r && !r.error) { const s = r.data || r; patchRow(id, { skus: [...(rows.find((x) => x.id === id)?.skus || []), { id: s.id, sku: s.sku, channel: s.channel, units_per_pack: s.units_per_pack }] }); }
    else setFlash('erro: ' + (r && r.error));
  };
  const onDetachSku = async (s) => {
    const r = await apiPost('/product-setup/sku/' + s.id + '/detach', {}).catch((e) => ({ error: e.message }));
    if (r && !r.error) setRows((rs) => rs.map((row) => ({ ...row, skus: (row.skus || []).filter((x) => x.id !== s.id) })));
    else setFlash('erro: ' + (r && r.error));
  };

  if (setup.loading && !rows) {
    return <div className="pgi-page" data-page="inv-produto-setup"><div className="kit-card pad pgi-loading">Carregando produtos…</div></div>;
  }
  if (setup.error) {
    return <div className="pgi-page" data-page="inv-produto-setup"><div className="kit-card pad bad" style={{ color: 'var(--bad-deep)' }}>Erro: {String(setup.error)}</div></div>;
  }

  const list = (rows || []).filter((p) => {
    if (!q) return true;
    const hay = (p.canonical_name + ' ' + (p.nickname || '') + ' ' + (p.skus || []).map((s) => s.sku).join(' ')).toLowerCase();
    return hay.includes(q.toLowerCase());
  });
  const noNick = (rows || []).filter((p) => !p.nickname).length;
  const noColor = (rows || []).filter((p) => !p.bottle_color).length;

  return (
    <div className="pgi-page" data-page="inv-produto-setup">
      <div className="pgi-head">
        <div className="pgi-head-main">
          <span className="kit-eyebrow">● HEALTHFARE · PRODUCT SETUP</span>
          <h1 className="kit-h1">Nickname, cor e <em>SKUs</em> por canal</h1>
          <p className="kit-sub">
            É a base do rodapé da shipping label. A cor da garrafa mais o número de garrafas decidem o tamanho do pacote.
          </p>
        </div>
        <div className="pgi-head-actions">
          {flash && <span className={'pgi-flash' + (flash.startsWith('erro') ? ' bad' : '')}>{flash}</span>}
          <a className="kit-btn sm sec" href="#config-estoque">Configurações de inventário</a>
        </div>
      </div>

      <div className="pgi-toolbar">
        <input className="kit-input grow" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="buscar produto / nickname / SKU…" />
        <span className="pgi-count">{list.length} produtos</span>
        {noNick > 0 && <span className="kit-chip warn">{noNick} sem nickname</span>}
        {noColor > 0 && <span className="kit-chip warn">{noColor} sem cor</span>}
        {ro && <span className="kit-chip neutral">somente leitura</span>}
      </div>

      {tiers.length > 0 && (
        <div className="kit-card pad" style={{ marginBottom: 14 }}>
          <div className="kit-mlabel" style={{ marginBottom: 6 }}>Tamanho do pacote por nº de garrafas</div>
          <div style={{ fontSize: 13, color: 'var(--ink-dim)' }}>
            {tiers.filter((t) => !t.bottle_color).map((t) => `${t.min_bottles}${t.max_bottles ? ' a ' + t.max_bottles : '+'} → ${t.package_size}`).join(' · ')}
            <span style={{ color: 'var(--ink-faint)' }}> · BX = caixa</span>
          </div>
        </div>
      )}

      <div className="kit-card pgi-tablecard">
        <table className="kit-table" data-table="produto-setup">
          <thead><tr>
            <th>Produto</th><th>Nickname</th><th>Cor da garrafa</th>
            <th className="num">Estoque Veeqo</th><th>Validade (rótulo)</th><th>SKUs (por canal)</th>
          </tr></thead>
          <tbody>
            {list.map((p) => (
              <Row key={p.id} p={p} ro={ro} onSave={onSave} onAddSku={onAddSku} onDetachSku={onDetachSku} />
            ))}
            {!list.length && (
              <tr><td colSpan={6} className="pgi-empty">Nenhum produto com esse filtro.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
