/* Página "Estoque" (Centro de Estoque — Bruno 08-01).
   Antes: só mapeamento produto↔SKU Veeqo. Agora, abas:
     (1) Estoque   — armazém por produto (bins + caixas) — v3.stock_*
     (2) Bins      — cada bin/prateleira com qty + restock
     (3) Caixas    — caixas numeradas nos paletes
     (4) Planner   — dias de estoque + lead time da fórmula + zona + batch EMS
     (5) Separadas — garrafas com problema (label/lacre) até resolver
     (6+) SKUs     — o mapeamento antigo (agora com botão CONFIRMAR → v3.product_skus)
   Fontes: /api/v3/data/stock/* + /api/v3/data/inventory (matcher legado).
   Admin-only (dashboard); operadores não veem nada disso (zero-disrupção). */
import React from 'react';
import { Icon, Leaf } from '../components/Icons.jsx';
import { usePoll, apiPost } from '../adapters/from-api.js';
import { V4_ALLOW_WRITES } from '../flags.js';

const MATCH_LABEL = { exato: 'SKU exato', base: 'SKU base', nome: 'só por nome' };
const MATCH_COLOR = { exato: 'var(--hf-leaf-600)', base: 'var(--hf-navy-500)', nome: 'var(--warn, #d97706)' };
const ZONE = {
  out: { label: 'ZERADO', color: 'var(--bad)' },
  low: { label: 'BAIXO', color: 'var(--warn, #d97706)' },
  plan: { label: 'PLANEJAR', color: 'var(--hf-navy-500)' },
  ok: { label: 'ok', color: 'var(--hf-leaf-600)' },
};

function Tab({ id, active, onClick, children, count, tone }) {
  const on = active === id;
  return (
    <button onClick={() => onClick(id)} style={{
      padding: '8px 14px', borderRadius: 10, border: '1px solid var(--border)', cursor: 'pointer',
      background: on ? 'var(--hf-navy-700)' : 'var(--surface-2)', color: on ? '#fff' : 'var(--text-2)',
      fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 7,
    }}>
      {children}
      {count != null && (
        <span style={{ fontSize: 11, fontWeight: 800, padding: '1px 7px', borderRadius: 999,
          background: on ? 'rgba(255,255,255,0.22)' : (tone === 'bad' ? 'color-mix(in srgb, var(--bad) 16%, transparent)' : 'var(--surface)'),
          color: on ? '#fff' : (tone === 'bad' ? 'var(--bad)' : 'var(--text-3)') }}>{count}</span>
      )}
    </button>
  );
}

function StatChip({ label, value, tone }) {
  return (
    <div className="card" style={{ padding: '10px 14px', minWidth: 120 }}>
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.05, fontWeight: 700 }}>{label}</div>
      <div className="mono" style={{ fontSize: 20, fontWeight: 800, color: tone === 'bad' ? 'var(--bad)' : tone === 'good' ? 'var(--hf-leaf-700)' : 'var(--hf-navy-700)' }}>{value}</div>
    </div>
  );
}

function Th({ children, right }) {
  return <th style={{ padding: '9px 12px', textAlign: right ? 'right' : 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.04, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{children}</th>;
}
function Td({ children, right, mono, bold, color }) {
  return <td style={{ padding: '8px 12px', textAlign: right ? 'right' : 'left', fontFamily: mono ? 'var(--mono, monospace)' : 'inherit', fontWeight: bold ? 700 : 400, color: color || 'inherit', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{children}</td>;
}

function Table({ children }) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>{children}</table>
      </div>
    </div>
  );
}

function ZonePill({ zone }) {
  const z = ZONE[zone] || ZONE.ok;
  return <span className="pill" style={{ fontSize: 10.5, fontWeight: 800, color: z.color, background: `color-mix(in srgb, ${z.color} 12%, transparent)` }}><span className="dot" style={{ background: z.color }}/>{z.label}</span>;
}

/** Infere casepack do sufixo do SKU (-C2/-C3/…): garrafas por unidade vendida. */
function inferPack(sku) {
  const m = /-C(\d)\b/.exec(String(sku || ''));
  return m ? Number(m[1]) : 1;
}

function InventoryPage() {
  const [tab, setTab] = React.useState('stock');
  // PERF (Bruno 08-03): a página abre na aba "Estoque" e NÃO trava mais.
  //  • `/inventory` agora é stale-while-revalidate no backend (responde na hora,
  //    refaz o matcher Veeqo em background) → carrega eager mas nunca bloqueia; o
  //    poll de 20s pega o resultado quando o refresh em background termina.
  //  • `/stock/planner` (lead-time EMS por produto, pesado) só carrega quando a
  //    aba Planner está aberta (path=null → usePoll não busca).
  // Antes: 8 chamadas no mount e o timeout de ~20s do Veeqo travava a percepção.
  const inv = usePoll('/inventory', [], 20000);        // matcher legado (backend SWR)
  const summary = usePoll('/stock/summary', [], 60000);
  const overview = usePoll('/stock-overview', [], 60000);  // Veeqo + armazém por produto (Bruno 08-04)
  const bins = usePoll('/stock/bins', [], 30000);
  const boxes = usePoll('/stock/boxes', [], 60000);
  const planner = usePoll(tab === 'planner' ? '/stock/planner' : null, [tab === 'planner'], 120000);
  const issues = usePoll('/stock/issues', [], 60000);
  const skus = usePoll('/stock/skus', [], 0);
  const supplies = usePoll('/supplies', [], 30000);   // envelopes/caixas (Bruno 08-03)
  const [q, setQ] = React.useState('');
  const [ackMsg, setAck] = React.useState(null);
  const [confirmedLocal, setConfirmedLocal] = React.useState({}); // sku -> true (pós-clique)

  const filt = (arr, keys) => {
    const t = q.trim().toLowerCase();
    if (!t) return arr || [];
    return (arr || []).filter((r) => keys.some((k) => String(r[k] || '').toLowerCase().includes(t)));
  };

  const ack = (m) => { setAck(m); setTimeout(() => setAck(null), 3500); };

  const confirmedSkus = React.useMemo(() => {
    const s = new Set(Object.keys(confirmedLocal));
    // só confirmado de verdade conta — import do Veeqo entra UNCONFIRMED
    // (confirmed_at NULL) e continua mostrando o botão "confirmar"
    for (const row of (skus.data || [])) if (row.confirmed_at) s.add(row.sku);
    return s;
  }, [skus.data, confirmedLocal]);

  async function confirmSku(m) {
    if (!V4_ALLOW_WRITES) { ack('preview · confirmar ' + m.veeqo_sku); return; }
    const pack = inferPack(m.veeqo_sku);
    const r = await apiPost('/stock/skus/confirm', {
      product_id: m.product_id, sku: m.veeqo_sku, channel: 'veeqo', units_per_pack: pack,
    }).catch((e) => ({ error: e.message }));
    if (r && !r.error) { setConfirmedLocal((c) => ({ ...c, [m.veeqo_sku]: true })); ack('✓ ' + m.veeqo_sku + ' confirmado' + (pack > 1 ? ' (' + pack + ' garrafas/un)' : '')); }
    else ack('erro: ' + (r && r.error));
  }

  async function resolveIssue(i, status) {
    if (!V4_ALLOW_WRITES) { ack('preview · ' + status + ' #' + i.id); return; }
    const r = await apiPost('/stock/issues/' + i.id + '/resolve', { status }).catch((e) => ({ error: e.message }));
    if (r && !r.error) ack('✓ issue #' + i.id + ' → ' + status);
    else ack('erro: ' + (r && r.error));
  }

  // Supplies (envelopes/caixas) — Bruno 08-03
  const supplyItems = (supplies.data && supplies.data.items) || [];
  const supplyMap = (supplies.data && supplies.data.mapping) || [];
  const lowSupplies = supplyItems.filter((s) => s.low);
  async function changeSupply(item, kind, promptLabel) {
    if (!V4_ALLOW_WRITES) { ack('preview · ' + kind + ' ' + item.name); return; }
    const raw = window.prompt(promptLabel + ' — ' + item.name + ' (atual: ' + item.qty + ')', '');
    if (raw == null || raw.trim() === '') return;
    const qty = Number(raw);
    if (!Number.isFinite(qty)) { ack('valor inválido'); return; }
    const r = await apiPost('/supplies/' + item.id + '/change', { kind, qty }).catch((e) => ({ error: e.message }));
    if (r && !r.error) ack('✓ ' + item.name + ' → ' + (r.data ? r.data.after : '?')); else ack('erro: ' + (r && r.error));
  }
  async function setSupplyMin(item) {
    if (!V4_ALLOW_WRITES) { ack('preview · min ' + item.name); return; }
    const raw = window.prompt('Nível mínimo p/ alerta — ' + item.name + ' (atual: ' + item.min_qty + ')', String(item.min_qty || ''));
    if (raw == null) return;
    const min_qty = Number(raw);
    if (!Number.isFinite(min_qty)) { ack('valor inválido'); return; }
    const r = await apiPost('/supplies/item', { id: item.id, min_qty }).catch((e) => ({ error: e.message }));
    if (r && !r.error) ack('✓ mín ' + item.name + ' = ' + min_qty); else ack('erro: ' + (r && r.error));
  }
  // adicionar um supply REAL (nome + tipo do Bruno) — um a um
  const [newSupply, setNewSupply] = React.useState({ name: '', kind: 'envelope' });
  async function addSupply() {
    const name = newSupply.name.trim();
    if (!name) { ack('digite o nome do suprimento'); return; }
    if (!V4_ALLOW_WRITES) { ack('preview · adicionar ' + name); return; }
    const r = await apiPost('/supplies/item', { name, kind: newSupply.kind }).catch((e) => ({ error: e.message }));
    if (r && !r.error) { ack('✓ suprimento "' + name + '" adicionado'); setNewSupply({ name: '', kind: newSupply.kind }); }
    else ack('erro: ' + (r && r.error));
  }
  // definir qual supply cada TAMANHO de pacote usa (A/Y/B/BX → supply do Bruno)
  async function mapSize(package_size, supply_item_id) {
    if (!V4_ALLOW_WRITES) { ack('preview · ' + package_size + '→' + supply_item_id); return; }
    if (!supply_item_id) return;
    const r = await apiPost('/supplies/mapping', { package_size, supply_item_id: Number(supply_item_id) }).catch((e) => ({ error: e.message }));
    if (r && !r.error) ack('✓ tamanho ' + package_size + ' mapeado'); else ack('erro: ' + (r && r.error));
  }
  const tiers = (supplies.data && supplies.data.tiers) || [];   // tamanhos possíveis

  const st = (inv.data && inv.data.stats) || {};
  const matched = (inv.data && inv.data.matched) || [];
  const oursUn = (inv.data && inv.data.ours_unmatched) || [];
  const veeqoUn = (inv.data && inv.data.veeqo_unmatched) || [];
  const plans = (inv.data && inv.data.veeqo_plans) || [];
  // backend SWR devolve {loading:true} enquanto o matcher Veeqo roda em background
  const invLoading = inv.loading || (inv.data && inv.data.loading);
  const sumRows = summary.data || [];
  const ovRows = overview.data || [];   // Veeqo + armazém por produto (Bruno 08-04)
  const binRows = bins.data || [];
  const boxRows = boxes.data || [];
  const planRows = planner.data || [];
  const issueRows = issues.data || [];
  const openIssues = issueRows.filter((i) => i.status === 'separated');
  const needRestock = binRows.filter((b) => b.needs_restock);
  const urgent = planRows.filter((p) => p.zone === 'out' || p.zone === 'low');

  const totalWh = sumRows.reduce((n, r) => n + Number(r.total_qty || 0), 0);

  return (
    <div>
      <div className="section-title">
        <Leaf size={14} color="var(--hf-leaf-500)"/>
        <h2>Estoque · armazém</h2><span className="en">· bins, caixas, planner, SKUs</span>
        <div className="rule"/>
      </div>

      {/* stats */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <StatChip label="Garrafas no armazém" value={totalWh || '—'} tone="good"/>
        <StatChip label="Bins p/ restock" value={needRestock.length} tone={needRestock.length ? 'bad' : undefined}/>
        <StatChip label="Separadas (abertas)" value={openIssues.length} tone={openIssues.length ? 'bad' : undefined}/>
        <StatChip label="Urgentes (planner)" value={urgent.length} tone={urgent.length ? 'bad' : undefined}/>
        <StatChip label="SKUs confirmados" value={(skus.data || []).filter((r) => r.confirmed_at).length + '/' + (skus.data || []).length} tone="good"/>
        <StatChip label="Suprimentos baixos" value={lowSupplies.length} tone={lowSupplies.length ? 'bad' : undefined}/>
      </div>

      {/* abas + busca */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <Tab id="stock" active={tab} onClick={setTab} count={ovRows.length}><Icon name="product" size={14}/> Estoque</Tab>
        <Tab id="bins" active={tab} onClick={setTab} count={binRows.length} tone={needRestock.length ? 'bad' : undefined}>Bins</Tab>
        <Tab id="boxes" active={tab} onClick={setTab} count={boxRows.filter((b) => b.status === 'in_storage').length}>Caixas</Tab>
        <Tab id="planner" active={tab} onClick={setTab} count={urgent.length} tone={urgent.length ? 'bad' : undefined}>Planner</Tab>
        <Tab id="issues" active={tab} onClick={setTab} count={openIssues.length} tone={openIssues.length ? 'bad' : undefined}>Separadas</Tab>
        <Tab id="supplies" active={tab} onClick={setTab} count={supplyItems.length} tone={lowSupplies.length ? 'bad' : undefined}><Icon name="product" size={14}/> Suprimentos</Tab>
        <Tab id="matched" active={tab} onClick={setTab} count={matched.length}><Icon name="link" size={14}/> SKUs</Tab>
        <Tab id="ours" active={tab} onClick={setTab} count={oursUn.length} tone="bad">Nossos s/ Veeqo</Tab>
        <Tab id="veeqo" active={tab} onClick={setTab} count={veeqoUn.length} tone="bad">Veeqo s/ nosso</Tab>
        <Tab id="plans" active={tab} onClick={setTab} count={plans.length}>Planos</Tab>
        <span style={{ flex: 1 }}/>
        {/* TikTok interim (Bruno 08-04): sem API por ora → export do Seller
            Center entra aqui. Encapsulado: quando a API chegar (TIKTOK_SOURCE
            =api), o backend recusa o upload e este botão avisa — nada mais muda. */}
        <label title="Seller Center → Orders → Export → sobe o arquivo aqui"
          style={{ fontSize: 12, fontWeight: 600, padding: '7px 12px', borderRadius: 9, cursor: 'pointer',
            border: '1px dashed var(--border)', color: 'var(--text-2)', background: 'var(--surface-2)' }}>
          ⬆ TikTok CSV
          <input type="file" accept=".csv,.txt,.tsv" style={{ display: 'none' }}
            onChange={async (e) => {
              const f = e.target.files && e.target.files[0];
              e.target.value = '';
              if (!f) return;
              if (!V4_ALLOW_WRITES) { ack('preview · import ' + f.name); return; }
              const csv = await f.text();
              ack('importando ' + f.name + '…');
              const r = await apiPost('/stock/tiktok-orders-csv', { csv }).catch((err) => ({ error: err.message }));
              if (r && !r.error) {
                const d = r.data || r;
                ack('✓ TikTok: ' + d.imported + ' linhas (' + (d.unmapped || 0) + ' sem SKU mapeado — mapear em Product Setup, canal tiktok)');
              } else ack('erro: ' + (r && r.error));
            }}/>
        </label>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filtrar…"
               style={{ padding: '7px 12px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 13, minWidth: 160 }}/>
      </div>

      {ackMsg && <div className="card" style={{ padding: '8px 14px', marginBottom: 10, fontSize: 12.5, color: 'var(--hf-navy-700)', fontWeight: 600 }}>{ackMsg}</div>}

      {/* ESTOQUE por produto — agora com estoque VEEQO ao lado do armazém (Bruno 08-04) */}
      {tab === 'stock' && (
        <>
          {(overview.loading || (overview.meta && overview.meta.stock_loading)) && (
            <div className="card" style={{ padding: 10, color: 'var(--text-3)', marginBottom: 10, fontSize: 12.5 }}>
              Carregando estoque do Veeqo em segundo plano — aparece em alguns segundos.
            </div>
          )}
          {ovRows.length === 0
            ? <div className="card" style={{ padding: 24, color: 'var(--text-3)' }}>Sem produtos.</div>
            : <Table>
                {/* Bins+Caixas SOMAM no Armazém(=Total). Veeqo é SEPARADO, DEPOIS. */}
                <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <Th>Produto</Th><Th right>Bins</Th><Th right>Caixas</Th><Th right>Armazém (total)</Th><Th right>Veeqo</Th>
                </tr></thead>
                <tbody>
                  {filt(ovRows, ['product', 'nickname']).map((r) => {
                    const low = r.has_veeqo_sku && r.veeqo_stock != null && r.veeqo_stock <= 10;
                    return (
                      <tr key={r.id} style={{ borderTop: '1px solid var(--border)', opacity: r.active ? 1 : 0.5 }}>
                        <Td bold>{r.product}{low && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--bad)', fontWeight: 700 }}>BAIXO</span>}</Td>
                        <Td right mono>{r.bin_qty}</Td>
                        <Td right mono>{r.box_qty}</Td>
                        <Td right mono bold>{r.warehouse_stock}</Td>
                        <Td right mono bold color={low ? 'var(--bad)' : undefined}>{r.veeqo_stock == null ? (r.has_veeqo_sku ? '…' : '—') : r.veeqo_stock}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>}
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>
            Para editar o estoque do Veeqo, use a página <b>Ver estoque</b> (com confirmação à prova de erro).
          </div>
        </>
      )}

      {/* BINS */}
      {tab === 'bins' && (
        binRows.length === 0
          ? <div className="card" style={{ padding: 24, color: 'var(--text-3)' }}>Nenhum bin cadastrado. Cadastre via POST /stock/bins (ou a tela de admin que vem na Fase B).</div>
          : <Table>
              <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
                <Th>Bin</Th><Th>Prateleira</Th><Th>Área</Th><Th>Produto</Th><Th right>Qty</Th><Th right>Mín</Th><Th>Status</Th>
              </tr></thead>
              <tbody>
                {filt(binRows, ['bin_code', 'shelf_code', 'product', 'area']).map((b) => (
                  <tr key={b.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <Td mono bold>{b.bin_code}</Td>
                    <Td mono>{b.shelf_code || '—'}</Td>
                    <Td>{b.area || '—'}</Td>
                    <Td>{b.product || <span style={{ color: 'var(--text-3)' }}>vazio</span>}</Td>
                    <Td right mono bold>{b.qty}</Td>
                    <Td right mono color="var(--text-3)">{b.min_qty || '—'}</Td>
                    <Td>{b.needs_restock
                      ? <span className="pill" style={{ fontSize: 10.5, color: 'var(--bad)', background: 'color-mix(in srgb, var(--bad) 12%, transparent)' }}><span className="dot" style={{ background: 'var(--bad)' }}/>RESTOCK</span>
                      : <span style={{ color: 'var(--text-3)', fontSize: 11 }}>ok</span>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
      )}

      {/* CAIXAS */}
      {tab === 'boxes' && (
        boxRows.length === 0
          ? <div className="card" style={{ padding: 24, color: 'var(--text-3)' }}>Nenhuma caixa registrada.</div>
          : <Table>
              <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
                <Th>Caixa</Th><Th>Área / palete</Th><Th>Produto</Th><Th right>Qty</Th><Th>Status</Th>
              </tr></thead>
              <tbody>
                {filt(boxRows, ['box_number', 'product', 'area']).map((x) => (
                  <tr key={x.id} style={{ borderTop: '1px solid var(--border)', opacity: x.status === 'empty' ? 0.5 : 1 }}>
                    <Td mono bold>{x.box_number}</Td>
                    <Td>{x.area || '—'}</Td>
                    <Td>{x.product || '—'}</Td>
                    <Td right mono bold>{x.qty}</Td>
                    <Td>{x.status === 'empty' ? 'vazia' : 'em estoque'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
      )}

      {/* PLANNER */}
      {tab === 'planner' && (
        planRows.length === 0
          ? <div className="card" style={{ padding: 24, color: 'var(--text-3)' }}>Planner sem dados ainda — precisa de estoque registrado + histórico de vendas (o sync coleta ~2 semanas de linhas shipped antes da velocidade ficar confiável).</div>
          : <>
              <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 8 }}>
                Dias de estoque = (armazém + marketplace) ÷ velocidade 14d. Lead = tempo medido da fórmula no EMS. Zona PLANEJAR = começar a planejar produção AGORA.
              </div>
              <Table>
                <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <Th>Zona</Th><Th>Produto</Th><Th right>Armazém</Th><Th right>Marketplace</Th><Th right>Vende/dia</Th><Th right>Dias</Th><Th right>Lead (d)</Th><Th>Batch EMS</Th>
                </tr></thead>
                <tbody>
                  {filt(planRows, ['name']).map((p) => (
                    <tr key={p.product_id} style={{ borderTop: '1px solid var(--border)' }}>
                      <Td><ZonePill zone={p.zone}/></Td>
                      <Td bold>{p.name}{!p.velocity_reliable && <span title="pouco histórico de venda ainda" style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-3)' }}>~</span>}</Td>
                      <Td right mono>{p.warehouse_qty}</Td>
                      <Td right mono>{p.marketplace_qty != null ? p.marketplace_qty : '—'}</Td>
                      <Td right mono>{p.per_day || '—'}</Td>
                      <Td right mono bold color={p.zone === 'out' || p.zone === 'low' ? 'var(--bad)' : undefined}>{p.days_of_stock != null ? p.days_of_stock : '∞'}</Td>
                      <Td right mono color="var(--text-3)">{p.lead_days}</Td>
                      <Td color="var(--text-2)">{p.ems_batch ? (p.ems_batch.batch + ' · ' + p.ems_batch.stage) : <span style={{ color: 'var(--bad)', fontWeight: 600 }}>sem batch</span>}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
      )}

      {/* SEPARADAS */}
      {tab === 'issues' && (
        issueRows.length === 0
          ? <div className="card" style={{ padding: 24, color: 'var(--text-3)' }}>Nenhuma garrafa separada. (Quando o kiosk lançar, "garrafa com problema" cai aqui até resolver.)</div>
          : <Table>
              <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
                <Th>Produto</Th><Th right>Qty</Th><Th>Motivo</Th><Th>Bin</Th><Th>Quem</Th><Th>Quando</Th><Th>Status</Th><Th>Ação</Th>
              </tr></thead>
              <tbody>
                {filt(issueRows, ['product', 'reason']).map((i) => (
                  <tr key={i.id} style={{ borderTop: '1px solid var(--border)', opacity: i.status === 'separated' ? 1 : 0.55 }}>
                    <Td bold>{i.product}</Td>
                    <Td right mono>{i.qty}</Td>
                    <Td>{i.reason === 'label' ? 'label' : i.reason === 'seal' ? 'lacre' : 'outro'}</Td>
                    <Td mono>{i.bin_code || '—'}</Td>
                    <Td>{i.person || '—'}</Td>
                    <Td color="var(--text-3)">{String(i.created_at || '').slice(0, 10)}</Td>
                    <Td>{i.status}</Td>
                    <Td>
                      {i.status === 'separated' && (
                        <span style={{ display: 'inline-flex', gap: 6 }}>
                          <button onClick={() => resolveIssue(i, 'restocked')} title="voltou pro bin" style={{ fontSize: 11, padding: '3px 8px', borderRadius: 7, border: '1px solid var(--border)', cursor: 'pointer', background: 'var(--surface-2)' }}>↩ estoque</button>
                          <button onClick={() => resolveIssue(i, 'relabeled')} title="re-etiquetada" style={{ fontSize: 11, padding: '3px 8px', borderRadius: 7, border: '1px solid var(--border)', cursor: 'pointer', background: 'var(--surface-2)' }}>label ok</button>
                          <button onClick={() => resolveIssue(i, 'discarded')} title="descartada" style={{ fontSize: 11, padding: '3px 8px', borderRadius: 7, border: '1px solid var(--border)', cursor: 'pointer', background: 'var(--surface-2)', color: 'var(--bad)' }}>descarte</button>
                        </span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
      )}

      {/* SUPRIMENTOS (envelopes/caixas) — consumidos a cada label impressa (Bruno 08-03) */}
      {tab === 'supplies' && (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 10 }}>
            Cadastre seus envelopes/caixas REAIS (um a um) e diga qual cada tamanho de pacote usa.
            {' '}Cada shipping label impressa deduz <b>1</b> do suprimento do tamanho. Baixo estoque avisa no admin-orin.
          </div>

          {/* adicionar suprimento real */}
          <div className="card" style={{ padding: '12px 14px', marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <b style={{ fontSize: 13 }}>Adicionar suprimento:</b>
            <input value={newSupply.name} onChange={(e) => setNewSupply((s) => ({ ...s, name: e.target.value }))}
              placeholder="nome real (ex.: Poly Mailer 6x9, Bubble 10x13…)"
              onKeyDown={(e) => { if (e.key === 'Enter') addSupply(); }}
              style={{ flex: '1 1 260px', padding: '7px 11px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }} />
            <select value={newSupply.kind} onChange={(e) => setNewSupply((s) => ({ ...s, kind: e.target.value }))}
              style={{ padding: '7px 10px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }}>
              <option value="envelope">envelope</option>
              <option value="box">caixa</option>
              <option value="other">outro</option>
            </select>
            <button onClick={addSupply} style={{ padding: '7px 14px', borderRadius: 9, border: 'none', background: 'var(--hf-navy-700)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>+ adicionar</button>
          </div>

          {/* mapa tamanho → supply (Bruno escolhe) */}
          {tiers.length > 0 && (
            <div className="card" style={{ padding: '12px 14px', marginBottom: 14 }}>
              <b style={{ fontSize: 13 }}>Qual suprimento cada tamanho de pacote usa</b>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', margin: '3px 0 10px' }}>
                O tamanho vem da cor da garrafa + nº de garrafas (1→A · 2–6→Y · 7–9→B · 10+→BX caixa). Escolha o envelope/caixa de cada um.
              </div>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                {tiers.map((t) => {
                  const cur = supplyMap.find((m) => m.package_size === t.package_size);
                  return (
                    <label key={t.package_size} style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                      <span style={{ fontWeight: 700 }}>{t.package_size}{t.is_box ? ' (caixa)' : ''}</span>
                      <select value={cur ? cur.supply_item_id : ''} onChange={(e) => mapSize(t.package_size, e.target.value)}
                        style={{ padding: '6px 9px', borderRadius: 8, border: '1px solid ' + (cur ? 'var(--border)' : 'var(--warn, #d97706)'), background: 'var(--surface)', color: 'var(--text)', fontSize: 13, minWidth: 150 }}>
                        <option value="">— escolher —</option>
                        {supplyItems.map((si) => <option key={si.id} value={si.id}>{si.name}</option>)}
                      </select>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {supplyItems.length === 0
            ? <div className="card" style={{ padding: 24, color: 'var(--text-3)' }}>Nenhum suprimento cadastrado ainda — adicione o primeiro acima.</div>
            : <Table>
                <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <Th>Suprimento</Th><Th>Tipo</Th><Th>Tamanhos</Th><Th right>Qty</Th><Th right>Mín</Th><Th>Status</Th><Th>Ações</Th>
                </tr></thead>
                <tbody>
                  {filt(supplyItems, ['name', 'kind']).map((s) => (
                    <tr key={s.id} style={{ borderTop: '1px solid var(--border)', opacity: s.active ? 1 : 0.5 }}>
                      <Td bold>{s.name}</Td>
                      <Td color="var(--text-3)">{s.kind === 'box' ? 'caixa' : s.kind === 'envelope' ? 'envelope' : s.kind}</Td>
                      <Td mono>{(s.sizes || []).join(', ') || '—'}</Td>
                      <Td right mono bold color={s.low ? 'var(--bad)' : undefined}>{s.qty}</Td>
                      <Td right mono color="var(--text-3)">{s.min_qty || '—'}</Td>
                      <Td>{s.low
                        ? <span className="pill" style={{ fontSize: 10.5, color: 'var(--bad)', background: 'color-mix(in srgb, var(--bad) 12%, transparent)' }}><span className="dot" style={{ background: 'var(--bad)' }}/>BAIXO</span>
                        : <span style={{ color: 'var(--text-3)', fontSize: 11 }}>ok</span>}</Td>
                      <Td>
                        <span style={{ display: 'inline-flex', gap: 6 }}>
                          <button onClick={() => changeSupply(s, 'restock', 'Reabastecer (+quantos)')} title="somar ao estoque" style={{ fontSize: 11, padding: '3px 8px', borderRadius: 7, border: '1px solid var(--border)', cursor: 'pointer', background: 'var(--surface-2)' }}>+ reabastecer</button>
                          <button onClick={() => changeSupply(s, 'count', 'Contagem (valor exato)')} title="setar contagem exata" style={{ fontSize: 11, padding: '3px 8px', borderRadius: 7, border: '1px solid var(--border)', cursor: 'pointer', background: 'var(--surface-2)' }}>contar</button>
                          <button onClick={() => setSupplyMin(s)} title="nível de alerta" style={{ fontSize: 11, padding: '3px 8px', borderRadius: 7, border: '1px solid var(--border)', cursor: 'pointer', background: 'var(--surface-2)' }}>mín</button>
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>}
        </>
      )}

      {/* SKUs CASADOS (matcher legado + CONFIRMAR → v3.product_skus) */}
      {tab === 'matched' && (
        <>
          {invLoading && matched.length === 0 && (
            <div className="card" style={{ padding: 16, color: 'var(--text-3)', marginBottom: 10 }}>
              Carregando SKUs do Veeqo… (a lista do Veeqo é externa e lenta; roda em segundo plano — aparece em alguns segundos, não trava a página.)
            </div>
          )}
          <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 8 }}>
            Confirmar grava o mapa em v3.product_skus — só SKUs confirmados movem estoque (dedução automática nunca chuta). Sufixo -C2/-C3 vira garrafas/un automaticamente.
          </div>
          <Table>
            <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
              <Th>Nosso produto</Th><Th>SKU Veeqo</Th><Th>Título no Veeqo</Th><Th>Match</Th><Th>Confirmação</Th>
            </tr></thead>
            <tbody>
              {filt(matched, ['product', 'veeqo_sku', 'veeqo_title']).map((m) => {
                const done = confirmedSkus.has(m.veeqo_sku);
                const pack = inferPack(m.veeqo_sku);
                return (
                  <tr key={m.product_id + '|' + m.veeqo_sku} style={{ borderTop: '1px solid var(--border)', opacity: m.active ? 1 : 0.55 }}>
                    <Td bold>{m.product}{!m.active && <span style={{ fontSize: 10, color: 'var(--text-3)', marginLeft: 6 }}>inativo</span>}</Td>
                    <Td mono>{m.veeqo_sku}</Td>
                    <Td color="var(--text-2)">{(m.veeqo_title || '').split('|')[0].trim()}</Td>
                    <Td><span className="pill" style={{ fontSize: 10.5, color: MATCH_COLOR[m.match], background: `color-mix(in srgb, ${MATCH_COLOR[m.match]} 12%, transparent)` }}><span className="dot" style={{ background: MATCH_COLOR[m.match] }}/>{MATCH_LABEL[m.match]}</span></Td>
                    <Td>
                      {done
                        ? <span style={{ color: 'var(--hf-leaf-700)', fontWeight: 700, fontSize: 12 }}>✓ confirmado</span>
                        : <button onClick={() => confirmSku(m)} style={{ fontSize: 11.5, padding: '4px 10px', borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer', background: 'var(--hf-navy-700)', color: '#fff', fontWeight: 700 }}>
                            confirmar{pack > 1 ? ' · ' + pack + ' grf/un' : ''}
                          </button>}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </>
      )}

      {/* NOSSOS SEM VEEQO */}
      {tab === 'ours' && (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 8 }}>Produtos nossos que NÃO achamos no Veeqo (SKU não bate / não existe lá). Confirmar.</div>
          <Table>
            <thead><tr><Th>Nosso produto</Th><Th>Nossos SKUs/códigos</Th><Th>Ativo</Th></tr></thead>
            <tbody>
              {filt(oursUn, ['product']).map((o) => (
                <tr key={o.product_id} style={{ borderTop: '1px solid var(--border)', opacity: o.active ? 1 : 0.55 }}>
                  <Td bold>{o.product}</Td>
                  <Td mono color="var(--text-3)">{(o.our_skus || []).join(', ') || '—'}</Td>
                  <Td>{o.active ? '✅' : '—'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}

      {/* VEEQO SEM NOSSO */}
      {tab === 'veeqo' && (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 8 }}>SKUs de suplemento no Veeqo que NÃO casam com nenhum produto nosso. Buraco a verificar.</div>
          <Table>
            <thead><tr><Th>SKU Veeqo</Th><Th>Título</Th></tr></thead>
            <tbody>
              {filt(veeqoUn, ['sku', 'title']).map((v) => (
                <tr key={v.sku} style={{ borderTop: '1px solid var(--border)' }}>
                  <Td mono bold>{v.sku}</Td>
                  <Td color="var(--text-2)">{(v.title || '').split('|')[0].trim()}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}

      {/* PLANOS / MEDICAÇÃO */}
      {tab === 'plans' && (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 8 }}>Assinaturas, planos e medicação (HF-PLN / HF-MED) + clínica — não são itens físicos da linha de produção.</div>
          <Table>
            <thead><tr><Th>SKU</Th><Th>Título</Th></tr></thead>
            <tbody>
              {filt(plans, ['sku', 'title']).map((v) => (
                <tr key={v.sku} style={{ borderTop: '1px solid var(--border)' }}>
                  <Td mono>{v.sku}</Td>
                  <Td color="var(--text-2)">{(v.title || '').split('|')[0].trim()}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </div>
  );
}

window.InventoryPage = InventoryPage;
export { InventoryPage };
