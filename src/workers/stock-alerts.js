'use strict';
/**
 * HEALTHFARE V3 — Centro de Estoque — stock-alerts (Bruno 08-01)
 *
 * O planejador que impede ruptura de estoque, ciente do EMS:
 *  1. Por produto: estoque armazém (bins+caixas) + estoque marketplace (Veeqo)
 *     ÷ velocidade de venda (média 14d das linhas shipped) = DIAS DE ESTOQUE.
 *  2. Lead time por fórmula MEDIDO do nosso histórico EMS (ems_activity_cache):
 *     mediana de (última sync − primeiro visto) por batch, por produto.
 *  3. Horizonte de planejamento: days_of_stock <= lead_time + margem →
 *     "comece a planejar AGORA".
 *  4. Alertas (deduped 24h por produto+tipo via audit_log):
 *     - baixo/zerado COM batch no EMS  → :rotating_light: rodar na linha ASAP
 *     - baixo/zerado SEM batch no EMS  → adicionar à lista de fabricação
 *  Threshold: v3.stock_thresholds (admin) OU heurística (lead_time + margem).
 *
 * Canal: STOCK_ALERTS_CHANNEL (env) — em teste aponta pro sandbox do admin;
 * produção = admin-orin. NUNCA canal de operador (regra permanente).
 * OPT-IN: WORKER_STOCK_ALERTS_ENABLED=true.
 */
const EDT = 'America/New_York';

class StockAlerts {
  constructor(deps = {}) {
    this.db = deps.db;
    this.veeqo = deps.veeqo || null;
    this.slack = deps.slack || null;         // { postAs }
    this.channelId = deps.channelId;         // admin-orin (ou sandbox em teste)
    this.enabled = deps.enabled !== undefined ? deps.enabled
      : (process.env.WORKER_STOCK_ALERTS_ENABLED === 'true');
    this.heartbeat = deps.heartbeat || null;
    this.safetyDays = deps.safetyDays || 3;  // margem sobre o lead time
    this.defaultLeadDays = deps.defaultLeadDays || 7;
    this._t = null; this._kick = null; this._ticking = false;
    this._sellablesCache = { at: 0, map: null };   // listSellables é pesado — cache 1h
  }

  start(ms = 30 * 60 * 1000) {
    this._kick = setTimeout(() => this.tick().catch((e) => console.error('[stock-alerts] erro:', e.message)), 45 * 1000);
    this._t = setInterval(() => this.tick().catch((e) => console.error('[stock-alerts] erro:', e.message)), ms);
    console.log('[V3] stock-alerts ligado (' + (this.enabled ? 'ON' : 'OFF') + ')');
  }
  stop() { if (this._t) clearInterval(this._t); if (this._kick) clearTimeout(this._kick); this._t = null; this._kick = null; }

  /** Estoque marketplace por produto (via product_skus confirmados).
   *  Casepacks (-C2…) são views do MESMO pool: usa o SKU base (units_per_pack=1)
   *  quando existe; senão o MAX entre os SKUs do produto (não soma — dobraria). */
  async _marketplaceByProduct() {
    if (!this.veeqo || !this.veeqo.configured()) return new Map();
    const now = Date.now();
    if (!this._sellablesCache.map || now - this._sellablesCache.at > 3600 * 1000) {
      const sellables = await this.veeqo.listSellables();
      const bySku = new Map(sellables.map((s) => [s.sku, s.stock]));
      this._sellablesCache = { at: now, map: bySku };
    }
    const bySku = this._sellablesCache.map;
    const rows = (await this.db.query(
      `SELECT product_id, sku, units_per_pack FROM v3.product_skus
        WHERE channel = 'veeqo' AND confirmed_at IS NOT NULL`)).rows;
    const out = new Map();  // product_id -> {stock, base_seen}
    for (const r of rows) {
      const stock = bySku.get(r.sku);
      if (stock == null) continue;
      const cur = out.get(r.product_id) || { stock: null, base: false };
      if (r.units_per_pack === 1) {
        if (!cur.base || stock > cur.stock) out.set(r.product_id, { stock, base: true });
      } else if (!cur.base) {
        out.set(r.product_id, { stock: Math.max(cur.stock == null ? 0 : cur.stock, stock), base: false });
      }
    }
    return new Map([...out.entries()].map(([k, v]) => [k, v.stock]));
  }

  /** Velocidade (unidades-garrafa/dia, média 14d) por produto, das linhas shipped. */
  async _velocityByProduct() {
    const r = await this.db.query(`
      SELECT l.product_id,
             SUM(l.qty * COALESCE(ps.units_per_pack, 1))::numeric / 14 AS per_day,
             COUNT(DISTINCT l.order_date) AS days_seen
        FROM v3.pnp_order_lines l
        LEFT JOIN v3.product_skus ps ON ps.channel = l.source AND ps.sku = l.sku
       WHERE l.status = 'shipped' AND l.product_id IS NOT NULL
         AND l.order_date > (NOW() AT TIME ZONE '${EDT}')::date - 14
       GROUP BY l.product_id`);
    return new Map(r.rows.map((x) => [x.product_id, { perDay: Number(x.per_day), daysSeen: Number(x.days_seen) }]));
  }

  /** Lead time medido por produto (mediana por batch do histórico EMS), em dias. */
  async _leadDaysByProduct() {
    const r = await this.db.query(`
      WITH per_batch AS (
        SELECT pb.product_id,
               EXTRACT(EPOCH FROM (MAX(c.last_synced_at) - MIN(c.first_seen_at))) / 86400 AS days
          FROM v3.ems_activity_cache c
          JOIN v3.product_batches pb ON pb.batch_number = c.batch_number AND pb.deleted_at IS NULL
         GROUP BY pb.product_id, c.batch_number
        HAVING MAX(c.last_synced_at) > MIN(c.first_seen_at))
      SELECT product_id,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days) AS median_days
        FROM per_batch WHERE days BETWEEN 0.25 AND 30
       GROUP BY product_id`);
    return new Map(r.rows.map((x) => [x.product_id, Number(x.median_days)]));
  }

  /** Batch ativo no EMS por produto: {batch_number, stage} (o mais recente). */
  async _emsActiveByProduct() {
    const r = await this.db.query(`
      SELECT DISTINCT ON (pb.product_id) pb.product_id, c.batch_number, c.stage
        FROM v3.ems_activity_cache c
        JOIN v3.product_batches pb ON pb.batch_number = c.batch_number AND pb.deleted_at IS NULL
       WHERE c.sync_status = 'active'
       ORDER BY pb.product_id, c.last_synced_at DESC`);
    return new Map(r.rows.map((x) => [x.product_id, { batch: x.batch_number, stage: x.stage }]));
  }

  async _thresholds() {
    const r = await this.db.query('SELECT * FROM v3.stock_thresholds');
    return new Map(r.rows.map((x) => [x.product_id, x]));
  }

  async _alertedRecently(kind, productId) {
    const r = await this.db.query(
      `SELECT 1 FROM v3.audit_log
        WHERE action = $1 AND (metadata->>'product_id')::int = $2
          AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
      [kind, productId]);
    return r.rowCount > 0;
  }

  async _post(text) {
    if (!(this.slack && this.slack.postAs && this.channelId)) return false;
    try {
      await this.slack.postAs({
        channel: this.channelId,
        sender: { name: 'HealthFare Estoque', icon: ':package:' },
        thread_ts: null, unfurl_links: false, unfurl_media: false, text,
      });
      return true;
    } catch (e) { console.error('[stock-alerts] post falhou:', e.message); return false; }
  }

  async _markAlerted(kind, productId, meta) {
    try {
      await this.db.query(
        `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
         VALUES ('system', NULL, $1, 'stock', $2, $3::jsonb)`,
        [kind, productId, JSON.stringify({ product_id: productId, ...meta })]);
    } catch (_) { /* dedupe fica em memória se audit falhar */ }
  }

  /** Estado completo por produto (também alimenta o endpoint /stock/planner). */
  async compute() {
    const [wh, velo, lead, ems, thr, mkt] = await Promise.all([
      this.db.query(`
        SELECT p.id AS product_id, p.canonical_name,
               COALESCE(b.q, 0) AS bin_qty, COALESCE(x.q, 0) AS box_qty
          FROM v3.products p
          LEFT JOIN (SELECT product_id, SUM(qty) q FROM v3.stock_bins WHERE active GROUP BY product_id) b ON b.product_id = p.id
          LEFT JOIN (SELECT product_id, SUM(qty) q FROM v3.stock_boxes WHERE status='in_storage' GROUP BY product_id) x ON x.product_id = p.id`),
      this._velocityByProduct(), this._leadDaysByProduct(),
      this._emsActiveByProduct(), this._thresholds(), this._marketplaceByProduct(),
    ]);
    const out = [];
    for (const row of wh.rows) {
      const pid = row.product_id;
      const v = velo.get(pid);
      const warehouseQty = Number(row.bin_qty) + Number(row.box_qty);
      const mktStock = mkt.has(pid) ? mkt.get(pid) : null;
      const totalQty = warehouseQty + (mktStock || 0);
      if (!v && totalQty === 0) continue;                       // produto sem vida — silêncio
      const perDay = v ? v.perDay : 0;
      const daysOfStock = perDay > 0 ? totalQty / perDay : null;
      const leadDays = lead.get(pid) || this.defaultLeadDays;
      const t = thr.get(pid) || {};
      const minDays = t.min_days != null ? Number(t.min_days) : (leadDays + this.safetyDays);
      const emsBatch = ems.get(pid) || null;
      let zone = 'ok';
      if ((mktStock != null && mktStock <= 0) || totalQty <= 0) zone = 'out';
      else if (t.min_units != null && totalQty <= t.min_units) zone = 'low';
      else if (daysOfStock != null && daysOfStock <= minDays / 2) zone = 'low';
      else if (daysOfStock != null && daysOfStock <= minDays) zone = 'plan';
      out.push({
        product_id: pid, name: row.canonical_name,
        bin_qty: Number(row.bin_qty), box_qty: Number(row.box_qty),
        warehouse_qty: warehouseQty, marketplace_qty: mktStock,
        per_day: perDay ? Number(perDay.toFixed(2)) : 0,
        days_of_stock: daysOfStock != null ? Number(daysOfStock.toFixed(1)) : null,
        lead_days: Number(leadDays.toFixed(1)), min_days: Number(minDays.toFixed(1)),
        ems_batch: emsBatch, zone,
        velocity_reliable: !!(v && v.daysSeen >= 7),
      });
    }
    out.sort((a, b) => {
      const z = { out: 0, low: 1, plan: 2, ok: 3 };
      if (z[a.zone] !== z[b.zone]) return z[a.zone] - z[b.zone];
      return (a.days_of_stock == null ? 999 : a.days_of_stock) - (b.days_of_stock == null ? 999 : b.days_of_stock);
    });
    return out;
  }

  async tick() {
    if (this._ticking || !this.enabled) return { skipped: true };
    this._ticking = true;
    try { this.heartbeat && this.heartbeat(); } catch (_) {}
    try {
      const rows = await this.compute();
      let alerts = 0;
      for (const r of rows) {
        // sem histórico confiável de venda, não grita (primeiras 1-2 semanas = coleta)
        if (!r.velocity_reliable && r.zone !== 'out') continue;
        if (r.zone === 'ok') continue;
        const kind = r.zone === 'plan' ? 'stock_plan_alert' : 'stock_low_alert';
        if (await this._alertedRecently(kind, r.product_id)) continue;
        let text;
        const stockLine = `armazém *${r.warehouse_qty}* (bins ${r.bin_qty} + caixas ${r.box_qty})`
          + (r.marketplace_qty != null ? ` · marketplace *${r.marketplace_qty}*` : '')
          + (r.days_of_stock != null ? ` · ~*${r.days_of_stock}* dias de estoque` : '');
        if (r.zone === 'plan') {
          text = `Planejar produção: *${r.name}*. ${stockLine}. `
            + `Fórmula leva ~${r.lead_days} dias` + (r.ems_batch ? ` (batch ${r.ems_batch.batch} em ${r.ems_batch.stage})` : ', sem batch no EMS')
            + `. Comece a planejar.`;
        } else if (r.ems_batch) {
          text = `:rotating_light: Rodar na linha ASAP: *${r.name}*. ${stockLine}. `
            + `Batch *${r.ems_batch.batch}* está em ${r.ems_batch.stage} no EMS, prioriza.`;
        } else {
          text = `:red_circle: Adicionar à lista de fabricação: *${r.name}*. ${stockLine}. `
            + `Sem batch no EMS, sem produção à vista. <!here>`;
        }
        if (await this._post(text)) {
          await this._markAlerted(kind, r.product_id, {
            zone: r.zone, days: r.days_of_stock, warehouse: r.warehouse_qty, marketplace: r.marketplace_qty,
          });
          alerts++;
        }
      }
      return { products: rows.length, alerts };
    } finally { this._ticking = false; }
  }
}

module.exports = { StockAlerts };
