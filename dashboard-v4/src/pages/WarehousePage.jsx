/* Página "Estoque" (#estoque) — o HUB do armazém (S15 Fase 1, Bruno 08-18).
   UMA página gerencia o inventário inteiro: total = prateleira + caixa + a
   organizar, reservado vem dos pedidos abertos da Veeqo, separadas nunca contam.

   Layout no STYLE-KIT (kit.css é global): eyebrow DM Mono verde, H1 DM Serif com
   uma palavra itálica, KPIs clicáveis que filtram, card "Precisa de atenção hoje"
   full width, tabela de produtos, painel lateral do produto e modais 2 passos
   (Revisar → Confirmar). Sem travessão em texto de UI.

   Contrato: docs/architecture/study/S15-BUILD-PLAN.md (GET overview, GET
   product/:id, POSTs que devolvem { ok:true, product:Row }).
*/
import React from 'react';
import { can, getLogin } from '../adapters/from-api.js';
import * as wh from '../adapters/warehouse-api.js';

// ── RBAC ──────────────────────────────────────────────────────────
// Escrita = manage_stock (ou '*'). Login sem lista de funções: libera (os logins
// de hoje têm '*'; nenhum operador chega aqui, a seção é gated no Shell).
export function canWrite() {
  const l = getLogin();
  if (!l || !Array.isArray(l.functions)) return true;
  return can('manage_stock');
}
export function canRead() {
  const l = getLogin();
  if (!l || !Array.isArray(l.functions)) return true;
  return can('view_stock') || can('manage_stock');
}

// ── helpers ───────────────────────────────────────────────────────
const n = (v) => (v == null ? 0 : Number(v));
const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR'));
const STATUS_LABEL = {
  ok: 'ok', baixo: 'baixo', zerado: 'zerado', negativo: 'negativo',
  drift: 'drift', pendente: 'aprovação pendente', organizar: 'organizar',
  sem_local: 'sem local', sem_sku: 'SKU não mapeado', repor: 'repor prateleira',
};
const STATUS_TONE = {
  ok: 'ok', baixo: 'warn', zerado: 'bad', negativo: 'bad', drift: 'bad',
  pendente: 'warn', organizar: 'warn', sem_local: 'neutral', sem_sku: 'warn', repor: 'warn',
};
const statusLabel = (s) => STATUS_LABEL[s] || String(s).replace(/_/g, ' ');
const statusTone = (s) => STATUS_TONE[s] || 'neutral';

const ATTN_LIMIT = 8;
const ATTENTION_TONE = {
  out: 'bad', negative: 'bad', drift: 'bad',
  low: 'warn', pending: 'warn', organizar: 'warn', sem_local: 'neutral',
};
const ATTENTION_LABEL = {
  out: 'ZERADO', low: 'BAIXO', negative: 'NEGATIVO', organizar: 'ORGANIZAR',
  pending: 'PENDENTE', drift: 'DRIFT', sem_local: 'SEM LOCAL',
};

function locChips(row) {
  const out = [];
  (row.bins || []).forEach((b) => out.push({ k: 'bin-' + b.id, t: [b.shelf_code, b.bin_code].filter(Boolean).join(' ') }));
  (row.boxes || []).forEach((b) => out.push({ k: 'box-' + b.id, t: b.box_number }));
  return out;
}

// ═══ modal genérico 2 passos ══════════════════════════════════════
function TwoStepModal({ title, product, baseSku, children, preview, onCancel, onConfirm, confirmLabel, busy, danger }) {
  const [step, setStep] = React.useState(1);
  return (
    <div className="kit-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="kit-modal" role="dialog" aria-label={title}>
        <div className="kit-mlabel">{step === 1 ? 'Passo 1 de 2 · preencher' : 'Passo 2 de 2 · confirmar'}</div>
        <div className="title">{title}</div>
        <div style={{ fontSize: 13, color: 'var(--ink-dim)', marginTop: 4 }}>
          {product ? product.nickname || product.name : ''}
          {baseSku ? <span className="kit-chip neutral" style={{ marginLeft: 8 }}>{baseSku}</span> : null}
        </div>

        {step === 1 && <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>}

        <div className="preview">
          <div className="kit-mlabel" style={{ marginBottom: 6 }}>Como fica</div>
          {preview}
        </div>

        <div className="foot">
          <button className="kit-btn sec" onClick={onCancel} disabled={busy}>Cancelar</button>
          {step === 1
            ? <button className="kit-btn primary" data-act="revisar" onClick={() => setStep(2)}>Revisar</button>
            : (
              <>
                <button className="kit-btn sec" onClick={() => setStep(1)} disabled={busy}>Voltar</button>
                <button className={'kit-btn ' + (danger ? 'danger' : 'primary')} data-act="confirmar"
                        onClick={onConfirm} disabled={busy}>
                  {busy ? 'Salvando…' : (confirmLabel || 'Confirmar')}
                </button>
              </>
            )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span className="kit-mlabel">{label}</span>
      {children}
    </label>
  );
}

// ═══ modais de ação ═══════════════════════════════════════════════
function ActionModal({ action, row, onClose, onDone, onError }) {
  const [qty, setQty] = React.useState('');
  const [dest, setDest] = React.useState('unplaced');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [reason, setReason] = React.useState(action === 'separar' ? 'label' : '');
  const [orderNumber, setOrderNumber] = React.useState('');
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const q = Number(qty) || 0;
  const bins = row.bins || [];
  const boxes = row.boxes || [];
  const locOptions = [
    ...bins.map((b) => ({ v: 'bin:' + b.id, t: 'Prateleira ' + [b.shelf_code, b.bin_code].filter(Boolean).join(' ') })),
    ...boxes.map((b) => ({ v: 'box:' + b.id, t: 'Caixa ' + b.box_number })),
  ];
  const parseLoc = (v) => {
    if (!v) return {};
    const [k, id] = v.split(':');
    return k === 'bin' ? { bin_id: Number(id) } : { box_id: Number(id) };
  };

  // preview dos números novos
  const cur = { total: n(row.total), shelf: n(row.shelf_qty), box: n(row.box_qty), unplaced: n(row.unplaced_qty), available: n(row.available) };
  const next = { ...cur };
  if (action === 'entrada') {
    next.total = cur.total + q; next.available = cur.available + q;
    if (dest === 'unplaced') next.unplaced = cur.unplaced + q;
    else if (dest.startsWith('bin:')) next.shelf = cur.shelf + q;
    else next.box = cur.box + q;
  } else if (action === 'organizar') {
    next.unplaced = cur.unplaced - q;
    if (to.startsWith('bin:')) next.shelf = cur.shelf + q; else if (to.startsWith('box:')) next.box = cur.box + q;
  } else if (action === 'mover') {
    if (from.startsWith('bin:')) next.shelf = cur.shelf - q; else if (from.startsWith('box:')) next.box = cur.box - q;
    if (to.startsWith('bin:')) next.shelf = cur.shelf + q; else if (to.startsWith('box:')) next.box = cur.box + q;
  } else if (action === 'ajustar') {
    const d = Number(qty) || 0;
    next.total = cur.total + d; next.available = cur.available + d;
    if (from.startsWith('bin:')) next.shelf = cur.shelf + d; else if (from.startsWith('box:')) next.box = cur.box + d;
    else next.unplaced = cur.unplaced + d;
  } else if (action === 'separar' || action === 'devolucao') {
    if (action === 'separar' && reason !== 'return') {
      next.total = cur.total - q; next.available = cur.available - q;
      if (from.startsWith('bin:')) next.shelf = cur.shelf - q; else next.unplaced = cur.unplaced - q;
    }
  }

  const TITLES = {
    entrada: 'Entrada de garrafas', organizar: 'Organizar (colocar em local)',
    mover: 'Mover entre locais', ajustar: 'Ajustar quantidade',
    separar: 'Separar garrafas', devolucao: 'Registrar devolução',
  };

  async function confirm() {
    setBusy(true);
    try {
      let res;
      if (action === 'entrada') {
        const body = { qty: q, note: note || undefined };
        if (dest.startsWith('bin:')) body.bin_id = Number(dest.split(':')[1]);
        else if (dest.startsWith('box:')) {
          const b = boxes.find((x) => x.id === Number(dest.split(':')[1]));
          if (b) body.box_number = b.box_number;
        }
        res = await wh.postEntrada(row.product_id, body);
      } else if (action === 'organizar') {
        res = await wh.postPlace(row.product_id, { qty: q, ...parseLoc(to) });
      } else if (action === 'mover') {
        res = await wh.postMove(row.product_id, { qty: q, from: parseLoc(from), to: parseLoc(to) });
      } else if (action === 'ajustar') {
        res = await wh.postAdjust(row.product_id, { qty: Number(qty), reason, ...parseLoc(from) });
      } else if (action === 'separar') {
        res = await wh.postSeparate(row.product_id, {
          qty: q, reason: reason || 'other', ...parseLoc(from),
          order_number: orderNumber || undefined, note: note || undefined,
        });
      } else if (action === 'devolucao') {
        res = await wh.postSeparate(row.product_id, {
          qty: q, reason: 'return', order_number: orderNumber || undefined, note: note || undefined,
        });
      }
      onDone(res && res.data && res.data.product, TITLES[action] + ' salva');
    } catch (e) {
      onError(e.message || 'erro ao salvar');
    } finally { setBusy(false); }
  }

  const numInput = (
    <Field label={action === 'ajustar' ? 'Quantidade com sinal (+ entra, - sai)' : 'Quantidade de garrafas'}>
      <input className="kit-input mono" type="number" value={qty} autoFocus
             onChange={(e) => setQty(e.target.value)} placeholder="0" />
    </Field>
  );

  return (
    <TwoStepModal
      title={TITLES[action]} product={row} baseSku={row.base_sku} busy={busy}
      danger={action === 'separar' || action === 'ajustar'}
      onCancel={onClose} onConfirm={confirm}
      confirmLabel={'Confirmar: ' + TITLES[action].toLowerCase()}
      preview={(
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(96px,1fr))', gap: 10 }}>
          <div><div className="kit-mlabel">Total</div><b>{cur.total} → {next.total}</b></div>
          <div><div className="kit-mlabel">Prateleira</div><b>{cur.shelf} → {next.shelf}</b></div>
          <div><div className="kit-mlabel">Caixa</div><b>{cur.box} → {next.box}</b></div>
          <div><div className="kit-mlabel">A organizar</div><b>{cur.unplaced} → {next.unplaced}</b></div>
          <div><div className="kit-mlabel">Disponível</div><b>{cur.available} → {next.available}</b></div>
        </div>
      )}
    >
      {numInput}

      {action === 'entrada' && (
        <Field label="Onde entra">
          <select className="kit-input" value={dest} onChange={(e) => setDest(e.target.value)}>
            <option value="unplaced">A organizar (sem local ainda)</option>
            {locOptions.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
          </select>
        </Field>
      )}

      {(action === 'organizar') && (
        <Field label="Colocar em">
          <select className="kit-input" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">escolher local</option>
            {locOptions.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
          </select>
        </Field>
      )}

      {action === 'mover' && (
        <>
          <Field label="De">
            <select className="kit-input" value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">escolher origem</option>
              {locOptions.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
            </select>
          </Field>
          <Field label="Para">
            <select className="kit-input" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">escolher destino</option>
              {locOptions.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
            </select>
          </Field>
        </>
      )}

      {action === 'ajustar' && (
        <>
          <Field label="Local (opcional)">
            <select className="kit-input" value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">A organizar / sem local</option>
              {locOptions.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
            </select>
          </Field>
          <Field label="Motivo (obrigatório)">
            <input className="kit-input" value={reason} onChange={(e) => setReason(e.target.value)}
                   placeholder="ex: contagem física do dia" />
          </Field>
        </>
      )}

      {action === 'separar' && (
        <>
          <Field label="Motivo">
            <div className="kit-seg">
              {['label', 'seal', 'other', 'return'].map((r) => (
                <button key={r} type="button" className={reason === r ? 'on' : ''} onClick={() => setReason(r)}>
                  {r === 'label' ? 'label' : r === 'seal' ? 'lacre' : r === 'other' ? 'outro' : 'devolução'}
                </button>
              ))}
            </div>
          </Field>
          <Field label="De qual prateleira (opcional)">
            <select className="kit-input" value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">sem local</option>
              {bins.map((b) => <option key={b.id} value={'bin:' + b.id}>{[b.shelf_code, b.bin_code].filter(Boolean).join(' ')}</option>)}
            </select>
          </Field>
        </>
      )}

      {(action === 'separar' || action === 'devolucao') && (
        <Field label="Número do pedido (opcional)">
          <input className="kit-input mono" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} placeholder="ex: 12-345" />
        </Field>
      )}

      {action !== 'ajustar' && (
        <Field label="Observação (opcional)">
          <input className="kit-input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      )}
    </TwoStepModal>
  );
}

// ═══ painel lateral do produto ════════════════════════════════════
function ProductPanel({ row, onClose, onAction, onRowUpdate, ack, writable, allRows }) {
  const [tab, setTab] = React.useState('locais');
  const [d, setD] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [mergeInto, setMergeInto] = React.useState('');
  const [mergeStep, setMergeStep] = React.useState(0);
  const [newSku, setNewSku] = React.useState({ sku: '', channel: 'veeqo', units_per_pack: 1, role: 'member' });

  const load = React.useCallback(() => {
    wh.getProduct(row.product_id).then((j) => { setD(j.data); setErr(null); }, (e) => setErr(e));
  }, [row.product_id]);
  React.useEffect(() => { setD(null); load(); }, [load]);

  const p = (d && d.product) || row;

  async function act(fn, okMsg) {
    setBusy(true);
    try { const r = await fn(); ack(okMsg); if (r && r.data && r.data.product) onRowUpdate(r.data.product); load(); }
    catch (e) { ack('erro: ' + (e.message || e)); }
    finally { setBusy(false); }
  }

  const TABS = [
    ['locais', 'Locais'], ['pedidos', 'Pedidos abertos'], ['mov', 'Movimentos'],
    ['separadas', 'Separadas'], ['pend', 'Pendências'], ['familia', 'Família'], ['config', 'Config'],
  ];

  return (
    <>
      <div className="kit-drawer-back" onClick={onClose} />
      <aside className="kit-drawer" data-panel="produto">
        <div className="head">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, color: 'var(--primary-deep)', lineHeight: 1.1 }}>
                {p.nickname || p.name}
              </div>
              <div style={{ color: 'var(--ink-dim)', fontSize: 12.5 }}>{p.name}</div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                {(p.status || []).map((s) => <span key={s} className={'kit-chip ' + statusTone(s)}>{statusLabel(s)}</span>)}
              </div>
            </div>
            <button className="kit-btn sec sm" onClick={onClose}>Fechar</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 8, marginTop: 14 }}>
            {[['Total', p.total], ['Pratel.', p.shelf_qty], ['Caixa', p.box_qty],
              ['A org.', p.unplaced_qty], ['Reserv.', p.reserved], ['Dispon.', p.available]].map(([l, v]) => (
              <div key={l}>
                <div className="kit-mlabel">{l}</div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: 'var(--primary-deep)', fontVariantNumeric: 'tabular-nums' }}>{fmt(v)}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="tabs">
          {TABS.map(([k, t]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t}</button>
          ))}
        </div>

        <div className="body">
          {err && <div className="kit-card pad bad" style={{ marginBottom: 12 }}>Erro ao carregar o produto: {err.message}</div>}
          {!d && !err && <div className="kit-card pad" style={{ color: 'var(--ink-dim)' }}>Carregando o produto…</div>}

          {tab === 'locais' && (
            <div className="kit-card pad">
              <div className="kit-mlabel" style={{ marginBottom: 8 }}>Prateleiras e caixas</div>
              <table className="kit-table">
                <thead><tr><th>Local</th><th>Área</th><th className="num">Qtd</th><th className="num">Mín</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {(p.bins || []).map((b) => (
                    <tr key={'b' + b.id}>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{[b.shelf_code, b.bin_code].filter(Boolean).join(' ')}</td>
                      <td style={{ color: 'var(--ink-dim)' }}>{b.area || '—'}</td>
                      <td className="num">{fmt(b.qty)}</td>
                      <td className="num">{fmt(b.min_qty)}</td>
                      <td>{b.needs_restock ? <span className="kit-chip warn">repor</span> : <span className="kit-chip ok">ok</span>}</td>
                      <td>{writable && (
                        <span style={{ display: 'flex', gap: 6 }}>
                          <button className="kit-btn xs sec" onClick={() => onAction('mover', p)}>Repor</button>
                          <button className="kit-btn xs sec" onClick={() => onAction('ajustar', p)}>Contar</button>
                        </span>
                      )}</td>
                    </tr>
                  ))}
                  {(p.boxes || []).map((b) => (
                    <tr key={'x' + b.id}>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{b.box_number}</td>
                      <td style={{ color: 'var(--ink-dim)' }}>{b.area || '—'}</td>
                      <td className="num">{fmt(b.qty)}</td>
                      <td className="num">—</td>
                      <td><span className="kit-chip neutral">caixa</span></td>
                      <td>{writable && <button className="kit-btn xs sec" onClick={() => onAction('mover', p)}>Mover</button>}</td>
                    </tr>
                  ))}
                  {!(p.bins || []).length && !(p.boxes || []).length && (
                    <tr><td colSpan={6} style={{ color: 'var(--ink-faint)' }}>Sem prateleira nem caixa. Cadastre em Locais.</td></tr>
                  )}
                </tbody>
              </table>
              {n(p.unplaced_qty) > 0 && (
                <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="kit-chip warn">{fmt(p.unplaced_qty)} a organizar</span>
                  {writable && <button className="kit-btn sm" onClick={() => onAction('organizar', p)}>Organizar</button>}
                </div>
              )}
            </div>
          )}

          {tab === 'pedidos' && (
            <div className="kit-card pad">
              <div className="kit-mlabel" style={{ marginBottom: 8 }}>Pedidos abertos (a reserva)</div>
              <table className="kit-table">
                <thead><tr><th>Pedido</th><th>Canal</th><th>SKU</th><th className="num">Qtd</th><th className="num">Garrafas</th><th>Status</th><th className="num">Idade</th></tr></thead>
                <tbody>
                  {((d && d.open_orders) || []).map((o, i) => (
                    <tr key={o.order_number + i}>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{o.order_number}</td>
                      <td><span className="kit-chip neutral">{o.channel}</span></td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{o.sku}</td>
                      <td className="num">{fmt(o.qty)}</td>
                      <td className="num">{fmt(o.bottles)}</td>
                      <td style={{ color: 'var(--ink-dim)' }}>{o.status}</td>
                      <td className="num">{o.age_min != null ? Math.round(o.age_min / 60) + 'h' : '—'}</td>
                    </tr>
                  ))}
                  {d && !((d.open_orders || []).length) && <tr><td colSpan={7} style={{ color: 'var(--ink-faint)' }}>Nenhum pedido aberto pra este produto.</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'mov' && (
            <div className="kit-card pad">
              <div className="kit-mlabel" style={{ marginBottom: 8 }}>Movimentos (mais novo primeiro)</div>
              <table className="kit-table">
                <thead><tr><th>Quando</th><th>Tipo</th><th className="num">Qtd</th><th>Local</th><th>Quem</th><th>Origem</th></tr></thead>
                <tbody>
                  {((d && d.movements) || []).map((m) => (
                    <tr key={m.id}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{String(m.created_at || '').slice(0, 16).replace('T', ' ')}</td>
                      <td><span className="kit-chip neutral">{m.kind}</span></td>
                      <td className="num">{m.qty > 0 ? '+' : ''}{fmt(m.qty)}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{m.bin_code || m.box_number || '—'}</td>
                      <td style={{ color: 'var(--ink-dim)' }}>{m.person || '—'}</td>
                      <td style={{ color: 'var(--ink-faint)', fontSize: 12 }}>{m.source || '—'}</td>
                    </tr>
                  ))}
                  {d && !((d.movements || []).length) && <tr><td colSpan={6} style={{ color: 'var(--ink-faint)' }}>Nenhum movimento registrado.</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'separadas' && (
            <div className="kit-card pad">
              <div className="kit-mlabel" style={{ marginBottom: 8 }}>Separadas (nunca contam no total)</div>
              <table className="kit-table">
                <thead><tr><th className="num">Qtd</th><th>Motivo</th><th>Pedido</th><th>Quem</th><th>Quando</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {((d && d.issues) || []).map((it) => (
                    <tr key={it.id}>
                      <td className="num">{fmt(it.qty)}</td>
                      <td><span className="kit-chip warn">{it.reason}</span></td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{it.order_number || '—'}</td>
                      <td style={{ color: 'var(--ink-dim)' }}>{it.person || '—'}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{String(it.created_at || '').slice(0, 10)}</td>
                      <td>{it.status}</td>
                      <td>{writable && it.status === 'separated' && (
                        <span style={{ display: 'flex', gap: 5 }}>
                          <button className="kit-btn xs sec" disabled={busy}
                                  onClick={() => act(() => wh.resolveIssue(it.id, { action: 'restocked' }), 'voltou ao estoque')}>Voltar ao estoque</button>
                          <button className="kit-btn xs sec" disabled={busy}
                                  onClick={() => act(() => wh.resolveIssue(it.id, { action: 'relabeled' }), 'label ok')}>Label ok</button>
                          <button className="kit-btn xs sec" disabled={busy}
                                  onClick={() => act(() => wh.resolveIssue(it.id, { action: 'discarded' }), 'descartada')}>Descartar</button>
                        </span>
                      )}</td>
                    </tr>
                  ))}
                  {d && !((d.issues || []).length) && <tr><td colSpan={7} style={{ color: 'var(--ink-faint)' }}>Nenhuma garrafa separada.</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'pend' && (
            <div className="kit-card pad">
              <div className="kit-mlabel" style={{ marginBottom: 8 }}>Pendências deste produto</div>
              <table className="kit-table">
                <thead><tr><th>Quem</th><th>Tipo</th><th className="num">Qtd</th><th>Motivo</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {((d && d.requests) || []).map((r) => (
                    <tr key={r.id}>
                      <td>{r.proposed_by || '—'}</td>
                      <td><span className="kit-chip neutral">{r.kind}</span></td>
                      <td className="num">{fmt(r.qty)}</td>
                      <td style={{ color: 'var(--ink-dim)' }}>{r.reason || '—'}</td>
                      <td><span className={'kit-chip ' + (r.status === 'pending' ? 'warn' : r.status === 'approved' ? 'ok' : 'neutral')}>{r.status}</span></td>
                      <td>{writable && r.status === 'pending' && (
                        <span style={{ display: 'flex', gap: 5 }}>
                          <button className="kit-btn xs" disabled={busy} onClick={() => act(() => wh.approveRequest(r.id), 'aprovado')}>Aprovar</button>
                          <button className="kit-btn xs sec" disabled={busy} onClick={() => act(() => wh.rejectRequest(r.id), 'recusado')}>Recusar</button>
                        </span>
                      )}</td>
                    </tr>
                  ))}
                  {d && !((d.requests || []).length) && <tr><td colSpan={6} style={{ color: 'var(--ink-faint)' }}>Nenhuma pendência.</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'familia' && (
            <div className="kit-card pad">
              <div className="kit-mlabel" style={{ marginBottom: 6 }}>SKU base (a garrafa física)</div>
              <div style={{ marginBottom: 14 }}>
                {d && d.family && d.family.base
                  ? <><span className="kit-chip solid">{d.family.base.sku}</span> <span className="kit-chip neutral" style={{ marginLeft: 6 }}>{d.family.base.channel}</span></>
                  : <span className="kit-chip warn">sem SKU base</span>}
              </div>
              <div className="kit-mlabel" style={{ marginBottom: 8 }}>Membros da família</div>
              <table className="kit-table">
                <thead><tr><th>SKU</th><th>Canal</th><th className="num">×Unid.</th><th>Tipo Veeqo</th><th className="num">Veeqo disp.</th><th className="num">Packs derivados</th><th /></tr></thead>
                <tbody>
                  {((d && d.family && d.family.members) || []).map((m) => (
                    <tr key={m.id}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{m.sku}</td>
                      <td><span className="kit-chip neutral">{m.channel}</span></td>
                      <td className="num">{m.units_per_pack}</td>
                      <td>{m.veeqo_type ? <span className={'kit-chip ' + (m.veeqo_type === 'kit' ? 'info' : 'neutral')}>{m.veeqo_type}</span> : <span className="kit-chip warn">?</span>}</td>
                      <td className="num">{fmt(m.veeqo_available)}</td>
                      <td className="num">{fmt(m.derived_packs)}</td>
                      <td>{writable && <button className="kit-btn xs sec" disabled={busy}
                        onClick={() => act(() => wh.detachSku(m.id), 'SKU desvinculado')}>Desvincular</button>}</td>
                    </tr>
                  ))}
                  {d && !((d.family && d.family.members || []).length) && <tr><td colSpan={7} style={{ color: 'var(--ink-faint)' }}>Nenhum SKU membro.</td></tr>}
                </tbody>
              </table>

              {writable && (
                <>
                  <div className="kit-mlabel" style={{ margin: '18px 0 8px' }}>Adicionar SKU à família</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <input className="kit-input mono" placeholder="SKU" value={newSku.sku} style={{ width: 150 }}
                           onChange={(e) => setNewSku({ ...newSku, sku: e.target.value })} />
                    <select className="kit-input" value={newSku.channel} onChange={(e) => setNewSku({ ...newSku, channel: e.target.value })}>
                      {['veeqo', 'amazon', 'ebay', 'walmart', 'tiktok'].map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <input className="kit-input mono" type="number" min="1" style={{ width: 80 }} value={newSku.units_per_pack}
                           onChange={(e) => setNewSku({ ...newSku, units_per_pack: Number(e.target.value) })} />
                    <select className="kit-input" value={newSku.role} onChange={(e) => setNewSku({ ...newSku, role: e.target.value })}>
                      <option value="member">membro</option><option value="base">base</option>
                    </select>
                    <button className="kit-btn sm" disabled={busy || !newSku.sku}
                            onClick={() => act(() => wh.attachSku(p.product_id, newSku), 'SKU adicionado')}>Adicionar SKU</button>
                  </div>

                  <div className="kit-mlabel" style={{ margin: '18px 0 8px' }}>Mesclar produto neste</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <select className="kit-input" value={mergeInto} onChange={(e) => { setMergeInto(e.target.value); setMergeStep(0); }} style={{ minWidth: 220 }}>
                      <option value="">escolher produto de origem</option>
                      {(allRows || []).filter((r) => r.product_id !== p.product_id).map((r) => (
                        <option key={r.product_id} value={r.product_id}>{r.nickname || r.name}</option>
                      ))}
                    </select>
                    {mergeStep === 0
                      ? <button className="kit-btn sm sec" disabled={!mergeInto} onClick={() => setMergeStep(1)}>Revisar</button>
                      : <button className="kit-btn sm danger" disabled={busy}
                          onClick={() => act(() => wh.mergeProduct(Number(mergeInto), p.product_id), 'produtos mesclados').then(() => setMergeStep(0))}>
                          Confirmar: mesclar SKUs neste produto
                        </button>}
                  </div>
                  {mergeStep === 1 && (
                    <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ink-dim)' }}>
                      Move os SKUs do produto escolhido pra este. O estoque não é somado nem movido.
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {tab === 'config' && (
            <div className="kit-card pad">
              <div className="kit-mlabel" style={{ marginBottom: 8 }}>Configuração do produto</div>
              <table className="kit-table">
                <tbody>
                  <tr><td>Mínimo por prateleira</td><td className="num">{(p.bins || []).map((b) => b.min_qty).join(' · ') || '—'}</td></tr>
                  <tr><td>Mínimo de unidades (limiar)</td><td className="num">{fmt(p.min_units)}</td></tr>
                  <tr><td>Dias de cobertura</td><td className="num">{p.days_cover == null ? '—' : p.days_cover}</td></tr>
                  <tr><td>Cor da garrafa</td><td>{p.bottle_color || '—'}</td></tr>
                  <tr><td>Veeqo (físico / alocado / disponível)</td>
                      <td className="num">{p.veeqo ? `${fmt(p.veeqo.physical)} / ${fmt(p.veeqo.allocated)} / ${fmt(p.veeqo.available)}` : '—'}</td></tr>
                </tbody>
              </table>
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <a className="kit-btn sm sec" href="#produto-setup">Abrir Product Setup</a>
                <a className="kit-btn sm sec" href="#estoque-geral">Editar Veeqo (página antiga)</a>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

// ═══ menu de ações da linha ═══════════════════════════════════════
function RowMenu({ row, onAction, writable }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return undefined;
    const off = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);
  if (!writable) return null;
  const items = [
    ['entrada', 'Entrada'],
    ...(n(row.unplaced_qty) > 0 ? [['organizar', 'Organizar']] : []),
    ['mover', 'Mover'], ['ajustar', 'Ajustar'], ['separar', 'Separar'],
    ['devolucao', 'Devolução'], ['familia', 'Família/SKUs'], ['veeqo', 'Veeqo'],
  ];
  return (
    <span ref={ref} style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <button className="kit-btn xs sec" data-menu={row.product_id} onClick={() => setOpen((v) => !v)} aria-label="Ações">⋯</button>
      {open && (
        <div className="kit-card" style={{ position: 'absolute', right: 0, top: 30, zIndex: 40, padding: 6, minWidth: 150 }}>
          {items.map(([k, t]) => (
            <button key={k} className="kit-btn xs sec" style={{ width: '100%', justifyContent: 'flex-start', border: 'none', height: 28 }}
                    onClick={() => { setOpen(false); onAction(k, row); }}>{t}</button>
          ))}
        </div>
      )}
    </span>
  );
}

// ═══ página ═══════════════════════════════════════════════════════
export function WarehousePage() {
  const [modal, setModal] = React.useState(null);       // { action, row }
  const [panel, setPanel] = React.useState(null);
  const [attnAll, setAttnAll] = React.useState(false);      // "ver todos" da caixa de atenção
  const [toast, setToast] = React.useState(null);
  const [rowsPatch, setRowsPatch] = React.useState({}); // product_id → Row atualizado
  const [q, setQ] = React.useState('');
  const [status, setStatus] = React.useState('todos');
  const [area, setArea] = React.useState('todas');
  const [onlyPend, setOnlyPend] = React.useState(false);
  const [onlyToday, setOnlyToday] = React.useState(false);

  const writable = canWrite();
  const ack = React.useCallback((m) => { setToast(m); setTimeout(() => setToast(null), 2600); }, []);

  // poll 20s, PAUSADO enquanto um modal está aberto
  const ov = wh.useWarehouse('/overview', [], 20000, !!modal);
  const data = ov.data || {};
  const kpis = data.kpis || {};
  const rawRows = data.products || [];
  const rows = React.useMemo(
    () => rawRows.map((r) => rowsPatch[r.product_id] || r),
    [rawRows, rowsPatch],
  );

  const onRowUpdate = React.useCallback((product) => {
    if (product && product.product_id != null) setRowsPatch((p) => ({ ...p, [product.product_id]: product }));
  }, []);

  // opções dos filtros
  const statuses = React.useMemo(() => {
    const s = new Set();
    rows.forEach((r) => (r.status || []).forEach((x) => s.add(x)));
    return [...s].sort();
  }, [rows]);
  const areas = React.useMemo(() => {
    const s = new Set();
    rows.forEach((r) => {
      (r.bins || []).forEach((b) => b.area && s.add(b.area));
      (r.boxes || []).forEach((b) => b.area && s.add(b.area));
    });
    return [...s].sort();
  }, [rows]);

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = rows.filter((r) => {
      if (needle) {
        const hay = [r.nickname, r.name, r.base_sku, ...(r.skus || []).map((s) => s.sku)].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      if (status !== 'todos' && !(r.status || []).includes(status)) return false;
      if (area !== 'todas') {
        const has = (r.bins || []).some((b) => b.area === area) || (r.boxes || []).some((b) => b.area === area);
        if (!has) return false;
      }
      if (onlyPend && !n(r.pending_out) && !n(r.pending_in)) return false;
      if (onlyToday && !n(r.reserved)) return false;
      return true;
    });
    out = out.slice().sort((a, b) => n(a.available) - n(b.available));
    return out;
  }, [rows, q, status, area, onlyPend, onlyToday]);

  const empty = !ov.loading && rows.length > 0 && rows.every(
    (r) => !(r.bins || []).length && !(r.boxes || []).length && !n(r.total),
  );

  function openAction(action, row) {
    if (action === 'familia') { setPanel(row); return; }
    if (action === 'veeqo') { window.location.hash = '#estoque-geral'; return; }
    setModal({ action, row });
  }

  async function approve(requestId) {
    try { const r = await wh.approveRequest(requestId); ack('aprovado'); if (r && r.data && r.data.product) onRowUpdate(r.data.product); ov.refresh(); }
    catch (e) { ack('erro: ' + e.message); }
  }

  if (!canRead()) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-dim)' }}>
        <h2 className="kit-h2">Sem acesso ao estoque</h2>
        <p className="kit-sub">Essa página precisa da função view_stock. Fale com o Admin.</p>
      </div>
    );
  }

  const KPIS = [
    { k: 'todos',      label: 'Garrafas',            value: kpis.total_bottles },
    { k: 'reservadas', label: 'Reservadas',          value: kpis.reserved },
    { k: 'dispon',     label: 'Disponíveis',         value: kpis.available },
    { k: 'separadas',  label: 'Separadas',           value: kpis.separated },
    { k: 'organizar',  label: 'A organizar',         value: kpis.unplaced,        tone: n(kpis.unplaced) ? 'warn' : '' },
    { k: 'repor',      label: 'Prateleiras p/ repor', value: kpis.bins_to_restock, tone: n(kpis.bins_to_restock) ? 'warn' : '' },
    { k: 'pendente',   label: 'Aprovações',          value: kpis.pending_requests, tone: n(kpis.pending_requests) ? 'warn' : '' },
    { k: 'drift',      label: 'Δ Veeqo',             value: kpis.drift_products,   tone: n(kpis.drift_products) ? 'bad' : '' },
  ];

  return (
    <div className="wh-root" data-page="estoque" style={{ paddingBottom: 60 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <span className="kit-eyebrow">● HEALTHFARE P&amp;P · ESTOQUE</span>
          <h1 className="kit-h1">Estoque do <em>armazém</em></h1>
          <p className="kit-sub">
            Total = prateleira + caixa + a organizar. Reservado vem dos pedidos abertos da Veeqo. Separadas nunca contam.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {writable && (
            <button className="kit-btn primary" data-act="entrada-top"
                    onClick={() => filtered[0] && openAction('entrada', filtered[0])}>Entrada</button>
          )}
          <a className="kit-btn sec" href="#estoque-aprovacoes">Aprovações ({fmt(kpis.pending_requests)})</a>
          <a className="kit-btn sec" href="#estoque-locais">Locais</a>
        </div>
      </div>

      {/* KPIs (clicáveis → filtram) */}
      <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }} data-kpis>
        {KPIS.map((kp) => (
          <button key={kp.k} type="button"
                  className={'kit-kpi-card ' + (status === kp.k ? 'on' : '')}
                  data-kpi={kp.k}
                  onClick={() => {
                    if (kp.k === 'todos') { setStatus('todos'); setOnlyPend(false); return; }
                    if (kp.k === 'pendente') { setOnlyPend(true); setStatus('todos'); return; }
                    if (statuses.includes(kp.k)) setStatus(kp.k); else setStatus('todos');
                  }}>
            <div className="kit-mlabel">{kp.label}</div>
            <div className={'kit-kpi ' + (kp.tone || '')}>{fmt(kp.value)}</div>
          </button>
        ))}
      </div>

      {ov.loading && !ov.data && (
        <div className="kit-card pad" style={{ marginTop: 18, color: 'var(--ink-dim)' }}>Carregando o estoque…</div>
      )}
      {ov.error && (
        <div className="kit-card pad bad" style={{ marginTop: 18 }}>
          Não deu pra carregar o estoque: {ov.error.message}. Tentando de novo em 20s.
        </div>
      )}

      {/* Precisa de atenção hoje: os mais graves primeiro; no dia 1 (tudo zerado) seriam 190+ linhas, então mostra 8 e um botão pra abrir o resto */}
      {(data.attention || []).length > 0 && (
        <div className="kit-card pad" style={{ marginTop: 16 }} data-attention>
          <div className="kit-mlabel" style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>Precisa de atenção hoje</span>
            <span className="kit-chip neutral">{(data.attention || []).length}</span>
            {(data.attention || []).length > ATTN_LIMIT && (
              <button className="kit-btn xs sec" style={{ marginLeft: 'auto' }} onClick={() => setAttnAll((v) => !v)}>
                {attnAll ? 'mostrar menos' : 'ver todos (' + (data.attention || []).length + ')'}
              </button>
            )}
          </div>
          {(attnAll ? (data.attention || []) : (data.attention || []).slice(0, ATTN_LIMIT)).map((a, i) => {
            const row = rows.find((r) => r.product_id === a.product_id);
            return (
              <div key={i} className="kit-dotted-row">
                <span className={'kit-chip ' + (ATTENTION_TONE[a.kind] || 'neutral')}>{ATTENTION_LABEL[a.kind] || a.kind}</span>
                <b style={{ fontSize: 13.5 }}>{a.product}</b>
                <span style={{ flex: 1, color: 'var(--ink-dim)', fontSize: 12.5 }}>{a.text}</span>
                {a.action && a.action.type === 'aprovar' && writable && (
                  <button className="kit-btn xs" onClick={() => approve(a.action.request_id)}>Aprovar</button>
                )}
                {a.action && a.action.type === 'repor' && writable && row && (
                  <button className="kit-btn xs sec" onClick={() => openAction('mover', row)}>Repor</button>
                )}
                {a.action && a.action.type === 'organizar' && writable && row && (
                  <button className="kit-btn xs sec" onClick={() => openAction('organizar', row)}>Organizar</button>
                )}
                {a.action && a.action.type === 'entrada' && writable && row && (
                  <button className="kit-btn xs sec" onClick={() => openAction('entrada', row)}>Entrada</button>
                )}
                {a.action && a.action.type === 'ver' && row && (
                  <button className="kit-btn xs sec" onClick={() => setPanel(row)}>Ver</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* estado vazio do dia 1 */}
      {empty && (
        <div className="kit-card pad" style={{ marginTop: 16 }} data-empty>
          <div className="kit-h2">Nenhuma prateleira ou caixa cadastrada ainda</div>
          <p className="kit-sub" style={{ marginTop: 6 }}>
            Nenhuma prateleira ou caixa cadastrada ainda. Cadastre em Locais e faça a primeira Entrada.
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <a className="kit-btn primary" href="#estoque-locais">Cadastrar locais</a>
            {writable && <button className="kit-btn sec" onClick={() => rows[0] && openAction('entrada', rows[0])}>Fazer a primeira Entrada</button>}
          </div>
        </div>
      )}

      {/* toolbar */}
      <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="kit-input" style={{ minWidth: 240, flex: '0 1 300px' }} value={q}
               placeholder="Buscar produto, nickname ou SKU" onChange={(e) => setQ(e.target.value)} />
        <select className="kit-input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="todos">Status: todos</option>
          {statuses.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </select>
        <select className="kit-input" value={area} onChange={(e) => setArea(e.target.value)}>
          <option value="todas">Área: todas</option>
          {areas.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink-dim)' }}>
          <input type="checkbox" checked={onlyPend} onChange={(e) => setOnlyPend(e.target.checked)} /> só com pendências
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink-dim)' }}>
          <input type="checkbox" checked={onlyToday} onChange={(e) => setOnlyToday(e.target.checked)} /> só com pedido hoje
        </label>
        <span style={{ flex: 1 }} />
        <span className="kit-mlabel">ordenado por disponível ↑ · {filtered.length} produtos</span>
      </div>

      {/* tabela */}
      <div className="kit-card" style={{ marginTop: 12, padding: '8px 12px 4px', overflowX: 'auto' }}>
        <table className="kit-table" data-table="produtos">
          <thead>
            <tr>
              <th>Produto</th>
              <th className="num">Total</th>
              <th className="num">Pratel.</th>
              <th className="num">Caixa</th>
              <th className="num">A org.</th>
              <th className="num">Reserv.</th>
              <th className="num">Pend.</th>
              <th className="num">Dispon.</th>
              <th className="num">Separ.</th>
              <th className="num sep">Veeqo</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const pend = n(r.pending_in) - n(r.pending_out);
              return (
                <tr key={r.product_id} className="clickable" data-row={r.product_id}
                    onClick={() => setPanel(r)}>
                  <td style={{ minWidth: 280 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'var(--font-display)', fontSize: 16, color: 'var(--primary-deep)' }}>
                        {r.nickname || r.name}
                      </span>
                      <span style={{ color: 'var(--ink-faint)', fontSize: 12 }}>{r.name}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 5, marginTop: 4, flexWrap: 'wrap' }}>
                      {(r.skus || []).map((s) => (
                        <span key={s.id || s.sku} className={'kit-chip ' + (s.role === 'base' ? 'solid' : 'neutral')}
                              title={s.channel}>
                          {s.sku}{s.role === 'member' && s.units_per_pack > 1 ? ' ×' + s.units_per_pack : ''}
                          {s.veeqo_type === 'kit' ? ' kit' : ''}
                        </span>
                      ))}
                      {locChips(r).map((c) => (
                        <span key={c.k} className="kit-chip neutral" style={{ fontFamily: 'var(--font-mono)' }}>{c.t}</span>
                      ))}
                      {!locChips(r).length && <span className="kit-chip warn">sem local</span>}
                    </div>
                  </td>
                  <td className="num"><b>{fmt(r.total)}</b></td>
                  <td className="num">{fmt(r.shelf_qty)}</td>
                  <td className="num">{fmt(r.box_qty)}</td>
                  <td className="num" style={n(r.unplaced_qty) ? { color: 'var(--warn-deep)', fontWeight: 600 } : undefined}>{fmt(r.unplaced_qty)}</td>
                  <td className="num">{fmt(r.reserved)}</td>
                  <td className="num" style={pend ? { color: pend < 0 ? 'var(--bad-deep)' : 'var(--ok-deep)', fontWeight: 600 } : undefined}>
                    {pend ? (pend > 0 ? '+' + pend : String(pend)) : '0'}
                  </td>
                  <td className="num" style={n(r.available) < 0 ? { color: 'var(--bad-deep)', fontWeight: 700 } : undefined}>{fmt(r.available)}</td>
                  <td className="num">{fmt(r.separated)}</td>
                  <td className="num sep">
                    {r.veeqo ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                        {fmt(r.veeqo.physical)}
                        {r.veeqo_match === 'ok' && <span className="kit-chip ok">✓</span>}
                        {r.veeqo_match === 'drift' && (
                          <span className="kit-chip bad">Δ {n(r.veeqo.physical) - n(r.total) > 0 ? '+' : ''}{n(r.veeqo.physical) - n(r.total)}</span>
                        )}
                        {r.veeqo_match === 'unknown' && <span className="kit-chip neutral">?</span>}
                      </span>
                    ) : <span className="kit-chip neutral">?</span>}
                  </td>
                  <td>
                    <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {(r.status || []).map((s) => <span key={s} className={'kit-chip ' + statusTone(s)}>{statusLabel(s)}</span>)}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <RowMenu row={r} writable={writable} onAction={openAction} />
                  </td>
                </tr>
              );
            })}
            {!filtered.length && !ov.loading && (
              <tr><td colSpan={12} style={{ color: 'var(--ink-faint)', padding: 20 }}>Nenhum produto com esses filtros.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {data.veeqo_checked_at && (
        <div className="kit-mlabel" style={{ marginTop: 10 }}>
          Veeqo conferida em {String(data.veeqo_checked_at).slice(0, 16).replace('T', ' ')} · a coluna Veeqo é comparação, nunca entra na soma
        </div>
      )}

      {modal && (
        <ActionModal
          action={modal.action} row={modal.row}
          onClose={() => setModal(null)}
          onError={(m) => ack('erro: ' + m)}
          onDone={(product, msg) => { setModal(null); if (product) onRowUpdate(product); ack(msg); ov.refresh(); }}
        />
      )}

      {panel && (
        <ProductPanel
          row={rowsPatch[panel.product_id] || panel}
          allRows={rows}
          writable={writable}
          ack={ack}
          onRowUpdate={onRowUpdate}
          onAction={(a, p) => openAction(a, rowsPatch[p.product_id] || p)}
          onClose={() => setPanel(null)}
        />
      )}

      {toast && <div className={'kit-toast ' + (String(toast).startsWith('erro') ? 'bad' : '')}>{toast}</div>}
    </div>
  );
}
