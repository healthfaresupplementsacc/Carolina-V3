'use strict';
/**
 * HEALTHFARE V3 — stock-drift-alert (S15 Fase 3, Bruno 08-18).
 *
 * "Reconciliação é CONTÍNUA" (decisão do Bruno, round 3). A cada 10 min compara o
 * nosso total com o da Veeqo (o mesmo cálculo do hub — chama computeDrift DIRETO,
 * não via HTTP: worker batendo na própria API é caminho duplo esperando pra divergir).
 *
 * Duas mensagens, nenhuma repetida:
 *   1. DIVERGÊNCIA NOVA → avisa na hora. Dedupe 1×/produto/dia NY (audit_log
 *      action 'stock_drift_alert'), senão vira spam a cada 10 min pro mesmo caso.
 *   2. 08:00 NY → resumo do que está divergindo (dedupe 'stock_drift_digest'/dia).
 *
 * NUNCA sobrescreve nada. O número não se conserta sozinho — quem decide importar
 * ou ajustar é uma pessoa, no hub. O worker só conta o que viu.
 *
 * Canal: admin-orin (o operador não tem o que fazer com "a Veeqo discorda"). Por
 * isso NÃO passa pelo alert-gate: o gate protege o canal dos operadores.
 * Estilo (memória): curto, direto, sem em dash, no máximo 1 emoji.
 * OPT-IN: WORKER_STOCK_DRIFT_ENABLED=true.
 */
const EDT = 'America/New_York';
const MAX_LINES = 12;      // digest maior que isso vira parede de texto

class StockDriftAlert {
  /**
   * @param {object} deps
   *   deps.db          pool pg
   *   deps.getDrift    async () => [{product_id, nickname, ours, veeqo, delta}]
   *   deps.slack       { postAs }
   *   deps.channelId   admin-orin
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this.getDrift = deps.getDrift || null;
    this.slack = deps.slack || null;
    this.channelId = deps.channelId || 'C0B36DR5MP1';
    this.enabled = deps.enabled !== undefined ? deps.enabled
      : (process.env.WORKER_STOCK_DRIFT_ENABLED === 'true');
    this.heartbeat = deps.heartbeat || null;
    this.digestHour = deps.digestHour != null ? deps.digestHour : 8;
    this.now = deps.now || (() => new Date());
    this._t = null; this._kick = null; this._ticking = false;
  }

  start(ms = 10 * 60 * 1000) {
    this._kick = setTimeout(() => this.tick().catch((e) => console.error('[stock-drift] erro:', e.message)), 90 * 1000);
    this._t = setInterval(() => this.tick().catch((e) => console.error('[stock-drift] erro:', e.message)), ms);
    console.log('[V3] stock-drift-alert ligado (' + (this.enabled ? 'ON' : 'OFF') + ')');
  }

  stop() {
    if (this._t) clearInterval(this._t);
    if (this._kick) clearTimeout(this._kick);
    this._t = null; this._kick = null;
  }

  _ny() {
    const now = this.now();
    const hour = Number((String(now.toLocaleString('en-US', { timeZone: EDT, hour: '2-digit', hour12: false })).match(/\d{1,2}/) || ['0'])[0]) % 24;
    return { hour, date: now.toLocaleDateString('en-CA', { timeZone: EDT }) };
  }

  /** Já avisei sobre este produto hoje? (dedupe por dia NY, via audit_log) */
  async _alerted(productId, nyDate) {
    const r = await this.db.query(
      `SELECT 1 FROM v3.audit_log
        WHERE action = 'stock_drift_alert'
          AND metadata->>'product_id' = $1 AND metadata->>'ny_date' = $2 LIMIT 1`,
      [String(productId), nyDate]);
    return (r.rowCount || 0) > 0;
  }

  async _markAlert(productId, nyDate, info) {
    await this.db.query(
      `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
       VALUES ('system', NULL, 'stock_drift_alert', 'product', $1, $2::jsonb)`,
      [productId, JSON.stringify({ product_id: productId, ny_date: nyDate, ...info })]).catch(() => {});
  }

  async _digestDone(nyDate) {
    const r = await this.db.query(
      `SELECT 1 FROM v3.audit_log
        WHERE action = 'stock_drift_digest' AND metadata->>'ny_date' = $1 LIMIT 1`, [nyDate]);
    return (r.rowCount || 0) > 0;
  }

  async _markDigest(nyDate, info) {
    await this.db.query(
      `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
       VALUES ('system', NULL, 'stock_drift_digest', 'stock', NULL, $1::jsonb)`,
      [JSON.stringify({ ny_date: nyDate, ...info })]).catch(() => {});
  }

  async _post(text) {
    if (!(this.slack && this.slack.postAs)) return false;
    try {
      await this.slack.postAs({
        channel: this.channelId,
        sender: { name: 'HealthFare Estoque', icon: ':package:' },
        thread_ts: null, unfurl_links: false, unfurl_media: false, text,
      });
      return true;
    } catch (e) { console.error('[stock-drift] post falhou:', e.message); return false; }
  }

  /** "BENF-300: Veeqo 214, aqui 226, diferença de -12" (sem em dash, direto). */
  _line(d) {
    const name = d.nickname || d.name || ('produto ' + d.product_id);
    const sign = d.delta > 0 ? '+' : '';
    return `${name}: Veeqo ${d.veeqo}, aqui ${d.ours}, diferença de ${sign}${d.delta}`;
  }

  async tick() {
    if (this._ticking || !this.enabled || !this.getDrift) return { skipped: true };
    this._ticking = true;
    try { this.heartbeat && this.heartbeat(); } catch (_) {}
    try {
      const { hour, date } = this._ny();
      const drift = (await this.getDrift()) || [];
      const out = { checked: drift.length, alerted: 0, digest: 0 };

      // 1) divergência NOVA (uma por produto por dia)
      const fresh = [];
      for (const d of drift) {
        if (await this._alerted(d.product_id, date)) continue;
        fresh.push(d);
      }
      if (fresh.length) {
        const head = fresh.length === 1
          ? ':package: *Estoque divergente da Veeqo*'
          : `:package: *Estoque divergente da Veeqo* (${fresh.length} produtos)`;
        const lines = fresh.slice(0, MAX_LINES).map((d) => '• ' + this._line(d));
        if (fresh.length > MAX_LINES) lines.push(`• e mais ${fresh.length - MAX_LINES}`);
        await this._post(head + '\n' + lines.join('\n')
          + '\nConfira no hub antes de importar. Nada foi alterado.');
        for (const d of fresh) {
          await this._markAlert(d.product_id, date, { ours: d.ours, veeqo: d.veeqo, delta: d.delta });
        }
        out.alerted = fresh.length;
      }

      // 2) resumo das 8h NY
      if (hour >= this.digestHour && !(await this._digestDone(date))) {
        if (drift.length) {
          const lines = drift.slice(0, MAX_LINES).map((d) => '• ' + this._line(d));
          if (drift.length > MAX_LINES) lines.push(`• e mais ${drift.length - MAX_LINES}`);
          await this._post(`:sunrise: *Resumo do estoque vs Veeqo* (${drift.length} produtos divergindo)\n`
            + lines.join('\n'));
        } else {
          await this._post(':sunrise: *Resumo do estoque vs Veeqo*\nTudo batendo hoje.');
        }
        await this._markDigest(date, { products: drift.length });
        out.digest = drift.length;
      }
      return out;
    } finally { this._ticking = false; }
  }
}

module.exports = { StockDriftAlert, MAX_LINES };
