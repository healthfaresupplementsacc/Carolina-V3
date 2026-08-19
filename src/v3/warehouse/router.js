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

const BASE = '/api/v3/warehouse';
const EDT = 'America/New_York';
const IMPORT_BULK_CAP = 500;
const BULK_BINS_CAP = 300;   // cadastro em lote de prateleiras, por chamada
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
  const family = deps.family || new FamilyRepo({ db, veeqoCache });
  const weights = deps.weights || new WeightsRepo({ db });
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
    }
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
    const [rows, pending] = await Promise.all([rowsWithVeeqo(null), pendingSummary()]);
    // KPI "Aprovações" e o badge do menu mostram O MESMO número: propostas
    // esperando (não produtos com proposta). Uma fonte só: pendingSummary.
    const kpis = Object.assign(kpisFrom(rows), { pending_requests: pending.count });
    ok(res, {
      products: rows,
      kpis,
      attention: attentionFrom(rows),
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

  route('post', '/family/merge', 'write', async (req, res) => {
    const b = req.body || {};
    const from = intOf(b.from_product_id); const into = intOf(b.into_product_id);
    if (!from || !into) throw new Error('from_product_id e into_product_id obrigatórios');
    const out = await family.merge({ from_product_id: from, into_product_id: into });
    await audit(req, 'warehouse.family_merge', into, { from_product_id: from, moved: out.moved });
    ok(res, { ok: true, moved: out.moved, product: await freshRow(into) });
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
  route('get', '/labels', 'read', async (req, res) => {
    const idsOf = (v) => String(v || '').split(',').map((x) => intOf(x)).filter((x) => x);
    const binIds = idsOf(req.query.bins);
    const boxIds = idsOf(req.query.boxes);
    const labels = [];
    if (binIds.length) {
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
    if (boxIds.length) {
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
    ok(res, { labels });
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

  console.log('[V3] Warehouse hub montado: ' + BASE + '/*');
  return router;
}

module.exports = { createWarehouseRouter, BASE, computeDrift, importVeeqo,
  IMPORT_BULK_CAP, BULK_BINS_CAP, BIN_CODE_MAX };
