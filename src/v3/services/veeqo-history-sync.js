'use strict';
/**
 * HEALTHFARE V4 — HISTÓRICO DE ESTOQUE DA VEEQO → NOSSO LIVRO (Bruno 09-16).
 *
 * "Você não vê o motivo e as notas que a gente coloca quando muda o estoque na Veeqo?"
 * Vê, sim: o endpoint NÃO documentado `GET /stock_histories` (confirmado por funcionário
 * da Veeqo no fórum deles em 2017, ainda no ar) devolve cada mudança de estoque com
 * quem fez ("Edited by Henrique Monteiro"), quanto, o nível depois, o MOTIVO ("Return",
 * "Item found", "Other"…) e a NOTA livre ("Inventory count 09/12/2026").
 *
 * O que este serviço faz:
 *   1. ESPELHA cada entrada em v3.veeqo_stock_history (migration 095), ligada ao nosso
 *      produto pelo SKU. É o registro: quem, quando, quanto, motivo, nota. Nada some.
 *   2. APLICA no nosso estoque só o que faz sentido aplicar:
 *      - action 'edited_by_user' (edição manual na Veeqo: devolução, achado, contagem…);
 *      - no armazém HealthFare (108841), SKU BASE de um produto nosso (kits derivam do
 *        base e pedidos já entram pelo veeqo-order-sync: nunca somar duas vezes);
 *      - depois da CARGA (BASELINE 2026-09-14 03:00Z): o que veio antes já está dentro
 *        da contagem que carregamos;
 *      - não feita por nós ("Edited by Production Line System" = o nosso próprio PUT).
 *      Vira StockService.adjust na caixa principal do produto, com reason_code mapeado,
 *      a nota da Veeqo preservada e o autor ("Veeqo · Henrique Monteiro"). Idempotente
 *      por source_ref 'veeqo_hist:<id>'.
 *
 * Regra de ouro mantida: quantidade só entra pela porta única (StockService). Aqui não
 * tem SQL cru em tabela de estoque.
 */

const HEALTHFARE_WAREHOUSE_ID = Number(process.env.VEEQO_WAREHOUSE_ID || 108841);
/** Momento da carga inicial (mutirão D-1). Edições manuais na Veeqo ANTES disso já
 *  estão dentro da contagem carregada; só o que veio depois vira movimento. */
const BASELINE = process.env.VEEQO_HISTORY_BASELINE || '2026-09-14T03:00:00Z';
/** Autor dos nossos próprios PUTs (a chave da API aparece assim na Veeqo). */
const OUR_ACTOR = /production line system/i;

/** Motivo da Veeqo → motivo do nosso catálogo (v3.stock_reasons). Preserva o texto
 *  original na nota; o código é só pra filtro/relatório. */
function mapReason(reason, increased, notes) {
  const r = String(reason || '').trim().toLowerCase();
  const n = String(notes || '').toLowerCase();
  // A nota costuma dizer mais que o motivo ("Other" + "BR-2026-0204" = produção; "Other" +
  // "Tiktok Order - 2 Units" = venda fora da Veeqo; "Other" + "Return Amz 15/09" = devolução).
  if (/\bbr-\d{4}-\d{3,}/i.test(n) || /produ|lote|batch/.test(n)) return increased ? 'producao' : 'erro_registro';
  if (/return|devolu/.test(r) || /return|devolu/.test(n)) return increased ? 'devolucao_usavel' : 'erro_registro';
  if (!increased && /order|pedido|tiktok|shopify|ebay|walmart|amazon|amz/.test(n)) return 'venda';
  if (/damag|lost|stolen|broken|dano|perd/.test(r)) return 'dano';
  if (/transfer/.test(r)) return increased ? 'transferencia_volta' : 'transferencia';
  if (/production|produ/.test(r)) return 'producao';
  if (/count|contag|found|achad/.test(r) || /count|contag|invent/.test(n)) return 'contagem';
  if (/sample|amostra/.test(r)) return 'amostra';
  if (/internal|uso/.test(r)) return 'uso_interno';
  return 'contagem';
}

/** Quem fez, a partir do summary ("Edited by Henrique Monteiro"). */
function actorOf(entry) {
  const s = String((entry && entry.action && entry.action.summary) || '').replace(/<[^>]+>/g, '');
  const m = s.match(/edited by\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Linha do espelho a partir de uma entrada crua do feed. skuInfo: {product_id, units_per_pack, veeqo_type, sku} | null */
function mirrorRow(entry, skuInfo) {
  const sel = entry.sellable || {}; const se = entry.stock_entry || {};
  return {
    id: Number(entry.id),
    created_at: entry.created_at,
    sellable_id: Number(sel.id || se.sellable_id) || null,
    sku: sel.sku_code || null,
    sellable_type: sel.type || null,
    product_id: skuInfo ? skuInfo.product_id : null,
    warehouse_id: Number(se.warehouse_id) || null,
    action: (entry.action && entry.action.name) || null,
    summary: String((entry.action && entry.action.summary) || '').replace(/<[^>]+>/g, '').slice(0, 300),
    actor: actorOf(entry),
    quantity: Number(entry.quantity) || 0,
    increased: !!entry.increased,
    stock_level: entry.stock_level != null ? Number(entry.stock_level) : null,
    reason: entry.reason || null,
    notes: entry.notes || null,
  };
}

function isBase(skuInfo, sellableType) {
  if (!skuInfo) return false;
  if (String(sellableType || '').toLowerCase() === 'kit' || skuInfo.veeqo_type === 'kit') return false;
  if (Number(skuInfo.units_per_pack || 1) !== 1) return false;
  if (/-WFS$/i.test(skuInfo.sku || '')) return false;
  return true;
}

/** Decisão pura: aplicar no nosso estoque? Devolve { apply, delta, reason_code, skip } */
function decide(row, opts = {}) {
  const baseline = opts.baseline || BASELINE;
  if (row.action !== 'edited_by_user') return { apply: false, skip: 'not_manual_edit' };
  if (row.warehouse_id !== HEALTHFARE_WAREHOUSE_ID) return { apply: false, skip: 'other_warehouse' };
  if (!row.product_id) return { apply: false, skip: 'sku_not_ours' };
  if (!row.is_base) return { apply: false, skip: 'not_base_sku' };
  if (row.actor && OUR_ACTOR.test(row.actor)) return { apply: false, skip: 'our_own_edit' };
  if (!(row.quantity > 0)) return { apply: false, skip: 'zero_qty' };
  if (new Date(row.created_at) <= new Date(baseline)) return { apply: false, skip: 'before_baseline' };
  const delta = row.increased ? row.quantity : -row.quantity;
  return { apply: true, delta, reason_code: mapReason(row.reason, row.increased, row.notes) };
}

class VeeqoHistorySync {
  /** deps: { db, veeqo (stockHistories), stock (StockService), heartbeat?, log?, baseline? } */
  constructor(deps = {}) {
    this.db = deps.db; this.veeqo = deps.veeqo; this.stock = deps.stock;
    this.heartbeat = deps.heartbeat || (() => {}); this.log = deps.log || ((...a) => console.log('[veeqo-history]', ...a));
    this.baseline = deps.baseline || BASELINE; this._t = null; this._busy = false;
  }

  async _skuMap() {
    const r = await this.db.query(`SELECT UPPER(ps.sku) AS sku, ps.product_id, ps.units_per_pack, ps.veeqo_type
                                     FROM v3.product_skus ps JOIN v3.products p ON p.id = ps.product_id
                                    WHERE p.merged_into_product_id IS NULL`);
    return new Map(r.rows.map((x) => [x.sku, { sku: x.sku, product_id: x.product_id, units_per_pack: x.units_per_pack, veeqo_type: x.veeqo_type }]));
  }

  async _mainBox(productId) {
    const r = await this.db.query(`SELECT id FROM v3.stock_boxes WHERE product_id = $1 AND status = 'in_storage' ORDER BY id LIMIT 1`, [productId]);
    return r.rows[0] ? r.rows[0].id : null;
  }

  /** Espelha + aplica uma lista de entradas cruas. Devolve contadores. */
  async ingest(entries, skuMap) {
    const out = { seen: 0, mirrored: 0, applied: 0, duplicate: 0, skipped: 0, errors: 0 };
    for (const e of entries || []) {
      out.seen++;
      const name = (e.action && e.action.name) || '';
      if (/^kit_content_/.test(name) || /^order_(de)?allocated$/.test(name)) continue;   // ruído: kits derivam, pedidos já têm dono
      const info = skuMap.get(String((e.sellable && e.sellable.sku_code) || '').toUpperCase()) || null;
      const row = mirrorRow(e, info); row.is_base = isBase(info, row.sellable_type);
      const d = decide(row, { baseline: this.baseline });
      const ins = await this.db.query(`
        INSERT INTO v3.veeqo_stock_history (id, created_at, sellable_id, sku, sellable_type, product_id, warehouse_id, action, summary, actor,
                                            quantity, increased, stock_level, reason, notes, apply_status, skip_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (id) DO NOTHING RETURNING id`,
        [row.id, row.created_at, row.sellable_id, row.sku, row.sellable_type, row.product_id, row.warehouse_id, row.action, row.summary, row.actor,
          row.quantity, row.increased, row.stock_level, row.reason, row.notes, d.apply ? 'pending' : 'skipped', d.apply ? null : d.skip]);
      if (!ins.rows[0]) { out.duplicate++; continue; }
      out.mirrored++;
      if (!d.apply) { out.skipped++; continue; }
      try {
        const boxId = await this._mainBox(row.product_id);
        const note = `[Veeqo] ${row.actor || '?'} · ${row.reason || 'sem motivo'}${row.notes ? ' · ' + row.notes : ''} · nível na Veeqo depois: ${row.stock_level}`;
        const res = await this.stock.adjust({
          product_id: row.product_id, qty: d.delta, box_id: boxId || undefined, unplaced: boxId ? undefined : true,
          note, source: 'veeqo_history', source_ref: 'veeqo_hist:' + row.id, reason_code: d.reason_code,
          actor_type: 'system', actor_name: 'Veeqo · ' + (row.actor || '?'), ref_type: 'veeqo_history', ref_id: row.id,
        });
        await this.db.query(`UPDATE v3.veeqo_stock_history SET apply_status = $2, applied_movement_id = $3, applied_qty = $4, applied_at = NOW() WHERE id = $1`,
          [row.id, res.duplicate ? 'duplicate' : 'applied', res.movement ? res.movement.id : null, res.applied || 0]);
        out.applied++;
        this.log(`aplicou ${d.delta > 0 ? '+' : ''}${d.delta} em produto ${row.product_id} (${row.sku}) · ${row.actor} · ${row.reason || '-'}${row.notes ? ' · ' + row.notes : ''}`);
      } catch (err) {
        out.errors++;
        await this.db.query(`UPDATE v3.veeqo_stock_history SET apply_status = 'error', skip_reason = $2 WHERE id = $1`, [row.id, String(err.message).slice(0, 200)]).catch(() => {});
        this.log('erro ao aplicar', row.id, err.message);
      }
    }
    return out;
  }

  async _cursor() {
    const r = await this.db.query(`SELECT value FROM v3.settings WHERE key = 'veeqo_history.cursor'`);
    return r.rows[0] && r.rows[0].value ? Number(r.rows[0].value.last_id) || 0 : 0;
  }
  async _setCursor(lastId) {
    await this.db.query(`INSERT INTO v3.settings (key, value, description) VALUES ('veeqo_history.cursor', $1::jsonb, 'último id do feed /stock_histories da Veeqo já espelhado')
                         ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`, [JSON.stringify({ last_id: lastId, at: new Date().toISOString() })]);
  }

  /** Incremental: feed global (mais novo primeiro) até chegar no último id visto. */
  async tick() {
    if (this._busy) return { skipped: true };
    this._busy = true;
    try {
      const skuMap = await this._skuMap();
      const cursor = await this._cursor();
      let maxId = cursor; const totals = { seen: 0, mirrored: 0, applied: 0, duplicate: 0, skipped: 0, errors: 0 };
      for (let page = 1; page <= 30; page++) {
        const rows = await this.veeqo.stockHistories({ page, per_page: 100 });
        if (!rows.length) break;
        const fresh = rows.filter((r) => Number(r.id) > cursor);
        const t = await this.ingest(fresh, skuMap);
        for (const k of Object.keys(totals)) totals[k] += t[k] || 0;
        for (const r of rows) maxId = Math.max(maxId, Number(r.id) || 0);
        if (fresh.length < rows.length) break;   // já passamos do cursor
      }
      if (maxId > cursor) await this._setCursor(maxId);
      this.heartbeat();
      return { cursor, new_cursor: maxId, ...totals };
    } finally { this._busy = false; }
  }

  /** Backfill: por SKU base (sellable_id), páginas até passar de `since`. */
  async backfillSellable(sellableId, since) {
    const skuMap = await this._skuMap();
    const totals = { seen: 0, mirrored: 0, applied: 0, duplicate: 0, skipped: 0, errors: 0 };
    for (let page = 1; page <= 50; page++) {
      const rows = await this.veeqo.stockHistories({ sellable_id: sellableId, page, per_page: 100 });
      if (!rows.length) break;
      const keep = rows.filter((r) => new Date(r.created_at) >= new Date(since));
      const t = await this.ingest(keep, skuMap);
      for (const k of Object.keys(totals)) totals[k] += t[k] || 0;
      if (keep.length < rows.length || rows.length < 100) break;
    }
    return totals;
  }

  start(ms) { const run = () => this.tick().catch((e) => console.error('[veeqo-history]', e.message)); setTimeout(run, 45 * 1000); this._t = setInterval(run, ms || 15 * 60 * 1000); return this; }
  stop() { if (this._t) clearInterval(this._t); }
}

module.exports = { VeeqoHistorySync, decide, mapReason, actorOf, mirrorRow, isBase, BASELINE, HEALTHFARE_WAREHOUSE_ID };
