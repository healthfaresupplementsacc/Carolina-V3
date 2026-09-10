'use strict';
/**
 * HEALTHFARE V4 — FASE B do copiloto de frete: COMPRAR a etiqueta pelo sistema
 * (estudo S15-VEEQO-LABEL-API-STUDY, construído completo mas DARK atrás de
 * FREIGHT_BUY_ENABLED — Bruno 09-04: "ja implementa tudo logo" enquanto o
 * estoque físico não carrega).
 *
 * O FLUXO DE UM ENVIO (a ordem é o produto, e é INEGOCIÁVEL):
 *   1. pedido elegível: pendente na Veeqo, SKUs mapeados, sem etiqueta ainda
 *      (nem na Veeqo, nem na nossa trilha) — Amazon RECUSADO na v1 (Buy
 *      Shipping é a Fase C, com is_amazon_order + channel_items);
 *   2. COTA NA HORA (cotação expira; nunca usar cotação velha) e escolhe a
 *      mais barata VÁLIDA que chega no due_date (bestValid COM dueDate: aqui é
 *      compra, prazo importa; BANNED do rates-client vale sempre — Media
 *      Mail/Bound Printed/Library é infração postal pra suplemento);
 *   3. COMPRA (POST shipping/api/v1/shipments, label_format PDF);
 *   4. MARCA ENVIADO na Veeqo (POST /shipments da API principal,
 *      update_remote_order: true → o tracking sobe pro canal);
 *   5. SÓ DEPOIS da Veeqo confirmar: guarda o PDF em v3.print_files (o MESMO
 *      cofre do fluxo de composição S15.37 — sobrevive a redeploy) e enfileira
 *      print_queue kind shipping_labels (a estação puxa, o /done carimba
 *      printed_at, igual ao compose);
 *   6. trilha inteira em v3.shipment_costs (custo, tracking, rate_id, arquivo,
 *      julgamento contra a mediana da faixa, cotação) — a MESMA linha que o
 *      freight-watch reencontraria depois (upsert com COALESCE, nada briga).
 *
 * O INVARIANTE (sessão do Bruno): NUNCA imprimir antes da Veeqo confirmar o
 * enviado. Se o mark-shipped falhar depois da compra: NÃO enfileira, tenta de
 * novo até 3x, e com tudo falhando abre INCIDENTE (v3/health/incident) e avisa
 * o admin-orin. O PDF fica guardado em print_files mesmo assim (o dinheiro já
 * foi gasto; perder o arquivo seria perder duas vezes) — só não imprime.
 *
 * SEGURANÇA DE ENTRADA: todo ponto de entrada exige
 * process.env.FREIGHT_BUY_ENABLED === 'true' (lido A CADA chamada, nunca
 * capturado no constructor — a lição do STOCK_DEDUCT_MODE) E, na compra, um
 * {confirm: true} explícito por chamada. Sem os dois, nada compra.
 *
 * Este módulo NUNCA escreve estoque (StockService é a porta única de
 * quantidade) e NUNCA posta no canal dos operadores.
 */

const rateslib = require('./rates-client');
const freight = require('./service');
const incidentLib = require('../health/incident');

const EDT = 'America/New_York';
const MAIN_BASE = 'https://api.veeqo.com';
const SHIPPING_BOOK_URL = 'https://api.veeqo.com/shipping/api/v1/shipments';
const ADMIN_CHANNEL = 'C0B36DR5MP1';           // admin-orin, NUNCA operador
const MARK_SHIPPED_TRIES = 3;                  // 1 tentativa + 2 retries
const CARRIER_OTHER = 3;                       // carrier_id "Other" da Veeqo
const DEFAULT_QUOTE_CAP = 10;                  // preview do eligible: gentil com a API
const TIMEOUT_MS = 20000;

/** Erro de negócio com código estável (o router traduz pra HTTP). */
class BuyError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

const nyDay = (d, tz) => (d || new Date()).toLocaleDateString('en-CA', { timeZone: tz || EDT });

/** Canal do pedido cru da Veeqo (mesma leitura do freight-watch). */
function channelOf(o) {
  return (o && o.channel && (o.channel.name || o.channel.type_code)) || null;
}

/** Amazon é Fase C (Buy Shipping tem regras próprias); na v1 é recusa dura. */
function isAmazon(channel) {
  return /amazon/i.test(String(channel || ''));
}

/** Alguma allocation já tem shipment = etiqueta já comprada na Veeqo. */
function hasShipment(o) {
  return (o && o.allocations || []).some((a) => a && a.shipment && a.shipment.id != null);
}

/** A primeira allocation (onde o mark-shipped pendura o tracking). */
function firstAllocation(o) {
  return (o && o.allocations && o.allocations[0]) || null;
}

/** SKUs das linhas do pedido (pro check de mapeamento). */
function orderSkus(o) {
  const out = [];
  for (const li of (o && o.line_items) || []) {
    const s = ((li.sellable && li.sellable.sku_code) || '').trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * Peso do pedido em GRAMAS: soma qty × weight_grams dos sellables; sem isso,
 * o weight da allocation. Sem peso nenhum → null (incotável; nunca chutamos
 * um peso pra uma COMPRA de verdade).
 */
function orderWeightG(o) {
  let total = 0;
  let any = false;
  for (const li of (o && o.line_items) || []) {
    const w = li.sellable != null ? Number(li.sellable.weight_grams) : NaN;
    const q = Number(li.quantity) || 0;
    if (Number.isFinite(w) && w > 0 && q > 0) { total += w * q; any = true; }
  }
  if (any && total > 0) return total;
  const alloc = firstAllocation(o);
  const aw = alloc != null ? Number(alloc.weight) : NaN;
  if (Number.isFinite(aw) && aw > 0) return aw;
  return null;
}

/**
 * carrier name da tarifa → carrier_id da Veeqo. Sem mapa confiável validado na
 * conta ainda (incerteza U-A/U-B do estudo), o default honesto é 3 "Other":
 * o tracking sobe pro canal do mesmo jeito. deps.carrierIds injeta um mapa
 * {regex-string: id} quando o Bruno validar os ids reais da conta.
 */
function carrierIdFor(name, carrierIds) {
  const n = String(name || '');
  for (const [pat, id] of Object.entries(carrierIds || {})) {
    try { if (new RegExp(pat, 'i').test(n)) return Number(id); } catch (_) { /* pattern ruim: ignora */ }
  }
  return CARRIER_OTHER;
}

/**
 * @param {object} deps
 *   db          pool pg (obrigatório)
 *   rates       rates-client ({quoteParcel}) — cotação SEMPRE fresca
 *   veeqo       client veeqo-api ({getOrdersPage}) — leitura de pedidos
 *   queue       PrintQueueService ({enqueue}) — a fila que a estação puxa
 *   slack       {postAs} pro incidente (admin-orin)
 *   channelId   default admin-orin
 *   apiKey      default VEEQO_API_KEY (book + mark-shipped)
 *   baseUrl     default https://api.veeqo.com
 *   fetchImpl   default globalThis.fetch (os testes injetam)
 *   enabled     default () => process.env.FREIGHT_BUY_ENABLED === 'true'
 *               (lido POR CHAMADA: flip de flag não exige restart)
 *   incident    default v3/health/incident (injetável nos testes)
 *   carrierIds  mapa {regex: carrier_id} (default vazio → 3 "Other")
 *   quoteCap    cotações no eligible por chamada (default 10)
 *   retryDelayMs espera entre retries do mark-shipped (default 1500; 0 nos testes)
 *   now, tz, timeoutMs
 */
function createBuy(deps = {}) {
  const db = deps.db;
  const rates = deps.rates;
  const veeqo = deps.veeqo;
  const queue = deps.queue;
  const slack = deps.slack || null;
  const channelId = deps.channelId || ADMIN_CHANNEL;
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : process.env.VEEQO_API_KEY;
  const baseUrl = String(deps.baseUrl || MAIN_BASE).replace(/\/+$/, '');
  const bookUrl = deps.bookUrl || SHIPPING_BOOK_URL;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const enabledFn = deps.enabled || (() => process.env.FREIGHT_BUY_ENABLED === 'true');
  const incident = deps.incident || incidentLib;
  const carrierIds = deps.carrierIds || {};
  const quoteCap = deps.quoteCap != null ? deps.quoteCap : DEFAULT_QUOTE_CAP;
  const retryDelayMs = deps.retryDelayMs != null ? deps.retryDelayMs : 1500;
  const timeoutMs = deps.timeoutMs || TIMEOUT_MS;
  const nowFn = deps.now || (() => new Date());
  const tz = deps.tz || EDT;

  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  function enabled() { return !!enabledFn(); }

  /** Toda porta de entrada passa aqui. Flag OFF = 403, sempre. */
  function assertEnabled() {
    if (!enabled()) {
      throw new BuyError('flag_off',
        'Compra de etiqueta desligada (FREIGHT_BUY_ENABLED). Fase B está dark.', 403);
    }
  }

  /** HTTP genérico com a chave da Veeqo. Erro nunca inclui a chave. */
  async function _req(method, url, bodyObj) {
    if (!apiKey) { const e = new BuyError('no_key', 'VEEQO_API_KEY não configurada', 500); throw e; }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let r;
    try {
      r = await fetchImpl(url, {
        method, signal: ctrl.signal,
        headers: { 'x-api-key': apiKey, accept: 'application/json', 'content-type': 'application/json' },
        body: bodyObj != null ? JSON.stringify(bodyObj) : undefined,
      });
    } catch (e) {
      clearTimeout(t);
      const err = new Error(e && e.name === 'AbortError'
        ? ('Veeqo timeout (' + timeoutMs + 'ms)') : ('Veeqo inacessível: ' + (e && e.message)));
      err.code = e && e.name === 'AbortError' ? 'timeout' : 'network';
      throw err;
    }
    clearTimeout(t);
    let j = null; try { j = await r.json(); } catch (_) { j = null; }
    if (!r.ok) {
      const e = new Error('Veeqo HTTP ' + r.status + (j && j.error ? (': ' + JSON.stringify(j.error)) : ''));
      e.code = 'http_error'; e.status = r.status; e.body = j;
      throw e;
    }
    return j;
  }

  /** O pedido cru, direto da Veeqo (GET /orders/:id). */
  async function _getOrder(orderId) {
    try {
      return await _req('GET', baseUrl + '/orders/' + encodeURIComponent(String(orderId)));
    } catch (e) {
      if (e && e.status === 404) throw new BuyError('order_not_found', 'Pedido ' + orderId + ' não existe na Veeqo.', 404);
      throw new BuyError('veeqo_unreachable', 'Não consegui ler o pedido na Veeqo: ' + e.message, 502);
    }
  }

  /** Quais desses SKUs NÃO estão mapeados em v3.product_skus. */
  async function _unmappedSkus(skus) {
    const list = [...new Set((skus || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
    if (!list.length) return [];
    const r = await db.query(
      `SELECT UPPER(sku) AS sku FROM v3.product_skus WHERE UPPER(sku) = ANY($1::text[])`, [list]);
    const have = new Set((r.rows || []).map((x) => x.sku));
    return list.filter((s) => !have.has(s));
  }

  /** Já existe compra NOSSA (tracking gravado) pra esse pedido? */
  async function _alreadyBought(orderId) {
    const r = await db.query(
      `SELECT shipment_id, tracking_number FROM v3.shipment_costs
        WHERE order_id = $1 AND tracking_number IS NOT NULL LIMIT 1`, [orderId]);
    return (r.rows && r.rows[0]) || null;
  }

  /** Compra a etiqueta na Rate Shopping API. Resposta normalizada. */
  async function _book({ rate_id, reference }) {
    let j;
    try {
      j = await _req('POST', bookUrl, {
        rate_id,
        label_format: 'PDF',
        customer_reference: 'HF-BUY-' + String(reference),
      });
    } catch (e) {
      // Falha aqui é ANTES de dinheiro confirmado; nada persistido ainda.
      // (Rede ambígua pós-POST é possível; o eligible/re-buy recusa depois
      // pela Veeqo se a compra tiver ido — a Veeqo é a fonte da verdade.)
      throw new BuyError('book_failed', 'A compra da etiqueta falhou na Veeqo: ' + e.message, 502);
    }
    const sh = (j && (j.shipment || j)) || {};
    return {
      shipment_id: sh.shipment_id != null ? sh.shipment_id : (sh.id != null ? sh.id : null),
      tracking_number: sh.tracking_number || null,
      label_content: sh.label_content || null,
      total_charge: sh.total_charge != null ? Number(sh.total_charge) : null,
      carrier: sh.carrier || sh.carrier_name || null,
      service_name: sh.service_name || null,
      raw_keys: Object.keys(j || {}),
    };
  }

  /** Marca enviado na API principal (o tracking sobe pro canal). */
  async function _markShipped({ order_id, allocation_id, tracking_number, carrier_id }) {
    return _req('POST', baseUrl + '/shipments', {
      order_id,
      allocation_id,
      tracking_number_attributes: { tracking_number },
      update_remote_order: true,
      carrier_id,
    });
  }

  /** Um pedido cru → a linha do eligible (sem cotação ainda). */
  async function _describe(o) {
    const channel = channelOf(o);
    const alloc = firstAllocation(o);
    const skus = orderSkus(o);
    const unmapped = await _unmappedSkus(skus);
    const weight_g = orderWeightG(o);
    const dest_zip = (o.deliver_to && o.deliver_to.zip) || null;
    const row = {
      order_id: o.id != null ? Number(o.id) : null,
      order_number: o.number != null ? String(o.number) : null,
      channel,
      status: o.status || null,
      due_date: o.due_date || null,
      dest_state: (o.deliver_to && o.deliver_to.state) || null,
      dest_zip,
      weight_g,
      skus,
      allocation_id: alloc && alloc.id != null ? alloc.id : null,
      amazon: isAmazon(channel),
      mapped: unmapped.length === 0,
      unmapped_skus: unmapped.length ? unmapped : undefined,
    };
    let reason = null;
    if (row.amazon) reason = 'amazon_fase_c';
    else if (hasShipment(o)) reason = 'ja_tem_etiqueta';
    else if (!row.mapped) reason = 'sku_sem_mapa';
    else if (!row.allocation_id) reason = 'sem_allocation';
    else if (!dest_zip) reason = 'sem_cep';
    else if (!weight_g) reason = 'sem_peso';
    row.buyable = reason == null;
    if (reason) row.reason = reason;
    return row;
  }

  /**
   * Os pedidos COMPRÁVEIS de hoje, com preview de cotação nos primeiros
   * `quoteCap` (cotar todos a cada refresh seria martelar a API de rates).
   * Lista honesta: pedido não comprável APARECE com o motivo (amazon, SKU sem
   * mapa, sem peso...) — esconder linha é como nascem os "cadê o pedido X?".
   * @param {{channel?:string}} p
   */
  async function eligible(p = {}) {
    assertEnabled();
    const want = p.channel ? String(p.channel).trim().toLowerCase() : null;
    const orders = [];
    for (let page = 1; page <= 3; page++) {
      const rows = await veeqo.getOrdersPage({ status: 'awaiting_fulfillment', page, pageSize: 100 });
      if (!rows || !rows.length) break;
      orders.push(...rows);
      if (rows.length < 100) break;
    }

    const out = [];
    for (const o of orders) {
      if (hasShipment(o)) continue;                 // etiqueta já existe na Veeqo: fora
      const row = await _describe(o);
      if (want && String(row.channel || '').toLowerCase() !== want) continue;
      out.push(row);
    }

    // já compradas por NÓS (trilha local) também ficam de fora da lista
    const ids = out.map((x) => x.order_id).filter((x) => x != null);
    if (ids.length) {
      const r = await db.query(
        `SELECT DISTINCT order_id FROM v3.shipment_costs
          WHERE order_id = ANY($1::bigint[]) AND tracking_number IS NOT NULL`, [ids]);
      const bought = new Set((r.rows || []).map((x) => Number(x.order_id)));
      for (const x of out) {
        if (bought.has(x.order_id)) { x.buyable = false; x.reason = 'ja_comprada_pelo_sistema'; }
      }
    }

    // preview de cotação: só nos compráveis, cap quoteCap, cotação fresca
    let quoted = 0;
    if (rates) {
      for (const x of out) {
        if (!x.buyable || quoted >= quoteCap) continue;
        const q = await rates.quoteParcel({
          dest_zip: x.dest_zip, dest_state: x.dest_state,
          weight_g: x.weight_g, reference: x.order_id,
        });
        quoted += 1;
        const best = q ? rateslib.bestValid(q.quotes, { dueDate: x.due_date }) : null;
        x.quote = best
          ? { service: best.name, price: best.price, delivery_estimate: best.delivery_estimate }
          : null;
      }
    }

    return {
      day: nyDay(nowFn(), tz),
      orders: out,
      counts: {
        total: out.length,
        buyable: out.filter((x) => x.buyable).length,
        quoted,
      },
    };
  }

  /**
   * COMPRA a etiqueta de UM pedido. A trilha inteira volta pra quem chamou.
   *
   * Falhas ANTES da compra lançam BuyError (viram HTTP 4xx/5xx limpos: nada
   * foi gasto). Depois que a compra acontece, NUNCA lança: devolve a trilha
   * com ok:false e o passo que falhou — dinheiro gasto não pode virar um 500
   * genérico que esconde o tracking.
   *
   * @param {{order_id:number|string, confirm:boolean, requested_by?:string,
   *          requested_login_id?:number, is_test?:boolean}} p
   */
  async function buyOne(p = {}) {
    assertEnabled();
    if (p.confirm !== true) {
      throw new BuyError('confirm_required',
        'Compra exige {confirm: true} explícito por chamada.', 400);
    }
    const orderId = Number(p.order_id);
    if (!Number.isFinite(orderId) || orderId <= 0) {
      throw new BuyError('bad_order_id', 'order_id obrigatório.', 400);
    }

    // ── elegibilidade (tudo ANTES de gastar) ────────────────────────────────
    const bought = await _alreadyBought(orderId);
    if (bought) {
      throw new BuyError('already_bought',
        'Pedido ' + orderId + ' já tem etiqueta comprada pelo sistema (tracking ' +
        bought.tracking_number + ').', 409);
    }
    const order = await _getOrder(orderId);
    const desc = await _describe(order);
    if (desc.amazon) {
      throw new BuyError('amazon_not_supported',
        'Pedido Amazon: compra via sistema é a Fase C (Buy Shipping). Recusado na v1.', 400);
    }
    if (hasShipment(order) || String(order.status || '') === 'shipped') {
      throw new BuyError('already_shipped',
        'Pedido ' + orderId + ' já tem etiqueta/envio na Veeqo.', 409);
    }
    if (String(order.status || '') === 'cancelled') {
      throw new BuyError('order_cancelled', 'Pedido ' + orderId + ' está cancelado.', 409);
    }
    if (!desc.mapped) {
      throw new BuyError('unmapped_sku',
        'SKU sem mapa no sistema: ' + (desc.unmapped_skus || []).join(', ') +
        '. Mapeia no Product Setup antes de comprar.', 409);
    }
    if (!desc.allocation_id) {
      throw new BuyError('no_allocation', 'Pedido sem allocation na Veeqo; não dá pra marcar enviado.', 409);
    }
    if (!desc.dest_zip) throw new BuyError('no_zip', 'Pedido sem CEP de destino; não dá pra cotar.', 409);
    if (!desc.weight_g) throw new BuyError('no_weight', 'Pedido sem peso (sellables sem weight_grams); não dá pra cotar.', 409);

    // ── cota FRESCA (cotação expira; nunca reusar) ──────────────────────────
    const q = rates ? await rates.quoteParcel({
      dest_zip: desc.dest_zip, dest_state: desc.dest_state,
      weight_g: desc.weight_g, reference: orderId,
    }) : null;
    if (!q) throw new BuyError('quote_failed', 'Não consegui cotar agora na Veeqo. Tenta de novo.', 502);
    const valid = rateslib.validQuotes(q.quotes);
    const best = rateslib.bestValid(q.quotes, { dueDate: desc.due_date });
    if (!best || !best.rate_id) {
      throw new BuyError('no_valid_rate',
        'Nenhuma cotação válida (' + (q.quotes || []).length + ' recebidas; banned não conta).', 409);
    }

    // ── COMPRA ──────────────────────────────────────────────────────────────
    const booked = await _book({ rate_id: best.rate_id, reference: orderId });
    const boughtAt = nowFn();
    const trail = {
      ok: false,
      order_id: orderId,
      order_number: desc.order_number,
      channel: desc.channel,
      quote: { valid_count: valid.length, best: { service: best.name, price: best.price, delivery_estimate: best.delivery_estimate, rate_id: best.rate_id } },
      booked: {
        shipment_id: booked.shipment_id,
        tracking_number: booked.tracking_number,
        cost: booked.total_charge != null ? booked.total_charge : best.price,
        service: booked.service_name || best.name,
        carrier: booked.carrier,
      },
      marked_shipped: false,
      printed_enqueued: false,
    };

    // ── MARCA ENVIADO (até 3 tentativas; o invariante mora aqui) ────────────
    const carrierId = carrierIdFor(booked.carrier || best.name, carrierIds);
    let markResp = null;
    let markErr = null;
    for (let attempt = 1; attempt <= MARK_SHIPPED_TRIES; attempt++) {
      try {
        markResp = await _markShipped({
          order_id: orderId,
          allocation_id: desc.allocation_id,
          tracking_number: booked.tracking_number,
          carrier_id: carrierId,
        });
        markErr = null;
        break;
      } catch (e) {
        markErr = e;
        trail.mark_shipped_attempts = attempt;
        if (attempt < MARK_SHIPPED_TRIES) await sleep(retryDelayMs);
      }
    }
    trail.marked_shipped = !markErr;

    // shipment_id definitivo: o que a API principal criou (é ESSE que o
    // freight-watch vai rever em allocations[].shipment); senão o do book.
    const shipmentId = (markResp && (markResp.id != null ? markResp.id
      : (markResp.shipment && markResp.shipment.id))) || booked.shipment_id;
    trail.shipment_id = shipmentId;

    // ── trilha em v3.shipment_costs (a MESMA linha que o watch usaria) ──────
    const cost = trail.booked.cost;
    const service = trail.booked.service;
    try {
      if (shipmentId != null) {
        await freight.upsertShipments(db, [{
          shipment_id: shipmentId,
          order_id: orderId,
          order_number: desc.order_number,
          channel: desc.channel,
          service,
          weight_g: desc.weight_g,
          cost,
          currency: 'USD',
          bought_at: boughtAt.toISOString(),
          due_date: desc.due_date,
          dest_state: desc.dest_state,
          dest_zip: desc.dest_zip,
          ny_day: nyDay(boughtAt, tz),
        }]);
        await db.query(
          `UPDATE v3.shipment_costs
              SET tracking_number = $2, carrier_name = $3, bought_via = 'system',
                  rate_id = $4, marked_shipped_at = $5, mark_shipped_error = $6
            WHERE shipment_id = $1`,
          [shipmentId, booked.tracking_number, booked.carrier || null,
            best.rate_id, markErr ? null : boughtAt.toISOString(),
            markErr ? String(markErr.message || markErr) : null]);
        // julgamento contra a mediana da faixa + a cotação que decidiu — a
        // etiqueta comprada por nós entra na MESMA régua das outras
        const band = freight.bandOf(service, desc.weight_g);
        const exp = await freight.expectedFor(db, band, desc.dest_state);
        const verdict = freight.judge({ cost, expected: exp.expected, samples: exp.samples, weight_g: desc.weight_g });
        await freight.saveJudgement(db, shipmentId, {
          band, expected_cost: exp.expected,
          outlier: verdict.outlier, outlier_reason: verdict.reason,
        });
        await freight.saveQuote(db, shipmentId, {
          quoted_best_cost: best.price, quoted_best_service: best.name,
          quoted_valid_count: valid.length,
        });
        trail.persisted = true;
      } else {
        trail.persisted = false;
        trail.persist_error = 'sem shipment_id em nenhuma resposta da Veeqo';
      }
    } catch (e) {
      trail.persisted = false;
      trail.persist_error = e.message;
      console.error('[freight-buy] trilha não persistiu:', e.message);
    }

    // ── PDF pro cofre (mesmo com mark-shipped falho: o dinheiro já foi) ─────
    let fileId = null;
    if (booked.label_content) {
      try {
        const pdf = Buffer.from(String(booked.label_content), 'base64');
        if (pdf.length >= 5 && pdf.subarray(0, 4).toString('latin1') === '%PDF') {
          const fr = await db.query(
            `INSERT INTO v3.print_files (mime, bytes, pages) VALUES ('application/pdf', $1, 1) RETURNING id`,
            [pdf]);
          fileId = fr.rows[0].id;
          if (shipmentId != null) {
            await db.query(
              `UPDATE v3.shipment_costs SET label_file_id = $2 WHERE shipment_id = $1`,
              [shipmentId, fileId]).catch(() => {});
          }
        } else {
          trail.label_error = 'label_content não é PDF';
        }
      } catch (e) {
        trail.label_error = e.message;
        console.error('[freight-buy] PDF não gravou:', e.message);
      }
    } else {
      trail.label_error = 'compra sem label_content na resposta';
    }
    trail.label_file_id = fileId;

    // ── mark-shipped FALHOU: NÃO imprime, incidente, admin-orin ─────────────
    if (markErr) {
      try {
        const inc = await incident.openIncident({ db, slack, channelId }, {
          code: 'freight_buy_mark_shipped',
          title: 'Etiqueta comprada mas a Veeqo não confirmou o enviado',
          oneLine: 'Comprei a etiqueta do pedido ' + (desc.order_number || orderId) +
            ' (tracking ' + (booked.tracking_number || '?') + ') mas o mark-shipped falhou ' +
            MARK_SHIPPED_TRIES + 'x. NADA foi pra impressão. Marca enviado na Veeqo na mão e imprime de lá.',
          detail: {
            order_id: orderId, order_number: desc.order_number,
            shipment_id: shipmentId, tracking_number: booked.tracking_number,
            cost, service, label_file_id: fileId,
            mark_shipped_error: String(markErr.message || markErr),
          },
          fix_hint: 'Veeqo > pedido ' + (desc.order_number || orderId) +
            ' > marcar enviado com o tracking acima; a etiqueta está guardada (print_files ' + fileId + ').',
        });
        trail.incident_id = inc && inc.id != null ? inc.id : null;
      } catch (e) {
        console.error('[freight-buy] incidente falhou:', e.message);
      }
      trail.ok = false;
      trail.failed_step = 'mark_shipped';
      trail.error = String(markErr.message || markErr);
      return trail;
    }

    // ── Veeqo confirmou: AGORA pode ir pra fila de impressão ────────────────
    if (fileId != null && queue) {
      try {
        const job = await queue.enqueue({
          kind: 'shipping_labels',
          requested_by: p.requested_by || 'freight-buy',
          requested_login_id: p.requested_login_id != null ? p.requested_login_id : null,
          is_test: !!p.is_test,
          payload: {
            day: nyDay(boughtAt, tz),
            count: 1,
            pages: 1,
            file_id: fileId,
            shipment_ids: shipmentId != null ? [String(shipmentId)] : [],
            order_number: desc.order_number,
            bought_via: 'system',
          },
        });
        await db.query(`UPDATE v3.print_files SET job_id = $1 WHERE id = $2`, [job.id, fileId]);
        // histórico por etiqueta: o /done da fila carimba printed_at aqui
        // (mesma tabela e mesma trava UNIQUE do fluxo de composição S15.37)
        if (shipmentId != null) {
          await db.query(
            `INSERT INTO v3.shipping_label_prints
               (source, external_order_id, shipment_id, order_number, channel, job_id, is_test)
             VALUES ('veeqo', $1, $2, $3, $4, $5, $6)
             ON CONFLICT (source, shipment_id) DO UPDATE
               SET job_id = EXCLUDED.job_id, composed_at = NOW()`,
            [String(orderId), String(shipmentId), desc.order_number, desc.channel,
              job.id, !!p.is_test]);
        }
        trail.printed_enqueued = true;
        trail.job_id = job.id;
      } catch (e) {
        trail.enqueue_error = e.message;
        console.error('[freight-buy] fila não recebeu:', e.message);
      }
    } else if (fileId == null) {
      // enviado confirmado mas sem PDF utilizável: o admin imprime da Veeqo;
      // incidente pra ninguém descobrir só quando o pacote não sair
      try {
        const inc = await incident.openIncident({ db, slack, channelId }, {
          code: 'freight_buy_no_label',
          title: 'Etiqueta comprada e enviada, mas sem PDF pra imprimir',
          oneLine: 'Pedido ' + (desc.order_number || orderId) + ' comprado e marcado enviado (tracking ' +
            (booked.tracking_number || '?') + '), mas a Veeqo não devolveu PDF utilizável. Imprime essa etiqueta pela tela da Veeqo.',
          detail: {
            order_id: orderId, shipment_id: shipmentId,
            tracking_number: booked.tracking_number, label_error: trail.label_error || null,
          },
          fix_hint: 'Veeqo > envios > reimprimir a etiqueta do pedido ' + (desc.order_number || orderId) + '.',
        });
        trail.incident_id = inc && inc.id != null ? inc.id : null;
      } catch (e) { console.error('[freight-buy] incidente falhou:', e.message); }
    }

    trail.ok = true;
    return trail;
  }

  return { enabled, eligible, buyOne };
}

module.exports = {
  createBuy, BuyError,
  // puras, exportadas pros testes
  orderWeightG, orderSkus, isAmazon, channelOf, hasShipment, firstAllocation, carrierIdFor,
  MARK_SHIPPED_TRIES, CARRIER_OTHER,
};
