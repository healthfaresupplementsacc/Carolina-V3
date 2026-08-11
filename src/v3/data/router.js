'use strict';
/**
 * HEALTHFARE V3 — API de dados JSON /api/v3/data/*
 *
 * Contrato ESTÁVEL e VERSIONADO (v3) entre o cérebro e os clientes
 * (dashboard, BI, sistema externo). JSON puro, nunca HTML.
 * Envelope { meta:{version,tz,date?,generated_at}, data }.
 * Auth na borda (auth.js). Os repos devolvem só `data`.
 *
 * Bloco 0: leitura. Bloco 2: 1ª escrita (POST /goals). Bloco 3:
 * o set completo de escrita (PATCH/DELETE) — "admin controla tudo",
 * sempre via os services porta-única, auditado.
 */

const { TimelineRepo } = require('./timeline-repo');
const { CountsRepo } = require('./counts-repo');
const { BatchesRepo } = require('./batches-repo');
const { MessagesRepo } = require('./messages-repo');
const { MetricsRepo } = require('./metrics-repo');
const { HealthRepo } = require('./health-repo');
const { stationOperatorNow } = require('../station-operator');   // fonte única: quem está na estação (Bruno 07-27)
const { VocabularyRepo } = require('./vocabulary-repo');
const { CatalogRepo } = require('./catalog-repo');
const { HistoryRepo } = require('./history-repo');
const { GoalsRepo } = require('./goals-repo');
const { FlowViewsRepo } = require('./flow-views-repo');
const { DeadlinesRepo } = require('./deadlines-repo');
const { SenderProfilesRepo } = require('./sender-profiles-repo');
const { GoalService } = require('../services/GoalService');
const { EventService } = require('../services/EventService');
const { BatchService } = require('../services/BatchService');
const { ProductionCountService } = require('../services/ProductionCountService');
const { DeadlineService } = require('../services/DeadlineService');
const { CatalogService } = require('../services/CatalogService');
const { SenderService } = require('../services/SenderService');
const { StockService } = require('../services/StockService');
const { SupplyService } = require('../services/SupplyService');
const { StockRepo } = require('./stock-repo');
const { StockAlerts } = require('../../workers/stock-alerts');
const { toNyIso, TZ, resolveDate } = require('./ny-date');
const { makeAuthMiddleware } = require('./auth');
const { veeqo } = require('../services/veeqo-api');
const printStream = require('../print-stream');
const attendanceMarkers = require('../attendance-markers');   // rótulos das batidas (Bruno 07-23)

const API_VERSION = 'v3';

// Spooler AO VIVO (Bruno 07-16): jobs ativos (progresso + ETA) + recém-completados.
// Usado no snapshot inicial do SSE. ETA = (páginas restantes) ÷ (ritmo até agora).
async function queryPrintLive(db) {
  const active = (await db.query(
    `SELECT computer, job_id, printer, document, status, pages_printed, total_pages, size_bytes,
            EXTRACT(EPOCH FROM (NOW() - first_seen_at))::int AS elapsed_sec
       FROM v3.print_progress
      WHERE done = false AND last_seen_at > NOW() - INTERVAL '20 seconds'
      ORDER BY first_seen_at`)).rows.map((j) => {
    const pp = j.pages_printed || 0, tp = j.total_pages || 0, el = j.elapsed_sec || 0;
    const pct = tp > 0 ? Math.min(100, Math.round((pp / tp) * 100)) : null;
    const eta_sec = (pp > 0 && el > 0 && tp > pp) ? Math.round((tp - pp) / (pp / el)) : null;
    return { ...j, pct, eta_sec };
  });
  const done = (await db.query(
    `SELECT pj.document, pj.printer, pj.sheets, pj.duration_sec, pj.status, pj.completed_at, pj.has_batch,
            pr.canonical_name AS product, pb.batch_number AS batch, pe.display_name AS operator
       FROM v3.print_jobs pj
       LEFT JOIN v3.products pr ON pr.id = pj.product_id
       LEFT JOIN v3.product_batches pb ON pb.id = pj.product_batch_id
       LEFT JOIN v3.persons pe ON pe.id = pj.person_id
      WHERE pj.created_at > NOW() - INTERVAL '12 hours'
      ORDER BY pj.created_at DESC LIMIT 8`)).rows;
  return { active, done };
}

// Página "Impressão" (Bruno 07-17): tudo das impressoras num payload só —
// estado físico atual, spooler ao vivo, stats do dia, histórico, transições.
// A saúde EPSON (tinta/mídia) chega no jsonb `ink`/`media` quando o canal
// BiDi/USB do .28 entrar; a página já tem os slots.
async function queryPrintersPage(db, date) {
  const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date
    : new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const printers = (await db.query(
    `SELECT computer, printer, status_label, error_label, ink, media, changed_at, updated_at,
            EXTRACT(EPOCH FROM (NOW() - updated_at))::int AS age_sec
       FROM v3.printer_status ORDER BY printer`)).rows;
  const live = await queryPrintLive(db);
  const stats = (await db.query(
    `SELECT COUNT(*)::int AS jobs, COALESCE(SUM(sheets),0)::int AS labels,
            COUNT(DISTINCT person_id)::int AS operators
       FROM v3.print_jobs
      WHERE (created_at AT TIME ZONE 'America/New_York')::date = $1::date`, [d])).rows[0];
  const byPrinter = (await db.query(
    `SELECT printer, COUNT(*)::int AS jobs, COALESCE(SUM(sheets),0)::int AS labels
       FROM v3.print_jobs
      WHERE (created_at AT TIME ZONE 'America/New_York')::date = $1::date
      GROUP BY printer ORDER BY labels DESC`, [d])).rows;
  const byOperator = (await db.query(
    `SELECT COALESCE(pe.display_name, pj.operator, 'sem PIN') AS operator,
            COUNT(*)::int AS jobs, COALESCE(SUM(pj.sheets),0)::int AS labels
       FROM v3.print_jobs pj LEFT JOIN v3.persons pe ON pe.id = pj.person_id
      WHERE (pj.created_at AT TIME ZONE 'America/New_York')::date = $1::date
      GROUP BY 1 ORDER BY labels DESC`, [d])).rows;
  const byProduct = (await db.query(
    `SELECT COALESCE(pr.canonical_name, 'não identificado') AS product,
            COUNT(*)::int AS jobs, COALESCE(SUM(pj.sheets),0)::int AS labels
       FROM v3.print_jobs pj LEFT JOIN v3.products pr ON pr.id = pj.product_id
      WHERE (pj.created_at AT TIME ZONE 'America/New_York')::date = $1::date
      GROUP BY 1 ORDER BY labels DESC`, [d])).rows;
  const history = (await db.query(
    `SELECT pj.id, pj.document, pj.printer, pj.pages, pj.copies, pj.sheets, pj.duration_sec,
            pj.print_seconds, pj.session_active_sec, pj.status, pj.has_batch, pj.submitted_at, pj.completed_at, pj.created_at,
            pr.canonical_name AS product, pb.batch_number AS batch, pe.display_name AS operator, pj.operator AS operator_fallback
       FROM v3.print_jobs pj
       LEFT JOIN v3.products pr ON pr.id = pj.product_id
       LEFT JOIN v3.product_batches pb ON pb.id = pj.product_batch_id
       LEFT JOIN v3.persons pe ON pe.id = pj.person_id
      ORDER BY pj.created_at DESC LIMIT 60`)).rows;
  const transitions = (await db.query(
    `SELECT printer, status_label, error_label, at
       FROM v3.printer_status_log ORDER BY at DESC LIMIT 30`)).rows;
  // Incidentes ABERTOS agora (settings printer_incident:*) — o que está com problema.
  const incidents = (await db.query(
    `SELECT REPLACE(key, 'printer_incident:', '') AS printer, value, updated_at
       FROM v3.settings WHERE key LIKE 'printer_incident:%'`)).rows.map((r) => ({
    printer: r.printer,
    error: r.value && r.value.error || null,
    since: r.value && r.value.since ? new Date(r.value.since).toISOString() : null,
    tried_by: r.value && r.value.tried_by || null,
    alerts: r.value && r.value.alerts || 0,
    down_seconds: r.value && r.value.since ? Math.round((Date.now() - r.value.since) / 1000) : null,
  }));
  // Histórico de erros de mídia (últimos 20) — pra ver recorrência.
  const errorLog = (await db.query(
    `SELECT printer, error_label, at FROM v3.printer_status_log
      WHERE error_label IS NOT NULL AND error_label <> 'none' AND status_label NOT LIKE 'ALERT:%'
      ORDER BY at DESC LIMIT 20`)).rows;
  // QUEM está logado no PC da impressão AGORA (Bruno 07-27): quadrado na página.
  // "ativo" = heartbeat (updated_at) recente (<2min); senão logado mas parado.
  // MESMA fonte de verdade do Slack (Bruno 07-27): quem logou por último na estação.
  // Devolve `stale` quando o dado está velho → a página mostra "não confirmado" em vez
  // de afirmar a pessoa errada.
  let stationOperator = null;
  try {
    const so = await stationOperatorNow(db);
    if (so) {
      stationOperator = {
        name: so.name,
        person_id: so.person_id,
        since: so.since,
        active_sec: so.active_sec,
        active_now: so.active_now,
        last_seen_sec: so.last_seen_sec,
        stale: so.stale,
      };
    }
  } catch (_) { /* ok */ }
  return { date: d, printers, live, stats, byPrinter, byOperator, byProduct, history, transitions, incidents, errorLog, stationOperator };
}

// Tab INVENTORY (Bruno 07-17): mapeia NOSSOS produtos (v3.products) ↔ SKUs do
// Veeqo. Base = nosso catálogo. 3 grupos: (1) casam c/ Veeqo, (2) nossos SEM Veeqo,
// (3) SKUs do Veeqo que sobram (sem produto nosso). Foco = verificar produto↔SKU.
// Cache 10min (o catálogo Veeqo é grande/lento; muda pouco).
const _invCache = { at: 0, data: null, refreshing: false };

// Estoque Veeqo por SKU (Bruno 08-03): a Veeqo devolve `stock` por sellable.
// Mesmo padrão stale-while-revalidate do _invCache (listSellables é lento/pode dar
// timeout) — nunca bloqueia o request; devolve o cache e atualiza em background.
const _stockCache = { at: 0, bySku: null, refreshing: false };
async function veeqoStockBySku() {
  const fresh = _stockCache.bySku && Date.now() - _stockCache.at < 10 * 60 * 1000;
  if (fresh) return _stockCache.bySku;
  if (!_stockCache.refreshing) {
    _stockCache.refreshing = true;
    veeqo.listSellables()
      .then((rows) => {
        const m = {};
        for (const s of rows) { if (s && s.sku != null) m[String(s.sku).trim().toUpperCase()] = (s.stock == null ? null : Number(s.stock)); }
        _stockCache.bySku = m; _stockCache.at = Date.now();
      })
      .catch((e) => console.error('[v3-data] veeqo stock refresh:', e.message))
      .finally(() => { _stockCache.refreshing = false; });
  }
  return _stockCache.bySku || {};   // {} enquanto o 1º refresh não volta (não trava)
}

// Nomes dos clientes por número de pedido (pra picklist) — a Veeqo tem o nome, o
// nosso pnp_order_lines não. SWR: puxa awaiting_fulfillment em background, mapeia
// order_number → nome. Não bloqueia o /picklist (mostra "a preencher" até chegar).
const _nameCache = { at: 0, byNum: null, refreshing: false };
async function veeqoNamesByOrder() {
  const fresh = _nameCache.byNum && Date.now() - _nameCache.at < 10 * 60 * 1000;
  if (fresh) return _nameCache.byNum;
  if (!_nameCache.refreshing) {
    _nameCache.refreshing = true;
    (async () => {
      const map = {};
      for (let p = 1; p <= 20; p++) {
        const rows = await veeqo.getOrdersPage({ status: 'awaiting_fulfillment', page: p, pageSize: 100 });
        if (!rows.length) break;
        for (const o of rows) {
          const d = o.deliver_to || o.customer || {};
          const name = ((d.first_name || '') + ' ' + (d.last_name || '')).trim() || (o.customer && o.customer.full_name) || null;
          if (name) map[String(o.number || o.id)] = name;
        }
        if (rows.length < 100) break;
      }
      _nameCache.byNum = map; _nameCache.at = Date.now();
    })().catch((e) => console.error('[v3-data] veeqo names refresh:', e.message))
      .finally(() => { _nameCache.refreshing = false; });
  }
  return _nameCache.byNum || {};
}

const _up = (s) => String(s || '').trim().toUpperCase();
const _baseSku = (s) => _up(s).replace(/[-\s]*(C\d+|WFS|FBA|R)\b/g, '').replace(/[-_\s]+$/, '').replace(/[-_\s]+/g, '-');
// Sufixo de CASEPACK do SKU ('C2','C3','C4'…) ou '' se for o produto base.
// Bruno 08-07: casepack é OUTRO produto — nunca casar base com C2, nem C2 com C4.
const _packOf = (s) => { const m = _up(s).match(/\bC(\d+)\b/); return m ? 'C' + m[1] : ''; };
const _normName = (s) => String(s || '').toLowerCase().split('|')[0]
  .replace(/healthfare/g, ' ')
  .replace(/\b\d[\d.,]*\s*(mg|mcg|g|iu|ml|ct|count|caps?|capsules?|tablets?|softgels?|vegan|pills?)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const _looksCode = (s) => /^[A-Z]{2,}[-0-9]/.test(_up(s)) && /\d/.test(String(s));
const _isClinic = (sku) => /^HC[-\s]/.test(_up(sku)) || _up(sku) === '70';
const _isPlanOrMed = (sku) => /^(HF-PLN|HF-MED|HF-ICE)/.test(_up(sku));

// PERF (Bruno 08-03): o compute chama veeqo.listSellables() que pagina ATÉ 60
// páginas da API de produtos do Veeqo e pode levar ~20–30s (ou dar timeout). Antes
// isso rodava DENTRO do request → cada abertura da aba Inventory com cache frio
// travava a página. Agora: stale-while-revalidate. O request NUNCA bloqueia — devolve
// o cache (mesmo velho) na hora e dispara o refresh em background. Sem cache ainda →
// devolve {loading:true} e o poll do front pega quando ficar pronto.
async function queryInventory(db) {
  const fresh = _invCache.data && Date.now() - _invCache.at < 10 * 60 * 1000;
  if (fresh) return { ..._invCache.data, cached: true };
  // dispara refresh em background (1 de cada vez)
  if (!_invCache.refreshing) {
    _invCache.refreshing = true;
    _computeInventory(db)
      .then((data) => { _invCache.at = Date.now(); _invCache.data = data; })
      .catch((e) => console.error('[v3-data] inventory refresh falhou:', e.message))
      .finally(() => { _invCache.refreshing = false; });
  }
  // tem cache velho? devolve na hora (stale). Senão, sinaliza loading (não trava).
  if (_invCache.data) return { ..._invCache.data, cached: true, stale: true };
  return { loading: true, matched: [], ours_unmatched: [], veeqo_unmatched: [], veeqo_plans: [], stats: {} };
}

async function _computeInventory(db) {
  if (!veeqo.configured()) return { configured: false, matched: [], ours_unmatched: [], veeqo_unmatched: [], stats: {} };

  const prods = (await db.query('SELECT id, canonical_name, aliases, active FROM v3.products')).rows;
  // índices dos NOSSOS produtos: por SKU exato, por base de SKU, por nome
  const byExact = new Map(); const byBase = new Map(); const nameIdx = [];
  for (const pr of prods) {
    const names = [pr.canonical_name, ...(pr.aliases || [])];
    pr._skus = names.filter(_looksCode).map(_up);
    for (const a of names) {
      if (_looksCode(a)) {
        const A = _up(a); if (!byExact.has(A)) byExact.set(A, pr);
        const b = _baseSku(A); if (b && !byBase.has(b)) byBase.set(b, pr);
      }
      const nn = _normName(a); if (nn && nn.length >= 3) nameIdx.push({ norm: nn, product: pr });
    }
  }

  const sellables = await veeqo.listSellables();     // [{sku, title, product_title, stock}]
  const veeqoBases = new Set(sellables.map((s) => _baseSku(s.sku)));

  // pra cada NOSSO produto: acha o SKU do Veeqo (exato/base/nome)
  const matched = []; const oursUnmatched = [];
  const usedSkus = new Set();
  for (const pr of prods) {
    let hit = null; let how = null;
    // 1) algum SKU nosso casa exato/base com um SKU do Veeqo?
    for (const s of sellables) {
      if (pr._skus.includes(_up(s.sku))) { hit = s; how = 'exato'; break; }
    }
    if (!hit) {
      for (const s of sellables) {
        // CASEPACK É OUTRO PRODUTO (Bruno 08-07): só casa base-com-base, C2-com-C2…
        // Sem isso, HF-BENF-300-C2 casaria com HF-BENF-300 (produtos diferentes).
        if (pr._skus.some((c) => _baseSku(c) === _baseSku(s.sku) && _packOf(c) === _packOf(s.sku))) { hit = s; how = 'base'; break; }
      }
    }
    // 2) senão, por NOME (respeitando o casepack: base ≠ C2 ≠ C4 — Bruno 08-07)
    if (!hit) {
      const pn = _normName(pr.canonical_name);
      const myPack = _packOf(pr.canonical_name) || (pr._skus.length ? _packOf(pr._skus[0]) : '');
      if (pn && pn.length >= 4) {
        hit = sellables.find((s) => {
          if (_packOf(s.sku) !== myPack) return false;
          const sn = _normName(s.title || s.product_title);
          return sn && (sn === pn || (pn.length >= 5 && (sn.includes(pn) || pn.includes(sn))));
        }) || null;
        if (hit) how = 'nome';
      }
    }
    if (hit) {
      usedSkus.add(_up(hit.sku));
      matched.push({ product_id: pr.id, product: pr.canonical_name, active: pr.active,
        veeqo_sku: hit.sku, veeqo_title: hit.title, match: how, stock: hit.stock });
    } else {
      oursUnmatched.push({ product_id: pr.id, product: pr.canonical_name, active: pr.active, our_skus: pr._skus });
    }
  }

  // SKUs do Veeqo que sobraram (sem produto nosso) — separa suplemento vs plano/clínica
  const veeqoUnmatched = []; const veeqoPlans = [];
  for (const s of sellables) {
    if (usedSkus.has(_up(s.sku))) continue;
    // já casou por base com algum nosso? (evita duplicar)
    const pr = byExact.get(_up(s.sku)) || byBase.get(_baseSku(s.sku));
    if (pr) continue;
    const row = { sku: s.sku, title: s.title, stock: s.stock };
    if (_isPlanOrMed(s.sku) || _isClinic(s.sku)) veeqoPlans.push(row);
    else veeqoUnmatched.push(row);
  }

  const data = {
    configured: true,
    matched: matched.sort((a, b) => (a.product || '').localeCompare(b.product || '')),
    ours_unmatched: oursUnmatched.sort((a, b) => (a.product || '').localeCompare(b.product || '')),
    veeqo_unmatched: veeqoUnmatched.sort((a, b) => (a.sku || '').localeCompare(b.sku || '')),
    veeqo_plans: veeqoPlans.sort((a, b) => (a.sku || '').localeCompare(b.sku || '')),
    stats: {
      our_products: prods.length,
      veeqo_skus: sellables.length,
      matched: matched.length,
      matched_exact: matched.filter((m) => m.match === 'exato').length,
      matched_base: matched.filter((m) => m.match === 'base').length,
      matched_name: matched.filter((m) => m.match === 'nome').length,
      ours_unmatched: oursUnmatched.length,
      veeqo_unmatched: veeqoUnmatched.length,
      veeqo_plans: veeqoPlans.length,
    },
  };
  return data;   // cache é escrito pelo queryInventory (stale-while-revalidate)
}

// ── VEEQO (Fase ①): cache 3min do "enviados do dia" — a Veeqo é externa/lenta e o
// dashboard faz poll; nunca deixa um erro externo derrubar o endpoint. ──────────
const _veeqoCache = new Map(); // date -> { at, data }
let _channelSkusVeeqo = { at: 0, data: null }; // catálogo de SKUs do Veeqo (dropdown Product Setup)
async function veeqoToday(date) {
  const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date
    : new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  if (!veeqo.configured()) return { configured: false, date: d, total_orders: 0, total_units: 0, by_channel: [], by_product: [] };
  const c = _veeqoCache.get(d);
  if (c && Date.now() - c.at < 3 * 60 * 1000) return { configured: true, cached: true, ...c.data };
  try {
    const data = await veeqo.shippedByDay(d);
    _veeqoCache.set(d, { at: Date.now(), data });
    return { configured: true, ...data };
  } catch (e) {
    return { configured: true, error: e.code || 'error', message: e.message, date: d, total_orders: 0, total_units: 0, by_channel: [], by_product: [] };
  }
}

/** Repos de leitura sobre um pool/cliente pg. */
function buildRepos(db) {
  return {
    timeline: new TimelineRepo({ db }),
    counts: new CountsRepo({ db }),
    batches: new BatchesRepo({ db }),
    messages: new MessagesRepo({ db }),
    metrics: new MetricsRepo({ db }),
    health: new HealthRepo({ db }),
    vocabulary: new VocabularyRepo({ db }),
    catalog: new CatalogRepo({ db }),
    history: new HistoryRepo({ db }),
    goals: new GoalsRepo({ db }),
    flowViews: new FlowViewsRepo({ db }),
    deadlines: new DeadlinesRepo({ db }),
    senderProfiles: new SenderProfilesRepo({ db }),
    stock: new StockRepo({ db }),
  };
}

/** Services porta-única (escrita), sobre um pool/cliente pg. */
function buildServices(db) {
  return {
    goal: new GoalService({ db }),
    event: new EventService({ db }),
    batch: new BatchService({ db }),
    count: new ProductionCountService({ db }),
    deadline: new DeadlineService({ db }),
    catalog: new CatalogService({ db }),
    sender: new SenderService({ db }),
    senderProfile: new SenderProfilesRepo({ db }), // share repo for CRUD writes too
    // Centro de Estoque (Bruno 08-01): porta única de escrita do estoque físico.
    // Discrepância (bin curto, contagem divergente) vira data_incident → caixa urgente.
    stock: new StockService({
      db,
      onDiscrepancy: async (d) => {
        try {
          await db.query(
            `INSERT INTO v3.data_incidents (kind, severity, title, explanation, product_id, amount, where_json)
             VALUES ($1, 'warning', $2, $3, $4, $5, $6::jsonb)`,
            ['stock_' + (d.kind || 'desync'), 'Estoque: ' + (d.kind || 'divergência'),
              d.note || 'divergência de estoque detectada',
              d.product_id || null, d.wanted != null ? d.wanted : null,
              JSON.stringify({ bin_id: d.bin_id || null, box_id: d.box_id || null, applied: d.applied != null ? d.applied : null })]);
        } catch (e) { console.error('[stock] incidente falhou:', e.message); }
      },
    }),
    // planner (leitura): reusa o compute() do worker, sem alertas (enabled:false)
    stockPlanner: new StockAlerts({ db, veeqo, enabled: false }),
    // Supplies (Bruno 08-03): envelopes/caixas que a impressão de label consome.
    // Baixo estoque → data_incident (caixa urgente + admin-orin via worker).
    supply: new SupplyService({
      db,
      onLow: async (x) => {
        try {
          await db.query(
            `INSERT INTO v3.data_incidents (kind, severity, title, explanation, amount, where_json)
             VALUES ('supply_low','warning',$1,$2,$3,$4::jsonb)`,
            ['Suprimento baixo: ' + x.item,
              x.item + ' está em ' + x.qty + ' (mín ' + x.min_qty + ') — reabasteça.',
              x.qty, JSON.stringify({ supply_item_id: x.supply_item_id, min_qty: x.min_qty })]);
        } catch (e) { console.error('[supply] incidente falhou:', e.message); }
      },
      onDiscrepancy: async (d) => {
        try {
          await db.query(
            `INSERT INTO v3.data_incidents (kind, severity, title, explanation, amount, where_json)
             VALUES ('supply_short','warning',$1,$2,$3,$4::jsonb)`,
            ['Suprimento insuficiente', d.note || 'consumo de supply estourou o estoque',
              d.wanted != null ? d.wanted : null,
              JSON.stringify({ supply_item_id: d.item_id || null, applied: d.applied != null ? d.applied : null })]);
        } catch (e) { console.error('[supply] discrepância falhou:', e.message); }
      },
    }),
  };
}

/** Envelope padrão da API. `data` = payload do repo/service. */
function envelope(data, metaExtra) {
  return {
    meta: Object.assign(
      { version: API_VERSION, tz: TZ, generated_at: toNyIso(new Date()) },
      metaExtra || {}),
    data,
  };
}

const intParam = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};
const body = (req) => (req && req.body) || {};

/**
 * Cada endpoint: { method?, path, handler async (req, repos, services) }
 * → { data, meta? }. Exportado pra teste.
 */
const ENDPOINTS = [
  // ── LEITURA ───────────────────────────────────────────────
  { path: '/api/v3/data/timeline',
    handler: async (req, r) => {
      const d = await r.timeline.eventsByDay(req.query.date);
      return { data: d, meta: { date: d.date } };
    } },
  { path: '/api/v3/data/person/:id/timeline',
    handler: async (req, r) => {
      const d = await r.timeline.eventsByPersonDay(intParam(req.params.id), req.query.date);
      return { data: d, meta: { date: d.date } };
    } },
  { path: '/api/v3/data/counts',
    handler: async (req, r) => {
      const d = await r.counts.countsByDay(req.query.date);
      return { data: d, meta: { date: d.date } };
    } },
  { path: '/api/v3/data/batches',
    handler: async (req, r) => ({ data: await r.batches.activeBatches() }) },
  { path: '/api/v3/data/batches/:id',
    handler: async (req, r) => ({ data: await r.batches.batchSummary(intParam(req.params.id)) }) },
  { path: '/api/v3/data/messages',
    handler: async (req, r) => {
      const d = await r.messages.messagesByDay(req.query.date, { limit: req.query.limit });
      return { data: d, meta: { date: d.date } };
    } },
  { path: '/api/v3/data/messages/:id',
    handler: async (req, r) => ({ data: await r.messages.messageById(intParam(req.params.id)) }) },
  // Ciclo de aprendizado base — lista as msgs que o LLM marcou como
  // incertas, OU com confidence low/unconfirmed, OU com processing_error.
  // Futura tela "Cérebro" usa isso.
  { path: '/api/v3/data/uncertain-cases',
    handler: async (req, r) => ({
      data: await r.messages.uncertainCases({
        limit: req.query.limit, since_days: req.query.since_days,
      }),
    }) },
  { path: '/api/v3/data/metrics',
    handler: async (req, r) => {
      const d = await r.metrics.metricsByDay(req.query.date);
      return { data: d, meta: { date: d.date } };
    } },
  { path: '/api/v3/data/health',
    handler: async (req, r) => ({ data: await r.health.workerHealth() }) },
  { path: '/api/v3/data/vocabulary',
    handler: async (req, r) => ({ data: await r.vocabulary.pending() }) },
  { path: '/api/v3/data/flows',
    handler: async (req, r) => ({ data: await r.catalog.flows() }) },
  { path: '/api/v3/data/catalog/persons',
    handler: async (req, r) => ({ data: await r.catalog.persons() }) },
  { path: '/api/v3/data/catalog/products',
    handler: async (req, r) => ({ data: await r.catalog.products() }) },
  { path: '/api/v3/data/catalog/activity-types',
    handler: async (req, r) => ({ data: await r.catalog.activityTypes() }) },
  // Busca universal (produto/lote/pessoa/tarefa) + histórico completo de lote.
  { path: '/api/v3/data/search',
    handler: async (req, r) => ({ data: await r.history.search(req.query.q) }) },
  { path: '/api/v3/data/history/batch/:id',
    handler: async (req, r) => ({ data: await r.history.batchHistory(intParam(req.params.id)) }) },
  { path: '/api/v3/data/history/product-family',
    handler: async (req, r) => ({ data: await r.history.familyHistory(req.query.ids) }) },
  { path: '/api/v3/data/person/:id/history',
    handler: async (req, r) => ({
      data: await r.history.personHistory(intParam(req.params.id),
        { from: req.query.from, to: req.query.to }),
    }) },
  { path: '/api/v3/data/product/:id/history',
    handler: async (req, r) => ({
      data: await r.history.productHistory(intParam(req.params.id),
        { from: req.query.from, to: req.query.to }),
    }) },
  { path: '/api/v3/data/goals',
    handler: async (req, r) => {
      const g = await r.goals.goalsByDay(req.query.date);
      return { data: g, meta: { date: g.date } };
    } },
  // Bloco 3 — visões por fluxo
  { path: '/api/v3/data/production',
    handler: async (req, r) => {
      const d = await r.flowViews.productionByDay(req.query.date);
      return { data: d, meta: { date: d.date } };
    } },
  { path: '/api/v3/data/pp',
    handler: async (req, r) => {
      const d = await r.flowViews.pnpByDay(req.query.date);
      return { data: d, meta: { date: d.date } };
    } },
  { path: '/api/v3/data/fnsku',
    handler: async (req, r) => {
      const d = await r.flowViews.fnskuByDay(req.query.date);
      return { data: d, meta: { date: d.date } };
    } },
  { path: '/api/v3/data/support',
    handler: async (req, r) => {
      const d = await r.flowViews.supportByDay(req.query.date);
      return { data: d, meta: { date: d.date } };
    } },
  // taxa de revisão (cápsulas/seg + frascos/min) + média de tempo de revisão
  // por produto e geral. Histórico (?range=7d|30d|90d|180d, default 30d).
  { path: '/api/v3/data/review-rate',
    handler: async (req, r) => ({
      data: await r.flowViews.reviewRate({
        range: req.query.range, product_id: req.query.product_id,
        person_id: req.query.person_id, from: req.query.from, to: req.query.to,
      }),
    }) },
  { path: '/api/v3/data/deadlines',
    handler: async (req, r) => ({ data: await r.deadlines.list() }) },
  // VEEQO (Fase ① — Bruno 07-08): pedidos ENVIADOS (etiqueta impressa) do dia,
  // por canal + por suplemento. Read-only, chave server-side. Cache 3min (a Veeqo
  // é externa/lenta e o dashboard faz poll). ?date=YYYY-MM-DD (default: hoje NY).
  { path: '/api/v3/data/veeqo-today',
    handler: async (req) => ({ data: await veeqoToday(req.query.date) }) },
  // sender profiles + manual post (porta de saída admin)
  { path: '/api/v3/data/sender-profiles',
    handler: async (req, r) => ({ data: await r.senderProfiles.list() }) },
  { path: '/api/v3/data/sent-history',
    handler: async (req, r, s) => ({ data: await s.sender.recentPosts(req.query.limit) }) },

  // ── ESCRITA (Bloco 3 — admin controla tudo, auditado) ─────
  // metas
  { method: 'post', path: '/api/v3/data/goals',
    handler: async (req, r, s) => {
      const b = body(req);
      return { data: await s.goal.record({
        product_id: b.product_id || null, batch_number: b.batch_number || null,
        expected_quantity: b.expected_quantity, unit: b.unit || 'bottle',
        destinations: b.destinations || null, production_date: resolveDate(b.production_date),
        source: 'dashboard', created_by_person_id: b.created_by_person_id || null,
        confidence: b.confidence || 'high', actor_type: 'admin',
      }) };
    } },
  { method: 'patch', path: '/api/v3/data/goals/:id',
    handler: async (req, r, s) => {
      const b = body(req);
      return { data: await s.goal.correct(intParam(req.params.id), b.changes || {}, b.by_person_id, b.note) };
    } },
  { method: 'delete', path: '/api/v3/data/goals/:id',
    handler: async (req, r, s) => ({
      data: await s.goal.softDelete(intParam(req.params.id), body(req).by_person_id, body(req).reason),
    }) },
  // events — CREATE (B.6: admin cria event direto pela UI; ex.: o
  // caso Bruno Sarmento/formulação que faltou no dia 22 e o LLM
  // nunca abriu). source_message_ts=NULL é a marca de criação manual
  // (idempotência por ts não aplicável). actor_type='admin' no audit.
  { method: 'post', path: '/api/v3/data/events',
    handler: async (req, r, s) => {
      const b = body(req);
      if (!b.person_id) throw new Error('person_id obrigatório');
      if (!b.started_at) throw new Error('started_at obrigatório');
      return { data: await s.event.upsert({
        person_id: b.person_id,
        activity_type_id: b.activity_type_id || null,
        product_batch_id: b.product_batch_id || null,
        started_at: b.started_at,
        ended_at: b.ended_at || null,
        phase_label: b.phase_label || null,
        description: b.description || null,
        confidence: b.confidence || 'high',
        cowork_with: b.cowork_with || [],
        quantity: b.quantity != null ? b.quantity : null,
        quantity_unit: b.quantity_unit || null,
        source_message_ts: null,
        actor_type: 'admin',
        actor_person_id: b.by_person_id || null,
      }) };
    } },
  // events
  { method: 'patch', path: '/api/v3/data/events/:id',
    handler: async (req, r, s) => {
      const b = body(req);
      return { data: await s.event.correct(intParam(req.params.id), b.changes || {}, b.by_person_id, b.note) };
    } },
  { method: 'delete', path: '/api/v3/data/events/:id',
    handler: async (req, r, s) => ({
      data: await s.event.softDelete(intParam(req.params.id), body(req).by_person_id, body(req).reason),
    }) },
  { method: 'post', path: '/api/v3/data/events/:id/restore',
    handler: async (req, r, s) => ({
      data: await s.event.restore(intParam(req.params.id), body(req).by_person_id),
    }) },
  { method: 'post', path: '/api/v3/data/events/merge',
    handler: async (req, r, s) => ({
      data: await s.event.mergeEvents(body(req).event_ids || [], body(req).by_person_id),
    }) },
  { method: 'post', path: '/api/v3/data/events/:id/split',
    handler: async (req, r, s) => ({
      data: await s.event.splitEvent(intParam(req.params.id), body(req).split_at, body(req).by_person_id),
    }) },
  // contagens
  { method: 'patch', path: '/api/v3/data/counts/:id',
    handler: async (req, r, s) => {
      const b = body(req);
      return { data: await s.count.supersede(intParam(req.params.id), b.new_bottles, b.by_person_id, b.note) };
    } },
  { method: 'delete', path: '/api/v3/data/counts/:id',
    handler: async (req, r, s) => ({
      data: await s.count.softDelete(intParam(req.params.id), body(req).by_person_id, body(req).reason),
    }) },
  { method: 'post', path: '/api/v3/data/counts/:id/confirm',
    handler: async (req, r, s) => {
      const b = body(req);
      const id = intParam(req.params.id);
      // decision: 'duplicate' → some da soma (softDelete) | 'additional' → entra (limpa flag)
      if (b.decision === 'duplicate') {
        return { data: await s.count.softDelete(id, b.by_person_id, 'duplicata confirmada pelo admin') };
      }
      if (b.decision === 'additional') {
        return { data: await s.count.confirmNotDuplicate(id, b.by_person_id) };
      }
      throw new Error('confirm: decision inválido (duplicate|additional)');
    } },
  // lotes — resolve produto+nº lote → batch_id (cria se não existir).
  // Usado pelo drawer de edição quando o admin escolhe produto + lote
  // pra anexar ao event. batch_number opcional → '(sem lote)' como
  // placeholder, permitindo eventos com produto mas sem nº de lote
  // (ex.: "Bruno mencionou Potassium" sem informar o lote).
  { method: 'post', path: '/api/v3/data/batches/resolve',
    handler: async (req, r, s) => {
      const b = body(req);
      const productId = parseInt(b.product_id, 10);
      if (!Number.isFinite(productId)) throw new Error('product_id obrigatório');
      const batchNum = (b.batch_number == null || String(b.batch_number).trim() === '')
        ? '(sem lote)'
        : String(b.batch_number).trim();
      const startedAt = b.started_at || new Date().toISOString();
      const batch = await s.batch.findOrCreateActive(productId, batchNum, startedAt,
        { actorType: 'admin' });
      return { data: {
        batch_id: batch.id,
        product_id: batch.product_id,
        batch_number: batch.batch_number,
        status: batch.status,
        started_at: batch.started_at,
      } };
    } },
  // lotes
  { method: 'patch', path: '/api/v3/data/batches/:id',
    handler: async (req, r, s) => {
      const b = body(req);
      return { data: await s.batch.closeBatch(intParam(req.params.id), b.finished_at || null,
        b.status, { actorType: 'admin', actorPersonId: b.by_person_id }) };
    } },
  // fases (activity_types)
  { method: 'patch', path: '/api/v3/data/catalog/activity-types/:id',
    handler: async (req, r, s) => {
      const b = body(req);
      return { data: await s.catalog.updateActivityType(intParam(req.params.id), b.changes || {}, b.by_person_id) };
    } },
  // sender profiles (CRUD)
  { method: 'post', path: '/api/v3/data/sender-profiles',
    handler: async (req, r, s) => ({ data: await s.senderProfile.create(body(req)) }) },
  { method: 'patch', path: '/api/v3/data/sender-profiles/:id',
    handler: async (req, r, s) => ({ data: await s.senderProfile.update(intParam(req.params.id), body(req)) }) },
  { method: 'delete', path: '/api/v3/data/sender-profiles/:id',
    handler: async (req, r, s) => ({ data: await s.senderProfile.softDelete(intParam(req.params.id)) }) },
  { method: 'post', path: '/api/v3/data/sender-profiles/:id/set-default',
    handler: async (req, r, s) => ({ data: await s.senderProfile.setDefault(intParam(req.params.id)) }) },
  // porta de saída MANUAL — postar como persona.
  // PIN obrigatório; audit em manual_post.sent.
  { method: 'post', path: '/api/v3/data/send',
    handler: async (req, r, s) => {
      const b = body(req);
      if (!b.sender_name) throw new Error('sender_name obrigatório');
      if (!b.channel) throw new Error('channel obrigatório');
      if (!b.text && !b.image) throw new Error('text ou image obrigatório');
      const out = await s.sender.send({
        channel: b.channel,
        text: b.text || null,
        sender: { name: b.sender_name, icon: b.sender_icon || null },
        image: b.image || null,
        thread_ts: b.thread_ts || null,
        actorType: 'admin',
      });
      return { data: out };
    } },
  // porta de saída MANUAL — reagir a msg (emoji).
  { method: 'post', path: '/api/v3/data/react',
    handler: async (req, r, s) => {
      const b = body(req);
      if (!b.channel) throw new Error('channel obrigatório');
      if (!b.ts) throw new Error('ts obrigatório');
      if (!b.emoji) throw new Error('emoji obrigatório');
      const out = await s.sender.react({
        channel: b.channel, ts: b.ts, emoji: b.emoji, actorType: 'admin',
      });
      return { data: out };
    } },
  // deadlines
  { method: 'post', path: '/api/v3/data/deadlines',
    handler: async (req, r, s) => ({ data: await s.deadline.create(body(req), body(req).by_person_id) }) },
  { method: 'patch', path: '/api/v3/data/deadlines/:id',
    handler: async (req, r, s) => {
      const b = body(req);
      return { data: await s.deadline.update(intParam(req.params.id), b.changes || {}, b.by_person_id) };
    } },
  { method: 'delete', path: '/api/v3/data/deadlines/:id',
    handler: async (req, r, s) => ({
      data: await s.deadline.remove(intParam(req.params.id), body(req).by_person_id),
    }) },

  // ── CENTRO DE ESTOQUE (Bruno 08-01) — leitura ─────────────────────────
  { path: '/api/v3/data/stock/bins',
    handler: async (req, r) => ({ data: await r.stock.bins() }) },
  { path: '/api/v3/data/stock/boxes',
    handler: async (req, r) => ({ data: await r.stock.boxes() }) },
  { path: '/api/v3/data/stock/summary',
    handler: async (req, r) => ({ data: await r.stock.summary() }) },
  { path: '/api/v3/data/stock/issues',
    handler: async (req, r) => ({ data: await r.stock.issues() }) },
  { path: '/api/v3/data/stock/movements',
    handler: async (req, r) => ({
      data: await r.stock.movements({ limit: req.query.limit, product_id: intParam(req.query.product_id) }),
    }) },
  { path: '/api/v3/data/stock/picksheet',
    handler: async (req, r) => {
      const d = await r.stock.picksheet(req.query.date);
      return { data: d, meta: { date: d.date } };
    } },
  { path: '/api/v3/data/stock/restock-list',
    handler: async (req, r) => ({ data: await r.stock.restockList() }) },
  { path: '/api/v3/data/stock/skus',
    handler: async (req, r) => ({ data: await r.stock.skus() }) },
  // planner: dias de estoque + lead time + zona (out/low/plan/ok) + batch EMS
  { path: '/api/v3/data/stock/planner',
    handler: async (req, r, s) => ({ data: await s.stockPlanner.compute() }) },

  // ── CENTRO DE ESTOQUE — escrita (admin; porta única = StockService) ───
  // criar/editar bin (upsert por bin_code)
  { method: 'post', path: '/api/v3/data/stock/bins',
    handler: async (req, r, s) => {
      const b = body(req);
      if (!b.bin_code) throw new Error('bin_code obrigatório');
      const q = await s.stock.db.query(
        `INSERT INTO v3.stock_bins (bin_code, shelf_code, area, product_id, min_qty)
         VALUES ($1,$2,$3,$4,COALESCE($5,0))
         ON CONFLICT (bin_code) DO UPDATE SET
           shelf_code = COALESCE(EXCLUDED.shelf_code, v3.stock_bins.shelf_code),
           area = COALESCE(EXCLUDED.area, v3.stock_bins.area),
           product_id = COALESCE(EXCLUDED.product_id, v3.stock_bins.product_id),
           min_qty = COALESCE($5, v3.stock_bins.min_qty),
           active = true, updated_at = NOW()
         RETURNING *`,
        [String(b.bin_code).trim().toUpperCase(), b.shelf_code || null, b.area || null,
          b.product_id || null, b.min_qty != null ? b.min_qty : null]);
      return { data: q.rows[0] };
    } },
  { method: 'post', path: '/api/v3/data/stock/boxes',
    handler: async (req, r, s) => {
      const b = body(req);
      if (!b.box_number) throw new Error('box_number obrigatório');
      const q = await s.stock.db.query(
        `INSERT INTO v3.stock_boxes (box_number, product_id, area, created_by_person_id)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (box_number) DO UPDATE SET
           area = COALESCE(EXCLUDED.area, v3.stock_boxes.area), updated_at = NOW()
         RETURNING *`,
        [String(b.box_number).trim().toUpperCase(), b.product_id || null, b.area || null,
          b.by_person_id || null]);
      return { data: q.rows[0] };
    } },
  { method: 'post', path: '/api/v3/data/stock/store',
    handler: async (req, r, s) => {
      const b = body(req);
      return { data: await s.stock.storeIn({ ...b, source: b.source || 'admin', actor_type: 'admin' }) };
    } },
  { method: 'post', path: '/api/v3/data/stock/restock',
    handler: async (req, r, s) => {
      const b = body(req);
      return { data: await s.stock.restock({ ...b, source: b.source || 'admin', actor_type: 'admin' }) };
    } },
  { method: 'post', path: '/api/v3/data/stock/count',
    handler: async (req, r, s) => {
      const b = body(req);
      return { data: await s.stock.count({ ...b, source: b.source || 'admin', actor_type: 'admin' }) };
    } },
  { method: 'post', path: '/api/v3/data/stock/adjust',
    handler: async (req, r, s) => {
      const b = body(req);
      return { data: await s.stock.adjust({ ...b, actor_type: 'admin' }) };
    } },
  { method: 'post', path: '/api/v3/data/stock/issues/:id/resolve',
    handler: async (req, r, s) => {
      const b = body(req);
      const status = ['relabeled', 'restocked', 'discarded'].includes(b.status) ? b.status : null;
      if (!status) throw new Error('status inválido (relabeled|restocked|discarded)');
      const q = await s.stock.db.query(
        `UPDATE v3.stock_issues SET status = $2, resolved_by_person_id = $3, resolved_at = NOW()
          WHERE id = $1 AND status = 'separated' RETURNING *`,
        [intParam(req.params.id), status, b.by_person_id || null]);
      if (!q.rows[0]) throw new Error('issue não existe ou já resolvida');
      // volta pro estoque? entrada no bin de origem (auditada, idempotente por issue)
      if (status === 'restocked' && q.rows[0].bin_id) {
        await s.stock.storeIn({
          product_id: q.rows[0].product_id, qty: q.rows[0].qty, bin_id: q.rows[0].bin_id,
          person_id: b.by_person_id || null, source: 'issue_resolve',
          source_ref: 'issue:' + q.rows[0].id, actor_type: 'admin',
        });
      }
      return { data: q.rows[0] };
    } },
  // confirmar mapeamento SKU↔produto (a InventoryPage vira UI de confirmação)
  { method: 'post', path: '/api/v3/data/stock/skus/confirm',
    handler: async (req, r, s) => {
      const b = body(req);
      if (!b.product_id || !b.sku) throw new Error('product_id e sku obrigatórios');
      const q = await s.stock.db.query(
        `INSERT INTO v3.product_skus (product_id, sku, channel, units_per_pack, barcode, confirmed_by_person_id, confirmed_at)
         VALUES ($1,$2,COALESCE($3,'veeqo'),COALESCE($4,1),$5,$6,NOW())
         ON CONFLICT (channel, sku) DO UPDATE SET
           product_id = EXCLUDED.product_id,
           units_per_pack = EXCLUDED.units_per_pack,
           barcode = COALESCE(EXCLUDED.barcode, v3.product_skus.barcode),
           confirmed_by_person_id = EXCLUDED.confirmed_by_person_id, confirmed_at = NOW()
         RETURNING *`,
        [b.product_id, String(b.sku).trim(), b.channel || null,
          b.units_per_pack || null, b.barcode || null, b.by_person_id || null]);
      return { data: q.rows[0] };
    } },
  { method: 'post', path: '/api/v3/data/stock/thresholds',
    handler: async (req, r, s) => {
      const b = body(req);
      if (!b.product_id) throw new Error('product_id obrigatório');
      const q = await s.stock.db.query(
        `INSERT INTO v3.stock_thresholds (product_id, min_days, min_units, set_by_person_id)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (product_id) DO UPDATE SET
           min_days = EXCLUDED.min_days, min_units = EXCLUDED.min_units,
           set_by_person_id = EXCLUDED.set_by_person_id, updated_at = NOW()
         RETURNING *`,
        [b.product_id, b.min_days != null ? b.min_days : null,
          b.min_units != null ? b.min_units : null, b.by_person_id || null]);
      return { data: q.rows[0] };
    } },

  // ── PRODUCT SETUP (Bruno 08-03): nickname + cor da garrafa + SKUs por canal ──
  // Fundação do RODAPÉ de shipping label. Página mostra SKU · produto · título ·
  // nickname (editável) · cor (Black/White/Other). Um produto pode ter VÁRIOS SKUs
  // de canais diferentes (eBay/Amazon/Walmart/TikTok/Veeqo) — todos apontam pra ele.
  { method: 'get', path: '/api/v3/data/product-setup',
    handler: async (req, r, s) => {
      const rows = await s.stock.db.query(`
        SELECT p.id, p.canonical_name, p.nickname, p.bottle_color, p.active,
               COALESCE(json_agg(json_build_object(
                 'id', ps.id, 'sku', ps.sku, 'channel', ps.channel,
                 'units_per_pack', ps.units_per_pack, 'confirmed', ps.confirmed_at IS NOT NULL
               ) ORDER BY (ps.channel='veeqo') DESC, ps.sku)
               FILTER (WHERE ps.id IS NOT NULL), '[]') AS skus,
               cat.expiry_date, cat.on_hold, cat.servings_per_container, cat.content_desc
          FROM v3.products p
          LEFT JOIN v3.product_skus ps ON ps.product_id = p.id
          -- catálogo 08-04 (mig 066): validade impressa no rótulo + HOLD;
          -- multipacks agregam (validade mais próxima; hold se qualquer variante)
          LEFT JOIN LATERAL (
            SELECT MIN(c.expiry_date) AS expiry_date,
                   BOOL_OR(c.status = 'hold') AS on_hold,
                   MAX(c.servings_per_container) AS servings_per_container,
                   MAX(c.content_desc) AS content_desc
              FROM v3.product_catalog c WHERE c.product_id = p.id
          ) cat ON true
         GROUP BY p.id, cat.expiry_date, cat.on_hold, cat.servings_per_container, cat.content_desc
         ORDER BY p.active DESC, p.canonical_name`).then((q) => q.rows);
      // Estoque Veeqo por produto: soma o stock dos SKUs Veeqo do produto (SWR, não trava).
      const stockBySku = await veeqoStockBySku();
      const stockReady = _stockCache.bySku != null;
      for (const p of rows) {
        let total = null;
        for (const sk of (p.skus || [])) {
          const st = stockBySku[String(sk.sku).trim().toUpperCase()];
          sk.veeqo_stock = st == null ? null : st;
          if (sk.channel === 'veeqo' && st != null) total = (total || 0) + st;
        }
        p.veeqo_stock = total;         // null = sem SKU veeqo / ainda carregando
      }
      return { data: rows, meta: { stock_loading: !stockReady } };
    } },

  // VISÃO DE ESTOQUE unificada (Bruno 08-04): por produto = estoque Veeqo
  // (marketplace, vendável) + estoque físico do armazém (bins+caixas). Uma tela
  // pra "quanto temos". Veeqo via SWR (não trava). meta.stock_loading avisa a UI.
  { method: 'get', path: '/api/v3/data/stock-overview',
    handler: async (req, r, s) => {
      const prods = await s.stock.db.query(`
        SELECT p.id, p.canonical_name, p.nickname, p.bottle_color, p.active,
               COALESCE((SELECT SUM(b.qty) FROM v3.stock_bins b WHERE b.product_id=p.id AND b.active),0) AS bin_qty,
               COALESCE((SELECT SUM(x.qty) FROM v3.stock_boxes x WHERE x.product_id=p.id AND x.status='in_storage'),0) AS box_qty,
               COALESCE(array_agg(ps.sku) FILTER (WHERE ps.channel='veeqo'), '{}') AS veeqo_skus
          FROM v3.products p
          LEFT JOIN v3.product_skus ps ON ps.product_id = p.id
         GROUP BY p.id
         ORDER BY p.active DESC, p.canonical_name`).then((q) => q.rows);
      const stockBySku = await veeqoStockBySku();
      const stockReady = _stockCache.bySku != null;
      const out = prods.map((p) => {
        let veeqo = null;
        for (const sku of (p.veeqo_skus || [])) {
          const st = stockBySku[String(sku).trim().toUpperCase()];
          if (st != null) veeqo = (veeqo || 0) + st;
        }
        // Bins + Caixas SOMAM no total do ARMAZÉM. Veeqo é SEPARADO (o que está
        // listado pra venda) — NÃO entra no total (Bruno 08-04).
        const warehouse = Number(p.bin_qty || 0) + Number(p.box_qty || 0);
        return {
          id: p.id, product: p.canonical_name, nickname: p.nickname, bottle_color: p.bottle_color, active: p.active,
          bin_qty: Number(p.bin_qty || 0), box_qty: Number(p.box_qty || 0),
          warehouse_stock: warehouse,        // = bins + caixas
          total: warehouse,                  // total do armazém (Veeqo NÃO soma aqui)
          veeqo_stock: veeqo,                // separado, mostrado DEPOIS do total
          veeqo_skus: p.veeqo_skus || [],    // pra o modal saber qual SKU escrever
          has_veeqo_sku: (p.veeqo_skus || []).length > 0,
        };
      });
      return { data: out, meta: { stock_loading: !stockReady } };
    } },

  // ESCREVER estoque no Veeqo (Bruno 08-04). GUARDAS contra SKU/produto errado:
  //  • o SKU tem que ser um SKU VEEQO REALMENTE mapeado a esse product_id no nosso
  //    banco (senão 400 — não deixa jogar quantidade num item errado);
  //  • mode 'set' (contagem, substitui) ou 'add' (reabastece, soma);
  //  • sempre lê o atual antes, escreve só no HealthFare Warehouse, audita before/after,
  //    e invalida o cache de estoque pra a UI refletir na hora.
  { method: 'post', path: '/api/v3/data/stock/veeqo-set',
    handler: async (req, r, s) => {
      const b = body(req);
      const pid = intParam(b.product_id);
      const sku = String(b.sku || '').trim();
      const mode = b.mode === 'add' ? 'add' : 'set';
      const qty = Number(b.qty);
      if (!pid || !sku) throw new Error('product_id e sku obrigatórios');
      if (!Number.isFinite(qty) || qty < 0) throw new Error('qty inválido');
      // GUARDA: o SKU precisa estar mapeado a ESTE produto, no canal veeqo.
      const chk = await s.stock.db.query(
        `SELECT 1 FROM v3.product_skus WHERE product_id=$1 AND channel='veeqo' AND UPPER(sku)=UPPER($2) LIMIT 1`,
        [pid, sku]);
      if (!chk.rowCount) throw new Error('SKU não pertence a esse produto (canal veeqo) — recusado por segurança');
      const { veeqo } = require('../services/veeqo-api');
      const res = await veeqo.setStock({ sku, mode, qty });
      // auditoria: quem/quando/o quê (write na Veeqo é sério)
      try {
        await s.stock.db.query(
          `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
           VALUES ('admin', $1, 'veeqo_stock_set', 'product', $2, $3::jsonb)`,
          [b.by_person_id || null, pid, JSON.stringify({ sku, mode, qty, before: res.before, after: res.after, warehouse_id: res.warehouse_id })]);
      } catch (_) { /* audit best-effort */ }
      // invalida cache de estoque pra o próximo /stock-overview já ver o novo valor
      _stockCache.at = 0; _stockCache.bySku = null;
      return { data: res };
    } },

  // PICKLIST (Bruno 08-04): pedidos PENDENTES agrupados POR PRODUTO, ordem de
  // caminhada (por local), single primeiro / multi-garrafa no fim, com nickname +
  // local (shelf·bin·pallet) + aviso multi-bottle por produto. Formato 4×6 na página.
  { method: 'get', path: '/api/v3/data/picklist',
    handler: async (req, r, s) => {
      const db = s.stock.db;
      const namesByNum = await veeqoNamesByOrder();   // order_number → nome do cliente (SWR)
      const stockBySku = await veeqoStockBySku();     // sku → estoque Veeqo (SWR)
      // 1 linha por PEDIDO (pending), com nickname + melhor bin/local do produto.
      const rows = (await db.query(`
        WITH best_bin AS (
          SELECT DISTINCT ON (product_id) product_id, bin_code, shelf_code, area, qty
            FROM v3.stock_bins WHERE active AND product_id IS NOT NULL
           ORDER BY product_id, qty DESC),
        best_box AS (
          SELECT DISTINCT ON (product_id) product_id, box_number, area
            FROM v3.stock_boxes WHERE status='in_storage' AND product_id IS NOT NULL
           ORDER BY product_id, qty DESC)
        SELECT l.order_number, l.channel, l.sku, l.qty,
               ps.product_id,
               COALESCE(p.nickname, p.canonical_name, l.sku) AS nickname,
               p.canonical_name AS product,
               p.bottle_color,
               (SELECT c.content_desc FROM v3.product_catalog c
                 WHERE c.product_id = p.id AND c.content_desc IS NOT NULL
                 ORDER BY c.id LIMIT 1) AS content_desc,
               COALESCE(ps.units_per_pack,1) AS units_per_pack,
               (l.qty * COALESCE(ps.units_per_pack,1)) AS bottles,
               bb.bin_code, bb.shelf_code, bb.area AS bin_area,
               bx.box_number AS pallet_box, bx.area AS pallet_area,
               (l.raw->>'title') AS title
          FROM v3.pnp_order_lines l
          LEFT JOIN v3.product_skus ps ON ps.channel=l.source AND UPPER(ps.sku)=UPPER(l.sku)
          LEFT JOIN v3.products p ON p.id=ps.product_id
          LEFT JOIN best_bin bb ON bb.product_id = ps.product_id
          LEFT JOIN best_box bx ON bx.product_id = ps.product_id
         WHERE l.status='pending'
         ORDER BY l.order_number`)).rows;

      // agrupa por produto (chave = product_id ou sku quando não mapeado)
      const groups = new Map();
      for (const o of rows) {
        const key = o.product_id != null ? 'p:' + o.product_id : 'sku:' + (o.sku || '?');
        if (!groups.has(key)) {
          groups.set(key, {
            key, product: o.product, nickname: o.nickname || o.product || o.sku || '(sem nome)', sku: o.sku, bottle_color: o.bottle_color,
            content_desc: o.content_desc, product_id: o.product_id,
            veeqo_stock: (stockBySku[String(o.sku).trim().toUpperCase()] != null
              ? Number(stockBySku[String(o.sku).trim().toUpperCase()]) : null),
            location: { shelf: o.shelf_code || null, bin: o.bin_code || null, pallet: o.pallet_box || null,
              area: o.bin_area || o.pallet_area || null },
            title: o.title, mapped: o.product_id != null, orders: [],
          });
        }
        groups.get(key).orders.push({
          order_number: o.order_number, channel: o.channel, sku: o.sku, qty: o.qty,
          bottles: Number(o.bottles) || o.qty, multi: (Number(o.bottles) || o.qty) > 1,
          picker: null, packer: null,
          patient: namesByNum[String(o.order_number)] || null,   // nome do cliente (Veeqo)
        });
      }

      // por grupo: single primeiro, multi no fim; e resumo multi-bottle
      const out = [];
      for (const g of groups.values()) {
        g.orders.sort((a, b) => (a.multi === b.multi ? 0 : a.multi ? 1 : -1) || a.order_number.localeCompare(b.order_number));
        const multis = g.orders.filter((o) => o.multi);
        const byBottles = {};
        for (const m of multis) byBottles[m.bottles] = (byBottles[m.bottles] || 0) + 1;
        g.multi_summary = Object.entries(byBottles).sort((a, b) => a[0] - b[0])
          .map(([b, n]) => ({ bottles: Number(b), orders: n }));
        g.single_count = g.orders.length - multis.length;
        g.multi_count = multis.length;
        g.order_count = g.orders.length;
        out.push(g);
      }
      // ordem de caminhada: por local (shelf, bin), mapeados primeiro, sem local no fim
      out.sort((a, b) => {
        const la = (a.location.shelf || '') + (a.location.bin || '');
        const lb = (b.location.shelf || '') + (b.location.bin || '');
        if (!!la !== !!lb) return la ? -1 : 1;
        return la.localeCompare(lb) || (a.product || a.sku || '').localeCompare(b.product || b.sku || '');
      });
      const totalOrders = rows.length;
      const totalBottles = rows.reduce((n, o) => n + (Number(o.bottles) || o.qty), 0);

      // ENVELOPES por tamanho (Bruno 08-06): 1 envelope por ORDEM (pacote), não por
      // produto. Junta as garrafas da ordem, olha a cor e escolhe o MENOR envelope
      // que cabe (regra do saco perfeito, v3.bottle_size_tiers).
      const envelopes = {}; let envUnknown = 0, envMixed = 0;
      try {
        const tiers = (await db.query(
          `SELECT bottle_color, min_bottles, max_bottles, package_size
             FROM v3.bottle_size_tiers ORDER BY bottle_color, min_bottles`)).rows;
        const byOrder = new Map();
        for (const o of rows) {
          const k = String(o.order_number);
          if (!byOrder.has(k)) byOrder.set(k, { bottles: 0, colors: new Set() });
          const e = byOrder.get(k);
          e.bottles += Number(o.bottles) || Number(o.qty) || 0;
          if (o.bottle_color) e.colors.add(String(o.bottle_color).toLowerCase());
        }
        for (const e of byOrder.values()) {
          if (e.colors.size > 1) { envMixed++; continue; }          // cores mistas: regra a definir
          const color = e.colors.size === 1 ? [...e.colors][0] : null;
          if (!color) { envUnknown++; continue; }                   // produto sem cor cadastrada
          const t = tiers.find((x) => x.bottle_color === color
            && e.bottles >= x.min_bottles && (x.max_bottles == null || e.bottles <= x.max_bottles));
          if (!t) { envUnknown++; continue; }
          envelopes[t.package_size] = (envelopes[t.package_size] || 0) + 1;
        }
      } catch (e) { console.error('[picklist] envelopes:', e.message); }

      return { data: { groups: out, total_orders: totalOrders, total_bottles: totalBottles, product_count: out.length,
        envelopes, envelopes_unknown: envUnknown, envelopes_mixed: envMixed,
        names_loading: _nameCache.byNum == null } };
    } },

  // ── CONFIGURAÇÕES DE INVENTÁRIO (Bruno 08-07) ────────────────────────────
  // Duas seções: (A) ordens & impressão (envelopes, mistura, suprimentos,
  // perguntas pendentes) e (B) inventário & estoque (bins, limiares) — B ainda
  // não foi construída de verdade, a página mostra o que já existe.
  { method: 'get', path: '/api/v3/data/inventory-settings',
    handler: async (req, r, s) => {
      const db = s.stock.db;
      const one = async (sql) => { try { return (await db.query(sql)).rows; } catch (e) { return []; } };
      return { data: {
        tiers: await one(`SELECT id, bottle_color, min_bottles, max_bottles, package_size, is_box
                            FROM v3.bottle_size_tiers ORDER BY bottle_color, min_bottles`),
        mix: await one(`SELECT id, package_size, black_qty, white_max, confirmed, note
                          FROM v3.envelope_mix ORDER BY package_size, black_qty`),
        supplies: await one(`SELECT id, name, kind, qty, min_qty, active FROM v3.supply_items ORDER BY name`),
        size_supply: await one(`SELECT m.package_size, m.supply_item_id, m.qty_per, i.name
                                  FROM v3.package_size_supply m JOIN v3.supply_items i ON i.id = m.supply_item_id
                                 ORDER BY m.package_size`),
        questions: await one(`SELECT id, key, question, context, active, asked_count, answer, answered_at
                                FROM v3.packing_questions ORDER BY active DESC, id`),
        bins: await one(`SELECT COUNT(*)::int AS n FROM v3.stock_bins WHERE active`),
        thresholds: await one(`SELECT COUNT(*)::int AS n FROM v3.stock_thresholds`),
      } };
    } },

  // editar faixa de tamanho por cor
  { method: 'post', path: '/api/v3/data/inventory-settings/tier',
    handler: async (req, r, s) => {
      const b = body(req); const db = s.stock.db;
      if (b.id) {
        const q = await db.query(
          `UPDATE v3.bottle_size_tiers SET
             bottle_color = COALESCE($2, bottle_color), min_bottles = COALESCE($3, min_bottles),
             max_bottles = $4, package_size = COALESCE($5, package_size), is_box = COALESCE($6, is_box)
           WHERE id = $1 RETURNING *`,
          [intParam(b.id), b.bottle_color || null, b.min_bottles != null ? intParam(b.min_bottles) : null,
            b.max_bottles === '' || b.max_bottles == null ? null : intParam(b.max_bottles),
            b.package_size || null, b.is_box != null ? b.is_box : null]);
        if (!q.rows[0]) throw new Error('faixa não existe');
        return { data: q.rows[0] };
      }
      if (!b.bottle_color || b.min_bottles == null || !b.package_size) throw new Error('bottle_color, min_bottles e package_size obrigatórios');
      const q = await db.query(
        `INSERT INTO v3.bottle_size_tiers (bottle_color, min_bottles, max_bottles, package_size, is_box)
         VALUES ($1,$2,$3,$4,COALESCE($5,false)) RETURNING *`,
        [b.bottle_color, intParam(b.min_bottles),
          b.max_bottles === '' || b.max_bottles == null ? null : intParam(b.max_bottles),
          b.package_size, b.is_box != null ? b.is_box : null]);
      return { data: q.rows[0] };
    } },

  // editar combinação de mistura (preta + branca) de um envelope
  { method: 'post', path: '/api/v3/data/inventory-settings/mix',
    handler: async (req, r, s) => {
      const b = body(req); const db = s.stock.db;
      if (!b.package_size || b.black_qty == null || b.white_max == null) throw new Error('package_size, black_qty e white_max obrigatórios');
      const q = await db.query(
        `INSERT INTO v3.envelope_mix (package_size, black_qty, white_max, confirmed, note)
         VALUES ($1,$2,$3,COALESCE($4,true),$5)
         ON CONFLICT (package_size, black_qty) DO UPDATE SET
           white_max = EXCLUDED.white_max, confirmed = EXCLUDED.confirmed,
           note = COALESCE(EXCLUDED.note, v3.envelope_mix.note), updated_at = NOW()
         RETURNING *`,
        [String(b.package_size).trim(), intParam(b.black_qty), intParam(b.white_max),
          b.confirmed != null ? b.confirmed : null, b.note || null]);
      return { data: q.rows[0] };
    } },

  // ligar/desligar uma pergunta de embalagem (ex.: confirmou o 9x12 → desliga)
  { method: 'post', path: '/api/v3/data/inventory-settings/question/:id',
    handler: async (req, r, s) => {
      const b = body(req);
      const q = await s.stock.db.query(
        `UPDATE v3.packing_questions SET active = COALESCE($2, active), answer = COALESCE($3, answer),
           answered_at = CASE WHEN $3 IS NOT NULL THEN NOW() ELSE answered_at END
         WHERE id = $1 RETURNING *`,
        [intParam(req.params.id), b.active != null ? b.active : null, b.answer || null]);
      if (!q.rows[0]) throw new Error('pergunta não existe');
      return { data: q.rows[0] };
    } },

  // FALTA DE ESTOQUE pro P&P de hoje (Bruno 08-06): o que está sem estoque /
  // baixo na picklist, cruzado com o EMS (cápsulas prontas? na linha? já passou?).
  { method: 'get', path: '/api/v3/data/stock-gaps',
    handler: async (req, r, s) => {
      const pl = await ENDPOINTS.find((e) => e.path === '/api/v3/data/picklist').handler(req, r, s);
      const { StockGapService } = require('../services/stock-gap-service');
      const { ems } = require('../services/ems-api');
      const svc = new StockGapService({ db: s.stock.db, ems });
      return { data: await svc.analyze(pl.data) };
    } },

  // faixas de tamanho de pacote (pra a página mostrar/editar a regra por cor)
  { method: 'get', path: '/api/v3/data/product-setup/tiers',
    handler: async (req, r, s) => ({ data: await s.stock.db.query(
      `SELECT id, bottle_color, min_bottles, max_bottles, package_size, is_box
         FROM v3.bottle_size_tiers ORDER BY bottle_color NULLS FIRST, min_bottles`).then((q) => q.rows) }) },

  // Import de pedidos do TikTok — CSV do Seller Center (Bruno 08-04: sem
  // account manager → sem API por ora). TODA a lógica TikTok vive ENCAPSULADA
  // em services/tiktok-source.js (contrato: linhas normalizadas → ingestLines →
  // pnp_order_lines). Quando a API sair: worker chama o MESMO ingestLines e
  // este upload passa a recusar (TIKTOK_SOURCE=api) — nada downstream muda.
  { method: 'post', path: '/api/v3/data/stock/tiktok-orders-csv',
    handler: async (req, r, s) => {
      const tiktok = require('../services/tiktok-source');
      if (tiktok.mode() === 'api') {
        throw new Error('TIKTOK_SOURCE=api — pedidos TikTok já vêm da API; upload de CSV desativado pra evitar duplo-feed');
      }
      const parsed = tiktok.parseSellerCenterCsv(body(req).csv);
      const out = await tiktok.ingestLines(s.stock.db, parsed.lines);
      return { data: { ...out, lines: parsed.lines.length, delim: parsed.delim } };
    } },

  // TODOS os SKUs conhecidos de um canal (Bruno 08-03: dropdown pesquisável no
  // "+ SKU" — escolher da lista em vez de digitar às cegas). Fontes por canal:
  //   veeqo → catálogo vivo (listSellables, cache 10min);
  //   amazon/ebay/walmart/tiktok/shopify → SKUs já VISTOS em pedidos daquele
  //   canal (v3.pnp_order_lines) + os já mapeados;
  //   other → só os já mapeados. Cada item diz se já está ligado a um produto.
  { method: 'get', path: '/api/v3/data/product-setup/channel-skus',
    handler: async (req, r, s) => {
      const ch = String(req.query.channel || '').toLowerCase();
      if (!['veeqo', 'amazon', 'ebay', 'walmart', 'tiktok', 'shopify', 'other'].includes(ch)) {
        throw new Error('channel inválido');
      }
      const attached = (await s.stock.db.query(
        `SELECT ps.sku, ps.product_id, p.canonical_name
           FROM v3.product_skus ps JOIN v3.products p ON p.id = ps.product_id
          WHERE ps.channel = $1`, [ch])).rows;
      const attMap = new Map(attached.map((a) => [a.sku, a]));
      let items = [];
      if (ch === 'veeqo') {
        if (!veeqo.configured()) return { data: { channel: ch, items: [], configured: false } };
        const now = Date.now();
        if (!_channelSkusVeeqo.data || now - _channelSkusVeeqo.at > 10 * 60 * 1000) {
          _channelSkusVeeqo = { at: now, data: await veeqo.listSellables() };
        }
        items = _channelSkusVeeqo.data.map((x) => ({ sku: x.sku, title: x.title || x.product_title || null }));
      } else if (ch !== 'other') {
        items = (await s.stock.db.query(
          `SELECT sku, MAX(raw->>'title') AS title
             FROM v3.pnp_order_lines
            WHERE sku IS NOT NULL AND channel ILIKE $1
            GROUP BY sku`, ['%' + ch + '%'])).rows;
      }
      const seen = new Set(items.map((i) => i.sku));
      for (const a of attached) if (!seen.has(a.sku)) items.push({ sku: a.sku, title: null });
      items = items
        .map((i) => ({
          ...i,
          attached_product_id: attMap.has(i.sku) ? attMap.get(i.sku).product_id : null,
          attached_product: attMap.has(i.sku) ? attMap.get(i.sku).canonical_name : null,
        }))
        .sort((a, b) => a.sku.localeCompare(b.sku));
      return { data: { channel: ch, items } };
    } },

  // editar nickname + cor de um produto (admin)
  { method: 'post', path: '/api/v3/data/product-setup/:id',
    handler: async (req, r, s) => {
      const b = body(req);
      const id = intParam(req.params.id);
      // só atualiza os campos enviados (nickname / bottle_color); string vazia → NULL
      const nick = b.nickname !== undefined ? (String(b.nickname).trim() || null) : undefined;
      const color = b.bottle_color !== undefined ? (String(b.bottle_color).trim() || null) : undefined;
      if (nick === undefined && color === undefined) throw new Error('nada pra atualizar (nickname ou bottle_color)');
      const sets = [], vals = [id]; let i = 2;
      if (nick !== undefined) { sets.push(`nickname = $${i++}`); vals.push(nick); }
      if (color !== undefined) { sets.push(`bottle_color = $${i++}`); vals.push(color); }
      const q = await s.stock.db.query(
        `UPDATE v3.products SET ${sets.join(', ')} WHERE id = $1 RETURNING id, canonical_name, nickname, bottle_color`, vals);
      if (!q.rows[0]) throw new Error('produto não existe');
      return { data: q.rows[0] };
    } },

  // ligar um SKU (de qualquer canal) a um produto — reusa product_skus (multi-canal)
  { method: 'post', path: '/api/v3/data/product-setup/:id/sku',
    handler: async (req, r, s) => {
      const b = body(req);
      const id = intParam(req.params.id);
      if (!b.sku) throw new Error('sku obrigatório');
      const ch = ['veeqo', 'tiktok', 'shopify', 'ebay', 'amazon', 'walmart', 'other']
        .includes(String(b.channel || '').toLowerCase()) ? String(b.channel).toLowerCase() : 'other';
      const q = await s.stock.db.query(
        `INSERT INTO v3.product_skus (product_id, sku, channel, units_per_pack, confirmed_by_person_id, confirmed_at)
         VALUES ($1,$2,$3,COALESCE($4,1),$5,NOW())
         ON CONFLICT (channel, sku) DO UPDATE SET
           product_id = EXCLUDED.product_id,
           units_per_pack = EXCLUDED.units_per_pack,
           confirmed_by_person_id = EXCLUDED.confirmed_by_person_id, confirmed_at = NOW()
         RETURNING id, product_id, sku, channel, units_per_pack`,
        [id, String(b.sku).trim(), ch, b.units_per_pack || null, b.by_person_id || null]);
      return { data: q.rows[0] };
    } },

  // desligar um SKU de um produto (remove o mapeamento)
  { method: 'post', path: '/api/v3/data/product-setup/sku/:skuId/detach',
    handler: async (req, r, s) => {
      const q = await s.stock.db.query(
        `DELETE FROM v3.product_skus WHERE id = $1 RETURNING id`, [intParam(req.params.skuId)]);
      if (!q.rows[0]) throw new Error('SKU não existe');
      return { data: { removed: q.rows[0].id } };
    } },

  // ── SUPPLIES (Bruno 08-03): envelopes/caixas — inventário próprio ────────
  // Cada tamanho de pacote (A/Y/B/BX) consome 1 supply por label impressa.
  { method: 'get', path: '/api/v3/data/supplies',
    handler: async (req, r, s) => {
      const items = await s.supply.db.query(`
        SELECT i.id, i.name, i.kind, i.qty, i.min_qty, i.active, i.note,
               COALESCE(json_agg(m.package_size ORDER BY m.package_size)
                 FILTER (WHERE m.package_size IS NOT NULL), '[]') AS sizes,
               (i.min_qty > 0 AND i.qty <= i.min_qty) AS low
          FROM v3.supply_items i
          LEFT JOIN v3.package_size_supply m ON m.supply_item_id = i.id
         GROUP BY i.id
         ORDER BY i.active DESC, i.name`);
      const map = await s.supply.db.query(`
        SELECT m.package_size, m.supply_item_id, m.qty_per, i.name
          FROM v3.package_size_supply m JOIN v3.supply_items i ON i.id = m.supply_item_id
         ORDER BY m.package_size`);
      // tamanhos possíveis (distintos de bottle_size_tiers) pra montar o mapa na UI
      const tiers = await s.supply.db.query(
        `SELECT DISTINCT package_size, bool_or(is_box) AS is_box
           FROM v3.bottle_size_tiers GROUP BY package_size ORDER BY package_size`);
      return { data: { items: items.rows, mapping: map.rows, tiers: tiers.rows } };
    } },

  // criar/editar um supply item (nome/kind/min_qty) — admin
  { method: 'post', path: '/api/v3/data/supplies/item',
    handler: async (req, r, s) => {
      const b = body(req);
      if (b.id) {
        const q = await s.supply.db.query(
          `UPDATE v3.supply_items SET
             name = COALESCE($2,name), kind = COALESCE($3,kind),
             min_qty = COALESCE($4,min_qty), note = COALESCE($5,note),
             active = COALESCE($6,active), updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [intParam(b.id), b.name || null, b.kind || null,
            b.min_qty != null ? b.min_qty : null, b.note || null,
            b.active != null ? b.active : null]);
        if (!q.rows[0]) throw new Error('supply não existe');
        return { data: q.rows[0] };
      }
      if (!b.name) throw new Error('name obrigatório');
      const q = await s.supply.db.query(
        `INSERT INTO v3.supply_items (name, kind, min_qty, note)
         VALUES ($1, COALESCE($2,'envelope'), COALESCE($3,0), $4) RETURNING *`,
        [String(b.name).trim(), b.kind || null, b.min_qty != null ? b.min_qty : null, b.note || null]);
      return { data: q.rows[0] };
    } },

  // reabastecer / ajustar / contar um supply (porta única = SupplyService)
  { method: 'post', path: '/api/v3/data/supplies/:id/change',
    handler: async (req, r, s) => {
      const b = body(req);
      const kind = ['restock', 'adjust', 'count'].includes(b.kind) ? b.kind : null;
      if (!kind) throw new Error('kind inválido (restock|adjust|count)');
      if (b.qty == null) throw new Error('qty obrigatório');
      return { data: await s.supply.change({
        supply_item_id: intParam(req.params.id), kind, qty: Number(b.qty),
        person_id: b.by_person_id || null, source: 'admin', note: b.note || null }) };
    } },

  // mapear um TAMANHO de pacote → supply (qual envelope cada tamanho usa)
  { method: 'post', path: '/api/v3/data/supplies/mapping',
    handler: async (req, r, s) => {
      const b = body(req);
      if (!b.package_size || !b.supply_item_id) throw new Error('package_size e supply_item_id obrigatórios');
      const q = await s.supply.db.query(
        `INSERT INTO v3.package_size_supply (package_size, supply_item_id, qty_per)
         VALUES ($1,$2,COALESCE($3,1))
         ON CONFLICT (package_size) DO UPDATE SET
           supply_item_id = EXCLUDED.supply_item_id,
           qty_per = EXCLUDED.qty_per, updated_at = NOW()
         RETURNING *`,
        [String(b.package_size).trim().toUpperCase(), intParam(b.supply_item_id), b.qty_per || null]);
      return { data: q.rows[0] };
    } },

  // ── RBAC: usuários, roles, funções (página Admin → Usuários) ────────────────
  // Só quem tem a função manage_users deveria ver isso (gate no front + aqui).
  { method: 'get', path: '/api/v3/data/rbac',
    handler: async (req, r, s) => {
      if (req.login && !require('./auth').hasFunction(req.login, 'manage_users')) throw new Error('sem permissão (manage_users)');
      const db = s.supply.db;
      const roles = await db.query(`
        SELECT ro.id, ro.key, ro.name, ro.rank, ro.active,
               COALESCE(array_agg(rf.function_key) FILTER (WHERE rf.function_key IS NOT NULL), '{}') AS functions
          FROM v3.app_roles ro LEFT JOIN v3.role_functions rf ON rf.role_id = ro.id
         GROUP BY ro.id ORDER BY ro.rank DESC`);
      const fns = await db.query(`SELECT key, label, category FROM v3.app_functions ORDER BY category, key`);
      const logins = await db.query(`
        SELECT l.id, l.name, l.active, ro.key AS role, ro.name AS role_name
          FROM v3.app_logins l JOIN v3.app_roles ro ON ro.id = l.role_id
         ORDER BY ro.rank DESC, l.name`);
      return { data: { roles: roles.rows, functions: fns.rows, logins: logins.rows } };
    } },

  // ligar/desligar uma função de um role (admin edita o acesso do manager etc.)
  { method: 'post', path: '/api/v3/data/rbac/role-function',
    handler: async (req, r, s) => {
      if (req.login && !require('./auth').hasFunction(req.login, 'manage_users')) throw new Error('sem permissão (manage_users)');
      const b = body(req);
      if (!b.role_id || !b.function_key) throw new Error('role_id e function_key obrigatórios');
      const db = s.supply.db;
      if (b.enabled) {
        await db.query(`INSERT INTO v3.role_functions (role_id, function_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [intParam(b.role_id), String(b.function_key)]);
      } else {
        await db.query(`DELETE FROM v3.role_functions WHERE role_id=$1 AND function_key=$2`,
          [intParam(b.role_id), String(b.function_key)]);
      }
      return { data: { role_id: intParam(b.role_id), function_key: b.function_key, enabled: !!b.enabled } };
    } },

  // criar/editar um login (nome, role, PIN, ativo) — admin only
  { method: 'post', path: '/api/v3/data/rbac/login',
    handler: async (req, r, s) => {
      if (req.login && !require('./auth').hasFunction(req.login, 'manage_users')) throw new Error('sem permissão (manage_users)');
      const b = body(req);
      const db = s.supply.db;
      if (b.id) {
        const q = await db.query(
          `UPDATE v3.app_logins SET
             name = COALESCE($2,name),
             role_id = COALESCE($3,role_id),
             pin = COALESCE($4,pin),
             active = COALESCE($5,active), updated_at = NOW()
           WHERE id = $1 RETURNING id, name, role_id, active`,
          [intParam(b.id), b.name || null, b.role_id ? intParam(b.role_id) : null,
            b.pin ? String(b.pin).trim() : null, b.active != null ? b.active : null]);
        if (!q.rows[0]) throw new Error('login não existe');
        return { data: q.rows[0] };
      }
      if (!b.name || !b.role_id || !b.pin) throw new Error('name, role_id e pin obrigatórios');
      const q = await db.query(
        `INSERT INTO v3.app_logins (name, role_id, pin) VALUES ($1,$2,$3) RETURNING id, name, role_id, active`,
        [String(b.name).trim(), intParam(b.role_id), String(b.pin).trim()]);
      return { data: q.rows[0] };
    } },

  // ── ROADMAP / planning board (Bruno 08-05): board do sistema inteiro, sincronizado.
  //    Bruno comenta + desenha; Claude marca feito. Fonte da verdade = banco.
  { method: 'get', path: '/api/v3/data/roadmap',
    handler: async (req, r, s) => {
      const db = s.supply.db;
      const areas = (await db.query(`SELECT id, key, name, color, sort FROM v3.roadmap_areas ORDER BY sort, name`)).rows;
      const cards = (await db.query(`
        SELECT c.id, c.area_id, c.title, c.detail, c.summary, c.status, c.priority, c.blocks_on,
               c.sort, c.done_at, c.created_by, c.updated_at,
               COALESCE((SELECT COUNT(*) FROM v3.roadmap_comments cm WHERE cm.card_id=c.id),0) AS comment_count
          FROM v3.roadmap_cards c WHERE NOT c.archived
         ORDER BY c.area_id, c.sort, c.id`)).rows;
      const sketches = (await db.query(`
        SELECT id, title, area_id, card_id, created_by, created_at, updated_at
          FROM v3.roadmap_sketches ORDER BY updated_at DESC`)).rows;   // sem data_url (leve)
      return { data: { areas, cards, sketches } };
    } },

  // comentários de um card
  { method: 'get', path: '/api/v3/data/roadmap/card/:id/comments',
    handler: async (req, r, s) => ({ data: (await s.supply.db.query(
      `SELECT id, author, body, created_at FROM v3.roadmap_comments WHERE card_id=$1 ORDER BY created_at`,
      [intParam(req.params.id)])).rows }) },

  // criar/editar card (Bruno pode adicionar os dele)
  { method: 'post', path: '/api/v3/data/roadmap/card',
    handler: async (req, r, s) => {
      const b = body(req); const db = s.supply.db;
      if (b.id) {
        const done = b.status === 'done';
        const q = await db.query(
          `UPDATE v3.roadmap_cards SET
             title=COALESCE($2,title), detail=COALESCE($3,detail),
             status=COALESCE($4,status), priority=COALESCE($5,priority),
             blocks_on=COALESCE($6,blocks_on), sort=COALESCE($7,sort),
             archived=COALESCE($8,archived), summary=COALESCE($9,summary),
             done_at=CASE WHEN $4='done' THEN COALESCE(done_at,NOW()) WHEN $4 IS NOT NULL THEN NULL ELSE done_at END,
             updated_at=NOW()
           WHERE id=$1 RETURNING *`,
          [intParam(b.id), b.title||null, b.detail!==undefined?b.detail:null,
            b.status||null, b.priority||null, b.blocks_on!==undefined?b.blocks_on:null,
            b.sort!=null?b.sort:null, b.archived!=null?b.archived:null,
            b.summary!==undefined?b.summary:null]);
        if (!q.rows[0]) throw new Error('card não existe');
        return { data: q.rows[0] };
      }
      if (!b.area_id || !b.title) throw new Error('area_id e title obrigatórios');
      const q = await db.query(
        `INSERT INTO v3.roadmap_cards (area_id,title,detail,status,priority,created_by)
         VALUES ($1,$2,$3,COALESCE($4,'todo'),COALESCE($5,'normal'),COALESCE($6,'bruno')) RETURNING *`,
        [intParam(b.area_id), String(b.title).trim(), b.detail||null, b.status||null, b.priority||null, b.created_by||null]);
      return { data: q.rows[0] };
    } },

  // adicionar comentário
  { method: 'post', path: '/api/v3/data/roadmap/card/:id/comment',
    handler: async (req, r, s) => {
      const b = body(req);
      if (!b.body || !String(b.body).trim()) throw new Error('body obrigatório');
      const q = await s.supply.db.query(
        `INSERT INTO v3.roadmap_comments (card_id, author, body)
         VALUES ($1, COALESCE($2,'bruno'), $3) RETURNING id, author, body, created_at`,
        [intParam(req.params.id), b.author||null, String(b.body).trim()]);
      return { data: q.rows[0] };
    } },

  // salvar sketch (PNG data-url do canvas)
  { method: 'post', path: '/api/v3/data/roadmap/sketch',
    handler: async (req, r, s) => {
      const b = body(req); const db = s.supply.db;
      if (!b.data_url || !/^data:image\/png/.test(String(b.data_url))) throw new Error('data_url (image/png) obrigatório');
      if (b.id) {
        const q = await db.query(`UPDATE v3.roadmap_sketches SET data_url=$2, title=COALESCE($3,title), updated_at=NOW() WHERE id=$1 RETURNING id, title, updated_at`,
          [intParam(b.id), b.data_url, b.title||null]);
        if (!q.rows[0]) throw new Error('sketch não existe');
        return { data: q.rows[0] };
      }
      const q = await db.query(
        `INSERT INTO v3.roadmap_sketches (title, area_id, card_id, data_url, created_by)
         VALUES ($1,$2,$3,$4,COALESCE($5,'bruno')) RETURNING id, title, updated_at`,
        [b.title||null, b.area_id?intParam(b.area_id):null, b.card_id?intParam(b.card_id):null, b.data_url, b.created_by||null]);
      return { data: q.rows[0] };
    } },

  // ler 1 sketch (com data_url)
  { method: 'get', path: '/api/v3/data/roadmap/sketch/:id',
    handler: async (req, r, s) => {
      const q = await s.supply.db.query(`SELECT id, title, area_id, card_id, data_url, created_at, updated_at FROM v3.roadmap_sketches WHERE id=$1`, [intParam(req.params.id)]);
      if (!q.rows[0]) throw new Error('sketch não existe');
      return { data: q.rows[0] };
    } },

  // apagar sketch
  { method: 'post', path: '/api/v3/data/roadmap/sketch/:id/delete',
    handler: async (req, r, s) => {
      const q = await s.supply.db.query(`DELETE FROM v3.roadmap_sketches WHERE id=$1 RETURNING id`, [intParam(req.params.id)]);
      if (!q.rows[0]) throw new Error('sketch não existe');
      return { data: { removed: q.rows[0].id } };
    } },
];

/**
 * Snapshot completo do dia, JSON puro. AUTH POR TOKEN (query ?token=...)
 * — independente do PIN. Pensado pro Claude (claude.ai) auditar o V3
 * via fetch read-only.
 *
 * Quando V3_SNAPSHOT_TOKEN não está setada no env → 503 (feature desligada).
 * Token inválido → 401. Match → JSON com timeline + cards + open events +
 * uncertain cases + worker health.
 */
async function buildSnapshot(dateInput, repos) {
  const date = resolveDate(dateInput);
  const [timeline, production, pp, support, goals, counts, deadlines, metrics, health, uncertain, autoClosed, fnsku]
    = await Promise.all([
      repos.timeline.eventsByDay(date),
      repos.flowViews.productionByDay(date),
      repos.flowViews.pnpByDay(date),
      repos.flowViews.supportByDay(date),
      repos.goals.goalsByDay(date),
      repos.counts.countsByDay(date),
      repos.deadlines.list(),
      repos.metrics.metricsByDay(date),
      repos.health.workerHealth(),
      repos.messages.uncertainCases({ since_days: 3, limit: 50 }),
      // E7-cérebro #4 — events auto-fechados HOJE (NY) viram notificações.
      // Tolerante a falta do método (fallback {events:[]}) pra não quebrar
      // testes que mockam repos parcialmente.
      repos.health.autoClosedEvents
        ? repos.health.autoClosedEvents(date)
        : Promise.resolve({ events: [] }),
      // FNSKU do dia (tolerante a mock parcial em testes) — Bruno 06-23
      repos.flowViews.fnskuByDay
        ? repos.flowViews.fnskuByDay(date)
        : Promise.resolve({}),
    ]);

  const openEvents = [];
  for (const p of (timeline.people || [])) {
    for (const e of (p.events || [])) {
      if (!e.ended_at) {
        openEvents.push({
          event_id: e.event_id, person_id: p.person_id, person: p.display_name,
          activity: e.activity, flow: e.flow,
          started_at: e.started_at, source_message_ts: e.source_message_ts,
        });
      }
    }
  }

  const batchById = {};
  for (const l of (production.lotes || [])) {
    if (l.batch_id != null) batchById[l.batch_id] = {
      batch_number: l.batch_number, product: l.product,
    };
  }

  const dupCount = (goals.goals || [])
    .reduce((s, g) => s + ((g.duplicatas_suspeitas || []).length), 0);
  const invalidCount = (production.lotes || []).reduce((s, l) => s + (l.invalid_event_count || 0), 0)
    + (pp.invalid_event_count || 0);
  const downtimeCount = (support.occurrences || []).filter((o) => o.is_downtime).length;

  return {
    date,
    timeline,
    cards: {
      production: production.lotes,
      pp: {
        total_seconds: pp.total_seconds,
        orders: pp.orders, seconds_per_order: pp.seconds_per_order,
        sub_steps: pp.sub_steps, quantities: pp.quantities, people: pp.people,
      },
      fnsku: {
        total_labels: (fnsku && fnsku.total_labels) || 0,
        person_seconds_total: (fnsku && fnsku.person_seconds_total) || 0,
        person_seconds: (fnsku && fnsku.person_seconds) || [],
        labels_per_min: (fnsku && fnsku.labels_per_min) != null ? fnsku.labels_per_min : null,
        sec_per_label: (fnsku && fnsku.sec_per_label) != null ? fnsku.sec_per_label : null,
        lotes: (fnsku && fnsku.lotes) || [], people: (fnsku && fnsku.people) || [],
      },
      support: support.occurrences,
      goals: goals.goals,
      counts: {
        total: (counts.counts || []).length,
        totals_by_product: counts.totals_by_product || {},
        rows: counts.counts || [],
      },
      deadlines: deadlines.deadlines,
      atencao: {
        duplicatas_count: dupCount,
        invalid_events: invalidCount,
        downtime_events: downtimeCount,
        open_events_count: openEvents.length,
        // E7-cérebro #4 — lista de auto-fechados de hoje pra render no card
        // de notificações (ev X de pessoa Y fechado às 21:00 sem F manual).
        auto_closed_events: autoClosed.events || [],
        auto_closed_count: (autoClosed.events || []).length,
      },
    },
    open_events: openEvents,
    uncertain_cases: uncertain.cases,
    batch_by_id: batchById,
    worker_health: health,
    metrics_summary: {
      msgs_processed: metrics.total_processed,
      errors: metrics.errors,
      cost_usd: metrics.cost_estimate_usd,
      by_confidence: metrics.by_confidence,
    },
  };
}

/**
 * Router Express da API de dados. Montar com app.use('/', router).
 * deps.db = pool pg; deps.repos / deps.services injetáveis (teste).
 */
function createDataRouter(deps = {}) {
  const express = require('express');
  const router = express.Router();
  const repos = deps.repos || buildRepos(deps.db);
  const services = deps.services || buildServices(deps.db);

  // Snapshot — registrada ANTES do middleware PIN: usa token próprio
  // (env V3_SNAPSHOT_TOKEN) na query. Read-only puro; sem write.
  //
  // E7-refine3: adiciona Cache-Control: no-store. O endpoint sempre retorna
  // a data pedida (verificado: buildSnapshot('2026-05-26') → date='2026-05-26'),
  // mas sem esse header navegadores e proxies podiam manter resp velha em
  // cache — Bruno relatou ver date=2026-05-25 num refresh de URL que ele
  // tinha aberto antes. Agora qualquer GET re-busca limpo.
  router.get('/api/v3/data/snapshot', async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const expected = deps.snapshotToken || process.env.V3_SNAPSHOT_TOKEN || null;
    if (!expected) {
      return res.status(503).json({ error: { code: 'disabled',
        message: 'snapshot desligado (V3_SNAPSHOT_TOKEN não setada).' } });
    }
    if (req.query.token !== expected) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'token inválido.' } });
    }
    try {
      const data = await buildSnapshot(req.query.date, repos);
      res.json(envelope(data, { date: data.date, snapshot: true }));
    } catch (e) {
      console.error('[v3-data] snapshot:', e.message);
      const code = /obrigatóri|inválid/.test(e.message) ? 400 : 500;
      res.status(code).json({ error: { code: code === 400 ? 'bad_request' : 'internal', message: e.message } });
    }
  });

  // LOGIN do dashboard (RBAC — Bruno 08-03): PIN → identidade + role + funções.
  // Registrado ANTES do middleware de auth (senão nem dava pra logar). O front
  // guarda o resultado e usa pra esconder páginas (ex.: manager não vê admin).
  router.post('/api/v3/data/login', async (req, res) => {
    try {
      const { resolveLogin } = require('./auth');
      const pin = (req.body && req.body.pin) || (req.query && req.query.pin);
      const login = await resolveLogin(deps.db, pin);
      if (!login) return res.status(401).json({ error: { code: 'unauthorized', message: 'PIN inválido.' } });
      res.json(envelope({ id: login.id, name: login.name, role: login.role, rank: login.rank, functions: login.functions }, {}));
    } catch (e) {
      console.error('[v3-data] login:', e.message);
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // auth na borda — protege TODO o /api/v3/data/* (exceto o snapshot + login acima)
  router.use('/api/v3/data', makeAuthMiddleware(deps));

  // ── SSE do spooler ao vivo (Bruno 07-16). O dashboard assina via EventSource
  // (?pin=..., já que EventSource não manda header) e recebe PUSH do progresso.
  // Snapshot no connect + eventos 'progress'/'done' empurrados pelo op.js. ──
  router.get('/api/v3/data/print-stream', async (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    if (res.flushHeaders) res.flushHeaders();
    res.write('retry: 5000\n\n');
    try {
      const live = await queryPrintLive(deps.db);
      res.write('event: snapshot\ndata: ' + JSON.stringify(live) + '\n\n');
    } catch (e) { /* segue mesmo se o snapshot falhar */ }
    printStream.addClient(res);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) {} }, 25000); // keep-alive
    req.on('close', () => clearInterval(hb));
  });

  // PONTO (relógio NGTeco) — ADMIN ONLY (PIN). Horários do relógio são internos:
  // esta é a ÚNICA superfície (além do #admin-orin) que os mostra. Bruno 07-22.
  router.get('/api/v3/data/attendance', async (req, res) => {
    try {
      const d = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date
        : new Date().toLocaleDateString('en-CA', { timeZone: TZ });
      const rows = (await deps.db.query(
        `SELECT p.id AS person_id, p.display_name, p.clock_code,
                s.checkin_at, s.checkout_at, s.state, s.break_started_at, s.last_in_at,
                s.punches_count, s.noclockin_callout_at, s.updated_at,
                EXTRACT(EPOCH FROM (NOW() - s.break_started_at))::int AS break_sec
           FROM v3.persons p
           LEFT JOIN v3.att_state s ON s.person_id = p.id AND s.att_date = $1::date
          WHERE p.clock_code IS NOT NULL AND p.clock_code <> '' AND p.active = true AND p.deleted_at IS NULL
          ORDER BY p.display_name`, [d])).rows;
      const punches = (await deps.db.query(
        `SELECT person_id, punch_time, seq FROM v3.att_punch WHERE att_date = $1::date ORDER BY person_id, punch_time`, [d])).rows;
      const byPerson = {};
      for (const pu of punches) (byPerson[pu.person_id] = byPerson[pu.person_id] || []).push({ punch_time: pu.punch_time });
      // quem tem SESSÃO ABERTA agora (logado no kiosk) — pro botão de "deslogar" (Bruno 08-01)
      const loggedInSet = new Set((await deps.db.query(
        `SELECT DISTINCT person_id FROM v3.operator_sessions WHERE logged_out_at IS NULL`)).rows.map((r) => r.person_id));
      // breaks justificados: events de break/lunch COM descrição (a pessoa explicou no /op)
      const justRows = (await deps.db.query(
        `SELECT e.person_id, e.started_at FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
          WHERE (e.started_at AT TIME ZONE '${TZ}')::date = $1::date AND e.deleted_at IS NULL
            AND at.slug IN ('break','lunch') AND COALESCE(TRIM(e.description),'') <> ''`, [d])).rows;
      const justByPerson = {};
      for (const j of justRows) (justByPerson[j.person_id] = justByPerson[j.person_id] || new Set()).add(new Date(j.started_at).getTime());
      res.json(envelope({
        date: d,
        people: rows.map((r) => {
          const pu = byPerson[r.person_id] || [];
          const dayClosed = !!r.checkout_at;
          let mk = { markers: [], breaks: [], lunch: null };
          try { mk = attendanceMarkers.computeMarkers(pu, dayClosed, justByPerson[r.person_id]); } catch (e) { /* segue */ }
          return {
            person_id: r.person_id, name: r.display_name, clock_code: r.clock_code,
            state: r.state || 'out',
            checkin_at: r.checkin_at, checkout_at: r.checkout_at, last_in_at: r.last_in_at,
            break_sec: r.state === 'break' && r.break_sec != null ? r.break_sec : null,
            punches: pu.map((x) => x.punch_time),
            markers: mk.markers,          // [{kind,at,label,type,minutes}] pra timeline
            breaks: mk.breaks.map((b) => ({ out: b.out, in: b.in, minutes: b.minutes, type: b.type, overtime_min: b.overtime_min || 0 })),
            no_clockin: !!r.noclockin_callout_at,
            logged_in: loggedInSet.has(r.person_id),   // sessão de kiosk aberta agora
            updated_at: r.updated_at,
          };
        }),
      }, { date: d }));
    } catch (e) {
      console.error('[v3-data] attendance:', e.message);
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // INCIDENTES DE DADOS (Bruno 07-23): caixa urgente no dashboard — duplicatas etc.
  router.get('/api/v3/data/incidents', async (req, res) => {
    try {
      const rows = (await deps.db.query(
        `SELECT i.id, i.kind, i.severity, i.title, i.explanation, i.diagnosis, i.where_json,
                i.amount, i.auto_fixed, i.related_count_ids, i.created_at,
                p.display_name AS person_name, pr.canonical_name AS product_name
           FROM v3.data_incidents i
           LEFT JOIN v3.persons p ON p.id = i.person_id
           LEFT JOIN v3.products pr ON pr.id = i.product_id
          WHERE i.status = 'open'
          ORDER BY i.created_at DESC LIMIT 20`)).rows;
      res.json(envelope({ incidents: rows }));
    } catch (e) {
      console.error('[v3-data] incidents:', e.message);
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });
  // resolver/dispensar um incidente
  router.post('/api/v3/data/incidents/:id/resolve', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const status = req.body && req.body.dismiss ? 'dismissed' : 'resolved';
      await deps.db.query(`UPDATE v3.data_incidents SET status=$2, resolved_at=NOW() WHERE id=$1`, [id, status]);
      res.json(envelope({ ok: true, id, status }));
    } catch (e) { res.status(500).json({ error: { code: 'internal', message: e.message } }); }
  });

  // FORCE-LOGOFF de um operador (Bruno 08-01): o admin desloga alguém da estação —
  // ex.: logou por engano na conta de outra pessoa. Fecha a(s) sessão(ões) aberta(s).
  // Se ?close_tasks=true, também fecha tarefas abertas hoje (login por engano que abriu
  // task). Idempotente. Não mexe em contagens já feitas.
  router.post('/api/v3/data/operator/:id/logoff', async (req, res) => {
    try {
      const personId = parseInt(req.params.id, 10);
      if (!personId) return res.status(400).json({ error: { code: 'bad_request', message: 'id inválido' } });
      const reason = (req.body && req.body.reason) || 'admin_logoff';
      const p = (await deps.db.query('SELECT display_name FROM v3.persons WHERE id=$1', [personId])).rows[0];
      const name = (p && p.display_name) || ('#' + personId);
      // 1) fecha sessões abertas (TODAS — pode haver vazadas)
      const sess = await deps.db.query(
        `UPDATE v3.operator_sessions SET logged_out_at=NOW(), logoff_reason=$2
          WHERE person_id=$1 AND logged_out_at IS NULL RETURNING id`, [personId, reason]);
      // 2) TIRA DE QUALQUER ATIVIDADE ATIVA (Bruno 08-03): fecha tarefas abertas
      //    não-background (máquina em background segue; login por engano não deve
      //    fechar uma máquina rodando de verdade de outra pessoa).
      const t = await deps.db.query(
        `UPDATE v3.events SET ended_at=NOW(), closed_reason='admin_logoff', updated_at=NOW()
          WHERE person_id=$1 AND ended_at IS NULL AND deleted_at IS NULL
            AND COALESCE(is_long_running,false)=false RETURNING id`, [personId]);
      const closedTasks = t.rows.map((r) => r.id);
      // 3) CHECA se a pessoa bateu a SAÍDA no relógio (NGTeco) hoje
      const att = (await deps.db.query(
        `SELECT state, checkout_at FROM v3.att_state
          WHERE person_id=$1 AND att_date=(NOW() AT TIME ZONE 'America/New_York')::date`, [personId])).rows[0];
      const clockedOut = !!(att && att.checkout_at);
      // 4) ALERTA no admin-orin (Bruno 08-03): registra o que o admin fez + o estado do ponto.
      if (deps.slack && deps.slack.postAs && deps.adminChannelId) {
        const clockTxt = clockedOut
          ? `Já tinha batido a *saída no relógio* hoje.`
          : `:warning: *Ainda NÃO bateu a saída no relógio* hoje — se foi embora, confiram o ponto dela.`;
        deps.slack.postAs({
          channel: deps.adminChannelId,
          sender: { name: 'HealthFare Tracker', icon: ':bust_in_silhouette:' },
          thread_ts: null, unfurl_links: false, unfurl_media: false,
          text: `:door: *${name}* foi *deslogado(a) da estação* pelo admin`
            + `${sess.rows.length ? ` (${sess.rows.length} sessão(ões) fechada(s))` : ''}`
            + `${closedTasks.length ? `, ${closedTasks.length} tarefa(s) encerrada(s)` : ''}. ${clockTxt}`,
        }).catch((e) => console.error('[v3-data] logoff admin alert:', e.message));
      }
      res.json(envelope({ ok: true, person_id: personId, name,
        sessions_closed: sess.rows.map((r) => r.id), tasks_closed: closedTasks, clocked_out: clockedOut }));
    } catch (e) {
      console.error('[v3-data] operator logoff:', e.message);
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // REGISTRAR SAÍDA MANUAL (Bruno 08-03): a pessoa esqueceu de bater a saída no
  // relógio → o admin marca o checkout do dia pela aba de pessoas. Fecha o dia
  // (state=out), encerra tarefas não-máquina + sessões, e avisa o admin-orin.
  // body: { at?: 'ISO' }  — sem `at`, usa agora. `at` pra registrar a saída real.
  router.post('/api/v3/data/operator/:id/checkout', async (req, res) => {
    try {
      const personId = parseInt(req.params.id, 10);
      if (!personId) return res.status(400).json({ error: { code: 'bad_request', message: 'id inválido' } });
      const at = (req.body && req.body.at) ? new Date(req.body.at) : new Date();
      if (isNaN(at.getTime())) return res.status(400).json({ error: { code: 'bad_request', message: 'horário inválido' } });
      const p = (await deps.db.query('SELECT display_name FROM v3.persons WHERE id=$1', [personId])).rows[0];
      const name = (p && p.display_name) || ('#' + personId);
      const atIso = at.toISOString();
      // 1) fecha o dia no att_state (checkout manual)
      await deps.db.query(
        `INSERT INTO v3.att_state (person_id, att_date, checkout_at, state, checkout_notified, updated_at)
           VALUES ($1, (NOW() AT TIME ZONE 'America/New_York')::date, $2, 'out', true, NOW())
         ON CONFLICT (person_id, att_date) DO UPDATE SET
           checkout_at=$2, state='out', break_started_at=NULL, checkout_notified=true, updated_at=NOW()`,
        [personId, atIso]);
      // 2) encerra tarefas não-máquina abertas + sessões, na hora da saída
      const t = await deps.db.query(
        `UPDATE v3.events SET ended_at=GREATEST(started_at, $2), closed_reason='admin_checkout', updated_at=NOW()
          WHERE person_id=$1 AND ended_at IS NULL AND deleted_at IS NULL
            AND COALESCE(is_long_running,false)=false RETURNING id`, [personId, atIso]);
      const s = await deps.db.query(
        `UPDATE v3.operator_sessions SET logged_out_at=COALESCE(logged_out_at,$2), logoff_reason=COALESCE(logoff_reason,'admin_checkout')
          WHERE person_id=$1 AND logged_out_at IS NULL RETURNING id`, [personId, atIso]);
      // 3) avisa o admin-orin (com o horário — é interno)
      if (deps.slack && deps.slack.postAs && deps.adminChannelId) {
        const hh = at.toLocaleTimeString('pt-BR', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
        deps.slack.postAs({
          channel: deps.adminChannelId,
          sender: { name: 'HealthFare Tracker', icon: ':clock6:' },
          thread_ts: null, unfurl_links: false, unfurl_media: false,
          text: `:clock6: *${name}* — saída registrada *manualmente* pelo admin às *${hh}* (esqueceu de bater no relógio).`
            + `${t.rows.length ? ` ${t.rows.length} tarefa(s) encerrada(s).` : ''}`,
        }).catch((e) => console.error('[v3-data] checkout admin alert:', e.message));
      }
      res.json(envelope({ ok: true, person_id: personId, name, checkout_at: atIso,
        tasks_closed: t.rows.map((r) => r.id), sessions_closed: s.rows.map((r) => r.id) }));
    } catch (e) {
      console.error('[v3-data] operator checkout:', e.message);
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // TOTAIS DE PRODUÇÃO PENDENTES (Bruno 07-27): linhas fechadas sem total, ainda
  // abertas (conversando com o operador) OU escaladas pro admin. Caixa no dashboard.
  router.get('/api/v3/data/pending-totals', async (req, res) => {
    try {
      const rows = (await deps.db.query(
        `SELECT id, event_id, person_name, product_name, batch_number, close_reason,
                status, state, attempts, escalated_at, created_at, updated_at
           FROM v3.production_total_followups
          WHERE status IN ('open','escalated')
          ORDER BY (status='escalated') DESC, created_at ASC LIMIT 30`)).rows;
      res.json(envelope({ pending: rows }));
    } catch (e) {
      console.error('[v3-data] pending-totals:', e.message);
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });
  // ADMIN registra o total manualmente → grava a contagem + fecha o followup.
  router.post('/api/v3/data/pending-totals/:id/resolve', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const dismiss = !!(req.body && req.body.dismiss);
      const f = (await deps.db.query(`SELECT * FROM v3.production_total_followups WHERE id=$1`, [id])).rows[0];
      if (!f) return res.status(404).json({ error: { code: 'not_found', message: 'followup não existe' } });
      if (f.status === 'resolved' || f.status === 'dismissed') return res.json(envelope({ ok: true, already: true }));
      // DISPENSAR (Bruno 08-03): "foi engano" — abertura errada da tarefa, sem produção
      // real. O admin descarta a cobrança SEM registrar número. (Vitor abriu NAC por
      // engano e escreveu "abertura errada da tarefa" — a caixa vermelha ficava presa.)
      if (dismiss) {
        await deps.db.query(
          `UPDATE v3.production_total_followups SET status='dismissed', state='dismissed', updated_at=NOW() WHERE id=$1`, [id]);
        return res.json(envelope({ ok: true, id, dismissed: true }));
      }
      const bottles = parseInt(req.body && req.body.bottles, 10);
      if (!Number.isInteger(bottles) || bottles < 0) {
        return res.status(400).json({ error: { code: 'bad_bottles', message: 'total inválido' } });
      }
      // grava a contagem canônica (mesma via do worker), se houver quem grave
      if (deps.recordTotal) {
        try { await deps.recordTotal({ followup: f, bottles, via: 'admin_dashboard', byPersonId: (req.session && req.session.person_id) || f.person_id }); }
        catch (e) { console.error('[v3-data] recordTotal admin:', e.message); }
      }
      await deps.db.query(
        `UPDATE v3.production_total_followups
            SET status='resolved', state='done', total_bottles=$2, resolved_via='admin_dashboard',
                resolved_at=NOW(), updated_at=NOW()
          WHERE id=$1`, [id, bottles]);
      res.json(envelope({ ok: true, id, bottles }));
    } catch (e) {
      console.error('[v3-data] resolve pending-total:', e.message);
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // SAÚDE DO SISTEMA (Bruno 07-28): cruza o REGISTRO de processos (verdade do que
  // deveria existir) com os heartbeats REAIS + sinais do .28 → ligado/desligado,
  // vivo/morto, verde/amarelo/vermelho. Fim do "não sei o que tá rodando".
  router.get('/api/v3/data/system-health', async (req, res) => {
    try {
      const reg = require('../process-registry');
      const procs = reg.listProcesses();
      // 1) heartbeats do Railway (worker_tick_* + a chave própria do observer)
      const ticks = new Map();
      const t = await deps.db.query("SELECT key, value FROM v3.settings WHERE key LIKE 'worker_tick_%' OR key='observer_last_tick_at'");
      for (const r of t.rows) {
        const k = r.key === 'observer_last_tick_at' ? 'observer_last_tick_at' : r.key.replace('worker_tick_', '');
        try { ticks.set(k, new Date(JSON.parse(JSON.stringify(r.value))).getTime()); } catch (_) {}
      }
      // 2) sinais do .28: última atualização de status (epson) e último job (printmon)
      let lastStatus = 0, lastJob = 0, lastWatchdog = 0;
      try { const s = await deps.db.query("SELECT MAX(updated_at) m FROM v3.printer_status"); lastStatus = s.rows[0].m ? new Date(s.rows[0].m).getTime() : 0; } catch (_) {}
      try { const j = await deps.db.query("SELECT MAX(created_at) m FROM v3.print_jobs"); lastJob = j.rows[0].m ? new Date(j.rows[0].m).getTime() : 0; } catch (_) {}
      try { const w = await deps.db.query("SELECT MAX(created_at) m FROM v3.audit_log WHERE action='print_watchdog.revived'"); lastWatchdog = w.rows[0].m ? new Date(w.rows[0].m).getTime() : 0; } catch (_) {}
      const now = Date.now();
      const agoMin = (ms) => (ms ? Math.round((now - ms) / 60000) : null);

      const out = procs.map((p) => {
        let lastBeat = null, health = 'unknown';
        if (p.where === 'railway') {
          if (!p.enabled) { health = 'off'; }
          else if (p.heartbeat) {
            const key = p.heartbeatKey === 'observer_last_tick_at' ? 'observer_last_tick_at' : p.key;
            lastBeat = ticks.get(key) || null;
            const stale = lastBeat ? (now - lastBeat) / 60000 > (p.staleMin || 10) : true;
            health = lastBeat ? (stale ? 'down' : 'up') : 'down';
          } else { health = 'on_no_hb'; }   // ligado, mas sem heartbeat pra confirmar
        } else {
          // .28: usa os sinais físicos. epson_status→lastStatus; printmon→lastJob;
          // watchdog→lastWatchdog; os sem sinal direto herdam do status geral do .28.
          const sig = p.key === 'epson_status' ? lastStatus
            : p.key === 'printmon' ? Math.max(lastStatus, lastJob)   // printmon vivo → status flui
            : p.key === 'print_watchdog' ? Math.max(lastStatus, lastWatchdog)
            : Math.max(lastStatus, lastJob);   // printlock/idlecleanup: proxy pelo pipeline vivo
          lastBeat = sig || null;
          // .28: "vivo" se houve sinal do pipeline nas últimas 2h (a impressora não
          // imprime o tempo todo; mas o status muda ao ligar/imprimir). staleMin frouxo.
          const stale = lastBeat ? (now - lastBeat) / 60000 > 120 : true;
          health = lastBeat ? (stale ? 'idle28' : 'up') : 'unknown';
        }
        return {
          key: p.key, name: p.name, where: p.where, critical: !!p.critical,
          enabled: p.enabled, health, tick_ms: p.tickMs, since: p.since,
          short: p.short, detail: p.detail,
          last_beat_min: agoMin(lastBeat), heartbeat: !!p.heartbeat,
        };
      });
      // resumo pro topo da página
      const summary = {
        total: out.length,
        up: out.filter((x) => x.health === 'up').length,
        down: out.filter((x) => x.health === 'down').length,
        off: out.filter((x) => x.health === 'off').length,
        critical_down: out.filter((x) => x.critical && x.health === 'down').length,
      };
      res.json(envelope({ processes: out, summary,
        signals: { printer_status_min: agoMin(lastStatus), last_job_min: agoMin(lastJob), last_watchdog_min: agoMin(lastWatchdog) } }));
    } catch (e) {
      console.error('[v3-data] system-health:', e.message);
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // Página "Impressão" do dashboard (PIN-authed pelo middleware acima).
  router.get('/api/v3/data/printers', async (req, res) => {
    try {
      const data = await queryPrintersPage(deps.db, req.query.date);
      res.json(envelope(data, { date: data.date }));
    } catch (e) {
      console.error('[v3-data] printers:', e.message);
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  // Tab "Inventory": mapeia nossos produtos ↔ SKUs do Veeqo (cache 10min).
  router.get('/api/v3/data/inventory', async (req, res) => {
    try {
      const data = await queryInventory(deps.db);
      res.json(envelope(data, {}));
    } catch (e) {
      console.error('[v3-data] inventory:', e.message);
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  for (const ep of ENDPOINTS) {
    const method = ep.method || 'get';
    router[method](ep.path, async (req, res) => {
      try {
        const out = await ep.handler(req, repos, services);
        res.json(envelope(out.data, out.meta));
      } catch (e) {
        console.error('[v3-data]', method.toUpperCase(), ep.path, '-', e.message);
        const notFound = /não existe/.test(e.message);
        const bad = /obrigatóri|inválid|não-(corrigível|editável)|precisa de/.test(e.message);
        const code = notFound ? 404 : (bad ? 400 : 500);
        res.status(code).json({
          error: {
            code: notFound ? 'not_found' : (bad ? 'bad_request' : 'internal'),
            message: e.message,
          },
        });
      }
    });
  }

  console.log('[V3] API de dados montada: /api/v3/data/* (' + ENDPOINTS.length + ' endpoints)');
  return router;
}

module.exports = { createDataRouter, buildRepos, buildServices, envelope, ENDPOINTS, API_VERSION, buildSnapshot };
