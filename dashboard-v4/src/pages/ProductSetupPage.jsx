/* Página "Product Setup" (Bruno 08-03).
   Fundação do RODAPÉ de shipping label + compilação de labels pra impressão (.246).
   Mostra CADA produto com: nickname (editável, pré-preenchido pela regra strip-HF),
   cor da garrafa (Black / White / Other→texto), e TODOS os SKUs mapeados por canal
   (eBay/Amazon/Walmart/TikTok/Veeqo — vários SKUs podem apontar pro MESMO produto).
   A cor + nº de garrafas → tamanho do pacote (v3.bottle_size_tiers).
   Admin-only. Fontes: /api/v3/data/product-setup* . */
import React from 'react';
import { usePoll, apiPost, apiGet } from '../adapters/from-api.js';
import { V4_ALLOW_WRITES } from '../flags.js';

const CHANNELS = ['veeqo', 'amazon', 'ebay', 'walmart', 'tiktok', 'shopify', 'other'];
const CH_COLOR = {
  veeqo: 'var(--hf-navy-500)', amazon: '#d97706', ebay: '#2563eb',
  walmart: '#0071dc', tiktok: '#111', shopify: 'var(--hf-leaf-600)', other: 'var(--text-3)',
};
// nickname sugerido = SKU sem HF-/HFC- (regra do Bruno), do 1º SKU veeqo/HF
function suggestNick(skus) {
  const pick = (skus || []).find((s) => /^HFC?-/i.test(s.sku)) || (skus || [])[0];
  if (!pick) return '';
  const m = String(pick.sku).match(/^HFC?-(.+)$/i);
  return m ? m[1] : '';
}

function Th({ children, right }) {
  return <th style={{ padding: '9px 12px', textAlign: right ? 'right' : 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.04, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{children}</th>;
}

function ColorPicker({ value, onChange, disabled }) {
  const known = value === 'black' || value === 'white' || !value;
  const [mode, setMode] = React.useState(known ? (value || '') : 'other');
  React.useEffect(() => { setMode(value === 'black' || value === 'white' || !value ? (value || '') : 'other'); }, [value]);
  const sel = (
    <select value={mode} disabled={disabled} onChange={(e) => {
      const v = e.target.value; setMode(v);
      if (v === 'other') return;             // espera o texto
      onChange(v || null);
    }} style={{ padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }}>
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
      <input defaultValue={known ? '' : value} placeholder="cor…" disabled={disabled}
        onKeyDown={(e) => { if (e.key === 'Enter') onChange(e.target.value.trim() || null); }}
        onBlur={(e) => onChange(e.target.value.trim() || null)}
        style={{ width: 90, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }} />
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
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
        placeholder={items === null ? 'carregando SKUs…' : 'filtrar ' + (items || []).length + ' SKUs…'}
        onKeyDown={(e) => { if (e.key === 'Enter') pickFirst(); if (e.key === 'Escape') onClose(); }}
        style={{ width: 190, fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--hf-navy-500)', background: 'var(--surface)', color: 'var(--text)' }} />
      <div style={{ position: 'absolute', zIndex: 40, top: '110%', left: 0, minWidth: 320, maxWidth: 460,
        maxHeight: 300, overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, boxShadow: '0 12px 32px -12px rgba(0,0,0,.35)', padding: 4 }}>
        {items === null && <div style={{ padding: 10, fontSize: 12, color: 'var(--text-3)' }}>carregando catálogo do canal…</div>}
        {err && <div style={{ padding: 10, fontSize: 12, color: 'var(--bad)' }}>{err}</div>}
        {items !== null && !err && shown.length === 0 && (
          <div style={{ padding: 10, fontSize: 12, color: 'var(--text-3)' }}>
            {t ? 'nenhum SKU com "' + q + '"' : 'nenhum SKU conhecido neste canal ainda'}
          </div>
        )}
        {shown.map((i) => {
          const taken = !!i.attached_product_id;
          return (
            <div key={i.sku}
              onClick={() => { if (!taken) onPick(i.sku); }}
              title={taken ? 'já ligado a ' + i.attached_product : (i.title || i.sku)}
              style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '5px 8px', borderRadius: 7,
                cursor: taken ? 'not-allowed' : 'pointer', opacity: taken ? 0.5 : 1 }}
              onMouseEnter={(e) => { if (!taken) e.currentTarget.style.background = 'var(--surface-2)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
              <span className="mono" style={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>{i.sku}</span>
              <span style={{ fontSize: 11.5, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {(i.title || '').split('|')[0].trim()}
              </span>
              {taken && <span style={{ fontSize: 10, color: 'var(--warn, #d97706)', whiteSpace: 'nowrap' }}>já → {i.attached_product}</span>}
            </div>
          );
        })}
        {filt.length > 60 && <div style={{ padding: '5px 8px', fontSize: 11, color: 'var(--text-3)' }}>… +{filt.length - 60} — continue digitando pra afinar</div>}
        {q.trim() && !exact && (
          <div onClick={() => onFree(q.trim())}
            style={{ padding: '6px 8px', borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--hf-navy-500)', cursor: 'pointer', fontWeight: 600 }}>
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
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
      {(skus || []).map((s) => (
        <span key={s.id} title={s.channel + (s.units_per_pack > 1 ? ' · casepack ' + s.units_per_pack : '')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 600,
            padding: '2px 7px', borderRadius: 999, border: '1px solid var(--border)',
            background: 'color-mix(in srgb, ' + (CH_COLOR[s.channel] || 'var(--text-3)') + ' 12%, transparent)',
            color: CH_COLOR[s.channel] || 'var(--text-2)' }}>
          <span className="mono">{s.sku}</span>
          {!disabled && <button onClick={() => onDetach(s)} title="remover" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'inherit', fontWeight: 800, lineHeight: 1, padding: 0 }}>×</button>}
        </span>
      ))}
      {!disabled && !adding && <button onClick={() => setAdding(true)} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, border: '1px dashed var(--border)', background: 'none', color: 'var(--text-3)', cursor: 'pointer' }}>+ SKU</button>}
      {!disabled && adding && (
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          <select value={ch} onChange={(e) => setCh(e.target.value)} style={{ fontSize: 12, padding: '3px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}>
            {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <SkuPicker channel={ch} onPick={add} onFree={add} onClose={close} />
          <button onClick={close} title="fechar" style={{ fontSize: 11, padding: '3px 7px', borderRadius: 6, border: '1px solid var(--border)', background: 'none', color: 'var(--text-3)', cursor: 'pointer' }}>×</button>
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
    <tr style={{ borderTop: '1px solid var(--border)' }}>
      <td style={{ padding: '8px 12px', fontWeight: 600, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {p.canonical_name}
        {!p.active && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-3)' }}>(inativo)</span>}
        {p.on_hold && <span title="Catálogo 08-04: HOLD — NÃO IMPRIMIR" style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, padding: '1px 6px', borderRadius: 999, background: 'color-mix(in srgb, var(--bad) 16%, transparent)', color: 'var(--bad)' }}>HOLD — NÃO IMPRIMIR</span>}
      </td>
      <td style={{ padding: '8px 12px' }}>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input value={nick} disabled={ro} onChange={(e) => setNick(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveNick(); }} onBlur={saveNick}
            placeholder={suggested || 'nickname…'}
            className="mono"
            style={{ width: 150, padding: '5px 8px', borderRadius: 8, fontSize: 13,
              border: '1px solid ' + (dirty ? 'var(--hf-navy-500)' : 'var(--border)'),
              background: 'var(--surface)', color: 'var(--text)' }} />
          {saving === 'nick' && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>…</span>}
          {!ro && !nick && suggested && <button onClick={() => { setNick(suggested); onSave(p.id, { nickname: suggested }); }} title="usar sugestão" style={{ fontSize: 10.5, padding: '2px 6px', borderRadius: 6, border: '1px dashed var(--border)', background: 'none', color: 'var(--text-3)', cursor: 'pointer' }}>← {suggested}</button>}
        </span>
      </td>
      <td style={{ padding: '8px 12px' }}>
        <ColorPicker value={p.bottle_color} disabled={ro} onChange={(v) => onSave(p.id, { bottle_color: v })} />
      </td>
      <td style={{ padding: '8px 12px', textAlign: 'right' }}>
        {p.veeqo_stock == null
          ? <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>
          : <span className="mono" style={{ fontWeight: 700, color: p.veeqo_stock <= 0 ? 'var(--bad)' : 'inherit' }}>{p.veeqo_stock}</span>}
      </td>
      {/* Validade do rótulo (catálogo 08-04, mig 066) — MIN entre as variantes.
          <12 meses = âmbar, <6 = vermelho. Título mostra caps/porções. */}
      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}
        title={(p.content_desc ? p.content_desc + ' · ' : '') + (p.servings_per_container ? p.servings_per_container + ' porções' : '')}>
        {(() => {
          if (!p.expiry_date) return <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>;
          const d = new Date(p.expiry_date);
          const months = (d - Date.now()) / (30.44 * 24 * 3600 * 1000);
          const color = months < 6 ? 'var(--bad)' : months < 12 ? 'var(--warn, #d97706)' : 'var(--text-2)';
          return <span className="mono" style={{ fontSize: 12.5, fontWeight: 600, color }}>
            {String(d.getUTCMonth() + 1).padStart(2, '0')}/{d.getUTCFullYear()}
          </span>;
        })()}
      </td>
      <td style={{ padding: '8px 12px' }}>
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

  if (setup.loading && !rows) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Carregando produtos…</div>;
  if (setup.error) return <div style={{ padding: 24, color: 'var(--bad)' }}>Erro: {String(setup.error)}</div>;

  const list = (rows || []).filter((p) => {
    if (!q) return true;
    const hay = (p.canonical_name + ' ' + (p.nickname || '') + ' ' + (p.skus || []).map((s) => s.sku).join(' ')).toLowerCase();
    return hay.includes(q.toLowerCase());
  });
  const noNick = (rows || []).filter((p) => !p.nickname).length;
  const noColor = (rows || []).filter((p) => !p.bottle_color).length;

  return (
    <div style={{ padding: '18px 22px', maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>Product Setup</h2>
        <span style={{ color: 'var(--text-3)', fontSize: 13 }}>Nickname · cor da garrafa · SKUs por canal — base do rodapé da shipping label.</span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '10px 0 14px' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="buscar produto / nickname / SKU…"
          style={{ flex: '1 1 260px', padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 14 }} />
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{list.length} produtos</span>
        {noNick > 0 && <span style={{ fontSize: 12, color: 'var(--warn, #d97706)', fontWeight: 600 }}>{noNick} sem nickname</span>}
        {noColor > 0 && <span style={{ fontSize: 12, color: 'var(--warn, #d97706)', fontWeight: 600 }}>{noColor} sem cor</span>}
        {flash && <span style={{ fontSize: 12, color: flash.startsWith('erro') ? 'var(--bad)' : 'var(--hf-leaf-700)', fontWeight: 600 }}>{flash}</span>}
        {ro && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>(somente leitura)</span>}
      </div>

      {tiers.length > 0 && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 14, fontSize: 12.5, color: 'var(--text-2)' }}>
          <b>Tamanho do pacote</b> (por nº de garrafas):{' '}
          {tiers.filter((t) => !t.bottle_color).map((t) => `${t.min_bottles}${t.max_bottles ? '–' + t.max_bottles : '+'} → ${t.package_size}`).join(' · ')}
          <span style={{ color: 'var(--text-3)' }}> · BX = caixa</span>
        </div>
      )}

      <div className="card" style={{ overflowX: 'auto', padding: 0 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead><tr style={{ background: 'var(--surface-2)' }}>
            <Th>Produto</Th><Th>Nickname</Th><Th>Cor da garrafa</Th><Th right>Estoque Veeqo</Th><Th>Validade (rótulo)</Th><Th>SKUs (por canal)</Th>
          </tr></thead>
          <tbody>
            {list.map((p) => (
              <Row key={p.id} p={p} ro={ro} onSave={onSave} onAddSku={onAddSku} onDetachSku={onDetachSku} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
