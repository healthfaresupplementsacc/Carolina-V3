'use strict';
/**
 * HEALTHFARE V3 — Centro de Estoque — veeqo-order-sync (Bruno 08-01)
 *
 * Espelha pedidos da Veeqo por LINHA em v3.pnp_order_lines:
 *   - abertos (awaiting_fulfillment) → pick sheet do dia
 *   - enviados (shipped = etiqueta impressa) → dedução de estoque
 *   - cancelados → tira a linha (nunca imprime cancelado — regra do Bruno)
 *
 * DEDUÇÃO (Fase A): STOCK_DEDUCT_MODE controla:
 *   'dry'  (default) → NÃO deduz nada; as linhas shipped ficam registradas e o
 *                      diff diário (shadow mode) compara com o físico.
 *   'live'           → StockService.pick() por linha, idempotente por
 *                      (source='veeqo_ship', source_ref='<order_id>:<line_id>').
 *
 * Status nunca regride: pending → picklisted → printed → shipped;
 * cancelled só sobrescreve estados não-terminais (shipped não vira cancelled
 * retroativamente aqui — divergência dessa ordem é caso pra incidente).
 *
 * SKU→produto SÓ via v3.product_skus confirmado. SKU sem mapa = quarentena
 * (product_id NULL + error_note) — deduzir por palpite corrompe dois produtos.
 * OPT-IN: só roda com WORKER_VEEQO_ORDERS_ENABLED=true (tabelas 058/059 precisam existir).
 */
const EDT = 'America/New_York';
const STATUS_RANK = { pending: 0, picklisted: 1, printed: 2, shipped: 3, cancelled: 3, error: 0 };

class VeeqoOrderSync {
  constructor(deps = {}) {
    this.db = deps.db;
    this.veeqo = deps.veeqo;                 // client veeqo-api
    this.stock = deps.stock || null;         // StockService (modo live)
    this.enabled = deps.enabled !== undefined ? deps.enabled
      : (process.env.WORKER_VEEQO_ORDERS_ENABLED === 'true');
    this.deductMode = deps.deductMode || process.env.STOCK_DEDUCT_MODE || 'dry';
    this.heartbeat = deps.heartbeat || null;
    this.maxPages = deps.maxPages || 15;     // 1500 pedidos/status/tick — folga enorme pro volume real
    this._t = null; this._kick = null; this._ticking = false;
  }

  start(ms = 5 * 60 * 1000) {
    this._kick = setTimeout(() => this.tick().catch((e) => console.error('[veeqo-sync] erro:', e.message)), 20 * 1000);
    this._t = setInterval(() => this.tick().catch((e) => console.error('[veeqo-sync] erro:', e.message)), ms);
    console.log('[V3] veeqo-order-sync ligado (' + (this.enabled ? 'ON' : 'OFF') + ', deduct=' + this.deductMode + ')');
  }
  stop() { if (this._t) clearInterval(this._t); if (this._kick) clearTimeout(this._kick); this._t = null; this._kick = null; }

  _nyDate(iso) { return iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: EDT }) : null; }

  /** Upsert de uma linha; status nunca regride (rank). Devolve a row atual. */
  async _upsertLine(l) {
    const r = await this.db.query(
      `INSERT INTO v3.pnp_order_lines
         (source, external_order_id, external_line_id, order_number, channel, sku,
          product_id, qty, status, order_date, shipped_at, raw, error_note)
       VALUES ('veeqo',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
       ON CONFLICT (source, external_order_id, external_line_id) DO UPDATE SET
         synced_at = NOW(),
         channel = COALESCE(EXCLUDED.channel, v3.pnp_order_lines.channel),
         product_id = COALESCE(v3.pnp_order_lines.product_id, EXCLUDED.product_id),
         qty = EXCLUDED.qty,
         shipped_at = COALESCE(EXCLUDED.shipped_at, v3.pnp_order_lines.shipped_at),
         error_note = EXCLUDED.error_note,
         status = CASE
           WHEN EXCLUDED.status = 'cancelled' AND v3.pnp_order_lines.status NOT IN ('shipped') THEN 'cancelled'
           WHEN $13::int > (CASE v3.pnp_order_lines.status
                              WHEN 'pending' THEN 0 WHEN 'picklisted' THEN 1
                              WHEN 'printed' THEN 2 ELSE 3 END)
             THEN EXCLUDED.status
           ELSE v3.pnp_order_lines.status END
       RETURNING *`,
      [String(l.order_id), String(l.line_id), l.order_number || null, l.channel || null,
        l.sku || null, l.product_id, l.qty, l.status, l.order_date, l.shipped_at || null,
        l.raw ? JSON.stringify(l.raw) : null, l.error_note || null,
        STATUS_RANK[l.status] != null ? STATUS_RANK[l.status] : 0]);
    return r.rows[0];
  }

  /** Mapa sku→{product_id, units_per_pack} (só confirmados). */
  async _skuMap() {
    const r = await this.db.query(
      `SELECT sku, product_id, units_per_pack FROM v3.product_skus
        WHERE channel = 'veeqo' AND confirmed_at IS NOT NULL`);
    const m = new Map();
    for (const row of r.rows) m.set(row.sku, row);
    return m;
  }

  _lines(order, status) {
    const out = [];
    for (const li of (order.line_items || [])) {
      const s = li.sellable || {};
      out.push({
        order_id: order.id, line_id: li.id != null ? li.id : (s.sku_code || 'x'),
        order_number: order.number || order.order_number || null,
        channel: (order.channel && (order.channel.name || order.channel.type_code)) || null,
        sku: (s.sku_code || '').trim() || null,
        qty: Number(li.quantity) || 0,
        status,
        order_date: this._nyDate(order.created_at || order.received_at) || this._nyDate(new Date().toISOString()),
        shipped_at: order.shipped_at || null,
        raw: { title: s.product_title || s.full_title || li.title || null },
      });
    }
    return out;
  }

  async _syncStatus(status, mappedStatus, sinceIso, skuMap) {
    let n = 0;
    for (let page = 1; page <= this.maxPages; page++) {
      const rows = await this.veeqo.getOrdersPage({ status, updatedSince: sinceIso, page, pageSize: 100 });
      if (!rows.length) break;
      for (const o of rows) {
        for (const l of this._lines(o, mappedStatus)) {
          if (!l.qty) continue;
          const map = l.sku ? skuMap.get(l.sku) : null;
          l.product_id = map ? map.product_id : null;
          l.error_note = map ? null : (l.sku ? 'SKU sem mapeamento confirmado' : 'linha sem SKU');
          const row = await this._upsertLine(l);
          n++;
          // dedução: só linhas shipped, modo live, ainda não deduzidas, com mapa
          if (mappedStatus === 'shipped' && this.deductMode === 'live' && this.stock
              && row && !row.deducted_at && map) {
            const bottles = l.qty * (map.units_per_pack || 1);   // -C2 = 2 garrafas por unidade
            await this.stock.pick({
              product_id: map.product_id, qty: bottles,
              source: 'veeqo_ship', source_ref: `${l.order_id}:${l.line_id}`,
              note: `${l.channel || 'veeqo'} pedido ${l.order_number || l.order_id}`,
              // prateleira primeiro, caixa depois (Bruno 08-18): a garrafa saiu do
              // armazém de verdade, então o total cai mesmo com a prateleira vazia.
              allow_box: true,
            });
            await this.db.query(
              'UPDATE v3.pnp_order_lines SET deducted_at = NOW() WHERE id = $1', [row.id]);
          }
        }
      }
      if (rows.length < 100) break;
    }
    return n;
  }

  async tick() {
    if (this._ticking || !this.enabled) return { skipped: true };
    if (!this.veeqo || !this.veeqo.configured()) return { skipped: true, no_key: true };
    this._ticking = true;
    try { this.heartbeat && this.heartbeat(); } catch (_) {}
    try {
      const skuMap = await this._skuMap();
      // janela: 48h cobre o dia NY + reprocesso de ontem com folga
      const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const open = await this._syncStatus('awaiting_fulfillment', 'pending', since, skuMap);
      const shipped = await this._syncStatus('shipped', 'shipped', since, skuMap);
      let cancelled = 0;
      try { cancelled = await this._syncStatus('cancelled', 'cancelled', since, skuMap); }
      catch (_) { /* nem toda conta expõe esse filtro — o que importa: nunca regride shipped */ }
      return { open, shipped, cancelled, deduct: this.deductMode };
    } finally { this._ticking = false; }
  }
}

module.exports = { VeeqoOrderSync };
