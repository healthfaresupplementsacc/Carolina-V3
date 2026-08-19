/* Página "Estoque" (Centro de Estoque — Bruno 08-01).
   Antes: só mapeamento produto↔SKU Veeqo. Agora, abas:
     (1) Estoque   — armazém por produto (bins + caixas) — v3.stock_*
     (2) Bins      — cada bin/prateleira com qty + restock
     (3) Caixas    — caixas numeradas nos paletes
     (4) Planner   — dias de estoque + lead time da fórmula + zona + batch EMS
     (5) Separadas — garrafas com problema (label/lacre) até resolver
     (6+) SKUs     — o mapeamento antigo (agora com botão CONFIRMAR → v3.product_skus)
   Fontes: /api/v3/data/stock/* + /api/v3/data/inventory (matcher legado).
   Admin-only (dashboard); operadores não veem nada disso (zero-disrupção).

   Pele: STYLE-KIT 100% (S15 fase 2). Classes .kit-* de kit.css + os
   complementos .pgi-* de pages-inventory.css. Lógica e endpoints iguais. */
import React from 'react';
import { usePoll, apiPost } from '../adapters/from-api.js';
import { V4_ALLOW_WRITES } from '../flags.js';
import { LegacyBanner } from '../components/Primitives.jsx';
import './pages-inventory.css';

const MATCH_LABEL = { exato: 'SKU exato', base: 'SKU base', nome: 'só por nome' };
const MATCH_TONE = { exato: 'ok', base: 'neutral', nome: 'warn' };
const ZONE = {
  out: { label: 'zerado', tone: 'bad' },
  low: { label: 'baixo', tone: 'bad' },
  plan: { label: 'planejar', tone: 'warn' },
  ok: { label: 'ok', tone: 'ok' },
};

/** Aba do segmented control do kit, com contador tonal. */
function Tab({ id, active, onClick, children, count, tone }) {
  const on = active === id;
  return (
    <button className={on ? 'on' : ''} onClick={() => onClick(id)} data-tab={id}>
      {children}
      {count != null && <span className={'n' + (tone === 'bad' ? ' bad' : '')}>{count}</span>}
    </button>
  );
}

function StatChip({ label, value, tone }) {
  return (
    <div className="kit-kpi-card pgi-kpi-card">
      <span className="kit-mlabel pgi-kpi-label">{label}</span>
      <div className={'kit-kpi' + (tone === 'bad' ? ' bad' : tone === 'good' ? ' ok' : '')}>{value}</div>
    </div>
  );
}

function Th({ children, right }) {
  return <th className={right ? 'num' : undefined}>{children}</th>;
}
function Td({ children, right, mono, bold, cls }) {
  const c = [right ? 'num' : 'wrapmax', mono && !right ? 'mono' : '', bold ? 'strong' : '', cls || '']
    .filter(Boolean).join(' ');
  return <td className={c}>{children}</td>;
}

function Table({ children, name }) {
  return (
    <div className="kit-card pgi-tablecard">
      <table className="kit-table" data-table={name}>{children}</table>
    </div>
  );
}

function Empty({ children }) {
  return <div className="kit-card pad" style={{ marginTop: 4 }}><div className="pgi-empty">{children}</div></div>;
}

function ZonePill({ zone }) {
  const z = ZONE[zone] || ZONE.ok;
  return <span className={'kit-chip ' + z.tone}>{z.label}</span>;
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
    <div className="pgi-page" data-page="inv-armazem">
      <LegacyBanner />
      {/* Mesmo aviso da outra tela antiga: aqui um casepack ainda vale como
          produto separado, e é assim que a mesma garrafa acaba contada duas
          vezes. A página está aposentada, então o certo é apontar pro lugar
          onde a garrafa tem uma linha só, não reagrupar coisa que vai sumir. */}
      <div className="pgi-hint" data-casepack-hint>
        Uma linha por listagem: os casepacks (C2, C3, C4) aparecem separados aqui, mesmo sendo a mesma garrafa.
        No <b>hub Estoque</b> cada garrafa tem uma linha só, com os SKUs pendurados nela.
      </div>
      <div className="pgi-head">
        <div className="pgi-head-main">
          <span className="kit-eyebrow">● HEALTHFARE · CENTRO DE ESTOQUE</span>
          <h1 className="kit-h1">Estoque do <em>armazém</em></h1>
          <p className="kit-sub">Bins, caixas, planner de produção, garrafas separadas, suprimentos e o mapa de SKUs por canal.</p>
        </div>
        <div className="pgi-head-actions">
          <a className="kit-btn sm sec" href="#estoque">Abrir o hub novo</a>
        </div>
      </div>

      {/* stats */}
      <div className="pgi-kpis">
        <StatChip label="Garrafas no armazém" value={totalWh || '—'} tone="good"/>
        <StatChip label="Bins p/ repor" value={needRestock.length} tone={needRestock.length ? 'bad' : undefined}/>
        <StatChip label="Separadas (abertas)" value={openIssues.length} tone={openIssues.length ? 'bad' : undefined}/>
        <StatChip label="Urgentes (planner)" value={urgent.length} tone={urgent.length ? 'bad' : undefined}/>
        <StatChip label="SKUs confirmados" value={(skus.data || []).filter((r) => r.confirmed_at).length + '/' + (skus.data || []).length} tone="good"/>
        <StatChip label="Suprimentos baixos" value={lowSupplies.length} tone={lowSupplies.length ? 'bad' : undefined}/>
      </div>

      {/* abas + busca */}
      <div className="pgi-toolbar">
        <div className="kit-seg pgi-seg">
          <Tab id="stock" active={tab} onClick={setTab} count={ovRows.length}>Estoque</Tab>
          <Tab id="bins" active={tab} onClick={setTab} count={binRows.length} tone={needRestock.length ? 'bad' : undefined}>Bins</Tab>
          <Tab id="boxes" active={tab} onClick={setTab} count={boxRows.filter((b) => b.status === 'in_storage').length}>Caixas</Tab>
          <Tab id="planner" active={tab} onClick={setTab} count={urgent.length} tone={urgent.length ? 'bad' : undefined}>Planner</Tab>
          <Tab id="issues" active={tab} onClick={setTab} count={openIssues.length} tone={openIssues.length ? 'bad' : undefined}>Separadas</Tab>
          <Tab id="supplies" active={tab} onClick={setTab} count={supplyItems.length} tone={lowSupplies.length ? 'bad' : undefined}>Suprimentos</Tab>
          <Tab id="matched" active={tab} onClick={setTab} count={matched.length}>SKUs</Tab>
          <Tab id="ours" active={tab} onClick={setTab} count={oursUn.length} tone="bad">Nossos s/ Veeqo</Tab>
          <Tab id="veeqo" active={tab} onClick={setTab} count={veeqoUn.length} tone="bad">Veeqo s/ nosso</Tab>
          <Tab id="plans" active={tab} onClick={setTab} count={plans.length}>Planos</Tab>
        </div>
        <span style={{ flex: 1 }}/>
        {/* TikTok interim (Bruno 08-04): sem API por ora → export do Seller
            Center entra aqui. Encapsulado: quando a API chegar (TIKTOK_SOURCE
            =api), o backend recusa o upload e este botão avisa — nada mais muda. */}
        <label className="pgi-upload" title="Seller Center, Orders, Export, sobe o arquivo aqui">
          Subir CSV do TikTok
          <input type="file" accept=".csv,.txt,.tsv"
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
                ack('✓ TikTok: ' + d.imported + ' linhas (' + (d.unmapped || 0) + ' sem SKU mapeado, mapear em Product Setup, canal tiktok)');
              } else ack('erro: ' + (r && r.error));
            }}/>
        </label>
        <input className="kit-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="filtrar…"
               style={{ minWidth: 170 }}/>
      </div>

      {ackMsg && <div className="kit-card pad pgi-loading" style={{ marginTop: 0, marginBottom: 12, color: 'var(--primary-deep)', fontWeight: 600 }}>{ackMsg}</div>}

      {/* ESTOQUE por produto — agora com estoque VEEQO ao lado do armazém (Bruno 08-04) */}
      {tab === 'stock' && (
        <>
          {(overview.loading || (overview.meta && overview.meta.stock_loading)) && (
            <div className="kit-card pad pgi-loading" style={{ marginTop: 0, marginBottom: 12 }}>
              Carregando estoque do Veeqo em segundo plano, aparece em alguns segundos.
            </div>
          )}
          {ovRows.length === 0
            ? <Empty>Sem produtos.</Empty>
            : <Table name="inv-stock">
                {/* Bins+Caixas SOMAM no Armazém(=Total). Veeqo é SEPARADO, DEPOIS. */}
                <thead><tr>
                  <Th>Produto</Th><Th right>Bins</Th><Th right>Caixas</Th><Th right>Armazém (total)</Th><Th right>Veeqo</Th>
                </tr></thead>
                <tbody>
                  {filt(ovRows, ['product', 'nickname']).map((r) => {
                    const low = r.has_veeqo_sku && r.veeqo_stock != null && r.veeqo_stock <= 10;
                    return (
                      <tr key={r.id} className={r.active === false ? 'off' : undefined}>
                        <Td bold>{r.product}{low && <span className="kit-chip bad" style={{ marginLeft: 8 }}>baixo</span>}</Td>
                        <Td right>{r.bin_qty}</Td>
                        <Td right>{r.box_qty}</Td>
                        <Td right bold>{r.warehouse_stock}</Td>
                        <Td right bold cls={low ? 'badnum' : undefined}>{r.veeqo_stock == null ? (r.has_veeqo_sku ? '…' : '—') : r.veeqo_stock}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>}
          <div className="pgi-note">
            Para editar o estoque do Veeqo, use a página <b>Ver estoque</b> (com confirmação à prova de erro).
          </div>
        </>
      )}

      {/* BINS */}
      {tab === 'bins' && (
        binRows.length === 0
          ? <Empty>Nenhum bin cadastrado. Cadastre na página Locais (Estoque, Locais).</Empty>
          : <Table name="inv-bins">
              <thead><tr>
                <Th>Bin</Th><Th>Prateleira</Th><Th>Área</Th><Th>Produto</Th><Th right>Qtd</Th><Th right>Mín</Th><Th>Status</Th>
              </tr></thead>
              <tbody>
                {filt(binRows, ['bin_code', 'shelf_code', 'product', 'area']).map((b) => (
                  <tr key={b.id}>
                    <Td mono bold>{b.bin_code}</Td>
                    <Td mono>{b.shelf_code || '—'}</Td>
                    <Td cls="dim">{b.area || '—'}</Td>
                    <Td>{b.product || <span style={{ color: 'var(--ink-faint)' }}>vazio</span>}</Td>
                    <Td right bold>{b.qty}</Td>
                    <Td right>{b.min_qty || '—'}</Td>
                    <Td>{b.needs_restock
                      ? <span className="kit-chip bad">repor</span>
                      : <span className="kit-chip ok">ok</span>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
      )}

      {/* CAIXAS */}
      {tab === 'boxes' && (
        boxRows.length === 0
          ? <Empty>Nenhuma caixa registrada.</Empty>
          : <Table name="inv-boxes">
              <thead><tr>
                <Th>Caixa</Th><Th>Área / palete</Th><Th>Produto</Th><Th right>Qtd</Th><Th>Status</Th>
              </tr></thead>
              <tbody>
                {filt(boxRows, ['box_number', 'product', 'area']).map((x) => (
                  <tr key={x.id} className={x.status === 'empty' ? 'off' : undefined}>
                    <Td mono bold>{x.box_number}</Td>
                    <Td cls="dim">{x.area || '—'}</Td>
                    <Td>{x.product || '—'}</Td>
                    <Td right bold>{x.qty}</Td>
                    <Td>{x.status === 'empty'
                      ? <span className="kit-chip neutral">vazia</span>
                      : <span className="kit-chip ok">em estoque</span>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
      )}

      {/* PLANNER */}
      {tab === 'planner' && (
        planRows.length === 0
          ? <Empty>Planner sem dados ainda. Precisa de estoque registrado + histórico de vendas (o sync coleta cerca de 2 semanas de linhas shipped antes da velocidade ficar confiável).</Empty>
          : <>
              <div className="pgi-hint">
                Dias de estoque = (armazém + marketplace) ÷ velocidade 14d. Lead = tempo medido da fórmula no EMS. Zona <b>planejar</b> = começar a planejar produção agora.
              </div>
              <Table name="inv-planner">
                <thead><tr>
                  <Th>Zona</Th><Th>Produto</Th><Th right>Armazém</Th><Th right>Marketplace</Th><Th right>Vende/dia</Th><Th right>Dias</Th><Th right>Lead (d)</Th><Th>Batch EMS</Th>
                </tr></thead>
                <tbody>
                  {filt(planRows, ['name']).map((p) => (
                    <tr key={p.product_id}>
                      <Td><ZonePill zone={p.zone}/></Td>
                      <Td bold>{p.name}{!p.velocity_reliable && <span title="pouco histórico de venda ainda" style={{ marginLeft: 6, color: 'var(--ink-faint)' }}>~</span>}</Td>
                      <Td right>{p.warehouse_qty}</Td>
                      <Td right>{p.marketplace_qty != null ? p.marketplace_qty : '—'}</Td>
                      <Td right>{p.per_day || '—'}</Td>
                      <Td right bold cls={p.zone === 'out' || p.zone === 'low' ? 'badnum' : undefined}>{p.days_of_stock != null ? p.days_of_stock : '∞'}</Td>
                      <Td right>{p.lead_days}</Td>
                      <Td cls="dim">{p.ems_batch ? (p.ems_batch.batch + ' · ' + p.ems_batch.stage) : <span className="kit-chip bad">sem batch</span>}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
      )}

      {/* SEPARADAS */}
      {tab === 'issues' && (
        issueRows.length === 0
          ? <Empty>Nenhuma garrafa separada. (Quando o kiosk lançar, "garrafa com problema" cai aqui até resolver.)</Empty>
          : <Table name="inv-issues">
              <thead><tr>
                <Th>Produto</Th><Th right>Qtd</Th><Th>Motivo</Th><Th>Bin</Th><Th>Quem</Th><Th>Quando</Th><Th>Status</Th><Th>Ação</Th>
              </tr></thead>
              <tbody>
                {filt(issueRows, ['product', 'reason']).map((i) => (
                  <tr key={i.id} className={i.status === 'separated' ? undefined : 'off'}>
                    <Td bold>{i.product}</Td>
                    <Td right>{i.qty}</Td>
                    <Td>{i.reason === 'label' ? 'label' : i.reason === 'seal' ? 'lacre' : 'outro'}</Td>
                    <Td mono>{i.bin_code || '—'}</Td>
                    <Td>{i.person || '—'}</Td>
                    <Td cls="dim">{String(i.created_at || '').slice(0, 10)}</Td>
                    <Td>{i.status === 'separated'
                      ? <span className="kit-chip warn">separada</span>
                      : <span className="kit-chip neutral">{i.status}</span>}</Td>
                    <Td>
                      {i.status === 'separated' && (
                        <span style={{ display: 'inline-flex', gap: 6 }}>
                          <button className="kit-btn xs sec" onClick={() => resolveIssue(i, 'restocked')} title="voltou pro bin">voltou pro bin</button>
                          <button className="kit-btn xs sec" onClick={() => resolveIssue(i, 'relabeled')} title="re-etiquetada">label ok</button>
                          <button className="kit-btn xs sec" onClick={() => resolveIssue(i, 'discarded')} title="descartada" style={{ color: 'var(--bad-deep)' }}>descarte</button>
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
          <div className="pgi-hint">
            Cadastre seus envelopes e caixas reais (um a um) e diga qual cada tamanho de pacote usa.
            {' '}Cada shipping label impressa deduz <b>1</b> do suprimento do tamanho. Estoque baixo avisa no admin-orin.
          </div>

          {/* adicionar suprimento real */}
          <div className="kit-card pad" style={{ marginBottom: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="kit-mlabel">Adicionar suprimento</span>
            <input className="kit-input" value={newSupply.name} onChange={(e) => setNewSupply((s) => ({ ...s, name: e.target.value }))}
              placeholder="nome real (ex.: Poly Mailer 6x9, Bubble 10x13…)"
              onKeyDown={(e) => { if (e.key === 'Enter') addSupply(); }}
              style={{ flex: '1 1 260px' }} />
            <select className="kit-input" value={newSupply.kind} onChange={(e) => setNewSupply((s) => ({ ...s, kind: e.target.value }))}>
              <option value="envelope">envelope</option>
              <option value="box">caixa</option>
              <option value="other">outro</option>
            </select>
            <button className="kit-btn sm primary" onClick={addSupply}>Adicionar</button>
          </div>

          {/* mapa tamanho → supply (Bruno escolhe) */}
          {tiers.length > 0 && (
            <div className="kit-card pad" style={{ marginBottom: 14 }}>
              <div className="kit-mlabel" style={{ marginBottom: 4 }}>Qual suprimento cada tamanho de pacote usa</div>
              <div className="pgi-hint" style={{ marginBottom: 12 }}>
                O tamanho vem da cor da garrafa + nº de garrafas (1 → A · 2 a 6 → Y · 7 a 9 → B · 10+ → BX caixa). Escolha o envelope ou a caixa de cada um.
              </div>
              <div className="pgi-fieldgrid">
                {tiers.map((t) => {
                  const cur = supplyMap.find((m) => m.package_size === t.package_size);
                  return (
                    <label key={t.package_size} className="pgi-field">
                      <span className="kit-mlabel">{t.package_size}{t.is_box ? ' (caixa)' : ''}</span>
                      <select className={'kit-input' + (cur ? '' : ' unset')} value={cur ? cur.supply_item_id : ''}
                        onChange={(e) => mapSize(t.package_size, e.target.value)}>
                        <option value="">escolher…</option>
                        {supplyItems.map((si) => <option key={si.id} value={si.id}>{si.name}</option>)}
                      </select>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {supplyItems.length === 0
            ? <Empty>Nenhum suprimento cadastrado ainda, adicione o primeiro acima.</Empty>
            : <Table name="inv-supplies">
                <thead><tr>
                  <Th>Suprimento</Th><Th>Tipo</Th><Th>Tamanhos</Th><Th right>Qtd</Th><Th right>Mín</Th><Th>Status</Th><Th>Ações</Th>
                </tr></thead>
                <tbody>
                  {filt(supplyItems, ['name', 'kind']).map((s) => (
                    <tr key={s.id} className={s.active ? undefined : 'off'}>
                      <Td bold>{s.name}</Td>
                      <Td cls="dim">{s.kind === 'box' ? 'caixa' : s.kind === 'envelope' ? 'envelope' : s.kind}</Td>
                      <Td mono>{(s.sizes || []).join(', ') || '—'}</Td>
                      <Td right bold cls={s.low ? 'badnum' : undefined}>{s.qty}</Td>
                      <Td right>{s.min_qty || '—'}</Td>
                      <Td>{s.low
                        ? <span className="kit-chip bad">baixo</span>
                        : <span className="kit-chip ok">ok</span>}</Td>
                      <Td>
                        <span style={{ display: 'inline-flex', gap: 6 }}>
                          <button className="kit-btn xs sec" onClick={() => changeSupply(s, 'restock', 'Reabastecer (+quantos)')} title="somar ao estoque">reabastecer</button>
                          <button className="kit-btn xs sec" onClick={() => changeSupply(s, 'count', 'Contagem (valor exato)')} title="setar contagem exata">contar</button>
                          <button className="kit-btn xs sec" onClick={() => setSupplyMin(s)} title="nível de alerta">mín</button>
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
            <div className="kit-card pad pgi-loading" style={{ marginTop: 0, marginBottom: 12 }}>
              Carregando SKUs do Veeqo. A lista do Veeqo é externa e lenta, roda em segundo plano e aparece em alguns segundos sem travar a página.
            </div>
          )}
          <div className="pgi-hint">
            Confirmar grava o mapa em v3.product_skus. Só SKU confirmado move estoque, a dedução automática nunca chuta. Sufixo -C2 ou -C3 vira garrafas por unidade automaticamente.
          </div>
          <Table name="inv-matched">
            <thead><tr>
              <Th>Nosso produto</Th><Th>SKU Veeqo</Th><Th>Título no Veeqo</Th><Th>Match</Th><Th>Confirmação</Th>
            </tr></thead>
            <tbody>
              {filt(matched, ['product', 'veeqo_sku', 'veeqo_title']).map((m) => {
                const done = confirmedSkus.has(m.veeqo_sku);
                const pack = inferPack(m.veeqo_sku);
                return (
                  <tr key={m.product_id + '|' + m.veeqo_sku} className={m.active ? undefined : 'off'}>
                    <Td bold>{m.product}{!m.active && <span className="kit-chip neutral" style={{ marginLeft: 8 }}>inativo</span>}</Td>
                    <Td mono>{m.veeqo_sku}</Td>
                    <Td cls="dim">{(m.veeqo_title || '').split('|')[0].trim()}</Td>
                    <Td><span className={'kit-chip ' + (MATCH_TONE[m.match] || 'neutral')}>{MATCH_LABEL[m.match] || m.match}</span></Td>
                    <Td>
                      {done
                        ? <span className="kit-chip ok">confirmado</span>
                        : <button className="kit-btn xs primary" onClick={() => confirmSku(m)}>
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
          <div className="pgi-hint">Produtos nossos que não achamos no Veeqo (SKU não bate ou não existe lá). Confirmar.</div>
          <Table name="inv-ours">
            <thead><tr><Th>Nosso produto</Th><Th>Nossos SKUs / códigos</Th><Th>Ativo</Th></tr></thead>
            <tbody>
              {filt(oursUn, ['product']).map((o) => (
                <tr key={o.product_id} className={o.active ? undefined : 'off'}>
                  <Td bold>{o.product}</Td>
                  <Td mono cls="dim">{(o.our_skus || []).join(', ') || '—'}</Td>
                  <Td>{o.active ? <span className="kit-chip ok">ativo</span> : <span className="kit-chip neutral">inativo</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}

      {/* VEEQO SEM NOSSO */}
      {tab === 'veeqo' && (
        <>
          <div className="pgi-hint">SKUs de suplemento no Veeqo que não casam com nenhum produto nosso. Buraco a verificar.</div>
          <Table name="inv-veeqo">
            <thead><tr><Th>SKU Veeqo</Th><Th>Título</Th></tr></thead>
            <tbody>
              {filt(veeqoUn, ['sku', 'title']).map((v) => (
                <tr key={v.sku}>
                  <Td mono bold>{v.sku}</Td>
                  <Td cls="dim">{(v.title || '').split('|')[0].trim()}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}

      {/* PLANOS / MEDICAÇÃO */}
      {tab === 'plans' && (
        <>
          <div className="pgi-hint">Assinaturas, planos e medicação (HF-PLN / HF-MED) mais clínica. Não são itens físicos da linha de produção.</div>
          <Table name="inv-plans">
            <thead><tr><Th>SKU</Th><Th>Título</Th></tr></thead>
            <tbody>
              {filt(plans, ['sku', 'title']).map((v) => (
                <tr key={v.sku}>
                  <Td mono>{v.sku}</Td>
                  <Td cls="dim">{(v.title || '').split('|')[0].trim()}</Td>
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
