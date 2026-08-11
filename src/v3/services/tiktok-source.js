'use strict';
/**
 * HEALTHFARE V3 — TikTok source (ENCAPSULADO — Bruno 08-04)
 *
 * "Keep these tiktok settings as something encapsulated, so that when we get
 *  the API, it's easy to switch without the system getting confused."
 *
 * CONTRATO: o resto do sistema (pick sheet, planner, cockpit, dedução) SÓ lê
 * v3.pnp_order_lines (source='tiktok') e NUNCA sabe de onde as linhas vieram.
 * Este módulo é a ÚNICA porta de entrada de pedidos TikTok, com duas
 * implementações intercambiáveis do mesmo funil:
 *
 *   modo 'csv' (HOJE, sem account manager): export manual do Seller Center →
 *     parseSellerCenterCsv() → linhas normalizadas → ingestLines().
 *   modo 'api' (FUTURO, quando o app do Partner Center sair): um worker
 *     tiktok-order-sync chama a Open API (Get Order List) → normaliza pro
 *     MESMO shape → chama o MESMO ingestLines(). O parser CSV se aposenta
 *     sem tocar em NADA downstream; o endpoint de upload passa a recusar
 *     (evita duplo-feed CSV+API).
 *
 * Shape normalizado de linha (o contrato entre os modos):
 *   { order_id, line_id, sku, qty, status('pending'|'shipped'|'cancelled'),
 *     order_date('YYYY-MM-DD' NY), title? }
 *
 * Config: TIKTOK_SOURCE = 'csv' (default) | 'api'.
 * Mesmas regras do sync Veeqo: upsert idempotente, status nunca regride,
 * SKU sem mapa (product_skus channel='tiktok') = quarentena, ZERO dedução aqui.
 */
const TZ = 'America/New_York';
const RANK = { pending: 0, picklisted: 1, printed: 2, shipped: 3, cancelled: 3 };

function mode() {
  return process.env.TIKTOK_SOURCE === 'api' ? 'api' : 'csv';
}

/** Export do Seller Center → linhas normalizadas. Tolera BOM, aspas,
 *  vírgula/tab/ponto-e-vírgula e nomes de coluna variantes. */
function parseSellerCenterCsv(rawText) {
  const raw = String(rawText || '').replace(/^﻿/, '');
  if (!raw.trim()) throw new Error('csv vazio (conteúdo do export do Seller Center)');
  const firstLine = raw.slice(0, raw.indexOf('\n') + 1 || raw.length);
  const delim = (firstLine.match(/\t/g) || []).length >= 2 ? '\t'
    : (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let cur = [], field = '', inQ = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQ) {
      if (ch === '"') { if (raw[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { cur.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && raw[i + 1] === '\n') i++;
      cur.push(field); field = '';
      if (cur.some((c) => c.trim() !== '')) rows.push(cur);
      cur = [];
    } else field += ch;
  }
  cur.push(field);
  if (cur.some((c) => c.trim() !== '')) rows.push(cur);
  if (rows.length < 2) throw new Error('CSV sem linhas de dados');

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => {
    for (const n of names) {
      const i = header.findIndex((h) => h.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };
  const cOrder = col('order id', 'order number', 'main order');
  const cSku = col('seller sku', 'sku');
  const cQty = col('quantity', 'qty');
  const cStatus = col('order status', 'order substatus', 'status');
  const cCreated = col('created time', 'create time', 'order create', 'paid time');
  const cProduct = col('product name', 'product');
  if (cOrder < 0 || cSku < 0 || cQty < 0) {
    throw new Error('CSV não reconhecido — precisa de Order ID, Seller SKU e Quantity (achei: '
      + header.slice(0, 8).join(' | ') + '…)');
  }
  const statusMap = (t) => {
    const x = String(t || '').toLowerCase();
    if (/cancel/.test(x)) return 'cancelled';
    if (/deliver|complet|shipped|in transit/.test(x)) return 'shipped';
    return 'pending';
  };
  const nyDate = (t) => {
    const d = t ? new Date(t) : new Date();
    return isNaN(d) ? new Date().toLocaleDateString('en-CA', { timeZone: TZ })
      : d.toLocaleDateString('en-CA', { timeZone: TZ });
  };
  const seen = new Map();                      // ordem+sku repetido → sufixo :2, :3…
  const lines = [];
  for (const row of rows.slice(1)) {
    const order_id = String(row[cOrder] || '').trim();
    const sku = String(row[cSku] || '').trim();
    const qty = parseInt(String(row[cQty] || '').replace(/\D/g, ''), 10) || 0;
    if (!order_id || !qty) continue;
    const k = order_id + ' ' + sku;
    seen.set(k, (seen.get(k) || 0) + 1);
    lines.push({
      order_id,
      line_id: sku + (seen.get(k) > 1 ? ':' + seen.get(k) : ''),
      sku: sku || null,
      qty,
      status: statusMap(cStatus >= 0 ? row[cStatus] : ''),
      order_date: nyDate(cCreated >= 0 ? row[cCreated] : null),
      title: cProduct >= 0 ? String(row[cProduct] || '').slice(0, 200) : null,
    });
  }
  return { lines, delim: delim === '\t' ? 'tab' : delim };
}

/** O funil ÚNICO: linhas normalizadas (de QUALQUER modo) → v3.pnp_order_lines.
 *  Idempotente; status nunca regride; SKU sem mapa = quarentena. */
async function ingestLines(db, lines) {
  const skuMap = new Map((await db.query(
    `SELECT sku, product_id FROM v3.product_skus WHERE channel = 'tiktok'`)).rows
    .map((x) => [x.sku, x.product_id]));
  let imported = 0, unmapped = 0;
  for (const l of lines) {
    const pid = (l.sku && skuMap.get(l.sku)) || null;
    if (!pid) unmapped++;
    await db.query(
      `INSERT INTO v3.pnp_order_lines
         (source, external_order_id, external_line_id, order_number, channel, sku,
          product_id, qty, status, order_date, raw, error_note)
       VALUES ('tiktok',$1,$2,$1,'TikTok Shop',$3,$4,$5,$6,$7,$8::jsonb,$9)
       ON CONFLICT (source, external_order_id, external_line_id) DO UPDATE SET
         synced_at = NOW(), qty = EXCLUDED.qty,
         product_id = COALESCE(v3.pnp_order_lines.product_id, EXCLUDED.product_id),
         error_note = EXCLUDED.error_note,
         status = CASE
           WHEN EXCLUDED.status = 'cancelled' AND v3.pnp_order_lines.status NOT IN ('shipped') THEN 'cancelled'
           WHEN $10::int > (CASE v3.pnp_order_lines.status
                              WHEN 'pending' THEN 0 WHEN 'picklisted' THEN 1
                              WHEN 'printed' THEN 2 ELSE 3 END)
             THEN EXCLUDED.status
           ELSE v3.pnp_order_lines.status END`,
      [l.order_id, l.line_id, l.sku, pid, l.qty, l.status, l.order_date,
        JSON.stringify({ title: l.title || null }),
        pid ? null : (l.sku ? 'SKU sem mapeamento (canal tiktok)' : 'linha sem SKU'),
        RANK[l.status] != null ? RANK[l.status] : 0]);
    imported++;
  }
  return { imported, unmapped };
}

module.exports = { mode, parseSellerCenterCsv, ingestLines };
