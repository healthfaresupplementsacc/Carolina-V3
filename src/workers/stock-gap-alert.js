'use strict';
/**
 * HEALTHFARE V3 — stock-gap-alert (Bruno 08-06)
 *
 * Dois avisos sobre falta de estoque pro P&P:
 *  1) **10 min depois** que um operador inicia "Impressão de ordens" → manda o
 *     que está zerado/baixo na picklist de hoje, com a recomendação do EMS
 *     (cápsulas prontas? na linha? já passou? nada?). Vai pro **admin-orin E
 *     orders-and-inventory**.
 *  2) **Todo dia às 8h NY** → manda no **admin-orin** tudo que está fora de
 *     estoque e que vamos precisar pro P&P.
 *
 * Dedupe: 1 aviso de cada tipo por dia (audit_log). Respeita o mute do canal de
 * operador pro aviso do orders-and-inventory (admin-orin sempre recebe).
 * OPT-IN: WORKER_STOCK_GAP_ALERT_ENABLED=true.
 */
const { isMuted } = require('../v3/alert-gate');
const EDT = 'America/New_York';

class StockGapAlert {
  constructor(deps = {}) {
    this.db = deps.db;
    this.slack = deps.slack || null;                 // { postAs }
    this.adminChannel = deps.adminChannel || 'C0B36DR5MP1';
    this.opsChannel = deps.opsChannel || 'C09UNBXFRKK';   // orders-and-inventory
    this.getGaps = deps.getGaps || null;             // async () => { items, ... }
    this.enabled = deps.enabled !== undefined ? deps.enabled
      : (process.env.WORKER_STOCK_GAP_ALERT_ENABLED === 'true');
    this.heartbeat = deps.heartbeat || null;
    this.delayMin = deps.delayMin != null ? deps.delayMin : 10;   // 10 min após iniciar impressão
    this.morningHour = deps.morningHour != null ? deps.morningHour : 8;
    this._t = null; this._kick = null; this._ticking = false;
  }

  start(ms = 5 * 60 * 1000) {
    this._kick = setTimeout(() => this.tick().catch((e) => console.error('[stock-gap] erro:', e.message)), 80 * 1000);
    this._t = setInterval(() => this.tick().catch((e) => console.error('[stock-gap] erro:', e.message)), ms);
    console.log('[V3] stock-gap-alert ligado (' + (this.enabled ? 'ON' : 'OFF') + ')');
  }
  stop() { if (this._t) clearInterval(this._t); if (this._kick) clearTimeout(this._kick); this._t = null; this._kick = null; }

  _ny() {
    const now = new Date();
    const hour = Number((String(now.toLocaleString('en-US', { timeZone: EDT, hour: '2-digit', hour12: false })).match(/\d{1,2}/) || ['0'])[0]) % 24;
    return { hour, date: now.toLocaleDateString('en-CA', { timeZone: EDT }) };
  }

  async _done(kind, nyDate) {
    const r = await this.db.query(
      `SELECT 1 FROM v3.audit_log WHERE action='stock_gap_alert'
         AND metadata->>'kind'=$1 AND metadata->>'ny_date'=$2 LIMIT 1`, [kind, nyDate]);
    return r.rowCount > 0;
  }
  async _mark(kind, nyDate, info) {
    await this.db.query(
      `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
       VALUES ('system', NULL, 'stock_gap_alert', 'pnp', NULL, $1::jsonb)`,
      [JSON.stringify({ kind, ny_date: nyDate, ...info })]).catch(() => {});
  }

  /** Impressão começou há >= delayMin (e ainda é hoje)? */
  async printingStartedAgo() {
    const r = await this.db.query(`
      SELECT MIN(e.started_at) AS first_start
        FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
       WHERE at.slug IN ('order_printing','order_printing_2')
         AND COALESCE(e.is_test,false) = false
         AND to_char(e.started_at AT TIME ZONE '${EDT}','YYYY-MM-DD')
             = to_char(NOW() AT TIME ZONE '${EDT}','YYYY-MM-DD')`);
    const t = r.rows[0] && r.rows[0].first_start;
    if (!t) return null;
    return (Date.now() - new Date(t).getTime()) / 60000;   // minutos
  }

  _format(gaps, title) {
    const items = (gaps.items || []);
    let text = title + '\n';
    const crit = items.filter((x) => x.severity === 'critical');
    const warn = items.filter((x) => x.severity !== 'critical');
    if (crit.length) {
      text += '\n:red_circle: *PRECISA RESOLVER JÁ:*\n';
      crit.forEach((x) => { text += '• *' + x.product + '* (precisa ' + x.needed + ', tem ' + x.stock + '). ' + x.advice + '\n'; });
    }
    if (warn.length) {
      text += '\n:warning: *Dá pra resolver hoje:*\n';
      warn.forEach((x) => { text += '• *' + x.product + '* (precisa ' + x.needed + ', tem ' + x.stock + '). ' + x.advice + '\n'; });
    }
    return text;
  }

  async _post(channel, text) {
    if (!(this.slack && this.slack.postAs)) return false;
    try {
      await this.slack.postAs({ channel, sender: { name: 'HealthFare P&P', icon: ':package:' },
        thread_ts: null, unfurl_links: false, unfurl_media: false, text });
      return true;
    } catch (e) { console.error('[stock-gap] post falhou:', e.message); return false; }
  }

  async tick() {
    if (this._ticking || !this.enabled) return { skipped: true };
    this._ticking = true;
    try { this.heartbeat && this.heartbeat(); } catch (_) {}
    try {
      const { hour, date } = this._ny();
      const out = {};

      // (1) 10 min depois de começar a imprimir
      if (!(await this._done('after_printing', date))) {
        const ago = await this.printingStartedAgo();
        if (ago != null && ago >= this.delayMin) {
          const gaps = await this.getGaps();
          if (gaps && (gaps.items || []).length) {
            const text = this._format(gaps, ':package: *Falta de estoque pro P&P de hoje* (impressão começou há ' + Math.round(ago) + ' min):');
            await this._post(this.adminChannel, text);
            const muted = await isMuted(this.db, new Date()).catch(() => false);
            if (!muted) await this._post(this.opsChannel, text);
            await this._mark('after_printing', date, { items: gaps.items.length, critical: gaps.critical_count });
            out.after_printing = gaps.items.length;
          } else {
            await this._mark('after_printing', date, { items: 0 });   // tudo ok: não repete hoje
            out.after_printing = 0;
          }
        }
      }

      // (2) todo dia às 8h NY → admin-orin
      if (hour >= this.morningHour && !(await this._done('morning', date))) {
        const gaps = await this.getGaps();
        const items = (gaps && gaps.items) || [];
        if (items.length) {
          await this._post(this.adminChannel,
            this._format(gaps, ':sunrise: *Estoque que vamos precisar pro P&P hoje* (' + items.length + ' produto(s)):'));
        }
        await this._mark('morning', date, { items: items.length });
        out.morning = items.length;
      }
      return out;
    } finally { this._ticking = false; }
  }
}

module.exports = { StockGapAlert };
