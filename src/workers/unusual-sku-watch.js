'use strict';
/**
 * HEALTHFARE V3 — unusual-sku-watch (Bruno 08-06)
 *
 * REGRA: a picklist imprime TUDO que está alocado no HealthFare Warehouse pro dia
 * (até SKU FBA quando cai lá — exceção válida). NUNCA filtrar a fila. MAS: SKU
 * "estranho" na fila de P&P → AVISAR o admin-orin (sem tirar da picklist).
 *
 * "Estranho" = SKU sem mapeamento em v3.product_skus (produto desconhecido).
 * FBA/WFS NAO e estranho (Bruno 08-06: usamos FBA pra alocacao no warehouse).
 * Dedupe: 1 aviso por SKU por dia (audit_log action='unusual_sku').
 *
 * OPT-IN: WORKER_UNUSUAL_SKU_ENABLED=true. Canal: admin-orin. Nunca canal de operador.
 */
const EDT = 'America/New_York';

class UnusualSkuWatch {
  constructor(deps = {}) {
    this.db = deps.db;
    this.slack = deps.slack || null;             // { postAs }
    this.channelId = deps.channelId;             // admin-orin
    this.enabled = deps.enabled !== undefined ? deps.enabled
      : (process.env.WORKER_UNUSUAL_SKU_ENABLED === 'true');
    this.heartbeat = deps.heartbeat || null;
    this._t = null; this._kick = null; this._ticking = false;
  }

  start(ms = 15 * 60 * 1000) {
    this._kick = setTimeout(() => this.tick().catch((e) => console.error('[unusual-sku] erro:', e.message)), 70 * 1000);
    this._t = setInterval(() => this.tick().catch((e) => console.error('[unusual-sku] erro:', e.message)), ms);
    console.log('[V3] unusual-sku-watch ligado (' + (this.enabled ? 'ON' : 'OFF') + ')');
  }
  stop() { if (this._t) clearInterval(this._t); if (this._kick) clearTimeout(this._kick); this._t = null; this._kick = null; }

  _nyDate() { return new Date().toLocaleDateString('en-CA', { timeZone: EDT }); }

  /** SKUs estranhos na fila pendente de hoje (pendente = vai ser impresso). */
  async findUnusual() {
    const r = await this.db.query(`
      SELECT DISTINCT l.sku, l.channel,
             (ps.product_id IS NULL) AS unmapped,
             (l.sku ~* 'fba|wfs') AS fba_wfs,
             COUNT(*) OVER (PARTITION BY l.sku) AS lines
        FROM v3.pnp_order_lines l
        LEFT JOIN v3.product_skus ps ON ps.channel = l.source AND UPPER(ps.sku) = UPPER(l.sku)
       WHERE l.status = 'pending' AND l.sku IS NOT NULL
         AND ps.product_id IS NULL`);
    return r.rows;
  }

  async _warnedToday(sku, nyDate) {
    const r = await this.db.query(
      `SELECT 1 FROM v3.audit_log WHERE action = 'unusual_sku'
         AND metadata->>'sku' = $1 AND metadata->>'ny_date' = $2 LIMIT 1`, [sku, nyDate]);
    return r.rowCount > 0;
  }
  async _mark(sku, nyDate, info) {
    await this.db.query(
      `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
       VALUES ('system', NULL, 'unusual_sku', 'pnp', NULL, $1::jsonb)`,
      [JSON.stringify({ sku, ny_date: nyDate, ...info })]).catch(() => {});
  }

  async tick() {
    if (this._ticking || !this.enabled) return { skipped: true };
    this._ticking = true;
    try { this.heartbeat && this.heartbeat(); } catch (_) {}
    try {
      const nyDate = this._nyDate();
      const rows = await this.findUnusual();
      const fresh = [];
      for (const x of rows) {
        if (await this._warnedToday(x.sku, nyDate)) continue;
        fresh.push(x);
      }
      if (!fresh.length) return { unusual: rows.length, warned: 0 };
      // 1 mensagem agrupada no admin-orin (nada é removido da picklist)
      let text = ':mag: *SKU incomum na fila de P&P de hoje*. segue NA picklist (regra: imprimimos tudo do HealthFare Warehouse), mas confere:\n';
      for (const x of fresh) {
        const why = ['sem produto mapeado'];
        text += '• `' + x.sku + '` (' + (x.channel || '?') + ', ' + x.lines + ' linha' + (Number(x.lines) !== 1 ? 's' : '') + '). ' + why.join(' + ') + '\n';
      }
      if (this.slack && this.slack.postAs && this.channelId) {
        try {
          await this.slack.postAs({
            channel: this.channelId,
            sender: { name: 'HealthFare P&P', icon: ':mag:' },
            thread_ts: null, unfurl_links: false, unfurl_media: false, text,
          });
        } catch (e) { console.error('[unusual-sku] post falhou:', e.message); return { unusual: rows.length, warned: 0 }; }
      }
      for (const x of fresh) await this._mark(x.sku, nyDate, { channel: x.channel, fba_wfs: x.fba_wfs, unmapped: x.unmapped });
      return { unusual: rows.length, warned: fresh.length };
    } finally { this._ticking = false; }
  }
}

module.exports = { UnusualSkuWatch };
