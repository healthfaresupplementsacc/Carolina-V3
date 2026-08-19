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
import * as wh from '../adapters/warehouse-api.js';
import { friendlyError } from './WarehousePage.jsx';
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

/* ── Peso da unidade (S15 Fase 3) ────────────────────────────────
   Peso de UMA garrafa cheia, em gramas. É o que transforma a balança em
   contador: (bruto − tara) / peso da unidade = quantas garrafas tem ali.
   Duas formas de preencher, porque na prática as duas acontecem:
     · Calibrar: pesa N garrafas juntas (mais garrafas = menos erro), tira a
       tara do recipiente, divide. O sistema guarda quantas foram na amostra.
     · Manual: alguém já sabe o peso e digita.
   Amostra de 1 garrafa é aceita mas avisada: qualquer sujeira vira erro
   multiplicado por 200 na contagem da caixa. */
function CalibrateModal({ p, onClose, onSaved, onError }) {
  const [gross, setGross] = React.useState('');
  const [count, setCount] = React.useState('10');
  const [tare, setTare] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const g = Number(gross) || 0;
  const c = Number(count) || 0;
  const t = Number(tare) || 0;
  const net = Math.max(0, g - t);
  const unit = c > 0 && net > 0 ? net / c : null;
  const valid = g > 0 && c > 0 && net > 0;

  async function save() {
    setBusy(true);
    try {
      await wh.setProductWeight(p.id, {
        sample_gross_g: g, sample_count: c, sample_tare_g: t || undefined,
      });
      onSaved(unit, c);
    } catch (e) { onError(e.message || 'erro ao calibrar'); }
    finally { setBusy(false); }
  }

  return (
    <div className="kit-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="kit-modal" role="dialog" aria-label="Calibrar peso" data-modal="calibrar">
        <div className="kit-mlabel">Peso da unidade · calibrar pela balança</div>
        <div className="title">Calibrar {p.nickname || p.canonical_name}</div>
        <div style={{ fontSize: 13, color: 'var(--ink-dim)', marginTop: 6, lineHeight: 1.5 }}>
          Descobrir quanto pesa UMA garrafa cheia. Com esse peso a balança passa a contar sozinha:
          o operador pesa a prateleira inteira e o sistema diz quantas garrafas tem.
        </div>

        {/* Passos numerados na ordem em que a pessoa faz na balança. */}
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="kit-mlabel">1. Quantas garrafas você pôs na balança</span>
            <input className="kit-input mono" type="number" min="1" value={count}
                   data-field="count" onChange={(e) => setCount(e.target.value)} />
            <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
              Coloque {c > 0 ? c : 10} garrafas cheias na balança. Quanto mais garrafas, mais certo fica o peso.
            </span>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="kit-mlabel">2. Quanto a balança está marcando (g)</span>
            <input className="kit-input mono" type="number" autoFocus value={gross} placeholder="0"
                   data-field="gross" onChange={(e) => setGross(e.target.value)} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="kit-mlabel">3. Quanto pesa a bandeja vazia (g, pode pular)</span>
            <input className="kit-input mono" type="number" value={tare} placeholder="0"
                   data-field="tare" onChange={(e) => setTare(e.target.value)} />
            <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
              Se as garrafas estão direto na balança, deixe vazio.
            </span>
          </label>
        </div>

        <div className="preview">
          <div className="kit-mlabel" style={{ marginBottom: 6 }}>Como fica</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(104px,1fr))', gap: 10 }}>
            <div><div className="kit-mlabel">Só as garrafas</div><b>{net ? net.toLocaleString('pt-BR') + ' g' : '—'}</b></div>
            <div><div className="kit-mlabel">Na balança</div><b>{c || '—'} garrafas</b></div>
            <div><div className="kit-mlabel">Uma garrafa pesa</div>
                 <b data-preview="unit">{unit ? unit.toFixed(2) + ' g' : '—'}</b></div>
          </div>
          {c === 1 && (
            <div className="kit-chip warn" style={{ marginTop: 8 }}>
              com 1 garrafa só, qualquer errinho vira erro grande na contagem da caixa
            </div>
          )}
        </div>

        <div className="foot">
          <button className="kit-btn sec" onClick={onClose} disabled={busy}>Cancelar</button>
          <button className="kit-btn primary" disabled={busy || !valid} onClick={save} data-act="salvar-peso">
            {busy ? 'Salvando…' : 'Salvar peso da unidade'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Célula do peso: mostra o valor + amostra, permite digitar direto e calibrar. */
function WeightCell({ p, ro, onCalibrate, onManual }) {
  const [edit, setEdit] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const w = p.unit_weight_g;
  const samples = p.unit_weight_samples;

  if (ro) {
    return <span style={{ fontFamily: 'var(--font-mono)' }}>{w == null ? '—' : Number(w).toFixed(2) + ' g'}</span>;
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
      {open ? (
        <input className="kit-input mono" type="number" autoFocus value={edit} placeholder="g"
               style={{ width: 78, padding: '4px 7px', fontSize: 12.5 }}
               onChange={(e) => setEdit(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setOpen(false); }}
               onBlur={() => {
                 const v = edit.trim();
                 setOpen(false);
                 if (v !== '' && Number(v) > 0 && Number(v) !== Number(w)) onManual(Number(v));
               }} />
      ) : (
        <button className="pgi-addsku" title="digitar o peso à mão"
                onClick={() => { setEdit(w == null ? '' : String(w)); setOpen(true); }}>
          {w == null ? 'sem peso' : Number(w).toFixed(2) + ' g'}
        </button>
      )}
      {samples > 0 && <span className="kit-chip neutral" title="garrafas na amostra">n={samples}</span>}
      <button className="kit-btn xs sec" data-act="calibrar" onClick={onCalibrate}>Calibrar</button>
    </span>
  );
}

function Row({ p, ro, onSave, onAddSku, onDetachSku, onCalibrate, onWeightManual }) {
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
      <td data-cell="unit-weight">
        <WeightCell p={p} ro={ro} onCalibrate={() => onCalibrate(p)} onManual={(v) => onWeightManual(p, v)} />
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
  const [cal, setCal] = React.useState(null);        // produto sendo calibrado
  const ro = !V4_ALLOW_WRITES;

  React.useEffect(() => { if (Array.isArray(setup.data)) setRows(setup.data); }, [setup.data]);
  React.useEffect(() => { apiGet('/product-setup/tiers').then((r) => setTiers(Array.isArray(r) ? r : (r && r.data) || [])).catch(() => {}); }, []);

  const patchRow = (id, patch) => setRows((rs) => rs.map((r) => r.id === id ? { ...r, ...patch } : r));

  /* Peso da unidade (S15 Fase 3) vive no hub de estoque (/warehouse/weights),
     não no /product-setup: quem escreve quantidade e peso é o StockService.
     Aqui só juntamos por product_id pra mostrar na mesma linha. */
  React.useEffect(() => {
    let on = true;
    wh.getWeights().then((j) => {
      if (!on) return;
      const byId = new Map(((j.data && j.data.products) || []).map((w) => [w.product_id, w]));
      setRows((rs) => (rs || []).map((r) => {
        const w = byId.get(r.id);
        return w ? { ...r, unit_weight_g: w.unit_weight_g, unit_weight_samples: w.samples } : r;
      }));
    }).catch(() => { /* sem pesos ainda: a coluna mostra "sem peso" */ });
    return () => { on = false; };
  }, [setup.data]);

  const saveWeightManual = async (p, unitG) => {
    try {
      await wh.setProductWeight(p.id, { unit_weight_g: unitG });
      patchRow(p.id, { unit_weight_g: unitG, unit_weight_samples: 0 });
      setFlash('peso salvo, a balança já conta com ele'); setTimeout(() => setFlash(''), 1800);
    } catch (e) { setFlash('erro ao salvar o peso: ' + friendlyError(e)); }
  };

  const onSave = async (id, fields) => {
    const r = await apiPost('/product-setup/' + id, fields).catch((e) => ({ error: e.message }));
    if (r && !r.error) { patchRow(id, fields); setFlash('salvo'); setTimeout(() => setFlash(''), 900); }
    else setFlash('erro ao salvar: ' + friendlyError(r && r.error));
  };
  const onAddSku = async (id, sku, channel) => {
    const r = await apiPost('/product-setup/' + id + '/sku', { sku, channel }).catch((e) => ({ error: e.message }));
    if (r && !r.error) { const s = r.data || r; patchRow(id, { skus: [...(rows.find((x) => x.id === id)?.skus || []), { id: s.id, sku: s.sku, channel: s.channel, units_per_pack: s.units_per_pack }] }); }
    else setFlash('erro ao salvar: ' + friendlyError(r && r.error));
  };
  const onDetachSku = async (s) => {
    const r = await apiPost('/product-setup/sku/' + s.id + '/detach', {}).catch((e) => ({ error: e.message }));
    if (r && !r.error) setRows((rs) => rs.map((row) => ({ ...row, skus: (row.skus || []).filter((x) => x.id !== s.id) })));
    else setFlash('erro ao salvar: ' + friendlyError(r && r.error));
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
            <th className="num">Estoque Veeqo</th><th>Validade (rótulo)</th>
            <th>Peso da unidade</th><th>SKUs (por canal)</th>
          </tr></thead>
          <tbody>
            {list.map((p) => (
              <Row key={p.id} p={p} ro={ro} onSave={onSave} onAddSku={onAddSku} onDetachSku={onDetachSku}
                   onCalibrate={setCal} onWeightManual={saveWeightManual} />
            ))}
            {!list.length && (
              <tr><td colSpan={7} className="pgi-empty">Nenhum produto com esse filtro.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {cal && (
        <CalibrateModal
          p={cal}
          onClose={() => setCal(null)}
          onError={(m) => { setFlash('erro ao calibrar: ' + friendlyError(m)); }}
          onSaved={(unit, n) => {
            patchRow(cal.id, { unit_weight_g: unit, unit_weight_samples: n });
            setCal(null);
            setFlash('peso calibrado, a balança já conta com ele'); setTimeout(() => setFlash(''), 1800);
          }}
        />
      )}
    </div>
  );
}
