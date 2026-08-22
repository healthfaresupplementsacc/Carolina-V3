/* Página "Montar estoque" (#estoque-montar) — a porta de CARGA do armazém
   (S15.43, decisões travadas com o Bruno em 08-22, carga começa HOJE).

   Três passos na ordem em que o trabalho acontece:
     1. Produtos e pesos: cada produto ganha o peso da unidade (balança).
     2. Locais e caixas: prateleiras em lote + TIPOS de caixa com tara
        calibrada (média de ~10 vazias + a variação real entre elas).
     3. Contar e carregar: o mutirão. Escolhe o produto, escolhe o destino,
        e conta DO JEITO QUE PREFERIR: na mão ou pesando. Nunca força um.

   Regras que esta tela obedece:
     · POST /load é a ÚNICA porta de escrita (compõe verbos do StockService
       no backend; aqui nunca existe escrita direta de quantidade).
     · Aviso nunca bloqueia: re-pesagem de caixa, delta da Veeqo e a
       sugestão de recontagem são conselhos, o operador decide.
     · Meia garrafa conta como garrafa (o backend arredonda pra cima), mas
       sobra grande sugere contar na mão em vez de gravar número duvidoso.
     · Balança HÍBRIDA: o campo de gramas é numérico e autofocado; serve o
       visor (a pessoa digita) e a balança USB que digita sozinha.

   STYLE-KIT global (kit.css) + StockLoadPage.css (.stl-*).
   PT-BR com acento, curto, humano, sem travessão. */
import React from 'react';
import * as wh from '../adapters/warehouse-api.js';
import { canRead, canWrite, friendlyError } from './WarehousePage.jsx';
import './StockLoadPage.css';

const n = (v) => (v == null ? 0 : Number(v));
const fmt = (v) => (v == null ? '0' : Number(v).toLocaleString('pt-BR'));
const fmtG = (v) => (v == null ? '?' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' g');

/** Total da Veeqo da linha: o backend novo manda veeqo_total; o formato
 *  anterior mandava veeqo.physical. Aceita os dois pra não ficar mudo. */
const veeqoOf = (r) => (r == null ? null
  : (r.veeqo_total != null ? Number(r.veeqo_total)
    : (r.veeqo && r.veeqo.physical != null ? Number(r.veeqo.physical) : null)));

/** uuid do client_ref: repetir o POST (rede ruim, dedo duplo) não duplica. */
function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
  });
}

/** Peso típico de uma garrafa (mediana dos pesos conhecidos): é a régua do
 *  veredito da caixa ("varia menos que meia garrafa? dá pra confiar"). */
function typicalBottleG(weights) {
  const ws = Object.values(weights || {}).map((w) => n(w.unit_weight_g)).filter((x) => x > 0).sort((a, b) => a - b);
  if (!ws.length) return 150;
  return ws[Math.floor(ws.length / 2)];
}

const SOURCE_LABEL = {
  count_manual: 'contado na mão',
  count_weigh: 'pesado',
  production_direct: 'da produção',
  loose_fixed: 'avulsa consertada',
};
const SOURCE_TONE = {
  count_manual: 'neutral', count_weigh: 'neutral',
  production_direct: 'ok', loose_fixed: 'warn',
};

/* ═══ PASSO 1 · pesar um produto ════════════════════════════════════
   O mesmo desenho do Calibrar do Product Setup (3 passos na ordem da
   balança), aqui com a dica da balança híbrida no campo do peso. */
function WeighModal({ p, onClose, onSaved, onError }) {
  const [count, setCount] = React.useState('10');
  const [gross, setGross] = React.useState('');
  const [tare, setTare] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const c = Number(count) || 0;
  const g = Number(gross) || 0;
  const t = Number(tare) || 0;
  const net = Math.max(0, g - t);
  const unit = c > 0 && net > 0 ? net / c : null;
  const valid = c > 0 && net > 0;

  async function save() {
    setBusy(true);
    try {
      await wh.setProductWeight(p.product_id, {
        sample_gross_g: g, sample_count: c, sample_tare_g: t || undefined,
      });
      onSaved(p, unit, c);
    } catch (e) { onError(e); }
    finally { setBusy(false); }
  }

  return (
    <div className="kit-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="kit-modal" role="dialog" aria-label="Pesar produto" data-modal="pesar">
        <div className="kit-mlabel">Peso da unidade · pela balança</div>
        <div className="title">Pesar {p.nickname || p.name}</div>
        <div style={{ fontSize: 13, color: 'var(--ink-dim)', marginTop: 6, lineHeight: 1.5 }}>
          Com o peso de UMA garrafa o passo 3 conta sozinho: pesa a prateleira e o sistema diz quantas tem.
        </div>

        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="kit-mlabel">1. Quantas garrafas na balança</span>
            <input className="kit-input mono" type="number" min="1" value={count}
                   data-field="count" onChange={(e) => setCount(e.target.value)} />
            <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
              Quanto mais garrafas, mais certo fica o peso. 10 é um bom número.
            </span>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="kit-mlabel">2. Peso total na balança (g)</span>
            <input className="kit-input mono" type="number" autoFocus value={gross} placeholder="0"
                   inputMode="decimal" data-field="gross" onChange={(e) => setGross(e.target.value)} />
            <span style={{ fontSize: 12, color: 'var(--ink-faint)' }} data-hint="balanca">
              aceita balança USB que digita sozinha: deixe o cursor aqui e ela preenche
            </span>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="kit-mlabel">3. Tara da bandeja (g, pode pular)</span>
            <input className="kit-input mono" type="number" value={tare} placeholder="0"
                   data-field="tare" onChange={(e) => setTare(e.target.value)} />
          </label>
        </div>

        <div className="preview" style={{ marginTop: 14 }}>
          <div className="kit-mlabel" style={{ marginBottom: 6 }}>Como fica</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(104px,1fr))', gap: 10 }}>
            <div><div className="kit-mlabel">Só as garrafas</div><b>{net ? fmt(net) + ' g' : '?'}</b></div>
            <div><div className="kit-mlabel">Na balança</div><b>{c || '?'} garrafas</b></div>
            <div><div className="kit-mlabel">Uma garrafa pesa</div>
                 <b data-preview="unit">{unit ? unit.toFixed(2) + ' g' : '?'}</b></div>
          </div>
          {c === 1 && (
            <div className="kit-chip warn" style={{ marginTop: 8 }}>
              com 1 garrafa só, qualquer errinho vira erro grande na contagem
            </div>
          )}
        </div>

        <div className="foot" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="kit-btn sec" onClick={onClose} disabled={busy}>Cancelar</button>
          <button className="kit-btn primary" disabled={busy || !valid} onClick={save} data-act="salvar-peso">
            {busy ? 'Salvando…' : 'Salvar peso da unidade'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Step1Produtos({ rows, weights, writable, onWeighSaved, onError }) {
  const [filter, setFilter] = React.useState('todos');
  const [weighing, setWeighing] = React.useState(null);

  const merged = rows.map((r) => ({ ...r, _w: weights[r.product_id] || null }));
  const list = merged.filter((r) => {
    const has = r._w && n(r._w.unit_weight_g) > 0;
    if (filter === 'sem') return !has;
    if (filter === 'com') return has;
    return true;
  });
  const semPeso = merged.filter((r) => !(r._w && n(r._w.unit_weight_g) > 0)).length;

  return (
    <div data-step-body="1">
      <div className="stl-what">
        Dê a cada produto o peso de uma garrafa: é o que deixa a balança contar por você no passo 3.
      </div>

      <div style={{ display: 'flex', gap: 6, margin: '10px 0', flexWrap: 'wrap' }} data-filter-peso>
        {[['todos', 'todos'], ['sem', 'sem peso (' + semPeso + ')'], ['com', 'com peso']].map(([k, label]) => (
          <button key={k} type="button" className={'wht-fchip' + (filter === k ? ' on' : '')}
                  data-chip-peso={k} aria-pressed={filter === k ? 'true' : 'false'}
                  onClick={() => setFilter(k)}>{label}</button>
        ))}
      </div>

      <div className="kit-card pad" style={{ overflowX: 'auto' }}>
        <table className="kit-table" data-table="pesos">
          <thead><tr>
            <th>Produto</th><th>SKU base</th>
            <th className="num">Peso da unidade</th><th className="num">Veeqo</th><th />
          </tr></thead>
          <tbody>
            {list.map((r) => {
              const w = r._w;
              const has = w && n(w.unit_weight_g) > 0;
              const vq = veeqoOf(r);
              return (
                <tr key={r.product_id} data-peso-row={r.product_id}>
                  <td>
                    <b>{r.nickname || r.name}</b>
                    {r.nickname && r.nickname !== r.name && (
                      <span style={{ color: 'var(--ink-faint)', fontSize: 12, marginLeft: 6 }}>{r.name}</span>
                    )}
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.base_sku || 'sem SKU'}</td>
                  <td className="num" data-cell="peso">
                    {has
                      ? <span style={{ fontFamily: 'var(--font-mono)' }}>{Number(w.unit_weight_g).toFixed(2)} g
                          <span style={{ color: 'var(--ink-faint)', fontSize: 11, marginLeft: 5 }}>({w.samples || 0} na amostra)</span></span>
                      : <span className="kit-chip warn" data-chip="sem-peso">sem peso</span>}
                  </td>
                  <td className="num" style={{ fontFamily: 'var(--font-mono)' }}>{vq == null ? 'sem Veeqo' : fmt(vq)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {writable && (
                      <button className="kit-btn xs sec" data-act="pesar" data-product={r.product_id}
                              onClick={() => setWeighing(r)}>Pesar</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!list.length && (
              <tr><td colSpan={5} style={{ color: 'var(--ink-faint)' }}>
                Nenhum produto nesse recorte. Troque o filtro aqui em cima.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {weighing && (
        <WeighModal p={weighing}
          onClose={() => setWeighing(null)}
          onSaved={(p, unit, c) => { setWeighing(null); onWeighSaved(p, unit, c); }}
          onError={(e) => { setWeighing(null); onError(e); }} />
      )}
    </div>
  );
}

/* ═══ PASSO 2 · criar várias prateleiras ════════════════════════════
   CÓPIA MÍNIMA do BulkBinsCard de LocationsPage.jsx (o original não é
   exportado e aquele arquivo pertence a outra frente agora). Mesma
   lógica, mesmos data-attributes; se um dia ele for exportado, importar
   daqui é uma troca de 3 linhas. */
const BULK_MAX = 300;

function buildCodes({ area, shelves, levels, positions }) {
  const a = String(area || '').trim().toUpperCase();
  const lv = String(levels || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  const nS = Math.max(0, Math.floor(Number(shelves) || 0));
  const nP = Math.max(0, Math.floor(Number(positions) || 0));
  if (!a || !lv.length || !nS || !nP) return [];
  const out = [];
  for (let s = 1; s <= nS; s += 1) {
    for (const l of lv) {
      for (let p = 1; p <= nP; p += 1) {
        out.push({ bin_code: a + String(s).padStart(2, '0') + l + p, shelf: a + String(s).padStart(2, '0') });
        if (out.length > BULK_MAX) return out;
      }
    }
  }
  return out;
}

function BulkBinsCard({ products, onDone, onError }) {
  const [open, setOpen] = React.useState(false);
  const [f, setF] = React.useState({ area: 'A', shelves: 8, levels: 'A,B,C', positions: 4, product_id: '', capacity: '' });
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState(null);

  const codes = React.useMemo(() => buildCodes(f), [f]);
  const over = codes.length > BULK_MAX;
  const shown = codes.slice(0, BULK_MAX);
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setResult(null); };

  async function create() {
    setBusy(true);
    try {
      const payload = shown.map((c) => ({
        bin_code: c.bin_code,
        shelf: c.shelf,
        area: String(f.area || '').trim().toUpperCase() || undefined,
        product_id: f.product_id ? Number(f.product_id) : undefined,
        capacity: f.capacity === '' ? undefined : Number(f.capacity),
      }));
      const res = await wh.addBinsBulk(payload);
      const d = (res && res.data) || {};
      const created = Number(d.created || 0);
      const skipped = Array.isArray(d.skipped) ? d.skipped.length : Number(d.skipped || 0);
      setResult({ created, skipped });
      onDone('Criadas ' + created + ', já existiam ' + skipped);
    } catch (e) { onError(e); }
    finally { setBusy(false); }
  }

  return (
    <div className="kit-card pad" style={{ marginTop: 14 }} data-bulk="prateleiras">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="kit-mlabel">Começando do zero</div>
          <div style={{ fontSize: 13.5, marginTop: 2 }}>
            <b>Criar várias prateleiras</b> de uma vez, no formato do armazém: área, número da prateleira,
            nível e posição. Uma por uma leva a manhã inteira.
          </div>
        </div>
        <button className="kit-btn sec" data-act="bulk-abrir" onClick={() => setOpen((v) => !v)}>
          {open ? 'Fechar' : 'Criar várias prateleiras'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 14, borderTop: '1px dotted var(--dotline)', paddingTop: 14 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="kit-mlabel">Área</span>
              <input className="kit-input mono" style={{ width: 78 }} data-field="area"
                     value={f.area} onChange={set('area')} placeholder="A" />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="kit-mlabel">Prateleiras (1 até)</span>
              <input className="kit-input mono" type="number" min="1" style={{ width: 92 }} data-field="shelves"
                     value={f.shelves} onChange={set('shelves')} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="kit-mlabel">Níveis</span>
              <input className="kit-input mono" style={{ width: 110 }} data-field="levels"
                     value={f.levels} onChange={set('levels')} placeholder="A,B,C" />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="kit-mlabel">Posições por nível</span>
              <input className="kit-input mono" type="number" min="1" style={{ width: 92 }} data-field="positions"
                     value={f.positions} onChange={set('positions')} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="kit-mlabel">Cabe quantas (opcional)</span>
              <input className="kit-input mono" type="number" min="1" style={{ width: 110 }} data-field="capacity"
                     value={f.capacity} onChange={set('capacity')} placeholder="48" />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="kit-mlabel">Produto (opcional)</span>
              <select className="kit-input" style={{ minWidth: 170 }} data-field="product"
                      value={f.product_id} onChange={set('product_id')}>
                <option value="">sem produto</option>
                {products.map((p) => <option key={p.product_id} value={p.product_id}>{p.nickname || p.name}</option>)}
              </select>
            </label>
          </div>

          <div className="kit-card pad" style={{ marginTop: 14, background: 'var(--kit-surface-2)' }} data-bulk-preview>
            <div className="kit-mlabel" style={{ marginBottom: 6 }}>Como fica</div>
            {!codes.length ? (
              <div style={{ fontSize: 13, color: 'var(--ink-dim)' }}>
                Preencha área, prateleiras, níveis e posições pra ver os códigos.
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <b style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: 'var(--primary-deep)' }}
                     data-bulk-count>{shown.length}</b>
                  <span style={{ fontSize: 13, color: 'var(--ink-dim)' }}>
                    prateleiras · {f.area ? String(f.area).toUpperCase() : ''}01
                    {String(f.levels || '').split(',')[0] ? String(f.levels).split(',')[0].trim().toUpperCase() : ''}1
                    {' até '}{shown.length ? shown[shown.length - 1].bin_code : ''}
                  </span>
                </div>
                <div style={{ marginTop: 8, display: 'flex', gap: 5, flexWrap: 'wrap' }} data-bulk-codes>
                  {shown.slice(0, 12).map((c) => (
                    <span key={c.bin_code} className="kit-chip neutral" style={{ fontFamily: 'var(--font-mono)' }}>{c.bin_code}</span>
                  ))}
                  {shown.length > 12 && (
                    <span className="kit-chip neutral">e mais {shown.length - 12} até {shown[shown.length - 1].bin_code}</span>
                  )}
                </div>
                {over && (
                  <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--warn-deep)' }}>
                    O limite é {BULK_MAX} por vez. Vamos criar as primeiras {BULK_MAX}, depois é só repetir com a próxima área.
                  </div>
                )}
              </>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="kit-btn primary" data-act="bulk-criar" disabled={busy || !codes.length} onClick={create}>
              {busy ? 'Criando…' : 'Criar ' + shown.length + ' prateleiras'}
            </button>
            {result && (
              <span className="kit-chip ok" data-bulk-result>
                Criadas {result.created}, já existiam {result.skipped}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══ PASSO 2 · calibrar a tara de um tipo de caixa ═════════════════
   Dois jeitos, porque os dois acontecem de verdade: pesar as vazias UMA
   POR UMA (dá média E variação real) ou TODAS JUNTAS (só a média; o
   sistema anota que a variação ficou desconhecida). O veredito compara a
   variação com meia garrafa típica: menos que isso, dá pra confiar. */
function CalibrateBoxModal({ type, typicalG, onClose, onDone, onError }) {
  const [mode, setMode] = React.useState('lista');   // 'lista' | 'juntas'
  const [text, setText] = React.useState('');
  const [total, setTotal] = React.useState('');
  const [count, setCount] = React.useState('10');
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState(null);  // { type, spread_g }

  const weights = React.useMemo(() => String(text || '')
    .split(/[\s,;]+/).map((x) => Number(x.replace(',', '.'))).filter((x) => Number.isFinite(x) && x > 0), [text]);
  const mean = weights.length ? weights.reduce((a, b) => a + b, 0) / weights.length : null;
  const spread = weights.length ? Math.max(...weights) - Math.min(...weights) : null;

  const gTotal = Number(total) || 0;
  const gCount = Number(count) || 0;
  const meanJuntas = gTotal > 0 && gCount > 0 ? gTotal / gCount : null;

  const valid = mode === 'lista' ? weights.length >= 1 : (gTotal > 0 && gCount > 0);

  async function save() {
    setBusy(true);
    try {
      const body = mode === 'lista' ? { weights_g: weights } : { total_g: gTotal, count: gCount };
      const res = await wh.calibrateBoxType(type.id, body);
      const d = (res && res.data) || {};
      setResult({ type: d.type || type, spread_g: d.spread_g != null ? d.spread_g : 0 });
      onDone(d);
    } catch (e) { onError(e); }
    finally { setBusy(false); }
  }

  const half = typicalG / 2;
  const rSpread = result ? n(result.spread_g) : null;
  const rTare = result && result.type ? n(result.type.tare_g) : null;
  const rSamples = result && result.type ? n(result.type.tare_samples) : null;

  return (
    <div className="kit-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="kit-modal" role="dialog" aria-label="Calibrar tara" data-modal="calibrar-caixa">
        <div className="kit-mlabel">Tara do tipo de caixa</div>
        <div className="title">Calibrar {type.name}</div>
        <div style={{ fontSize: 13, color: 'var(--ink-dim)', marginTop: 6, lineHeight: 1.5 }}>
          Pese umas 10 caixas VAZIAS desse tipo. O sistema guarda a média como tara e a variação entre elas,
          que é o que diz se dá pra confiar no peso.
        </div>

        {!result && (
          <>
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button type="button" className={'stl-method' + (mode === 'lista' ? ' on' : '')} style={{ flex: 1 }}
                      data-cal-mode="lista" onClick={() => setMode('lista')}>
                <b>Pesei uma por uma</b>
                <span>média e variação de verdade</span>
              </button>
              <button type="button" className={'stl-method' + (mode === 'juntas' ? ' on' : '')} style={{ flex: 1 }}
                      data-cal-mode="juntas" onClick={() => setMode('juntas')}>
                <b>Pesei todas juntas</b>
                <span>só total e quantas eram</span>
              </button>
            </div>

            {mode === 'lista' ? (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 12 }}>
                <span className="kit-mlabel">Peso de cada caixa vazia (g), separado por espaço ou vírgula</span>
                <textarea className="kit-input mono" rows={3} value={text} data-field="pesos"
                          placeholder="780 785 779 …" autoFocus
                          onChange={(e) => setText(e.target.value)} />
                <span style={{ fontSize: 12, color: 'var(--ink-faint)' }} data-cal-preview>
                  {weights.length
                    ? weights.length + ' caixas · média ' + mean.toFixed(1) + ' g · variação ' + spread.toFixed(0) + ' g'
                    : 'vá digitando: a conta aparece aqui'}
                </span>
              </label>
            ) : (
              <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span className="kit-mlabel">Peso total (g)</span>
                  <input className="kit-input mono" type="number" value={total} data-field="total"
                         inputMode="decimal" autoFocus placeholder="0"
                         onChange={(e) => setTotal(e.target.value)} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span className="kit-mlabel">Quantas caixas</span>
                  <input className="kit-input mono" type="number" min="1" value={count} data-field="quantas"
                         onChange={(e) => setCount(e.target.value)} />
                </label>
                <div style={{ alignSelf: 'flex-end', fontSize: 12.5, color: 'var(--ink-dim)' }} data-cal-preview>
                  {meanJuntas ? 'média ' + meanJuntas.toFixed(1) + ' g por caixa' : 'preencha os dois campos'}
                </div>
              </div>
            )}

            <div className="foot" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="kit-btn sec" onClick={onClose} disabled={busy}>Cancelar</button>
              <button className="kit-btn primary" disabled={busy || !valid} onClick={save} data-act="salvar-tara">
                {busy ? 'Salvando…' : 'Salvar tara'}
              </button>
            </div>
          </>
        )}

        {result && (
          <>
            <div className="kit-card pad" style={{ marginTop: 14 }} data-cal-result>
              <b>tara {fmt(Math.round(rTare))} g, variação ±{fmt(Math.round(rSpread / 2))} g entre {fmt(rSamples)} caixas</b>
              <div style={{ marginTop: 6, fontSize: 13 }} data-cal-verdict>
                {rSpread <= half
                  ? <span className="kit-chip ok">dá pra confiar no peso desse tipo</span>
                  : <span className="kit-chip warn">essa caixa varia demais, prefira contar na mão</span>}
              </div>
            </div>
            <div className="foot" style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <button className="kit-btn primary" onClick={onClose} data-act="fechar-cal">Pronto</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Step2Locais({ products, boxTypes, typicalG, writable, refreshTypes, onToast, onError }) {
  const [novo, setNovo] = React.useState({ name: '', length_cm: '', width_cm: '', height_cm: '' });
  const [busy, setBusy] = React.useState(false);
  const [calType, setCalType] = React.useState(null);
  const [box, setBox] = React.useState({ box_number: '', product_id: '', qty: '', box_type_id: '' });

  async function createType() {
    setBusy(true);
    try {
      await wh.createBoxType({
        name: novo.name.trim(),
        length_cm: novo.length_cm === '' ? undefined : Number(novo.length_cm),
        width_cm: novo.width_cm === '' ? undefined : Number(novo.width_cm),
        height_cm: novo.height_cm === '' ? undefined : Number(novo.height_cm),
      });
      onToast('Tipo de caixa criado. Agora calibre a tara dele.');
      setNovo({ name: '', length_cm: '', width_cm: '', height_cm: '' });
      refreshTypes();
    } catch (e) { onError(e); }
    finally { setBusy(false); }
  }

  async function createBox() {
    setBusy(true);
    try {
      await wh.addBox({
        box_number: box.box_number.trim(),
        product_id: box.product_id ? Number(box.product_id) : undefined,
        qty: box.qty === '' ? undefined : Number(box.qty),
        box_type_id: box.box_type_id ? Number(box.box_type_id) : undefined,
      });
      onToast('Caixa cadastrada');
      setBox({ box_number: '', product_id: '', qty: '', box_type_id: '' });
    } catch (e) { onError(e); }
    finally { setBusy(false); }
  }

  const dims = (t) => (t.length_cm && t.width_cm && t.height_cm
    ? fmt(t.length_cm) + ' × ' + fmt(t.width_cm) + ' × ' + fmt(t.height_cm) + ' cm'
    : 'sem medidas');

  return (
    <div data-step-body="2">
      <div className="stl-what">
        Prepare os lugares: prateleiras em lote e os tipos de caixa com a tara pesada.
      </div>

      {writable && (
        <BulkBinsCard products={products}
          onDone={(m) => onToast(m)}
          onError={onError} />
      )}

      {/* TIPOS DE CAIXA */}
      <div className="kit-card pad" style={{ marginTop: 16 }}>
        <div className="kit-mlabel" style={{ marginBottom: 4 }}>Tipos de caixa</div>
        <div style={{ fontSize: 13, color: 'var(--ink-dim)' }}>
          A caixa é cadastrada pelo tamanho (ex: 20x20x20). A tara do tipo vale pra todas as caixas dele:
          pese umas 10 vazias e o passo 3 desconta sozinho.
        </div>

        <div className="stl-types" data-boxtypes>
          {boxTypes.map((t) => (
            <div key={t.id} className="kit-card pad" data-boxtype={t.id}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <b style={{ fontFamily: 'var(--font-display)', fontSize: 17, color: 'var(--primary-deep)' }}>{t.name}</b>
                {t.needs_recalibration && (
                  <span className="kit-chip warn" data-chip="repesar">precisa re-pesar</span>
                )}
                {t.active === false && <span className="kit-chip neutral">inativo</span>}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--ink-dim)', marginTop: 4 }}>{dims(t)}</div>
              <div style={{ fontSize: 13, marginTop: 6, fontFamily: 'var(--font-mono)' }} data-type-tare>
                {t.tare_g != null
                  ? <>tara {fmtG(t.tare_g)}{t.spread_g != null && t.spread_g > 0 ? ' ± ' + fmt(Math.round(t.spread_g / 2)) + ' g' : ''}
                      <span style={{ color: 'var(--ink-faint)', marginLeft: 5 }}>({fmt(t.tare_samples)} na amostra)</span></>
                  : <span className="kit-chip warn">sem tara ainda</span>}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginTop: 4 }}>
                {t.last_calibrated_at
                  ? 'calibrada em ' + String(t.last_calibrated_at).slice(0, 10)
                  : 'nunca calibrada'}
                {t.boxes_count != null && <> · {fmt(t.boxes_count)} caixas desse tipo</>}
              </div>
              {writable && (
                <button className="kit-btn sm sec" style={{ marginTop: 10 }}
                        data-act="calibrar-tipo" data-type={t.id}
                        onClick={() => setCalType(t)}>Calibrar tara</button>
              )}
            </div>
          ))}
          {!boxTypes.length && (
            <div className="kit-card pad" style={{ color: 'var(--ink-faint)' }} data-boxtypes-empty>
              Nenhum tipo ainda. Crie o primeiro aqui embaixo: só o nome já basta pra começar.
            </div>
          )}
        </div>

        {writable && (
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'flex-end' }} data-form="novo-tipo">
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="kit-mlabel">Novo tipo (nome)</span>
              <input className="kit-input mono" style={{ width: 140 }} placeholder="20x20x20" data-field="type-name"
                     value={novo.name} onChange={(e) => setNovo({ ...novo, name: e.target.value })} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="kit-mlabel">C (cm)</span>
              <input className="kit-input mono" type="number" style={{ width: 74 }} data-field="type-l"
                     value={novo.length_cm} onChange={(e) => setNovo({ ...novo, length_cm: e.target.value })} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="kit-mlabel">L (cm)</span>
              <input className="kit-input mono" type="number" style={{ width: 74 }} data-field="type-w"
                     value={novo.width_cm} onChange={(e) => setNovo({ ...novo, width_cm: e.target.value })} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="kit-mlabel">A (cm)</span>
              <input className="kit-input mono" type="number" style={{ width: 74 }} data-field="type-h"
                     value={novo.height_cm} onChange={(e) => setNovo({ ...novo, height_cm: e.target.value })} />
            </label>
            <button className="kit-btn sm primary" data-act="criar-tipo"
                    disabled={busy || !novo.name.trim()} onClick={createType}>Criar tipo</button>
          </div>
        )}
      </div>

      {/* CAIXAS FÍSICAS com o tipo */}
      {writable && (
        <div className="kit-card pad" style={{ marginTop: 16 }} data-form="nova-caixa">
          <div className="kit-mlabel" style={{ marginBottom: 6 }}>Cadastrar caixa física</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="kit-input mono" style={{ width: 130 }} placeholder="número, ex: BX-0451" data-field="box-number"
                   value={box.box_number} onChange={(e) => setBox({ ...box, box_number: e.target.value })} />
            <select className="kit-input" style={{ minWidth: 150 }} data-field="box-type"
                    value={box.box_type_id} onChange={(e) => setBox({ ...box, box_type_id: e.target.value })}>
              <option value="">tipo da caixa</option>
              {boxTypes.filter((t) => t.active !== false).map((t) => (
                <option key={t.id} value={t.id}>{t.name}{t.tare_g != null ? ' · tara ' + Math.round(t.tare_g) + ' g' : ''}</option>
              ))}
            </select>
            <select className="kit-input" style={{ minWidth: 150 }} data-field="box-product"
                    value={box.product_id} onChange={(e) => setBox({ ...box, product_id: e.target.value })}>
              <option value="">sem produto</option>
              {products.map((p) => <option key={p.product_id} value={p.product_id}>{p.nickname || p.name}</option>)}
            </select>
            <input className="kit-input mono" type="number" style={{ width: 100 }} placeholder="quantas" data-field="box-qty"
                   value={box.qty} onChange={(e) => setBox({ ...box, qty: e.target.value })} />
            <button className="kit-btn sm primary" data-act="criar-caixa"
                    disabled={busy || !box.box_number.trim()} onClick={createBox}>Adicionar caixa</button>
          </div>
        </div>
      )}

      {calType && (
        <CalibrateBoxModal type={calType} typicalG={typicalG}
          onClose={() => { setCalType(null); refreshTypes(); }}
          onDone={() => { /* o resultado fica no modal; a lista atualiza no fechar */ }}
          onError={(e) => { onError(e); }} />
      )}
    </div>
  );
}

/* ═══ PASSO 3 · contar e carregar (o mutirão) ═══════════════════════ */
function Step3Carregar({
  rows, weights, bins, boxes, boxTypes, writable,
  onLoaded, onError, onGoStep,
}) {
  const [q, setQ] = React.useState('');
  const [pid, setPid] = React.useState(null);
  const [dest, setDest] = React.useState({ kind: 'bin', id: '' });
  const [method, setMethod] = React.useState('mao');   // 'mao' | 'peso'
  const [mode, setMode] = React.useState('contagem');  // 'contagem' | 'producao' | 'avulsas'
  const [qty, setQty] = React.useState('');
  const [grams, setGrams] = React.useState('');
  const [note, setNote] = React.useState('');
  const [computed, setComputed] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [recent, setRecent] = React.useState([]);
  const gramsRef = React.useRef(null);

  const product = rows.find((r) => r.product_id === pid) || null;
  const w = product ? weights[product.product_id] : null;
  const hasWeight = w && n(w.unit_weight_g) > 0;

  // busca por nome, apelido, SKU base e SKUs filhos
  const filtered = React.useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return rows.filter((r) => {
      if (String(r.name || '').toLowerCase().includes(s)) return true;
      if (String(r.nickname || '').toLowerCase().includes(s)) return true;
      if (String(r.base_sku || '').toLowerCase().includes(s)) return true;
      return (r.children || []).some((c) => String(c.sku || '').toLowerCase().includes(s))
        || (r.skus || []).some((c) => String(c.sku || '').toLowerCase().includes(s));
    }).slice(0, 12);
  }, [q, rows]);

  // "faltam N": quem ainda não bate com a Veeqo, do maior alvo pro menor
  const missing = React.useMemo(() => rows
    .filter((r) => veeqoOf(r) != null && n(r.total) !== veeqoOf(r))
    .sort((a, b) => veeqoOf(b) - veeqoOf(a)), [rows]);

  React.useEffect(() => { setComputed(null); setGrams(''); setQty(''); }, [pid]);
  React.useEffect(() => { setComputed(null); }, [dest.kind, dest.id, method]);
  React.useEffect(() => {
    if (method === 'peso' && gramsRef.current) gramsRef.current.focus();
  }, [method, pid]);

  async function compute(gRaw) {
    const g = Number(gRaw);
    if (!product || !Number.isFinite(g) || g <= 0) { setComputed(null); return; }
    try {
      const body = { product_id: product.product_id, gross_g: g };
      if (dest.kind === 'bin' && dest.id) body.bin_id = Number(dest.id);
      if (dest.kind === 'box' && dest.id) {
        body.box_id = Number(dest.id);
        const bx = boxes.find((b) => b.id === Number(dest.id));
        if (bx && bx.box_type_id) body.box_type_id = bx.box_type_id;
      }
      const res = await wh.computeCount(body);
      setComputed((res && res.data) || null);
    } catch (e) { setComputed(null); onError(e); }
  }

  const destLabel = () => {
    if (dest.kind === 'unplaced') return 'em A organizar';
    if (dest.kind === 'bin') {
      const b = bins.find((x) => x.id === Number(dest.id));
      return 'na prateleira ' + (b ? b.bin_code : '?');
    }
    const b = boxes.find((x) => x.id === Number(dest.id));
    return 'na caixa ' + (b ? b.box_number : '?');
  };

  async function load(qtyFinal, sourceKind, meta) {
    if (!product || !writable) return;
    const qn = Math.floor(Number(qtyFinal));
    if (!Number.isFinite(qn) || qn < 1) { onError(new Error('quantidade tem que ser 1 ou mais')); return; }
    if (dest.kind !== 'unplaced' && !dest.id) { onError(new Error('escolha a prateleira ou a caixa de destino')); return; }
    if (mode === 'avulsas' && !note.trim()) { onError(new Error('diga de onde vieram as avulsas (o campo de nota)')); return; }
    setBusy(true);
    try {
      const body = {
        product_id: product.product_id,
        qty: qn,
        dest: dest.kind === 'unplaced' ? { kind: 'unplaced' } : { kind: dest.kind, id: Number(dest.id) },
        source: sourceKind,
        client_ref: uuid(),
      };
      const m = { ...(meta || {}) };
      if (mode === 'avulsas') m.note = note.trim();
      if (Object.keys(m).length) body.meta = m;
      const res = await wh.postLoad(body);
      const d = (res && res.data) || {};
      const prod = d.product || {};
      const vq = prod.veeqo_total != null ? Number(prod.veeqo_total) : veeqoOf(product);
      const tot = prod.total != null ? Number(prod.total) : null;
      let tail = '';
      if (prod.veeqo_match) tail = ', batendo com a Veeqo.';
      else if (vq != null && tot != null) tail = tot < vq ? '. Faltam ' + fmt(vq - tot) + ' pra Veeqo.' : '. Sobram ' + fmt(tot - vq) + ' sobre a Veeqo.';
      else tail = '.';
      onLoaded(prod, fmt(qn) + ' garrafas ' + destLabel() + '. Total agora ' + fmt(tot) + tail);
      setRecent((r) => [{
        at: new Date(), product: product.nickname || product.name, qty: qn,
        dest: destLabel(), source: sourceKind,
      }].concat(r).slice(0, 15));
      setQty(''); setGrams(''); setComputed(null); setNote('');
    } catch (e) { onError(e); }
    finally { setBusy(false); }
  }

  const sourceFor = (m) => {
    if (mode === 'producao') return 'production_direct';
    if (mode === 'avulsas') return 'loose_fixed';
    return m === 'peso' ? 'count_weigh' : 'count_manual';
  };

  const weighMeta = () => (computed ? {
    gross_g: Number(grams), tare_g: computed.tare_g, net_g: computed.net_g,
    unit_weight_g: computed.unit_weight_g, qty_min: computed.qty_min, qty_max: computed.qty_max,
    residual_fraction: computed.residual_fraction, confidence: computed.confidence,
  } : { gross_g: Number(grams) });

  const vq = product ? veeqoOf(product) : null;
  const tot = product ? n(product.total) : null;
  const match = product && vq != null && tot === vq;

  return (
    <div data-step-body="3">
      <div className="stl-what">
        Escolha o produto, escolha o destino e conte do seu jeito: na mão ou pesando. O alvo é bater com a Veeqo.
      </div>

      <div className="stl-grid3" style={{ marginTop: 10 }}>
        {/* ── esquerda: escolher o produto ── */}
        <div data-col="escolher">
          <div className="kit-card pad">
            <div className="kit-mlabel" style={{ marginBottom: 8 }}>Qual produto</div>
            <input className="kit-input" style={{ width: '100%' }} data-field="busca"
                   placeholder="Buscar por nome, apelido ou SKU"
                   value={q} onChange={(e) => setQ(e.target.value)} />
            {filtered.length > 0 && (
              <div className="stl-missing" data-search-results>
                {filtered.map((r) => (
                  <button key={r.product_id} type="button" data-pick={r.product_id}
                          className={pid === r.product_id ? 'on' : ''}
                          onClick={() => { setPid(r.product_id); setQ(''); }}>
                    <span>{r.nickname || r.name}</span>
                    <span className="d">{veeqoOf(r) == null ? 'sem Veeqo' : 'Veeqo ' + fmt(veeqoOf(r))}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="kit-mlabel" style={{ margin: '14px 0 4px' }} data-missing-title>
              Faltam acertar ({missing.length})
            </div>
            <div className="stl-missing" data-missing-list>
              {missing.slice(0, 10).map((r) => {
                const v = veeqoOf(r); const t = n(r.total);
                return (
                  <button key={r.product_id} type="button" data-pick={r.product_id}
                          className={pid === r.product_id ? 'on' : ''}
                          onClick={() => setPid(r.product_id)}>
                    <span>{r.nickname || r.name}</span>
                    <span className="d" style={{ color: t < v ? 'var(--warn-deep)' : 'var(--ink-dim)' }}>
                      {t < v ? 'faltam ' + fmt(v - t) : 'sobram ' + fmt(t - v)}
                    </span>
                  </button>
                );
              })}
              {!missing.length && (
                <div style={{ fontSize: 12.5, color: 'var(--ink-faint)' }}>
                  Tudo batendo com a Veeqo. Bom trabalho.
                </div>
              )}
            </div>
          </div>

          {product && (
            <div className="kit-card pad" style={{ marginTop: 12 }} data-product-card>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--primary-deep)' }}>
                {product.nickname || product.name}
              </div>
              {product.base_sku && (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--ink-faint)', marginTop: 2 }}>
                  {product.base_sku}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                <div><div className="kit-mlabel">Alvo (Veeqo)</div>
                  <b style={{ fontSize: 18 }} data-card-veeqo>{vq == null ? 'sem total' : fmt(vq)}</b></div>
                <div><div className="kit-mlabel">Aqui agora</div>
                  <b style={{ fontSize: 18 }} data-card-total>{fmt(tot)}</b></div>
              </div>
              <div style={{ marginTop: 10 }}>
                {vq == null
                  ? <span className="kit-chip neutral" data-veeqo-chip="sem">sem total da Veeqo</span>
                  : match
                    ? <span className="kit-chip ok" data-veeqo-chip="bate">bate com a Veeqo ✓</span>
                    : <span className="kit-chip warn" data-veeqo-chip="delta"
                            title="Diferença com a Veeqo: confira ou ajuste, nada está travado">
                        {tot < vq ? 'faltam ' + fmt(vq - tot) : 'sobram ' + fmt(tot - vq)} · conferir/ajustar
                      </span>}
              </div>
              {!hasWeight && (
                <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--warn-deep)' }} data-card-sem-peso>
                  Esse produto ainda não tem peso: pesar não conta. Contar na mão funciona,
                  ou <button type="button" className="kit-btn xs sec" onClick={() => onGoStep(1)}>dê o peso no passo 1</button>.
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── direita: carregar ── */}
        <div data-col="carregar">
          {!product ? (
            <div className="kit-card pad" style={{ color: 'var(--ink-dim)' }} data-empty="sem-produto">
              Escolha um produto na lista da esquerda pra começar a carregar.
            </div>
          ) : (
            <div className="kit-card pad">
              {/* destino primeiro: onde a garrafa vai morar */}
              <div className="kit-mlabel" style={{ marginBottom: 8 }}>1 · Pra onde vai</div>
              <div className="stl-dest" data-dest-row>
                {[['bin', 'Prateleira'], ['box', 'Caixa'], ['unplaced', 'A organizar']].map(([k, label]) => (
                  <button key={k} type="button" className={dest.kind === k ? 'on' : ''}
                          data-dest={k} onClick={() => setDest({ kind: k, id: '' })}>{label}</button>
                ))}
              </div>
              {dest.kind === 'bin' && (
                bins.length ? (
                  <select className="kit-input" style={{ marginTop: 10, minWidth: 220 }} data-field="dest-bin"
                          value={dest.id} onChange={(e) => setDest({ kind: 'bin', id: e.target.value })}>
                    <option value="">escolha a prateleira</option>
                    {bins.filter((b) => b.active !== false).map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.bin_code}{b.product ? ' · ' + b.product : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div style={{ marginTop: 10, fontSize: 13, color: 'var(--warn-deep)' }} data-empty="sem-bins">
                    Nenhuma prateleira ainda. <button type="button" className="kit-btn xs sec"
                      data-act="ir-passo2" onClick={() => onGoStep(2)}>Crie as prateleiras no passo 2</button>
                  </div>
                )
              )}
              {dest.kind === 'box' && (
                boxes.length ? (
                  <select className="kit-input" style={{ marginTop: 10, minWidth: 220 }} data-field="dest-box"
                          value={dest.id} onChange={(e) => setDest({ kind: 'box', id: e.target.value })}>
                    <option value="">escolha a caixa</option>
                    {boxes.map((b) => {
                      const t = boxTypes.find((x) => x.id === b.box_type_id);
                      return (
                        <option key={b.id} value={b.id}>
                          {b.box_number}{t ? ' · ' + t.name : ''}{b.product ? ' · ' + b.product : ''}
                        </option>
                      );
                    })}
                  </select>
                ) : (
                  <div style={{ marginTop: 10, fontSize: 13, color: 'var(--warn-deep)' }} data-empty="sem-boxes">
                    Nenhuma caixa ainda. <button type="button" className="kit-btn xs sec"
                      onClick={() => onGoStep(2)}>Cadastre no passo 2</button>
                  </div>
                )
              )}

              {/* a escolha lado a lado, sempre as duas na frente */}
              <div className="kit-mlabel" style={{ margin: '16px 0 8px' }}>2 · Como você contou</div>
              <div className="stl-methods" data-methods>
                <button type="button" className={'stl-method' + (method === 'mao' ? ' on' : '')}
                        data-method="mao" onClick={() => setMethod('mao')}>
                  <b>Contei na mão</b>
                  <span>digita a quantidade e pronto</span>
                </button>
                <button type="button" className={'stl-method' + (method === 'peso' ? ' on' : '')}
                        data-method="peso" onClick={() => setMethod('peso')}>
                  <b>Pesei</b>
                  <span>o sistema faz a conta pra você</span>
                </button>
              </div>

              {method === 'mao' && (
                <div data-form="mao">
                  <div className="stl-qty">
                    <button type="button" data-act="menos"
                            onClick={() => setQty(String(Math.max(1, (Number(qty) || 1) - 1)))}>-</button>
                    <input className="kit-input mono" type="number" min="1" value={qty} placeholder="quantas"
                           inputMode="numeric" data-field="qtd"
                           onChange={(e) => setQty(e.target.value)}
                           onKeyDown={(e) => { if (e.key === 'Enter' && Number(qty) >= 1) load(qty, sourceFor('mao')); }} />
                    <button type="button" data-act="mais"
                            onClick={() => setQty(String((Number(qty) || 0) + 1))}>+</button>
                  </div>
                  <button className="kit-btn primary" style={{ marginTop: 12, minHeight: 44 }}
                          data-act="carregar-mao" disabled={busy || !writable || !(Number(qty) >= 1)}
                          onClick={() => load(qty, sourceFor('mao'))}>
                    {busy ? 'Carregando…' : 'Carregar ' + (Number(qty) >= 1 ? fmt(Number(qty)) + ' garrafas' : '')}
                  </button>
                </div>
              )}

              {method === 'peso' && (
                <div data-form="peso">
                  <div className="stl-grams" style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      <span className="kit-mlabel">Peso na balança (g)</span>
                      <input ref={gramsRef} className="kit-input mono" type="number" value={grams} placeholder="0"
                             inputMode="decimal" autoFocus data-field="gramas"
                             onChange={(e) => { setGrams(e.target.value); setComputed(null); }}
                             onKeyDown={(e) => { if (e.key === 'Enter') compute(grams); }} />
                    </label>
                    <button className="kit-btn sec" style={{ minHeight: 44 }} data-act="calcular"
                            disabled={!grams || !hasWeight} onClick={() => compute(grams)}>Calcular</button>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-faint)', marginTop: 5 }} data-hint="balanca">
                    aceita balança USB que digita sozinha: deixe o cursor no campo e ela preenche
                  </div>

                  {computed && (
                    <div style={{ marginTop: 12 }} data-compute-result>
                      <div style={{ fontSize: 15 }}>
                        <b data-compute-range>
                          {computed.qty_min !== computed.qty_max
                            ? 'dá ' + fmt(computed.qty_min) + ' a ' + fmt(computed.qty_max) + ' garrafas'
                            : 'dá ' + fmt(computed.qty) + ' garrafas'}
                        </b>
                        <span style={{ color: 'var(--ink-dim)', marginLeft: 8 }} data-compute-conf>
                          · confiança {computed.confidence}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--ink-faint)', marginTop: 3 }}>
                        tara usada {fmtG(computed.tare_g)} · líquido {fmtG(computed.net_g)} · vamos registrar {fmt(computed.qty)}
                      </div>

                      {computed.recount_suggested ? (
                        <div className="stl-recount" data-recount-card>
                          <b>Deu muita sobra pra fechar a conta.</b> Melhor contar na mão do que gravar um número duvidoso.
                          <div className="acts">
                            <button className="kit-btn sm" data-act="usar-assim-mesmo" disabled={busy || !writable}
                                    onClick={() => load(computed.qty, sourceFor('peso'), weighMeta())}>
                              usar {fmt(computed.qty)} assim mesmo
                            </button>
                            <button className="kit-btn sm sec" data-act="vou-contar-mao"
                                    onClick={() => { setMethod('mao'); setQty(''); }}>
                              vou contar na mão
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button className="kit-btn primary" style={{ marginTop: 12, minHeight: 44 }}
                                data-act="carregar-peso" disabled={busy || !writable || !(computed.qty >= 1)}
                                onClick={() => load(computed.qty, sourceFor('peso'), weighMeta())}>
                          {busy ? 'Carregando…' : 'Carregar ' + fmt(computed.qty) + ' garrafas'}
                        </button>
                      )}
                    </div>
                  )}
                  {!hasWeight && (
                    <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--warn-deep)' }}>
                      Sem o peso da unidade a balança não sabe contar. Use "Contei na mão" ou pese o produto no passo 1.
                    </div>
                  )}
                </div>
              )}

              {/* nota obrigatória das avulsas */}
              {mode === 'avulsas' && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 12 }}>
                  <span className="kit-mlabel">De onde vieram (obrigatório)</span>
                  <input className="kit-input" data-field="nota" value={note}
                         placeholder="ex: achadas no fundo do palete 2, etiqueta refeita"
                         onChange={(e) => setNote(e.target.value)} />
                </label>
              )}

              {/* atalhos de origem: os dois caminhos extras do dia a dia */}
              <div className="kit-mlabel" style={{ margin: '16px 0 6px' }}>Veio de outro lugar?</div>
              <div className="stl-shortcuts" data-shortcuts>
                <button type="button" className={'stl-shortcut' + (mode === 'producao' ? ' on' : '')}
                        data-shortcut="producao"
                        onClick={() => setMode(mode === 'producao' ? 'contagem' : 'producao')}>
                  <b>Chegou da produção, direto pra prateleira</b>
                  <span>{mode === 'producao' ? 'ativo · o registro sai como vindo da produção' : 'caixa no zero? garrafa nova entra aqui'}</span>
                </button>
                <button type="button" className={'stl-shortcut' + (mode === 'avulsas' ? ' on' : '')}
                        data-shortcut="avulsas"
                        onClick={() => setMode(mode === 'avulsas' ? 'contagem' : 'avulsas')}>
                  <b>Avulsas com etiqueta consertada</b>
                  <span>{mode === 'avulsas' ? 'ativo · diga de onde vieram na nota' : 'garrafa solta pelo armazém, rótulo refeito'}</span>
                </button>
              </div>
            </div>
          )}

          {/* últimos carregamentos da sessão */}
          {recent.length > 0 && (
            <div className="kit-card pad stl-recent" data-recent>
              <div className="kit-mlabel" style={{ marginBottom: 6 }}>Últimos carregamentos (esta sessão)</div>
              <ul style={{ margin: 0, padding: 0 }}>
                {recent.map((r, i) => (
                  <li key={i} data-recent-item>
                    <span className="t">{r.at.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                    <b>{r.product}</b>
                    <span>{fmt(r.qty)} garrafas</span>
                    <span style={{ color: 'var(--ink-dim)' }}>{r.dest}</span>
                    <span className={'kit-chip ' + (SOURCE_TONE[r.source] || 'neutral')} data-source-chip={r.source}>
                      {SOURCE_LABEL[r.source] || r.source}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══ A PÁGINA ══════════════════════════════════════════════════════ */
export function StockLoadPage() {
  const writable = canWrite();
  const ov = wh.useWarehouse('/overview', [], 0);
  const loc = wh.useWarehouse('/locations', [], 0);
  const types = wh.useWarehouse('/box-types', [], 0);
  const prog = wh.useWarehouse('/load/progress', [], 30000);

  const [step, setStep] = React.useState(1);
  const [weights, setWeights] = React.useState({});
  const [patch, setPatch] = React.useState({});        // product_id → totais pós-load
  const [dismissed, setDismissed] = React.useState({}); // box_type_id → true
  const [toast, setToast] = React.useState(null);

  React.useEffect(() => {
    let on = true;
    wh.getWeights().then((j) => {
      if (!on) return;
      const map = {};
      (((j || {}).data || {}).products || []).forEach((w) => { map[w.product_id] = w; });
      setWeights(map);
    }).catch(() => { /* sem pesos ainda: o passo 1 mostra "sem peso" */ });
    return () => { on = false; };
  }, []);

  const ack = React.useCallback((m, bad) => {
    setToast({ msg: m, bad: !!bad });
    setTimeout(() => setToast(null), 3200);
  }, []);
  const ackErr = React.useCallback((e) => ack(friendlyError(e), true), [ack]);

  const rows = React.useMemo(() => {
    const base = ((ov.data || {}).products || []);
    return base.map((r) => (patch[r.product_id] ? { ...r, ...patch[r.product_id] } : r));
  }, [ov.data, patch]);

  const bins = ((loc.data || {}).bins || []);
  const boxes = ((loc.data || {}).boxes || []);
  const boxTypes = ((types.data || {}).types || []);
  const p = (prog.data || {});
  const warns = (p.recalibration_warnings || []).filter((wr) => !dismissed[wr.box_type_id]);
  const typicalG = typicalBottleG(weights);

  if (!canRead()) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-dim)' }}>
        <h2 className="kit-h2">Sem acesso</h2>
        <p className="kit-sub">Essa página precisa da função view_stock.</p>
      </div>
    );
  }

  return (
    <div data-page="montar" style={{ paddingBottom: 60 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <span className="kit-eyebrow">● HEALTHFARE P&amp;P · CARGA DO ARMAZÉM</span>
          <h1 className="kit-h1">Montar o <em>estoque</em></h1>
          <p className="kit-sub">
            Pesos, locais e a contagem, na ordem do trabalho. O alvo de cada produto é o total da Veeqo:
            diferença é aviso pra conferir, nunca trava.
          </p>
        </div>
        <a className="kit-btn sec" href="#estoque">Voltar ao estoque</a>
      </div>

      {/* progresso do mutirão: sempre à vista */}
      <div className="stl-progress" style={{ marginTop: 14 }} data-progress>
        <span><span className="n" data-prog="produtos">{fmt(p.products_total)}</span> produtos</span>
        <span className="sep">·</span>
        <span><span className="n" data-prog="pesos">{fmt(p.products_with_weight)}</span> com peso</span>
        <span className="sep">·</span>
        <span><span className="n" data-prog="bins">{fmt(p.bins_count)}</span> prateleiras</span>
        <span className="sep">·</span>
        <span><span className="n" data-prog="tipos">{fmt(p.box_types_count)}</span> tipos de caixa</span>
        <span className="sep">·</span>
        <span><span className="n" data-prog="garrafas">{fmt(p.bottles_loaded)}</span> garrafas</span>
        <span className="sep">·</span>
        <span><span className="n" data-prog="batendo">{fmt(p.products_matching_veeqo)}</span> batendo com a Veeqo</span>
        {warns.map((wr) => (
          <span key={wr.box_type_id} className="stl-recalib" data-recalib-chip={wr.box_type_id}>
            Precisamos re-pesar as caixas {wr.name}
            <button type="button" className="go" data-act="recalib-ir"
                    onClick={() => setStep(2)}>ver no passo 2</button>
            <button type="button" data-act="recalib-fechar" title="Dispensar o aviso por agora"
                    onClick={() => setDismissed((d) => ({ ...d, [wr.box_type_id]: true }))}>×</button>
          </span>
        ))}
      </div>

      {/* os três passos, na ordem do trabalho */}
      <div className="stl-steps" data-steps>
        {[[1, 'Produtos e pesos'], [2, 'Locais e caixas'], [3, 'Contar e carregar']].map(([num, label]) => (
          <button key={num} type="button" className={'stl-step' + (step === num ? ' on' : '')}
                  data-step={num} onClick={() => setStep(num)}>
            <span className="num">{num}</span>{label}
          </button>
        ))}
      </div>

      {ov.error && (
        <div className="kit-card pad bad" style={{ marginTop: 14 }}>
          Não deu pra carregar os produtos. {friendlyError(ov.error)}
        </div>
      )}

      {step === 1 && (
        <Step1Produtos rows={rows} weights={weights} writable={writable}
          onWeighSaved={(prod, unit, c) => {
            setWeights((m) => ({ ...m, [prod.product_id]: { product_id: prod.product_id, unit_weight_g: unit, samples: c } }));
            ack('Peso salvo: ' + (unit ? unit.toFixed(2) : '?') + ' g por garrafa. A balança já conta com ele.');
            prog.refresh();
          }}
          onError={ackErr} />
      )}

      {step === 2 && (
        <Step2Locais products={rows} boxTypes={boxTypes} typicalG={typicalG} writable={writable}
          refreshTypes={() => { types.refresh(); prog.refresh(); loc.refresh(); }}
          onToast={(m) => { ack(m); prog.refresh(); loc.refresh(); }}
          onError={ackErr} />
      )}

      {step === 3 && (
        <Step3Carregar rows={rows} weights={weights} bins={bins} boxes={boxes}
          boxTypes={boxTypes} writable={writable}
          onLoaded={(prod, msg) => {
            if (prod && prod.product_id != null) {
              setPatch((m) => ({ ...m, [prod.product_id]: {
                total: prod.total, shelf_qty: prod.shelf_qty, box_qty: prod.box_qty,
                unplaced_qty: prod.unplaced_qty,
                ...(prod.veeqo_total != null ? { veeqo_total: prod.veeqo_total } : {}),
              } }));
            }
            ack(msg);
            prog.refresh();
          }}
          onError={ackErr}
          onGoStep={setStep} />
      )}

      {toast && <div className={'kit-toast ' + (toast.bad ? 'bad' : '')} data-toast>{toast.msg}</div>}
    </div>
  );
}

export default StockLoadPage;
