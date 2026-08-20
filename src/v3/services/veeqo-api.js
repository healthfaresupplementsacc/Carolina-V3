'use strict';
/**
 * Veeqo API (read-only) — client server-side pro fluxo P&P direto-ao-cliente.
 *
 * A Veeqo é o gerenciador multi-canal de pedidos (Amazon, eBay, Walmart, site
 * HealthFare…). Quando a etiqueta é impressa, o pedido vira `status='shipped'`.
 * Então "pedidos impressos hoje + qty por suplemento" = pedidos shipped no dia.
 * (TikTok/Shopify ficam de fora por enquanto — Simone reporta manual; ver
 * [[pp-vs-production-line]] / [[veeqo-integration-plan]].)
 *
 * SEGURANÇA (mesmo padrão do ems-api):
 *  - Chave SÓ no servidor: process.env.VEEQO_API_KEY (segredo do Railway). Acesso
 *    TOTAL à conta → NUNCA logada, nunca em código/commit/resposta/browser.
 *  - Leitura: GET /orders + /products. ESCRITA (Bruno 08-04): SÓ setStock() —
 *    escreve o estoque físico no HealthFare Warehouse (108841, hardcoded). O outro
 *    armazém (Rosa Neciosup Castro) NUNCA é tocado. Nenhuma outra escrita existe.
 */
const config = require('../../config');

/**
 * A URL da imagem, de onde quer que a Veeqo tenha posto (S15.41).
 *
 * O mesmo produto vem com a foto em campos diferentes conforme como foi
 * cadastrado (importado de marketplace, criado à mão, herdado do sellable):
 * `main_image_src` é string; `main_image` e `image` às vezes são string, às
 * vezes objeto {src|url|thumbnail_url}. Tentar um campo só perde foto de graça.
 * Ordem: a maior primeiro, a thumb por último.
 * @returns {string|null}
 */
function pickImage(o, thumb) {
  if (!o) return null;
  const cands = thumb
    ? [o.thumbnail_url, o.thumb_url, o.main_image_thumb_src, o.main_image, o.image]
    : [o.main_image_src, o.image_src, o.main_image, o.image, o.thumbnail_url];
  for (const c of cands) {
    if (!c) continue;
    if (typeof c === 'string') { const s = c.trim(); if (s) return s; }
    else if (typeof c === 'object') {
      const s = c.src || c.url || (thumb ? c.thumbnail_url : null) || c.thumbnail_url;
      if (s && String(s).trim()) return String(s).trim();
    }
  }
  return null;
}

/** 'Kit'|'ProductVariant' da Veeqo → 'kit'|'variant'|null (nosso vocabulário). */
function typeOf(s) {
  if (!s) return null;
  return s.type === 'Kit' ? 'kit' : (s.type === 'ProductVariant' ? 'variant' : null);
}

/**
 * Um produto CRU da Veeqo → a forma que a absorção consome. Função pura, exportada:
 * o teste roda ela contra uma fixture de resposta real, sem rede nenhuma.
 */
function normalizeProduct(pd) {
  const img = pickImage(pd, false);
  const thumb = pickImage(pd, true);
  return {
    id: pd.id != null ? Number(pd.id) : null,
    title: pd.title || pd.name || '',
    brand: pd.brand || null,
    description: pd.description || null,
    image_url: img,
    thumb_url: thumb,
    sellables: (pd.sellables || []).map((s) => ({
      sku: (s.sku_code || s.sku || '').trim(),
      title: s.product_title || s.full_title || pd.title || '',
      upc_code: s.upc_code || s.upc || null,
      type: typeOf(s),
      // sellable com foto PRÓPRIA (variação de sabor/cor); sem ela herda a do pai
      image_url: pickImage(s, false) || null,
    })).filter((s) => s.sku),
  };
}

function createVeeqoClient(opts = {}) {
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : config.veeqo.apiKey;
  const baseUrl = String(opts.baseUrl || config.veeqo.baseUrl).replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || 20000;
  const tz = opts.tz || config.tz || 'America/New_York';

  function configured() { return !!apiKey; }

  async function getOrdersPage({ status = 'shipped', updatedSince, page = 1, pageSize = 100 }) {
    if (!apiKey) { const e = new Error('VEEQO_API_KEY não configurada'); e.code = 'no_key'; throw e; }
    const qs = new URLSearchParams({ status, page: String(page), page_size: String(pageSize) });
    if (updatedSince) qs.set('updated_at_min', updatedSince);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let r;
    try {
      r = await fetchImpl(baseUrl + '/orders?' + qs.toString(), {
        method: 'GET', headers: { 'x-api-key': apiKey, accept: 'application/json' }, signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const err = new Error(e && e.name === 'AbortError' ? ('Veeqo timeout (' + timeoutMs + 'ms)') : ('Veeqo inacessível: ' + (e && e.message)));
      err.code = e && e.name === 'AbortError' ? 'timeout' : 'network';
      throw err; // erro NÃO inclui a chave
    }
    clearTimeout(timer);
    if (r.status === 401) { const e = new Error('Veeqo recusou a chave (401)'); e.code = 'unauthorized'; e.status = 401; throw e; }
    if (!r.ok) { const e = new Error('Veeqo HTTP ' + r.status); e.code = 'http_error'; e.status = r.status; throw e; }
    let j = null; try { j = await r.json(); } catch (_) { j = null; }
    return Array.isArray(j) ? j : ((j && j.orders) || []);
  }

  const nyDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: tz }) : null);

  /**
   * Pedidos ENVIADOS (etiqueta impressa) num dia NY (YYYY-MM-DD), agregados por
   * canal e por suplemento. Pagina até esvaziar (cap 40 páginas = 4000 pedidos).
   * Read-only, seguro chamar a cada request (o backend cacheia por cima se quiser).
   */
  /**
   * Os PEDIDOS enviados num dia NY, CRUS (objeto inteiro da Veeqo).
   *
   * shippedByDay() logo abaixo responde "quantos/quais suplementos" e joga os
   * pedidos fora depois de somar. As etiquetas de envio precisam do pedido
   * inteiro — principalmente `allocations[].shipment.id`, que é o que a API de
   * etiqueta recebe. Mesma varredura, mesmo filtro de dia NY; o que muda é só o
   * que sai. Read-only.
   *
   * @param {string} day YYYY-MM-DD (NY); default = hoje
   * @returns {Promise<Array<object>>} pedidos crús com shipped_at naquele dia
   */
  async function ordersShippedOn(day) {
    const d = day || new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const since = new Date(Date.parse(d + 'T00:00:00Z') - 30 * 3600 * 1000).toISOString();
    const out = [];
    for (let page = 1; page <= 40; page++) {
      const rows = await getOrdersPage({ status: 'shipped', updatedSince: since, page, pageSize: 100 });
      if (!rows.length) break;
      for (const o of rows) if (nyDate(o.shipped_at) === d) out.push(o);
      if (rows.length < 100) break;
    }
    return out;
  }

  /**
   * O PDF da etiqueta, direto da Veeqo (conferido 08-19: 200 application/pdf,
   * ~60KB, UMA página 4x6 por shipment).
   *
   * A MESMA rota devolve JSON ({labels_count}) quando o accept é json — o header
   * `accept: application/pdf` é o que decide. Por isso este método não passa pelo
   * _req() genérico: aquele faz r.json() e destruiria os bytes.
   *
   * Pedir vários shipment_ids numa chamada só é possível (o parâmetro é array),
   * mas a gente pede UM POR VEZ de propósito: cada etiqueta precisa do rodapé
   * DELA (produto, local, garrafas, envelope são por pedido), então um PDF
   * juntando várias não serviria — teria que ser fatiado de novo, adivinhando
   * qual página é de quem.
   *
   * @param {string|number} shipmentId
   * @returns {Promise<Buffer>} bytes do PDF
   */
  async function getLabelPdf(shipmentId) {
    if (!apiKey) { const e = new Error('VEEQO_API_KEY não configurada'); e.code = 'no_key'; throw e; }
    const id = String(shipmentId || '').trim();
    if (!id) { const e = new Error('shipment_id obrigatório'); e.code = 'bad_request'; throw e; }
    const qs = new URLSearchParams();
    qs.append('shipment_ids[]', id);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let r;
    try {
      r = await fetchImpl(baseUrl + '/shipping/labels?' + qs.toString(), {
        method: 'GET', signal: ctrl.signal,
        headers: { 'x-api-key': apiKey, accept: 'application/pdf' },
      });
    } catch (e) {
      clearTimeout(timer);
      const err = new Error(e && e.name === 'AbortError' ? ('Veeqo timeout (' + timeoutMs + 'ms)') : ('Veeqo inacessível: ' + (e && e.message)));
      err.code = e && e.name === 'AbortError' ? 'timeout' : 'network';
      throw err;   // erro NÃO inclui a chave
    }
    clearTimeout(timer);
    if (r.status === 401) { const e = new Error('Veeqo recusou a chave (401)'); e.code = 'unauthorized'; e.status = 401; throw e; }
    if (!r.ok) { const e = new Error('Veeqo HTTP ' + r.status + ' na etiqueta ' + id); e.code = 'http_error'; e.status = r.status; throw e; }
    const buf = Buffer.from(await r.arrayBuffer());
    // Guarda dura: se vier JSON/HTML (chave sem permissão de etiqueta, shipment
    // inexistente), o pdf-lib estouraria lá na frente com erro incompreensível.
    // Melhor falhar aqui dizendo o que realmente aconteceu.
    if (buf.length < 5 || buf.subarray(0, 4).toString('latin1') !== '%PDF') {
      const e = new Error('Veeqo não devolveu PDF na etiqueta ' + id);
      e.code = 'not_pdf'; throw e;
    }
    return buf;
  }

  async function shippedByDay(day) {
    const d = day || new Date().toLocaleDateString('en-CA', { timeZone: tz });
    // janela: 30h antes do início UTC do dia, pra cobrir o fuso; filtra pela data NY.
    const since = new Date(Date.parse(d + 'T00:00:00Z') - 30 * 3600 * 1000).toISOString();
    const byProduct = new Map(); const byChannel = new Map();
    let orders = 0, units = 0, scanned = 0, pages = 0, capped = false;
    for (let page = 1; page <= 40; page++) {
      const rows = await getOrdersPage({ status: 'shipped', updatedSince: since, page, pageSize: 100 });
      pages = page;
      if (!rows.length) break;
      scanned += rows.length;
      for (const o of rows) {
        if (nyDate(o.shipped_at) !== d) continue;
        orders += 1;
        const ch = (o.channel && (o.channel.name || o.channel.type_code)) || '—';
        byChannel.set(ch, (byChannel.get(ch) || 0) + 1);
        for (const li of (o.line_items || [])) {
          const s = li.sellable || {};
          const name = s.product_title || s.full_title || li.title || '?';
          const sku = s.sku_code || '';
          const k = name + ' ' + sku;
          const q = Number(li.quantity) || 0;
          units += q;
          const cur = byProduct.get(k) || { product: name, sku, units: 0, lines: 0 };
          cur.units += q; cur.lines += 1; byProduct.set(k, cur);
        }
      }
      if (rows.length < 100) break;
      if (page === 40) capped = true;
    }
    return {
      date: d,
      total_orders: orders,
      total_units: units,
      by_channel: [...byChannel.entries()].map(([channel, count]) => ({ channel, orders: count })).sort((a, b) => b.orders - a.orders),
      by_product: [...byProduct.values()].sort((a, b) => b.units - a.units),
      scanned, pages, capped,
    };
  }

  // Catálogo de PRODUTOS do Veeqo (pro tab Inventory — mapear SKU↔nosso produto).
  // Read-only. Pagina /products; devolve [{sku, title, product_title, ...}] por sellable.
  async function getProductsPage({ page = 1, pageSize = 100 }) {
    if (!apiKey) { const e = new Error('VEEQO_API_KEY não configurada'); e.code = 'no_key'; throw e; }
    const qs = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let r;
    try {
      r = await fetchImpl(baseUrl + '/products?' + qs.toString(), {
        method: 'GET', headers: { 'x-api-key': apiKey, accept: 'application/json' }, signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const err = new Error(e && e.name === 'AbortError' ? ('Veeqo timeout (' + timeoutMs + 'ms)') : ('Veeqo inacessível: ' + (e && e.message)));
      err.code = e && e.name === 'AbortError' ? 'timeout' : 'network';
      throw err;
    }
    clearTimeout(timer);
    if (r.status === 401) { const e = new Error('Veeqo recusou a chave (401)'); e.code = 'unauthorized'; e.status = 401; throw e; }
    if (!r.ok) { const e = new Error('Veeqo HTTP ' + r.status); e.code = 'http_error'; e.status = r.status; throw e; }
    let j = null; try { j = await r.json(); } catch (_) { j = null; }
    return Array.isArray(j) ? j : ((j && j.products) || []);
  }

  /** Todos os SKUs do Veeqo (únicos), com título + estoque total quando presente.
   *  Pagina até 60 páginas (6000 produtos). Read-only.
   *
   *  Bruno 08-18 (V1 verificado): os casepacks -C2/-C3/-C4 são KITS do Veeqo —
   *  o Veeqo deriva a disponibilidade deles do sellable base e, ao enviar um kit,
   *  decrementa o base pelas unidades. Por isso devolvemos também:
   *    type = 'kit' | 'variant' | null   (chip na UI: mapeamento errado fica visível)
   *    wh   = {physical, allocated, available} do HealthFare Warehouse (108841)
   *  O `stock` antigo (soma de TODOS os armazéns) continua igual — nada quebra.
   *  Regra que fica: a comparação "Veeqo confirma o total" usa o BASE, nunca soma kits. */
  async function listSellables() {
    const out = new Map(); // sku -> { sku, title, product_title, stock, type, wh }
    for (let page = 1; page <= 60; page++) {
      const rows = await getProductsPage({ page, pageSize: 100 });
      if (!rows.length) break;
      for (const pd of rows) {
        const ptitle = pd.title || pd.name || '';
        for (const s of (pd.sellables || [])) {
          const sku = (s.sku_code || '').trim();
          if (!sku || out.has(sku)) continue;
          // estoque total (soma de stock_entries se vier — senão null)
          let stock = null;
          if (Array.isArray(s.stock_entries)) {
            stock = s.stock_entries.reduce((n, e) => n + (Number(e.physical_stock_level ?? e.available ?? 0) || 0), 0);
          } else if (s.inventory && s.inventory.available != null) {
            stock = Number(s.inventory.available) || 0;
          }
          const type = s.type === 'Kit' ? 'kit' : (s.type === 'ProductVariant' ? 'variant' : null);
          const num = (v) => (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
          const entry = Array.isArray(s.stock_entries)
            ? s.stock_entries.find((e) => Number(e.warehouse_id) === HEALTHFARE_WAREHOUSE_ID) : null;
          const wh = entry ? {
            physical: num(entry.physical_stock_level),
            allocated: num(entry.allocated_stock_level),
            available: num(entry.available_stock_level ?? entry.available),
          } : null;
          out.set(sku, { sku, title: s.product_title || s.full_title || ptitle, product_title: ptitle, upc_code: s.upc_code || null, stock, type, wh });
        }
      }
      if (rows.length < 100) break;
    }
    return [...out.values()];
  }

  /**
   * O CATÁLOGO DE PRODUTOS INTEIRO, cru, pra ABSORÇÃO (Bruno 08-19).
   *
   * listSellables() acima devolve o que o hub precisa pra CONTAR (sku, estoque,
   * tipo). Ela joga fora tudo o que identifica o produto: foto, marca, descrição,
   * o id do produto pai. É exatamente isso que se perde se a conta da Veeqo
   * fechar, e é isso que este método traz.
   *
   * Devolve por produto: {id, title, brand, description, image_url, thumb_url,
   * sellables:[{sku, title, upc_code, type, image_url}]}. O `image_url` sai do
   * primeiro campo que existir (main_image_src / main_image / image / thumbnail),
   * porque a Veeqo varia a forma conforme o produto foi cadastrado — alguns têm
   * string direta, outros um objeto {src}.
   *
   * Read-only, mesma paginação e mesmo teto de 60 páginas do listSellables.
   */
  async function listProducts() {
    const out = [];
    for (let page = 1; page <= 60; page++) {
      const rows = await getProductsPage({ page, pageSize: 100 });
      if (!rows.length) break;
      for (const pd of rows) {
        if (!pd) continue;
        out.push(normalizeProduct(pd));
      }
      if (rows.length < 100) break;
    }
    return out;
  }

  // ── ESCRITA DE ESTOQUE (Bruno 08-04) ──────────────────────────────────────
  // ÚNICO ponto que ESCREVE na Veeqo. Trava dura: só o "HealthFare Warehouse".
  // O outro armazém (Rosa Neciosup Castro) NUNCA é tocado. Erro NÃO expõe a chave.
  const HEALTHFARE_WAREHOUSE_ID = Number(opts.warehouseId || process.env.VEEQO_WAREHOUSE_ID || 108841);

  async function _req(method, path, bodyObj) {
    if (!apiKey) { const e = new Error('VEEQO_API_KEY não configurada'); e.code = 'no_key'; throw e; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let r;
    try {
      r = await fetchImpl(baseUrl + path, {
        method, signal: ctrl.signal,
        headers: { 'x-api-key': apiKey, accept: 'application/json', 'content-type': 'application/json' },
        body: bodyObj != null ? JSON.stringify(bodyObj) : undefined,
      });
    } catch (e) {
      clearTimeout(timer);
      const err = new Error(e && e.name === 'AbortError' ? ('Veeqo timeout (' + timeoutMs + 'ms)') : ('Veeqo inacessível: ' + (e && e.message)));
      err.code = e && e.name === 'AbortError' ? 'timeout' : 'network'; throw err;
    }
    clearTimeout(timer);
    if (r.status === 401) { const e = new Error('Veeqo recusou a chave (401)'); e.code = 'unauthorized'; e.status = 401; throw e; }
    let j = null; try { j = await r.json(); } catch (_) { j = null; }
    if (!r.ok) { const e = new Error('Veeqo HTTP ' + r.status + (j && j.error ? (': ' + j.error) : '')); e.code = 'http_error'; e.status = r.status; e.body = j; throw e; }
    return j;
  }

  /** Acha o sellable pelo SKU (exato). Devolve { sellable_id, sku, title, warehouse_stock }
   *  do NOSSO armazém, ou null. Read-only. Usado antes de escrever pra confirmar o alvo. */
  async function findSellableBySku(sku) {
    const want = String(sku || '').trim().toLowerCase();
    if (!want) return null;
    for (let page = 1; page <= 60; page++) {
      const rows = await getProductsPage({ page, pageSize: 100 });
      if (!rows.length) break;
      for (const pd of rows) {
        for (const s of (pd.sellables || [])) {
          if ((s.sku_code || '').trim().toLowerCase() !== want) continue;
          const entry = (s.stock_entries || []).find((e) => Number(e.warehouse_id) === HEALTHFARE_WAREHOUSE_ID);
          return {
            sellable_id: s.id, sku: s.sku_code,
            title: s.product_title || s.full_title || pd.title || '',
            warehouse_stock: entry ? Number(entry.physical_stock_level ?? 0) : 0,
            warehouse_id: HEALTHFARE_WAREHOUSE_ID,
          };
        }
      }
      if (rows.length < 100) break;
    }
    return null;
  }

  /**
   * Escreve o estoque FÍSICO de um SKU no HealthFare Warehouse.
   * mode 'set' = o número vira o físico; 'add' = soma ao físico atual.
   * SEMPRE lê o atual antes (confirma o alvo + calcula 'add' + devolve before/after).
   * @returns {object} { sku, sellable_id, warehouse_id, before, after, mode, applied }
   */
  async function setStock({ sku, mode = 'set', qty }) {
    const n = Number(qty);
    if (!Number.isFinite(n) || n < 0) { const e = new Error('quantidade inválida'); e.code = 'bad_qty'; throw e; }
    if (mode !== 'set' && mode !== 'add') { const e = new Error("mode deve ser 'set' ou 'add'"); e.code = 'bad_mode'; throw e; }
    const found = await findSellableBySku(sku);
    if (!found) { const e = new Error('SKU não encontrado no Veeqo: ' + sku); e.code = 'not_found'; throw e; }
    const before = found.warehouse_stock;
    const after = mode === 'add' ? before + n : n;
    // Veeqo: PUT do stock_entry por sellable+warehouse (probe 08-04: PUT=200, POST=404).
    await _req('PUT', `/sellables/${found.sellable_id}/warehouses/${found.warehouse_id}/stock_entry`,
      { stock_entry: { physical_stock_level: after, infinite: false } });
    return { sku: found.sku, sellable_id: found.sellable_id, warehouse_id: found.warehouse_id,
      before, after, mode, applied: after - before };
  }

  return { configured, baseUrl, getOrdersPage, shippedByDay, ordersShippedOn, getLabelPdf,
    getProductsPage, listSellables, listProducts,
    findSellableBySku, setStock, warehouseId: HEALTHFARE_WAREHOUSE_ID };
}

const veeqo = createVeeqoClient();
module.exports = { veeqo, createVeeqoClient, normalizeProduct, pickImage };
