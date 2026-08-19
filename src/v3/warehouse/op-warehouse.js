'use strict';
/**
 * HEALTHFARE V3 — Hub de estoque do OPERADOR (S15 Fase 3, Bruno 08-18).
 *
 * TODA a lógica do /op/estoque mora aqui. src/routes/op.js só REGISTRA rotas finas
 * (arquivo grande demais, regra do CLAUDE.md: nada de linha nova lá). Mesmo padrão
 * do op-stock.js da Fase 2: cada função recebe (session, body|query [, res]) e
 * devolve {status?, body} — este módulo não conhece Express (a única exceção é o
 * `stream`, porque SSE É a resposta e precisa do res cru).
 *
 * O QUE MUDA O TOTAL ESPERA APROVAÇÃO. O que só muda de LUGAR aplica na hora:
 *   organizar (a organizar → prateleira/caixa)  → StockService.place, IMEDIATO
 *   contagem (peso ou manual)                   → proposta kind 'count' com meta
 *   caixa nova (entrada)                        → proposta kind 'entrada' com meta.box
 * Regra #0: nada aqui bloqueia o operador. Falta peso unitário? A contagem vira
 * manual, com o resíduo registrado, e o admin decide. Nunca "não dá, tente depois".
 *
 * createOpWarehouse({db, stock, requests, veeqoCache?, scanHub?, weights?})
 *   db        pool pg
 *   stock     StockService (porta única de escrita)
 *   requests  StockRequestService (fila de aprovação)
 *   weights   WeightsRepo (peso/tara; criado sozinho se não vier)
 *   scanHub   registro de pareamento + SSE (criado sozinho se não vier)
 */

const { createScanHub, KEEPALIVE_MS } = require('./scan-hub');
const { WeightsRepo } = require('./weights');

const TASK_COUNT_SUGGESTIONS = 2;   // 2 contagens cíclicas por dia (o operador termina)
const LOOKUP_LIMIT = 20;

function bad(error, detail) { return { status: 400, body: detail ? { error, detail } : { error } }; }
function gone(error, detail) { return { status: 410, body: detail ? { error, detail } : { error } }; }
function intOf(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function numOf(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function textOf(v, max) { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null; }

/**
 * Barcode → o que é isso. Ordem: bin exato → caixa → UPC → SKU → formas de URL.
 * A ordem importa: um código de bin ('A03B2') nunca deve cair no LIKE de SKU, e o
 * QR das nossas etiquetas carrega a URL inteira (o celular lê a URL, não o código).
 */
function parseBarcode(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // formas de URL/QR das nossas próprias etiquetas
  const bin = s.match(/^bin:(.+)$/i);
  if (bin) return { hint: 'bin', value: bin[1].trim() };
  const box = s.match(/^box:(.+)$/i);
  if (box) return { hint: 'box', value: box[1].trim() };
  const hash = s.match(/#estoque\/p\/(\d+)/);
  if (hash) return { hint: 'product_id', value: hash[1] };
  const urlQ = s.match(/[?&](?:b|bin)=([^&\s]+)/);
  if (urlQ) return { hint: 'bin', value: decodeURIComponent(urlQ[1]) };
  const urlBox = s.match(/[?&](?:x|box)=([^&\s]+)/);
  if (urlBox) return { hint: 'box', value: decodeURIComponent(urlBox[1]) };
  const urlP = s.match(/[?&]p=(\d+)/);
  if (urlP) return { hint: 'product_id', value: urlP[1] };
  return { hint: 'any', value: s };
}

function createOpWarehouse(deps = {}) {
  const db = deps.db;
  const stock = deps.stock;
  const requests = deps.requests;
  const weights = deps.weights || new WeightsRepo({ db });
  const scanHub = deps.scanHub || createScanHub({ db });

  // ── SCANNER PAREADO ──────────────────────────────────────────

  /** POST scan/pair (sessão do kiosk) → código + QR pra apontar o celular. */
  async function pairPhone(session, body) {
    const out = await scanHub.pair({
      session_token: session.token || session.session_token || null,
      person_id: session.person_id,
    });
    return { body: { ok: true, code: out.code, expires_at: out.expires_at,
      url: '/scan/?c=' + out.code } };
  }

  /**
   * GET scan/stream?code= (sessão do kiosk) — SSE. Precisa do res cru.
   * Só a MESMA sessão que pareou escuta (senão o kiosk do lado lê os scans daqui).
   */
  async function stream(session, query, res) {
    const code = String((query && query.code) || '').trim().toUpperCase();
    if (!code) return bad('code_required', 'Código do pareamento obrigatório.');
    const row = await scanHub.get(code);
    if (!row) return { status: 404, body: { error: 'pair_unknown', detail: 'Pareamento não existe.' } };
    if (scanHub.isExpired(row)) return gone('pair_expired', 'Pareamento expirou. Gere um código novo.');
    const mine = session.token || session.session_token || null;
    if (row.session_token && mine && row.session_token !== mine) {
      return { status: 403, body: { error: 'pair_not_yours', detail: 'Esse pareamento é de outro computador.' } };
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('event: ready\ndata: ' + JSON.stringify({ code, at: new Date().toISOString() }) + '\n\n');
    scanHub.addClient(code, res);
    // comentário periódico: proxy nenhum mata a conexão por ociosidade.
    // unref: o timer acompanha a conexão, nunca segura o processo vivo sozinho.
    const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch (_) { clearInterval(ka); } }, KEEPALIVE_MS);
    if (typeof ka.unref === 'function') ka.unref();
    if (typeof res.on === 'function') res.on('close', () => clearInterval(ka));
    return { sse: true };
  }

  /**
   * POST scan/push {code, barcode, symbology?} — o CELULAR. Sem sessão: o código
   * de pareamento é a credencial. Expirado → 410 (a tela do celular manda ler o
   * QR de novo). Já resolve o barcode e manda resolvido pro kiosk: o telefone é
   * burro de propósito, quem sabe o que é cada código é o servidor.
   */
  async function push(body) {
    const b = body || {};
    const code = String(b.code || '').trim().toUpperCase();
    const barcode = textOf(b.barcode, 200);
    if (!code) return bad('code_required', 'Código do pareamento obrigatório.');
    if (!barcode) return bad('barcode_required', 'Nada foi lido.');
    const row = await scanHub.get(code);
    if (!row) return { status: 404, body: { error: 'pair_unknown', detail: 'Pareamento não existe.' } };
    if (scanHub.isExpired(row)) return gone('pair_expired', 'Pareamento expirou. Leia o QR de novo.');
    await scanHub.renew(code, { phone_ua: textOf(b.ua, 300) });
    const hit = await resolveBarcode(barcode);
    const delivered = scanHub.broadcast(code, 'scan', {
      type: 'scan', code: barcode, symbology: textOf(b.symbology, 40),
      resolved: hit, at: new Date().toISOString(),
    });
    return { body: { ok: true, delivered, kind: hit.kind } };
  }

  /** POST scan/keepalive {code} — o celular avisa que ainda está lendo. */
  async function keepalive(body) {
    const code = String((body && body.code) || '').trim().toUpperCase();
    if (!code) return bad('code_required', 'Código do pareamento obrigatório.');
    const row = await scanHub.renew(code, { phone_ua: textOf(body && body.ua, 300) });
    if (!row) return { status: 404, body: { error: 'pair_unknown', detail: 'Pareamento não existe.' } };
    return { body: { ok: true, expires_at: new Date(row.expires_at).toISOString(),
      listeners: scanHub.clientCount(code) } };
  }

  /**
   * Resolve um código lido: bin, caixa, produto ou desconhecido.
   * Ordem: bin_code exato → box_number → UPC (barcode) → SKU → nada.
   */
  async function resolveBarcode(raw) {
    const parsed = parseBarcode(raw);
    if (!parsed) return { kind: 'unknown' };
    const v = parsed.value;
    const up = v.toUpperCase();

    if (parsed.hint === 'product_id') {
      const p = await productById(intOf(v));
      return p ? { kind: 'product', product: p } : { kind: 'unknown', raw: v };
    }
    if (parsed.hint !== 'box') {
      const bin = (await db.query(
        `SELECT b.id, b.bin_code, b.shelf_code, b.area, b.qty, b.min_qty, b.capacity, b.tare_g,
                b.product_id, COALESCE(p.nickname, p.canonical_name) AS product
           FROM v3.stock_bins b LEFT JOIN v3.products p ON p.id = b.product_id
          WHERE UPPER(b.bin_code) = $1 AND b.active LIMIT 1`, [up])).rows[0];
      if (bin) return { kind: 'bin', bin };
      if (parsed.hint === 'bin') return { kind: 'unknown', raw: v };
    }
    const box = (await db.query(
      `SELECT x.id, x.box_number, x.area, x.qty, x.tare_g, x.batch_number, x.sealed, x.status,
              x.product_id, COALESCE(p.nickname, p.canonical_name) AS product
         FROM v3.stock_boxes x LEFT JOIN v3.products p ON p.id = x.product_id
        WHERE UPPER(x.box_number) = $1 LIMIT 1`, [up])).rows[0];
    if (box) return { kind: 'box', box };
    if (parsed.hint === 'box') return { kind: 'unknown', raw: v };

    // UPC primeiro (é o que está impresso na garrafa), SKU depois
    const bySku = (await db.query(
      `SELECT product_id FROM v3.product_skus
        WHERE UPPER(COALESCE(barcode,'')) = $1 OR UPPER(sku) = $1
        ORDER BY (UPPER(COALESCE(barcode,'')) = $1) DESC, units_per_pack ASC LIMIT 1`, [up])).rows[0];
    if (bySku) {
      const p = await productById(bySku.product_id);
      if (p) return { kind: 'product', product: p };
    }
    return { kind: 'unknown', raw: v };
  }

  /** GET scan/resolve?barcode= (sessão) */
  async function resolve(session, query) {
    const barcode = textOf(query && query.barcode, 200);
    if (!barcode) return bad('barcode_required', 'Informe o código.');
    const hit = await resolveBarcode(barcode);
    return { body: { ok: true, ...hit } };
  }

  /** Produto + onde ele mora + quanto tem a organizar (o que a tela precisa). */
  async function productById(id) {
    const pid = intOf(id);
    if (!pid) return null;
    const r = (await db.query(
      `SELECT p.id AS product_id, p.canonical_name AS name, p.nickname, p.bottle_color,
              p.unit_weight_g,
              COALESCE(u.qty, 0) AS unplaced_qty
         FROM v3.products p
         LEFT JOIN v3.stock_unplaced u ON u.product_id = p.id
        WHERE p.id = $1`, [pid])).rows[0];
    if (!r) return null;
    const bins = (await db.query(
      `SELECT id, bin_code, shelf_code, area, qty, min_qty, capacity
         FROM v3.stock_bins WHERE product_id = $1 AND active ORDER BY bin_code`, [pid])).rows;
    const boxes = (await db.query(
      `SELECT id, box_number, area, qty, batch_number, sealed
         FROM v3.stock_boxes WHERE product_id = $1 AND status = 'in_storage'
         ORDER BY box_number`, [pid])).rows;
    return {
      product_id: r.product_id, name: r.name, nickname: r.nickname || r.name,
      bottle_color: r.bottle_color || null,
      unit_weight_g: r.unit_weight_g == null ? null : Number(r.unit_weight_g),
      unplaced_qty: Number(r.unplaced_qty) || 0,
      bins, boxes,
      home_bin: bins[0] ? bins[0].bin_code : null,
    };
  }

  // ── ORGANIZAR (aplica na hora: só muda de lugar) ─────────────

  /** POST stock/organize {product_id, qty, bin_id?|box_id?} */
  async function organize(session, body) {
    const b = body || {};
    const productId = intOf(b.product_id);
    const qty = intOf(b.qty);
    const binId = intOf(b.bin_id);
    const boxId = intOf(b.box_id);
    if (productId == null) return bad('product_required', 'Escolha o produto.');
    if (qty == null || qty <= 0 || qty > 100000) return bad('qty_required', 'Quantidade maior que 0.');
    if (binId == null && boxId == null) return bad('location_required', 'Diga a prateleira ou a caixa.');
    if (binId != null && boxId != null) return bad('location_ambiguous', 'Escolha só a prateleira ou só a caixa.');
    const out = await stock.place({
      product_id: productId, qty, bin_id: binId, box_id: boxId,
      person_id: session.person_id, source: 'op_kiosk', actor_type: 'operator',
      note: textOf(b.note, 300), is_test: !!session.is_sandbox,
    });
    return { body: { ok: true, applied: out.applied || 0,
      unplaced: out.unplaced != null ? out.unplaced : null,
      product: await productById(productId) } };
  }

  // ── CONTAR ───────────────────────────────────────────────────

  /**
   * POST stock/count/weigh {product_id, bin_id?|box_id?, gross_g, tare_g?}
   * Balança → qty. Vira PROPOSTA (kind 'count') com o meta da pesagem, pro admin
   * ver de onde saiu o número. Sem peso unitário cadastrado, `qty` volta null e a
   * proposta NÃO é criada: a tela manda contar na mão (nunca chuta um total).
   */
  async function countWeigh(session, body) {
    const b = body || {};
    const productId = intOf(b.product_id);
    const binId = intOf(b.bin_id);
    const boxId = intOf(b.box_id);
    const gross = numOf(b.gross_g);
    if (productId == null) return bad('product_required', 'Escolha o produto.');
    if (binId == null && boxId == null) return bad('location_required', 'Diga a prateleira ou a caixa que você pesou.');
    if (gross == null || gross < 0) return bad('gross_required', 'Informe o peso bruto em gramas.');
    const calc = await weights.compute({ product_id: productId, gross_g: gross,
      tare_g: b.tare_g, bin_id: binId, box_id: boxId });
    if (calc.qty == null) {
      return { status: 409, body: { error: 'no_unit_weight',
        detail: 'Esse produto ainda não tem peso por garrafa. Conte na mão ou calibre o peso.',
        ...calc } };
    }
    const meta = {
      gross_g: gross, tare_g: calc.tare_g, unit_weight_g: calc.unit_weight_g,
      computed_qty: calc.qty, residual_g: calc.residual_g, confidence: calc.confidence,
      method: 'weigh',
    };
    const req = await requests.propose({
      product_id: productId, kind: 'count', direction: 'in', qty: calc.qty,
      bin_id: binId, box_id: boxId, meta,
      reason: textOf(b.reason, 300),
      note: 'contagem por peso: found=' + calc.qty + ' (bruto ' + gross + 'g, tara ' + calc.tare_g + 'g)',
      person_id: session.person_id, login: session.display_name || null,
      is_test: !!session.is_sandbox,
    });
    return { body: { ok: true, request_id: req.id, status: 'pending',
      qty: calc.qty, confidence: calc.confidence, residual_g: calc.residual_g,
      unit_weight_g: calc.unit_weight_g, tare_g: calc.tare_g, net_g: calc.net_g } };
  }

  /**
   * POST stock/count/manual {product_id, bin_id?|box_id?, qty}
   * qty 0 vale (contagem-no-zero: "está vazio" é informação, não erro).
   */
  async function countManual(session, body) {
    const b = body || {};
    const productId = intOf(b.product_id);
    const binId = intOf(b.bin_id);
    const boxId = intOf(b.box_id);
    const qty = intOf(b.qty);
    if (productId == null) return bad('product_required', 'Escolha o produto.');
    if (binId == null && boxId == null) return bad('location_required', 'Diga a prateleira ou a caixa que você contou.');
    if (qty == null || qty < 0 || qty > 100000) return bad('qty_required', 'Quantidade de 0 pra cima.');
    // qty 0 não passa no CHECK (qty > 0) da fila: registra como 0 no meta e propõe 1?
    // NÃO. A contagem-no-zero é registrada com qty 0 no meta e a proposta guarda
    // o found real; o service aplica `count` com o found do meta na aprovação.
    const meta = { computed_qty: qty, method: 'manual', confidence: 'high' };
    const req = await requests.propose({
      product_id: productId, kind: 'count', direction: 'in',
      qty: Math.max(1, qty),        // a fila exige qty > 0; o found real está no meta
      bin_id: binId, box_id: boxId, meta,
      reason: textOf(b.reason, 300),
      note: 'contagem manual: found=' + qty,
      person_id: session.person_id, login: session.display_name || null,
      is_test: !!session.is_sandbox,
    });
    return { body: { ok: true, request_id: req.id, status: 'pending', qty, confidence: 'high' } };
  }

  // ── CAIXA NOVA (entrada) ─────────────────────────────────────

  /**
   * POST stock/box/new {product_id, qty, batch_number?, area?}
   * PROPOSTA kind 'entrada' com meta.box — o NÚMERO da caixa (BX-0451) só é
   * alocado na APROVAÇÃO (número queimado numa caixa que o admin recusou seria
   * um buraco na sequência; a regra é que número de caixa nunca se repete).
   */
  async function boxNew(session, body) {
    const b = body || {};
    const productId = intOf(b.product_id);
    const qty = intOf(b.qty);
    if (productId == null) return bad('product_required', 'Escolha o produto.');
    if (qty == null || qty <= 0 || qty > 100000) return bad('qty_required', 'Quantidade maior que 0.');
    const meta = {
      box: { new: true, batch_number: textOf(b.batch_number, 60), area: textOf(b.area, 60),
        tare_g: numOf(b.tare_g) },
      method: 'box_new',
    };
    const req = await requests.propose({
      product_id: productId, kind: 'entrada', direction: 'in', qty, meta,
      reason: textOf(b.reason, 300),
      note: 'caixa nova' + (meta.box.batch_number ? ' lote ' + meta.box.batch_number : ''),
      person_id: session.person_id, login: session.display_name || null,
      is_test: !!session.is_sandbox,
    });
    return { body: { ok: true, request_id: req.id, status: 'pending' } };
  }

  /** GET stock/box/label?box_id= → o que a etiqueta 4x6 mostra. */
  async function boxLabel(session, query) {
    const boxId = intOf(query && query.box_id);
    if (boxId == null) return bad('box_required', 'Informe a caixa.');
    const row = (await db.query(
      `SELECT x.id, x.box_number, x.area, x.qty, x.batch_number, x.sealed, x.label_printed_at,
              x.product_id, COALESCE(p.nickname, p.canonical_name) AS product
         FROM v3.stock_boxes x LEFT JOIN v3.products p ON p.id = x.product_id
        WHERE x.id = $1`, [boxId])).rows[0];
    if (!row) return { status: 404, body: { error: 'box_unknown', detail: 'Caixa não existe.' } };
    return { body: { ok: true, label: {
      kind: 'box', code: row.box_number,
      line2: row.product || 'sem produto',
      line3: row.qty + ' garrafas' + (row.batch_number ? ' · lote ' + row.batch_number : ''),
      url: '/scan/?x=' + encodeURIComponent(row.box_number),
      area: row.area || null, sealed: !!row.sealed,
      label_printed_at: row.label_printed_at || null,
    } } };
  }

  // ── TAREFAS DE HOJE + BUSCA ──────────────────────────────────

  /**
   * GET stock/tasks → o que fazer hoje, sem alguém ter que pensar:
   *   counts    2 prateleiras pra contar (a que não é contada há mais tempo primeiro)
   *   restock   prateleiras no mínimo, com a caixa que abastece
   *   organize  produtos com garrafas a organizar
   */
  async function tasks(session) {
    const [counts, restock, organizeRows] = await Promise.all([
      db.query(`
        SELECT b.id AS bin_id, b.bin_code, b.qty, b.product_id,
               COALESCE(p.nickname, p.canonical_name) AS product,
               m.last_count
          FROM v3.stock_bins b
          LEFT JOIN v3.products p ON p.id = b.product_id
          LEFT JOIN (SELECT bin_id, MAX(created_at) AS last_count
                       FROM v3.stock_movements WHERE kind = 'count' AND bin_id IS NOT NULL
                      GROUP BY bin_id) m ON m.bin_id = b.id
         WHERE b.active AND b.product_id IS NOT NULL
         ORDER BY m.last_count ASC NULLS FIRST, b.qty DESC
         LIMIT ${TASK_COUNT_SUGGESTIONS}`),
      db.query(`
        SELECT b.id AS bin_id, b.bin_code, b.qty, b.min_qty, b.capacity, b.product_id,
               COALESCE(p.nickname, p.canonical_name) AS product,
               x.id AS box_id, x.box_number, x.qty AS box_qty
          FROM v3.stock_bins b
          LEFT JOIN v3.products p ON p.id = b.product_id
          LEFT JOIN LATERAL (
            SELECT id, box_number, qty FROM v3.stock_boxes
             WHERE product_id = b.product_id AND status = 'in_storage' AND qty > 0
             ORDER BY qty DESC LIMIT 1) x ON true
         WHERE b.active AND b.min_qty > 0 AND b.qty <= b.min_qty
         ORDER BY b.qty ASC LIMIT 20`),
      db.query(`
        SELECT u.product_id, u.qty, COALESCE(p.nickname, p.canonical_name) AS product
          FROM v3.stock_unplaced u JOIN v3.products p ON p.id = u.product_id
         WHERE u.qty > 0 ORDER BY u.qty DESC LIMIT 20`),
    ]);
    return { body: { ok: true,
      counts: counts.rows.map((r) => ({ bin_id: r.bin_id, bin_code: r.bin_code,
        product_id: r.product_id, product: r.product, qty: Number(r.qty) || 0,
        last_count: r.last_count || null })),
      restock: restock.rows.map((r) => ({ bin_id: r.bin_id, bin_code: r.bin_code,
        product_id: r.product_id, product: r.product,
        qty: Number(r.qty) || 0, min_qty: Number(r.min_qty) || 0,
        capacity: r.capacity == null ? null : Number(r.capacity),
        box_id: r.box_id || null, box_number: r.box_number || null,
        box_qty: r.box_qty == null ? null : Number(r.box_qty) })),
      organize: organizeRows.rows.map((r) => ({ product_id: r.product_id,
        product: r.product, qty: Number(r.qty) || 0 })),
    } };
  }

  /** GET stock/lookup?q= → busca por nome, apelido, SKU ou UPC (entrada manual). */
  async function lookup(session, query) {
    const q = textOf(query && query.q, 80);
    if (!q || q.length < 2) return { body: { ok: true, products: [] } };
    const like = '%' + q.toLowerCase() + '%';
    const rows = (await db.query(
      `SELECT DISTINCT p.id AS product_id, p.canonical_name AS name, p.nickname,
              p.unit_weight_g
         FROM v3.products p
         LEFT JOIN v3.product_skus s ON s.product_id = p.id
        WHERE p.active AND (
              LOWER(p.canonical_name) LIKE $1
           OR LOWER(COALESCE(p.nickname,'')) LIKE $1
           OR LOWER(s.sku) LIKE $1
           OR LOWER(COALESCE(s.barcode,'')) LIKE $1)
        ORDER BY p.nickname NULLS LAST, p.canonical_name
        LIMIT ${LOOKUP_LIMIT}`, [like])).rows;
    return { body: { ok: true, products: rows.map((r) => ({
      product_id: r.product_id, name: r.name, nickname: r.nickname || r.name,
      unit_weight_g: r.unit_weight_g == null ? null : Number(r.unit_weight_g),
    })) } };
  }

  return {
    pair: pairPhone, stream, push, keepalive, resolve, resolveBarcode,
    organize, countWeigh, countManual, tasks, lookup, boxNew, boxLabel,
    productById, scanHub, weights,
  };
}

module.exports = { createOpWarehouse, parseBarcode, TASK_COUNT_SUGGESTIONS };
