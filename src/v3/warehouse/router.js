'use strict';
/**
 * HEALTHFARE V3 — Warehouse hub — API /api/v3/warehouse/* (Bruno 08-18, S15 Fase 1).
 *
 * UMA página gerencia o estoque inteiro do armazém (fluxo ②, P&P direto-ao-cliente).
 * Este router é o único caminho dela; escrita SEMPRE pelo StockService /
 * StockRequestService (porta única), nunca SQL de quantidade daqui.
 *
 * CONTRATO: envelope { data } / { error:{ code, message } } (mesmo do data router).
 * AUTH: makeAuthMiddleware (PIN → v3.app_logins). Leitura precisa de view_stock
 * ou manage_stock; escrita precisa de manage_stock ('*' vale pra tudo).
 * As propostas do OPERADOR entram na Fase 2 pelo /op — aqui só quem decide.
 *
 * Números (estudo §3): total = prateleira + caixa + a organizar; reservado vem das
 * linhas abertas da Veeqo; disponível = total − reservado − pendente_out; separadas
 * ficam FORA do total. A coluna Veeqo é comparação, nunca soma (V1: kits derivam
 * do base, então a comparação é sempre contra o SKU base).
 */

const express = require('express');
const { makeAuthMiddleware, hasFunction } = require('../data/auth');
const { createVeeqoCache } = require('./veeqo-cache');
const { LocationsRepo } = require('./locations-repo');
const { FamilyRepo } = require('./family-repo');
const { WeightsRepo, computeQty } = require('./weights');
const { createMobile } = require('./mobile');
const { suggest } = require('./sku-suggest');
const { createSkuSync } = require('./sku-sync');
const { createVeeqoAbsorb } = require('./veeqo-absorb');

const BASE = '/api/v3/warehouse';
const EDT = 'America/New_York';
const IMPORT_BULK_CAP = 500;
const BULK_BINS_CAP = 300;   // cadastro em lote de prateleiras, por chamada
const MERGE_BULK_CAP = 50;   // grupos de merge por chamada (cada um mexe em estoque)
const BIN_CODE_MAX = 12;     // 'A03B2' folgado; acima disso não é código de prateleira

/** Data de hoje em NY (o source_ref do import é por dia: reimportar não duplica). */
const nyDate = (d) => (d || new Date()).toLocaleDateString('en-CA', { timeZone: EDT });

const err = (res, code, message, status) =>
  res.status(status || 400).json({ error: { code, message } });

/** Erro do service → HTTP. Mesmo critério do data router. */
function statusFor(e) {
  const m = String((e && e.message) || '');
  if (/não existe/.test(m)) return 404;
  if (/obrigatóri|inválid|precisa de|iguais/.test(m)) return 400;
  return 500;
}
function codeFor(status) {
  return status === 404 ? 'not_found' : (status === 400 ? 'bad_request' : 'internal');
}

const intOf = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

// ── LISTA DO HUB: busca, filtro, ordenação e página ─────────────────────────
// 190+ linhas numa tabela: ordenar e filtrar no NAVEGADOR significa mandar tudo
// e recalcular a cada tecla. Aqui em cima, uma vez, e o cliente só desenha.
// Sem nenhum parâmetro o comportamento é EXATAMENTE o de antes (lista inteira,
// ordem do service por apelido) — nada que já funciona muda de jeito.

/** Colunas ordenáveis: nome da API → como ler o número/texto da Row. */
const SORTABLE = {
  nome: (r) => String(r.nickname || r.name || '').toLowerCase(),
  total: (r) => r.total,
  prateleira: (r) => r.shelf_qty,
  caixa: (r) => r.box_qty,
  organizar: (r) => r.unplaced_qty,
  reservado: (r) => r.reserved,
  pendente: (r) => (Number(r.pending_out) || 0) + (Number(r.pending_in) || 0),
  disponivel: (r) => r.available,
  dias: (r) => r.days_of_stock,
  separadas: (r) => r.separated,
  veeqo: (r) => r.veeqo_total,
  skus: (r) => r.sku_count,
};

const PAGE_MAX = 500;   // teto duro: nenhum cliente precisa de mais numa tacada

/**
 * Aplica busca + filtro + ordenação + página sobre as Rows já montadas.
 * ORDENAÇÃO ESTÁVEL e NULO POR ÚLTIMO: "Dias" e "Veeqo" são null em muita linha;
 * jogar null pro fim nas duas direções é o que faz a tabela parecer certa (null
 * no topo do "maior primeiro" seria lido como "o maior de todos").
 * @returns {{rows, total, limit, offset}}
 */
function applyQuery(rows, q = {}) {
  let out = rows;

  const term = String(q.q || '').trim().toLowerCase();
  if (term) {
    out = out.filter((r) => {
      if (String(r.name || '').toLowerCase().includes(term)) return true;
      if (String(r.nickname || '').toLowerCase().includes(term)) return true;
      // busca também nos SKUs FILHOS: quem cola um "-C3" da Veeqo tem que achar
      // a linha do pai, que é onde a garrafa está.
      return (r.skus || []).some((s) => String(s.sku || '').toLowerCase().includes(term));
    });
  }

  const status = String(q.status || '').trim();
  if (status) {
    const want = status.split(',').map((s) => s.trim()).filter(Boolean);
    if (want.length) out = out.filter((r) => want.some((w) => (r.status || []).includes(w)));
  }

  if (q.only_with_qty === '1' || q.only_with_qty === 1 || q.only_with_qty === true) {
    out = out.filter((r) => Number(r.total) > 0);
  }

  const total = out.length;

  const col = SORTABLE[String(q.sort || '').trim()];
  if (col) {
    const dir = String(q.dir || 'asc').toLowerCase() === 'desc' ? -1 : 1;
    // decora com o índice original: empate mantém a ordem que o service deu
    out = out.map((r, i) => ({ r, i })).sort((a, b) => {
      const x = col(a.r); const y = col(b.r);
      const xn = x == null || x === ''; const yn = y == null || y === '';
      if (xn && yn) return a.i - b.i;
      if (xn) return 1;              // nulo por último nas DUAS direções
      if (yn) return -1;
      if (x < y) return -1 * dir;
      if (x > y) return 1 * dir;
      return a.i - b.i;              // estável
    }).map((d) => d.r);
  }

  const limitRaw = intOf(q.limit);
  const limit = limitRaw && limitRaw > 0 ? Math.min(limitRaw, PAGE_MAX) : null;
  const offset = Math.max(0, intOf(q.offset) || 0);
  if (limit != null || offset) out = out.slice(offset, limit != null ? offset + limit : undefined);

  return { rows: out, total, limit, offset };
}

// ── DRIFT e IMPORT: funções puras, reusáveis fora do HTTP ───────────────────
// O worker de drift (src/workers/stock-drift-alert.js) chama computeDrift DIRETO,
// sem passar por HTTP — worker batendo na própria API é caminho duplo esperando
// pra divergir. Mesmas contas do overview, um lugar só.

/**
 * Produtos onde a Veeqo e a gente discordam. Usa os MESMOS números do overview
 * (comparação sempre contra o SKU base; kits derivam do base e somá-los contaria
 * a mesma garrafa duas vezes).
 * @param {object} deps {stock, veeqoCache}
 * @returns {Promise<Array<{product_id,name,nickname,base_sku,ours,veeqo,delta}>>}
 */
async function computeDrift(deps = {}) {
  const bySku = await deps.veeqoCache.bySku();
  const rows = await deps.stock.overview({});
  const out = [];
  for (const r of rows) {
    const key = r.base_sku ? String(r.base_sku).trim().toUpperCase() : null;
    const v = key ? bySku[key] : null;
    if (!v || !v.wh) continue;                       // sem número da Veeqo = 'unknown', não é drift
    const veeqo = Number(v.wh.physical);
    const ours = Number(r.total);
    if (!Number.isFinite(veeqo) || veeqo === ours) continue;
    out.push({
      product_id: r.product_id, name: r.name, nickname: r.nickname || r.name,
      base_sku: r.base_sku, ours, veeqo, delta: veeqo - ours,
    });
  }
  return out;
}

/**
 * IMPORTAR DA VEEQO: a Veeqo é a fonte do total POR ENQUANTO (decisão do Bruno,
 * round 3). Traz o saldo dela pro nosso livro.
 *
 *   delta = veeqo.physical − nosso total
 *   delta > 0 → entrada de verdade, no bucket "a organizar", kind 'import'
 *   delta < 0 → NUNCA deduz sozinho. Some garrafa de graça no sistema é como se
 *               perde estoque de verdade; volta em `negative` pra alguém olhar.
 *   delta = 0 → pula
 *
 * Idempotente POR DIA: source_ref 'veeqo_import:<sku>:<yyyy-mm-dd>' — clicar duas
 * vezes no botão não importa duas vezes.
 *
 * @param {object} deps {stock, veeqoCache}
 * @param {object} opts {product_id?, person_id?, login?, now?}
 */
async function importVeeqo(deps = {}, opts = {}) {
  const stock = deps.stock;
  const bySku = await deps.veeqoCache.bySku();
  const only = opts.product_id ? Number(opts.product_id) : null;
  const rows = await stock.overview(only ? { product_id: only } : {});
  const day = nyDate(opts.now ? new Date(opts.now) : null);
  const imported = []; const negative = [];
  let skipped = 0; let processed = 0;

  for (const r of rows) {
    if (!only && processed >= IMPORT_BULK_CAP) break;
    processed += 1;
    const key = r.base_sku ? String(r.base_sku).trim().toUpperCase() : null;
    const v = key ? bySku[key] : null;
    if (!v || !v.wh || !Number.isFinite(Number(v.wh.physical))) { skipped += 1; continue; }
    const delta = Number(v.wh.physical) - Number(r.total);
    if (delta === 0) { skipped += 1; continue; }
    if (delta < 0) {
      negative.push({ product_id: r.product_id, name: r.name, nickname: r.nickname,
        base_sku: r.base_sku, ours: Number(r.total), veeqo: Number(v.wh.physical), delta });
      continue;
    }
    const out = await stock.storeIn({
      product_id: r.product_id, qty: delta, kind: 'import',
      person_id: opts.person_id || null, actor_type: 'admin',
      source: 'veeqo_import', source_ref: 'veeqo_import:' + key + ':' + day,
      note: `import Veeqo${opts.login ? ' [' + opts.login + ']' : ''}: Veeqo ${v.wh.physical}, aqui ${r.total}`,
    });
    imported.push({ product_id: r.product_id, name: r.name, nickname: r.nickname,
      base_sku: r.base_sku, delta, applied: out.applied || 0, duplicate: !!out.duplicate });
  }
  return { imported, negative, skipped };
}

function createWarehouseRouter(deps = {}) {
  const db = deps.db;
  const stock = deps.stock;
  const requests = deps.requests;
  const veeqoCache = deps.veeqoCache || createVeeqoCache({ veeqo: deps.veeqo });
  const locations = deps.locations || new LocationsRepo({ db });
  // stock no FamilyRepo: o merge move ESTOQUE, e quantidade só o StockService escreve
  const family = deps.family || new FamilyRepo({ db, veeqoCache, stock });
  const weights = deps.weights || new WeightsRepo({ db });
  // sku-sync: mapeamento SKU↔produto a partir do catálogo da Veeqo. Escreve SÓ
  // v3.product_skus / v3.products; nunca quantidade (isso é o StockService).
  const skuSync = deps.skuSync || createSkuSync({ db, veeqo: deps.veeqo, veeqoCache, family });
  // absorção: o DESCRITIVO da Veeqo (título, marca, UPC, foto) guardado aqui.
  // Mesma regra do sku-sync — escreve só descrição, nunca quantidade.
  const veeqoAbsorb = deps.veeqoAbsorb || createVeeqoAbsorb({ db, veeqo: deps.veeqo });
  const router = express.Router();

  router.use(BASE, express.json({ limit: '256kb' }));
  router.use(BASE, makeAuthMiddleware({ db }));

  const canRead = (req) => hasFunction(req.login, 'view_stock') || hasFunction(req.login, 'manage_stock');
  const canWrite = (req) => hasFunction(req.login, 'manage_stock');

  /** Contexto padrão de toda chamada ao StockService a partir do hub. */
  const actor = (req, note) => ({
    source: 'warehouse_hub',
    actor_type: 'admin',
    person_id: (req.login && req.login.person_id) || null,
    note: `[${(req.login && req.login.name) || 'admin'}]${note ? ' ' + note : ''}`,
  });

  async function audit(req, action, targetId, after) {
    try {
      await db.query(
        `INSERT INTO v3.audit_log
           (actor_type, actor_person_id, action, target_type, target_id, after_data, metadata)
         VALUES ('admin', $1, $2, 'warehouse', $3, $4::jsonb, $5::jsonb)`,
        [(req.login && req.login.person_id) || null, action, targetId || null,
          after ? JSON.stringify(after) : null,
          JSON.stringify({ login: (req.login && req.login.name) || null })]);
    } catch (_) { /* auditoria nunca derruba a operação */ }
  }

  // ── enriquecimento Veeqo ───────────────────────────────────
  // Regra V1: compara SEMPRE contra o SKU base (ProductVariant). Kits derivam do
  // base no próprio Veeqo — somá-los contaria a mesma garrafa várias vezes.
  function enrich(row, bySku) {
    const key = row.base_sku ? String(row.base_sku).trim().toUpperCase() : null;
    const v = key ? bySku[key] : null;
    row.veeqo = v && v.wh ? v.wh : null;
    row.veeqo_match = row.veeqo == null ? 'unknown'
      : (Number(row.veeqo.physical) === Number(row.total) ? 'ok' : 'drift');
    for (const s of (row.skus || [])) {
      const info = bySku[String(s.sku).trim().toUpperCase()];
      s.veeqo_type = info ? info.type : null;
      s.veeqo_qty = info && info.wh && info.wh.physical != null ? Number(info.wh.physical) : null;
    }
    // children é a MESMA lista de objetos que skus (o service filtra por
    // referência), então já vem enriquecida — só reaponta pra garantir.
    row.children = (row.skus || []).filter((s) => s.role !== 'base');
    // veeqo_total = SÓ o base físico. NUNCA base + kits: o kit é a mesma garrafa
    // do base contada de novo (memória 'merge-safety-rules', estudo §10.4).
    row.veeqo_total = row.veeqo && row.veeqo.physical != null ? Number(row.veeqo.physical) : null;
    if (row.veeqo_match === 'drift' && !row.status.includes('drift')) {
      row.status = row.status.filter((x) => x !== 'ok');
      row.status.push('drift');
      if (!row.status.length) row.status.push('ok');
    }
    return row;
  }

  async function rowsWithVeeqo(productId) {
    const bySku = await veeqoCache.bySku();
    const rows = await stock.overview(productId ? { product_id: productId } : {});
    return rows.map((r) => enrich(r, bySku));
  }

  /** Row fresca de um produto (toda escrita devolve isso). */
  async function freshRow(productId) {
    const rows = await rowsWithVeeqo(Number(productId));
    return rows[0] || null;
  }

  // ── textos PT-BR da lista "Precisa de atenção hoje" ────────
  // Os mesmos fatos que os watchdogs mandam pro Slack, na tela, com a ação junto.
  function attentionFrom(rows) {
    const items = [];
    for (const r of rows) {
      const name = r.nickname || r.name;
      if (r.status.includes('negative')) {
        items.push({ kind: 'negative', product_id: r.product_id, product: name,
          text: `${name} · disponível ${r.available}, os pedidos abertos passam do estoque`,
          action: { type: 'entrada' } });
      } else if (r.status.includes('out')) {
        const box = (r.boxes || [])[0];
        items.push({ kind: 'out', product_id: r.product_id, product: name,
          text: box ? `${name} · zerado na prateleira, caixa ${box.box_number} tem ${box.qty}`
            : `${name} · zerado no armazém`,
          action: box ? { type: 'repor', box_id: box.id } : { type: 'entrada' } });
      } else if (r.status.includes('low')) {
        items.push({ kind: 'low', product_id: r.product_id, product: name,
          text: `${name} · disponível ${r.available}, mínimo ${r.min_units}`,
          action: { type: 'entrada' } });
      }
      if (r.status.includes('organizar')) {
        items.push({ kind: 'organizar', product_id: r.product_id, product: name,
          text: `${name} · ${r.unplaced_qty} garrafas a organizar, ainda sem prateleira ou caixa`,
          action: { type: 'organizar' } });
      }
      const repor = (r.bins || []).find((b) => b.needs_restock);
      if (repor) {
        items.push({ kind: 'low', product_id: r.product_id, product: name,
          text: `${name} · prateleira ${repor.bin_code} com ${repor.qty}, mínimo ${repor.min_qty}, precisa repor`,
          action: { type: 'repor', bin_id: repor.id } });
      }
      if (r.pending_out || r.pending_in) {
        const parts = [];
        if (r.pending_out) parts.push(`saída de ${r.pending_out}`);
        if (r.pending_in) parts.push(`entrada de ${r.pending_in}`);
        items.push({ kind: 'pending', product_id: r.product_id, product: name,
          text: `${name} · ${parts.join(' e ')} esperando aprovação`,
          action: { type: 'aprovar' } });
      }
      if (r.veeqo_match === 'drift') {
        const d = Number(r.veeqo.physical) - Number(r.total);
        items.push({ kind: 'drift', product_id: r.product_id, product: name,
          text: `${name} · Veeqo ${r.veeqo.physical}, aqui ${r.total}, diferença de ${d > 0 ? '+' : ''}${d}`,
          action: { type: 'ver' } });
      }
      if (r.status.includes('sem_local')) {
        items.push({ kind: 'sem_local', product_id: r.product_id, product: name,
          text: `${name} · ${r.total} garrafas sem prateleira nem caixa cadastrada`,
          action: { type: 'organizar' } });
      }
    }
    return items;
  }

  function kpisFrom(rows) {
    const sum = (f) => rows.reduce((n, r) => n + (Number(f(r)) || 0), 0);
    return {
      total_bottles: sum((r) => r.total),
      reserved: sum((r) => r.reserved),
      available: sum((r) => r.available),
      separated: sum((r) => r.separated),
      unplaced: sum((r) => r.unplaced_qty),
      bins_to_restock: rows.reduce((n, r) => n + (r.bins || []).filter((b) => b.needs_restock).length, 0),
      pending_requests: rows.filter((r) => r.pending_out > 0 || r.pending_in > 0).length,
      drift_products: rows.filter((r) => r.veeqo_match === 'drift').length,
    };
  }

  // ── wiring ─────────────────────────────────────────────────

  const ok = (res, data) => res.json({ data });

  /** Envolve um handler com o gate de permissão + tradução de erro. */
  function route(method, path, mode, handler) {
    router[method](BASE + path, async (req, res) => {
      const allowed = mode === 'write' ? canWrite(req) : canRead(req);
      if (!allowed) {
        return err(res, 'forbidden',
          mode === 'write' ? 'Este login não pode editar estoque.' : 'Este login não pode ver estoque.', 403);
      }
      try {
        await handler(req, res);
      } catch (e) {
        const status = statusFor(e);
        if (status === 500) console.error('[warehouse]', method.toUpperCase(), path, '-', e.message);
        return err(res, codeFor(status), e.message, status);
      }
    });
  }

  /** product_id da rota, validado. */
  function productIdOf(req) {
    const id = intOf(req.params.id);
    if (!id) throw new Error('product_id inválido');
    return id;
  }

  /**
   * A FILA em uma frase: quantas propostas esperam e há quanto tempo a mais velha
   * espera. É o número que decide se alguém precisa parar e aprovar agora — o
   * celular e o topo do hub mostram isso antes de qualquer outra coisa.
   * is_test fora, igual ao resto do overview (o sandbox não enche a fila real).
   */
  async function pendingSummary() {
    const r = await db.query(`
      SELECT COUNT(*)::int AS count,
             MAX(EXTRACT(EPOCH FROM (NOW() - created_at))::int / 60) AS oldest_age_min
        FROM v3.stock_change_requests
       WHERE status = 'pending' AND is_test = false`);
    const row = (r.rows && r.rows[0]) || {};
    const count = Number(row.count) || 0;
    return { count, oldest_age_min: count > 0 && row.oldest_age_min != null
      ? Number(row.oldest_age_min) : null };
  }

  // ── LEITURA ────────────────────────────────────────────────

  route('get', '/overview', 'read', async (req, res) => {
    const [all, pending] = await Promise.all([rowsWithVeeqo(null), pendingSummary()]);
    // KPI "Aprovações" e o badge do menu mostram O MESMO número: propostas
    // esperando (não produtos com proposta). Uma fonte só: pendingSummary.
    //
    // KPIs e "Precisa de atenção hoje" são do ARMAZÉM INTEIRO, sempre sobre `all`:
    // filtrar a tabela não pode fazer sumir o alerta de um produto zerado que
    // está fora da página. A paginação é da LISTA, não dos fatos.
    const kpis = Object.assign(kpisFrom(all), { pending_requests: pending.count });
    const page = applyQuery(all, req.query || {});
    ok(res, {
      products: page.rows,
      total: page.total,             // linhas que passaram no filtro (antes da página)
      limit: page.limit, offset: page.offset,
      kpis,
      attention: attentionFrom(all),
      pending_summary: pending,
      veeqo_checked_at: veeqoCache.checkedAt(),
      generated_at: new Date().toISOString(),
    });
  });

  route('get', '/product/:id', 'read', async (req, res) => {
    const id = productIdOf(req);
    const detail = await stock.productDetail(id);
    if (!detail) return err(res, 'not_found', 'produto não existe: ' + id, 404);
    const bySku = await veeqoCache.bySku();
    const product = enrich(detail.product, bySku);
    const fam = await family.forProduct(id, product.available);
    ok(res, { ...detail, product, family: fam });
  });

  // ── ESCRITA de estoque ─────────────────────────────────────

  // ENTRADA: sem bin e sem caixa → "a organizar" (Bruno 08-18).
  route('post', '/product/:id/entrada', 'write', async (req, res) => {
    const id = productIdOf(req);
    const b = req.body || {};
    const qty = intOf(b.qty);
    if (!qty || qty <= 0) throw new Error('qty inválido (inteiro > 0)');
    let boxId = intOf(b.box_id);
    if (!boxId && b.box_number) {
      const box = await locations.upsertBox({ box_number: b.box_number, area: b.area, product_id: id });
      boxId = box.id;
    }
    await stock.storeIn({
      ...actor(req, b.note || ''), product_id: id, qty,
      bin_id: intOf(b.bin_id) || null, box_id: boxId || null,
    });
    await audit(req, 'warehouse.entrada', id, { qty, bin_id: intOf(b.bin_id) || null, box_id: boxId || null });
    ok(res, { ok: true, product: await freshRow(id) });
  });

  // ORGANIZAR: "a organizar" → prateleira/caixa.
  route('post', '/product/:id/place', 'write', async (req, res) => {
    const id = productIdOf(req);
    const b = req.body || {};
    const qty = intOf(b.qty);
    if (!qty || qty <= 0) throw new Error('qty inválido (inteiro > 0)');
    await stock.place({
      ...actor(req, b.note || ''), product_id: id, qty,
      bin_id: intOf(b.bin_id) || null, box_id: intOf(b.box_id) || null,
    });
    await audit(req, 'warehouse.place', id, { qty, bin_id: intOf(b.bin_id) || null, box_id: intOf(b.box_id) || null });
    ok(res, { ok: true, product: await freshRow(id) });
  });

  // MOVER: bin ↔ caixa (total não muda).
  route('post', '/product/:id/move', 'write', async (req, res) => {
    const id = productIdOf(req);
    const b = req.body || {};
    const qty = intOf(b.qty);
    if (!qty || qty <= 0) throw new Error('qty inválido (inteiro > 0)');
    const from = b.from || {}; const to = b.to || {};
    await stock.move({
      ...actor(req, b.note || ''), product_id: id, qty,
      from: { bin_id: intOf(from.bin_id) || null, box_id: intOf(from.box_id) || null },
      to: { bin_id: intOf(to.bin_id) || null, box_id: intOf(to.box_id) || null },
    });
    await audit(req, 'warehouse.move', id, { qty, from, to });
    ok(res, { ok: true, product: await freshRow(id) });
  });

  // AJUSTAR: ± com motivo obrigatório.
  route('post', '/product/:id/adjust', 'write', async (req, res) => {
    const id = productIdOf(req);
    const b = req.body || {};
    const qty = intOf(b.qty);
    if (!qty || qty === 0) throw new Error('qty inválido (inteiro diferente de zero)');
    if (!b.reason) throw new Error('reason obrigatório');
    await stock.adjust({
      ...actor(req, ''), product_id: id, qty,
      bin_id: intOf(b.bin_id) || null, box_id: intOf(b.box_id) || null,
      note: `[${(req.login && req.login.name) || 'admin'}] ${b.reason}`,
    });
    await audit(req, 'warehouse.adjust', id, { qty, reason: b.reason });
    ok(res, { ok: true, product: await freshRow(id) });
  });

  // SEPARAR: label/seal/other deduzem a prateleira; return NÃO deduz nada.
  route('post', '/product/:id/separate', 'write', async (req, res) => {
    const id = productIdOf(req);
    const b = req.body || {};
    const qty = intOf(b.qty);
    if (!qty || qty <= 0) throw new Error('qty inválido (inteiro > 0)');
    const reason = ['label', 'seal', 'other', 'return'].includes(b.reason) ? b.reason : 'other';
    await stock.separate({
      ...actor(req, b.note || ''), product_id: id, qty, reason,
      bin_id: intOf(b.bin_id) || null, order_number: b.order_number || null,
    });
    await audit(req, 'warehouse.separate', id, { qty, reason, order_number: b.order_number || null });
    ok(res, { ok: true, product: await freshRow(id) });
  });

  // RESOLVER uma Separada (volta pro estoque / relabel / descarte).
  route('post', '/issues/:id/resolve', 'write', async (req, res) => {
    const issueId = intOf(req.params.id);
    if (!issueId) throw new Error('issue_id inválido');
    const b = req.body || {};
    const out = await stock.resolveIssue({
      ...actor(req, b.note || ''), issue_id: issueId, action: b.action,
      bin_id: intOf(b.bin_id) || null, box_id: intOf(b.box_id) || null,
      source_ref: 'issue:' + issueId,
    });
    await audit(req, 'warehouse.issue_resolve', issueId, { action: b.action });
    ok(res, { ok: true, product: await freshRow(out.issue.product_id) });
  });

  // ── FILA DE APROVAÇÃO ──────────────────────────────────────

  route('get', '/requests', 'read', async (req, res) => {
    const rows = await requests.list({
      status: req.query.status || null,
      product_id: req.query.product_id ? intOf(req.query.product_id) : null,
    });
    ok(res, { requests: rows });
  });

  route('post', '/requests', 'write', async (req, res) => {
    const b = req.body || {};
    const row = await requests.propose({
      product_id: intOf(b.product_id), kind: b.kind, direction: b.direction,
      qty: intOf(b.qty), bin_id: intOf(b.bin_id) || null, box_id: intOf(b.box_id) || null,
      issue_id: intOf(b.issue_id) || null, reason: b.reason || null, note: b.note || null,
      person_id: (req.login && req.login.person_id) || null,
      login: (req.login && req.login.name) || null,
    });
    ok(res, { ok: true, request: row, product: await freshRow(row.product_id) });
  });

  route('post', '/requests/:id/approve', 'write', async (req, res) => {
    const id = intOf(req.params.id);
    if (!id) throw new Error('id inválido');
    const row = await requests.approve({
      id, login: (req.login && req.login.name) || null,
      person_id: (req.login && req.login.person_id) || null,
      note: (req.body && req.body.note) || null,
    });
    ok(res, { ok: true, request: row, product: await freshRow(row.product_id) });
  });

  route('post', '/requests/:id/reject', 'write', async (req, res) => {
    const id = intOf(req.params.id);
    if (!id) throw new Error('id inválido');
    const row = await requests.reject({
      id, login: (req.login && req.login.name) || null,
      person_id: (req.login && req.login.person_id) || null,
      note: (req.body && req.body.note) || null,
    });
    ok(res, { ok: true, request: row, product: await freshRow(row.product_id) });
  });

  // ── LOCAIS (Blocker #1: sem bin/caixa cadastrada tudo é zero) ──

  route('get', '/locations', 'read', async (req, res) => {
    ok(res, await locations.list());
  });

  route('post', '/locations/bin', 'write', async (req, res) => {
    const b = req.body || {};
    const bin = await locations.upsertBin({
      bin_code: b.bin_code, shelf_code: b.shelf_code, area: b.area,
      product_id: intOf(b.product_id) || null, min_qty: b.min_qty,
    });
    await audit(req, 'warehouse.bin_upsert', bin.id, { bin_code: bin.bin_code });
    ok(res, { ok: true, bin, product: bin.product_id ? await freshRow(bin.product_id) : null });
  });

  /**
   * CADASTRO EM LOTE de prateleiras (Bruno 08-19): {bins:[{bin_code, shelf, area,
   * product_id, capacity}]}. Um corredor inteiro de uma vez, colado de uma lista.
   *
   * Código já existente é PULADO, nunca sobrescrito (volta em `skipped`): quem
   * cola a lista de novo não pode apagar o produto ou o mínimo que alguém ajustou.
   * Teto de 300 por chamada — acima disso é arquivo, não formulário.
   * `shelf` e `shelf_code` valem os dois (a tela manda `shelf`, a coluna é
   * `shelf_code`; recusar por causa do nome do campo seria burocracia).
   */
  route('post', '/locations/bins/bulk', 'write', async (req, res) => {
    const list = Array.isArray(req.body && req.body.bins) ? req.body.bins : null;
    if (!list || !list.length) throw new Error('bins obrigatório (lista com pelo menos um código)');
    if (list.length > BULK_BINS_CAP) {
      // "inválid" no texto: é o que statusFor lê pra devolver 400 em vez de 500
      throw new Error(`lista inválida: máximo de ${BULK_BINS_CAP} prateleiras por vez, vieram ${list.length}`);
    }
    const clean = []; const invalid = [];
    for (const b of list) {
      const code = String((b && b.bin_code) || '').trim().toUpperCase();
      if (!code || code.length > BIN_CODE_MAX) { invalid.push(code || '(vazio)'); continue; }
      clean.push({ bin_code: code, shelf_code: b.shelf_code || b.shelf || null,
        area: b.area || null, product_id: intOf(b.product_id) || null,
        capacity: b.capacity, min_qty: b.min_qty });
    }
    if (!clean.length) throw new Error('lista inválida: nenhum código aproveitável (até ' + BIN_CODE_MAX + ' caracteres)');
    const out = await locations.bulkBins(clean);
    // invalid entra no skipped: o operador vê TUDO que não virou prateleira, num lugar só
    const skipped = out.skipped.concat(invalid);
    await audit(req, 'warehouse.bins_bulk', null, { created: out.created, skipped: skipped.length });
    ok(res, { created: out.created, skipped });
  });

  route('post', '/locations/box', 'write', async (req, res) => {
    const b = req.body || {};
    const box = await locations.upsertBox({
      box_number: b.box_number, area: b.area, product_id: intOf(b.product_id) || null,
    });
    // qty inicial informada = ENTRADA de verdade (pelo StockService, com movimento).
    const qty = intOf(b.qty);
    if (qty && qty > 0 && box.product_id) {
      await stock.storeIn({
        ...actor(req, 'cadastro da caixa ' + box.box_number),
        product_id: box.product_id, qty, box_id: box.id,
      });
    }
    await audit(req, 'warehouse.box_upsert', box.id, { box_number: box.box_number, qty: qty || 0 });
    ok(res, { ok: true, box, product: box.product_id ? await freshRow(box.product_id) : null });
  });

  route('post', '/locations/bin/:id/deactivate', 'write', async (req, res) => {
    const id = intOf(req.params.id);
    if (!id) throw new Error('id inválido');
    const bin = await locations.deactivateBin(id);
    await audit(req, 'warehouse.bin_deactivate', id, { bin_code: bin.bin_code });
    ok(res, { ok: true, bin, product: bin.product_id ? await freshRow(bin.product_id) : null });
  });

  // ── FAMÍLIA / SKUs ─────────────────────────────────────────

  route('get', '/family/:productId', 'read', async (req, res) => {
    const id = intOf(req.params.productId);
    if (!id) throw new Error('product_id inválido');
    const row = await freshRow(id);
    ok(res, await family.forProduct(id, row ? row.available : null));
  });

  route('post', '/family/:productId/attach', 'write', async (req, res) => {
    const id = intOf(req.params.productId);
    if (!id) throw new Error('product_id inválido');
    const b = req.body || {};
    const sku = await family.attach({
      product_id: id, sku: b.sku, channel: b.channel,
      units_per_pack: b.role === 'base' ? 1 : (intOf(b.units_per_pack) || 1),
      person_id: (req.login && req.login.person_id) || null,
    });
    await audit(req, 'warehouse.family_attach', id, { sku: sku.sku, channel: sku.channel, units_per_pack: sku.units_per_pack });
    ok(res, { ok: true, sku, product: await freshRow(id) });
  });

  route('post', '/family/detach', 'write', async (req, res) => {
    const b = req.body || {};
    const skuId = intOf(b.sku_id);
    if (!skuId) throw new Error('sku_id inválido');
    const removed = await family.detach(skuId);
    await audit(req, 'warehouse.family_detach', skuId, { sku: removed.sku, product_id: removed.product_id });
    ok(res, { ok: true, sku: removed, product: await freshRow(removed.product_id) });
  });

  /**
   * MERGE de duas linhas do hub que são a MESMA garrafa (Bruno 08-19).
   * Move SKUs + estoque, RETIRA o fantasma e devolve o resultado completo. O
   * audit guarda os sku_ids porque é deles que o unmerge sabe o que devolver.
   */
  route('post', '/family/merge', 'write', async (req, res) => {
    const b = req.body || {};
    const from = intOf(b.from_product_id); const into = intOf(b.into_product_id);
    if (!from || !into) throw new Error('from_product_id e into_product_id obrigatórios');
    const out = await family.merge({ from_product_id: from, into_product_id: into,
      person_id: (req.login && req.login.person_id) || null });
    await audit(req, 'warehouse.family_merge', out.parent.product_id, {
      from_product_id: from, moved: out.moved_skus.length, moved_qty: out.moved_qty,
      retired_product_id: out.retired_product_id,
      sku_ids: out.moved_skus.map((s) => s.id) });
    ok(res, { ok: true, ...out, product: await freshRow(out.parent.product_id) });
  });

  /**
   * MERGE EM LOTE: a tela de sugestões manda vários grupos confirmados de uma vez
   * (é assim que 190 linhas viram ~120 sem 70 cliques). Um grupo que falha NÃO
   * derruba os outros — cada um volta com seu próprio ok/erro, senão o operador
   * perde o lote inteiro por causa de um id errado.
   */
  route('post', '/family/merge-bulk', 'write', async (req, res) => {
    const groups = Array.isArray(req.body && req.body.groups) ? req.body.groups : null;
    if (!groups || !groups.length) throw new Error('groups obrigatório (lista com pelo menos um grupo)');
    if (groups.length > MERGE_BULK_CAP) {
      throw new Error(`lista inválida: máximo de ${MERGE_BULK_CAP} grupos por vez, vieram ${groups.length}`);
    }
    const results = [];
    let mergedProducts = 0; let movedQty = 0;
    for (const g of groups) {
      const into = intOf(g && g.into_product_id);
      const froms = Array.isArray(g && g.from_product_ids)
        ? g.from_product_ids.map(intOf).filter((x) => x) : [];
      if (!into || !froms.length) {
        results.push({ into_product_id: into || null, ok: false,
          error: 'into_product_id e from_product_ids obrigatórios' });
        continue;
      }
      const merged = []; const failed = [];
      for (const from of froms) {
        if (from === into) continue;                 // juntar consigo mesmo é no-op
        try {
          const out = await family.merge({ from_product_id: from, into_product_id: into,
            person_id: (req.login && req.login.person_id) || null });
          await audit(req, 'warehouse.family_merge', out.parent.product_id, {
            from_product_id: from, moved: out.moved_skus.length, moved_qty: out.moved_qty,
            retired_product_id: out.retired_product_id, bulk: true,
            sku_ids: out.moved_skus.map((s) => s.id) });
          merged.push({ from_product_id: from, moved_skus: out.moved_skus.length,
            moved_qty: out.moved_qty, retired_product_id: out.retired_product_id });
          mergedProducts += 1; movedQty += out.moved_qty;
        } catch (e) {
          failed.push({ from_product_id: from, error: e.message });
        }
      }
      results.push({ into_product_id: into, ok: !failed.length, merged, failed,
        product: await freshRow(into) });
    }
    ok(res, { results, merged_products: mergedProducts, moved_qty: movedQty,
      groups: results.length });
  });

  /** DESFAZER: o produto volta pro hub e os SKUs daquele merge voltam com ele. */
  route('post', '/family/unmerge', 'write', async (req, res) => {
    const id = intOf(req.body && req.body.product_id);
    if (!id) throw new Error('product_id obrigatório');
    const out = await family.unmerge({ product_id: id,
      person_id: (req.login && req.login.person_id) || null });
    await audit(req, 'warehouse.family_unmerge', id, {
      was_merged_into: out.was_merged_into,
      returned_skus: out.returned_skus.length });
    ok(res, { ok: true, ...out, product: await freshRow(id) });
  });

  /**
   * SUGESTÕES de parentesco: grupos de linhas que provavelmente são a MESMA
   * garrafa, com o motivo em português. NUNCA junta nada — quem confirma é gente
   * (merge errado manda a garrafa errada pro cliente).
   */
  route('get', '/sku-suggestions', 'read', async (req, res) => {
    const [rows, bySku] = await Promise.all([rowsWithVeeqo(null), veeqoCache.bySku()]);
    ok(res, { ...suggest(rows, bySku), generated_at: new Date().toISOString() });
  });

  /**
   * PRÉVIA DA SINCRONIZAÇÃO COM A VEEQO (S15.39, Bruno 08-19). O plano do que o
   * sync FARIA, sem escrever nada: ligações novas, produtos que faltam,
   * conflitos que precisam de gente e os SKUs ignorados (serviço/plano/insumo).
   *
   * É read, não write, de propósito: quem só olha o estoque pode ver o tamanho
   * do buraco de mapeamento sem poder mexer nele.
   */
  route('get', '/sku-sync/preview', 'read', async (req, res) => {
    const out = await skuSync.preview();
    // ABSORÇÃO (S15.41): junto do plano de mapeamento vai o retrato do que a
    // gente TEM guardado do catálogo. É a resposta à pergunta do Bruno ("se
    // fechar a conta hoje...") em número: quantos SKUs ainda estão sem título,
    // sem foto e sem UPC. Falha da absorção não derruba o preview do mapeamento
    // (são duas perguntas independentes); vira absorb:null.
    let absorb = null;
    try {
      const a = await veeqoAbsorb.preview();
      absorb = { stats: a.stats, updates: a.updates.length, downloads: a.downloads.length };
    } catch (e) {
      console.error('[warehouse] preview absorção:', e.message);
    }
    ok(res, { ...out, absorb, veeqo_checked_at: veeqoCache.checkedAt(),
      generated_at: new Date().toISOString() });
  });

  /**
   * A FOTO DO PRODUTO, dos NOSSOS bytes (S15.41). Não redireciona pro link da
   * Veeqo de propósito: o ponto da absorção é justamente não depender dele. 404
   * quando o produto ainda não teve foto baixada — o cliente cai no placeholder.
   *
   * Cache longo: a foto de um produto praticamente não muda, e quando muda o
   * product_id continua o mesmo, então o navegador só reconfere depois de 1 dia.
   */
  route('get', '/image/:product_id', 'read', async (req, res) => {
    const pid = intOf(req.params.product_id);
    if (!pid) return err(res, 'bad_request', 'product_id inválido', 400);
    const row = await veeqoAbsorb.imageOf(pid);
    if (!row || !row.bytes) return err(res, 'not_found', 'Este produto ainda não tem foto guardada.', 404);
    res.setHeader('Content-Type', row.mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.end(row.bytes);
  });

  /**
   * APLICAR: liga os SKUs novos no pai e corrige units_per_pack errado. Cria
   * produto novo SÓ com {create_missing:true} explícito no corpo — o default é
   * NÃO criar, porque um typo de SKU na Veeqo não pode virar linha no hub.
   * NUNCA junta dois produtos (isso é o "Juntar SKUs", com gente na frente) e
   * NUNCA escreve quantidade.
   */
  route('post', '/sku-sync/apply', 'write', async (req, res) => {
    const b = req.body || {};
    const createMissing = b.create_missing === true;
    const planOut = await skuSync.preview();
    const applied = await skuSync.apply(planOut, {
      create_missing: createMissing,
      person_id: (req.login && req.login.person_id) || null,
    });
    await audit(req, 'warehouse.sku_sync_apply', null, {
      create_missing: createMissing, linked: applied.linked,
      units_fixed: applied.units_fixed, created: applied.created,
      conflicts: (planOut.conflicts || []).length });
    ok(res, { ...applied, plan: { stats: planOut.stats, conflicts: planOut.conflicts,
      create: planOut.create }, generated_at: new Date().toISOString() });
  });

  // ── S15 FASE 3 — IMPORT DA VEEQO ───────────────────────────
  // Botão "Importar da Veeqo": traz o saldo dela pro nosso livro. Sobe estoque
  // (entrada de verdade, pelo StockService), nunca desce sozinho.
  route('post', '/import-veeqo', 'write', async (req, res) => {
    const b = req.body || {};
    const productId = intOf(b.product_id) || null;
    await veeqoCache.warm();                 // o import não pode rodar com cache vazio
    const out = await importVeeqo({ stock, veeqoCache }, {
      product_id: productId,
      person_id: (req.login && req.login.person_id) || null,
      login: (req.login && req.login.name) || null,
    });
    await audit(req, 'warehouse.import_veeqo', productId, {
      imported: out.imported.length, negative: out.negative.length, skipped: out.skipped });
    ok(res, out);
  });

  // ── S15 FASE 3 — DRIFT (mesma conta que o worker do Slack usa) ──
  route('get', '/drift', 'read', async (req, res) => {
    const items = await computeDrift({ stock, veeqoCache });
    ok(res, { drift: items, checked_at: veeqoCache.checkedAt(),
      generated_at: new Date().toISOString() });
  });

  // ── S15 FASE 3 — PESOS E TARAS ─────────────────────────────
  route('get', '/weights', 'read', async (req, res) => {
    ok(res, await weights.list());
  });

  // peso por garrafa: direto OU calibrado de uma amostra pesada
  route('post', '/weights/product/:id', 'write', async (req, res) => {
    const id = productIdOf(req);
    const b = req.body || {};
    const row = await weights.setUnitWeight({ product_id: id, ...b });
    await audit(req, 'warehouse.unit_weight', id, { unit_weight_g: row.unit_weight_g, samples: row.samples });
    ok(res, { ok: true, product: row });
  });

  route('post', '/weights/tare', 'write', async (req, res) => {
    const row = await weights.upsertTare(req.body || {});
    await audit(req, 'warehouse.tare_preset', row.id, { name: row.name, kind: row.kind, tare_g: row.tare_g });
    ok(res, { ok: true, tare: row });
  });

  route('post', '/weights/bin/:id', 'write', async (req, res) => {
    const id = intOf(req.params.id);
    if (!id) throw new Error('bin_id inválido');
    const row = await weights.setBin(id, req.body || {});
    await audit(req, 'warehouse.bin_weight', id, { tare_g: row.tare_g, capacity: row.capacity });
    ok(res, { ok: true, bin: row });
  });

  route('post', '/weights/box/:id', 'write', async (req, res) => {
    const id = intOf(req.params.id);
    if (!id) throw new Error('box_id inválido');
    const row = await weights.setBox(id, req.body || {});
    await audit(req, 'warehouse.box_weight', id, { tare_g: row.tare_g,
      batch_number: row.batch_number, sealed: row.sealed });
    ok(res, { ok: true, box: row });
  });

  // ── S15 FASE 3 — PESO VIRA CONTAGEM (só calcula, não escreve) ──
  route('post', '/count/compute', 'read', async (req, res) => {
    const b = req.body || {};
    const productId = intOf(b.product_id);
    if (!productId) throw new Error('product_id inválido');
    ok(res, await weights.compute({
      product_id: productId, gross_g: b.gross_g, tare_g: b.tare_g,
      bin_id: intOf(b.bin_id) || null, box_id: intOf(b.box_id) || null,
    }));
  });

  // ── S15 FASE 3 — ETIQUETAS (o dashboard desenha Code128 + QR no cliente) ──
  // A etiqueta é sempre: código grande, uma linha de onde/o quê, uma de quanto.
  //
  // labelsFor é uma FUNÇÃO (não só um handler) porque o celular precisa das
  // mesmas etiquetas resolvidas do mesmo jeito na hora de enfileirar a impressão
  // (mobile.printSubmit). Duas montagens do mesmo texto sairiam diferentes um dia.
  async function labelsFor(binIds, boxIds) {
    const labels = [];
    if (binIds && binIds.length) {
      const rows = (await db.query(
        `SELECT b.id, b.bin_code, b.shelf_code, b.area, b.qty, b.capacity,
                COALESCE(p.nickname, p.canonical_name) AS product
           FROM v3.stock_bins b LEFT JOIN v3.products p ON p.id = b.product_id
          WHERE b.id = ANY($1::int[]) ORDER BY b.bin_code`, [binIds])).rows;
      for (const r of rows) {
        labels.push({ kind: 'bin', id: r.id, code: r.bin_code,
          line2: [r.shelf_code, r.area].filter(Boolean).join(' · ') || (r.product || 'sem produto'),
          line3: r.product ? r.product : (r.capacity ? 'cabe ' + r.capacity : ''),
          url: '/scan/?b=' + encodeURIComponent(r.bin_code) });
      }
    }
    if (boxIds && boxIds.length) {
      const rows = (await db.query(
        `SELECT x.id, x.box_number, x.area, x.qty, x.batch_number, x.sealed,
                COALESCE(p.nickname, p.canonical_name) AS product
           FROM v3.stock_boxes x LEFT JOIN v3.products p ON p.id = x.product_id
          WHERE x.id = ANY($1::int[]) ORDER BY x.box_number`, [boxIds])).rows;
      for (const r of rows) {
        labels.push({ kind: 'box', id: r.id, code: r.box_number,
          line2: r.product || 'sem produto',
          line3: (Number(r.qty) || 0) + ' garrafas'
            + (r.batch_number ? ' · lote ' + r.batch_number : ''),
          url: '/scan/?x=' + encodeURIComponent(r.box_number) });
      }
    }
    return labels;
  }

  route('get', '/labels', 'read', async (req, res) => {
    const csv = (v) => String(v || '').split(',').map((x) => intOf(x)).filter((x) => x);
    ok(res, { labels: await labelsFor(csv(req.query.bins), csv(req.query.boxes)) });
  });

  // etiqueta saiu da impressora → carimba (a caixa sem etiqueta é caixa perdida)
  route('post', '/locations/box/:id/label-printed', 'write', async (req, res) => {
    const id = intOf(req.params.id);
    if (!id) throw new Error('box_id inválido');
    const r = await db.query(
      `UPDATE v3.stock_boxes SET label_printed_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING id, box_number, label_printed_at`, [id]);
    if (!r.rows[0]) return err(res, 'not_found', 'caixa não existe: ' + id, 404);
    await audit(req, 'warehouse.box_label_printed', id, { box_number: r.rows[0].box_number });
    ok(res, { ok: true, box: r.rows[0] });
  });

  // ── S15 FASE 3 — UPC da Veeqo → product_skus.barcode ───────
  // Sem isso o operador escaneia a garrafa e o sistema não sabe o que é. O UPC
  // já está na Veeqo; só falta copiar pros SKUs que a gente mapeou.
  route('post', '/skus/import-upc', 'write', async (req, res) => {
    await veeqoCache.warm();
    const bySku = await veeqoCache.bySku();
    const rows = (await db.query(
      'SELECT id, sku, barcode FROM v3.product_skus WHERE channel = $1', ['veeqo'])).rows;
    let updated = 0;
    for (const s of rows) {
      const info = bySku[String(s.sku).trim().toUpperCase()];
      const upc = info && info.upc ? String(info.upc).trim() : null;
      if (!upc || upc === s.barcode) continue;
      await db.query('UPDATE v3.product_skus SET barcode = $2 WHERE id = $1', [s.id, upc]);
      updated += 1;
    }
    await audit(req, 'warehouse.import_upc', null, { updated });
    ok(res, { updated });
  });

  // ── S15.35 — MOBILE (/m/ no iPhone, Bruno 08-19) ───────────
  // Mesmo router, mesma auth, mesmo RBAC, mesmo envelope: o celular é só mais um
  // cliente do hub. O módulo mobile.js reusa rowsWithVeeqo / kpisFrom /
  // attentionFrom / pendingSummary / labelsFor — nenhum número é recalculado por
  // outro caminho, então o celular e o dashboard nunca discordam.
  const mobile = deps.mobile || createMobile({
    db, requests, locations, queue: deps.printQueue || null,
    rowsWithVeeqo, kpisFrom, attentionFrom, pendingSummary, labelsFor,
    opWarehouse: deps.opWarehouse || null,
  });

  route('get', '/mobile/bootstrap', 'read', async (req, res) => {
    ok(res, await mobile.bootstrap(req));
  });

  route('get', '/mobile/scan/resolve', 'read', async (req, res) => {
    ok(res, await mobile.scanResolve(req));
  });

  route('get', '/mobile/printers', 'read', async (req, res) => {
    ok(res, await mobile.printers());
  });

  // enfileirar impressão MEXE em papel do armazém → manage_stock, como toda ação
  route('post', '/mobile/print/submit', 'write', async (req, res) => {
    const out = await mobile.printSubmit(req);
    await audit(req, 'warehouse.mobile_print_submit', out.job_id,
      { kind: out.job.kind, queued: out.queued });
    ok(res, { job_id: out.job_id, queued: out.queued, labels: out.labels, job: out.job });
  });

  console.log('[V3] Warehouse hub montado: ' + BASE + '/* (+ mobile)');
  return router;
}

module.exports = { createWarehouseRouter, BASE, computeDrift, importVeeqo, applyQuery,
  IMPORT_BULK_CAP, BULK_BINS_CAP, BIN_CODE_MAX, MERGE_BULK_CAP, SORTABLE, PAGE_MAX };
