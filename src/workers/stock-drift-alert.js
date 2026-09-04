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
 * MODO QUIETO (Fase 0 do MASTER-SYNC-PLAN, conflito 6): enquanto o armazém
 * físico está TODO zerado (carga nunca feita), comparar com a Veeqo é ruído puro
 * (25-76 alertas/dia medidos). Armazém total = 0 → os avisos por produto são
 * suprimidos e o resumo vira UMA linha. Sem flag e sem passo humano: a primeira
 * garrafa carregada (total > 0) devolve o comportamento normal no mesmo tick,
 * porque os dedupes por produto nunca foram marcados durante o silêncio.
 *
 * Caronas diárias no mesmo worker (já roda todo dia, canal certo, dedupe pronto):
 *   - resumo de deduções parciais: o digest lê as rows audit_log
 *     'deduct_shortfall' do dia (gravadas pelo veeqo-order-sync em modo live)
 *     e acrescenta 1 linha quando houve furo. Nunca silencioso, nunca spam.
 *   - comparador P&P digitado vs enviado (Fase 0, tarefa 0.8): ~17h NY compara a
 *     soma de orders_printed digitada nas tasks de impressão com os pedidos
 *     REALMENTE enviados na Veeqo no dia (espelho local v3.shipment_costs,
 *     COUNT DISTINCT order_id; fallback v3.pnp_order_lines se o espelho estiver
 *     vazio). |digitado - enviado| > max(10, 15% do enviado) → 1 linha no
 *     admin-orin. Dedupe 1×/dia via audit_log 'pnp_typed_drift'.
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
    // comparador P&P digitado vs enviado: 17h NY, fim do expediente de impressão
    this.pnpCompareHour = deps.pnpCompareHour != null ? deps.pnpCompareHour : 17;
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

  /**
   * Total físico do armazém (todas as garrafas, todos os produtos). Mesmos
   * filtros do StockService.overview (bins ativos, caixas in_storage, unplaced).
   * Erro na query → null → tratado como CARREGADO (fail-open: na dúvida, alertar
   * é mais seguro que silenciar).
   */
  async _warehouseTotal() {
    try {
      const r = await this.db.query(
        `SELECT COALESCE((SELECT SUM(qty) FROM v3.stock_bins WHERE active), 0)
              + COALESCE((SELECT SUM(qty) FROM v3.stock_boxes WHERE status = 'in_storage'), 0)
              + COALESCE((SELECT SUM(qty) FROM v3.stock_unplaced), 0) AS total`);
      const t = r.rows[0] ? Number(r.rows[0].total) : null;
      return Number.isFinite(t) ? t : null;
    } catch (e) { return null; }
  }

  /** Furos de dedução do dia (audit_log 'deduct_shortfall' do veeqo-order-sync). */
  async _deductShortfalls(nyDate) {
    try {
      const r = await this.db.query(
        `SELECT COUNT(*)::int AS lines,
                COALESCE(SUM((metadata->>'missing')::int), 0)::int AS missing
           FROM v3.audit_log
          WHERE action = 'deduct_shortfall' AND metadata->>'ny_date' = $1`, [nyDate]);
      return r.rows[0] || { lines: 0, missing: 0 };
    } catch (e) { return { lines: 0, missing: 0 }; }
  }

  /** Comparador já rodou hoje? (dedupe 1x/dia NY) */
  async _pnpDriftDone(nyDate) {
    const r = await this.db.query(
      `SELECT 1 FROM v3.audit_log
        WHERE action = 'pnp_typed_drift' AND metadata->>'ny_date' = $1 LIMIT 1`, [nyDate]);
    return (r.rowCount || 0) > 0;
  }

  async _markPnpDrift(nyDate, info) {
    await this.db.query(
      `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
       VALUES ('system', NULL, 'pnp_typed_drift', 'stock', NULL, $1::jsonb)`,
      [JSON.stringify({ ny_date: nyDate, ...info })]).catch(() => {});
  }

  /** Digitado: soma de orders_printed nas tasks de impressão do dia (não-teste). */
  async _typedOrders(nyDate) {
    const r = await this.db.query(
      `SELECT COALESCE(SUM(e.orders_printed), 0)::int AS total
         FROM v3.events e
         JOIN v3.activity_types at ON at.id = e.activity_type_id
        WHERE at.slug IN ('order_printing', 'order_printing_2')
          AND e.orders_printed IS NOT NULL
          AND COALESCE(e.is_test, false) = false
          AND e.deleted_at IS NULL
          AND to_char(e.started_at AT TIME ZONE '${EDT}', 'YYYY-MM-DD') = $1`, [nyDate]);
    return r.rows[0].total;
  }

  /**
   * Enviado de verdade na Veeqo no dia: espelho local v3.shipment_costs (1 row
   * por shipment, freight-watch), COUNT DISTINCT order_id = PEDIDOS, não linhas.
   * Espelho vazio (worker off, outage) → fallback pro espelho de linhas
   * v3.pnp_order_lines (veeqo-order-sync), DISTINCT external_order_id shipped.
   */
  async _shippedOrders(nyDate) {
    const a = await this.db.query(
      `SELECT COUNT(DISTINCT order_id)::int AS n
         FROM v3.shipment_costs WHERE ny_day = $1 AND order_id IS NOT NULL`, [nyDate]);
    const n = a.rows[0] ? Number(a.rows[0].n) : 0;
    if (n > 0) return n;
    const b = await this.db.query(
      `SELECT COUNT(DISTINCT external_order_id)::int AS n
         FROM v3.pnp_order_lines
        WHERE status = 'shipped' AND shipped_at IS NOT NULL
          AND to_char(shipped_at AT TIME ZONE '${EDT}', 'YYYY-MM-DD') = $1`, [nyDate]);
    return b.rows[0] ? Number(b.rows[0].n) : 0;
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
      // MODO QUIETO: armazém inteiro zerado = carga física nunca feita; comparar
      // é ruído. null (query falhou) = fail-open, comporta como carregado.
      const wtotal = await this._warehouseTotal();
      const quiet = wtotal === 0;
      const out = { checked: drift.length, alerted: 0, digest: 0, quiet };

      // 1) divergência NOVA (uma por produto por dia). No modo quieto NADA é
      //    postado e NADA é marcado: a primeira garrafa carregada devolve os
      //    avisos no mesmo tick, sem flag e sem passo humano.
      if (!quiet) {
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
      }

      // 2) resumo das 8h NY (+ furos de dedução do dia, se houve: nunca mudo)
      if (hour >= this.digestHour && !(await this._digestDone(date))) {
        const sf = await this._deductShortfalls(date);
        const sfLine = sf.lines > 0
          ? `\nDeducao incompleta em ${sf.lines} ${sf.lines === 1 ? 'linha' : 'linhas'} hoje, faltaram ${sf.missing} garrafas. Detalhe no audit_log deduct_shortfall.`
          : '';
        if (quiet) {
          await this._post('Estoque fisico ainda nao carregado: comparacao com a Veeqo silenciada '
            + `(${drift.length} produtos difeririam hoje). Volta sozinha quando a carga comecar.` + sfLine);
        } else if (drift.length) {
          const lines = drift.slice(0, MAX_LINES).map((d) => '• ' + this._line(d));
          if (drift.length > MAX_LINES) lines.push(`• e mais ${drift.length - MAX_LINES}`);
          await this._post(`:sunrise: *Resumo do estoque vs Veeqo* (${drift.length} produtos divergindo)\n`
            + lines.join('\n') + sfLine);
        } else {
          await this._post(':sunrise: *Resumo do estoque vs Veeqo*\nTudo batendo hoje.' + sfLine);
        }
        await this._markDigest(date, { products: drift.length, quiet, deduct_shortfall_lines: sf.lines });
        out.digest = drift.length;
      }

      // 3) comparador P&P digitado vs enviado (17h NY, 1x/dia). Independe do
      //    modo quieto: usa números da Veeqo dos dois lados, não o armazém.
      if (hour >= this.pnpCompareHour && !(await this._pnpDriftDone(date))) {
        const typed = await this._typedOrders(date);
        const shipped = await this._shippedOrders(date);
        const delta = typed - shipped;
        const tolerance = Math.max(10, Math.round(shipped * 0.15));
        let posted = false;
        if (Math.abs(delta) > tolerance) {
          posted = await this._post(`P&P do dia: digitado ${typed}, enviado na Veeqo ${shipped}, `
            + `diferenca de ${Math.abs(delta)}. Vale conferir os registros de impressao.`);
        }
        await this._markPnpDrift(date, { typed, shipped, delta, tolerance, posted });
        out.pnp = { typed, shipped, delta, posted };
      }
      return out;
    } finally { this._ticking = false; }
  }
}

module.exports = { StockDriftAlert, MAX_LINES };
