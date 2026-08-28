'use strict';
/**
 * HEALTHFARE V4 — freight-watch (Bruno 08-28).
 *
 * "a gente tem um problema serio com o veeqo que eh o preco dos labels... o
 * veeqo coloca uma data ainda antes e a gente acaba sendo cobrado mto pelo
 * carrier... tem como eu saber oq o custo ta acima e oq nao ta antes de
 * imprimir?"
 *
 * A cada 5 min (janela 8h-19h NY, mesmo padrão de janela do encap-monitor):
 *  1. lê os pedidos shipped recentes da Veeqo (até 48h, poucas páginas, gentil
 *     com a API) e espelha cada shipment em v3.shipment_costs;
 *  2. julga cada etiqueta NOVA contra a mediana 30d da faixa (freight/service);
 *  3. etiqueta acima do normal → UMA mensagem no admin-orin NA HORA. O timing é
 *     o produto: deletar o envio na Veeqo estorna a etiqueta automático (janela
 *     14 dias), MAS pra USPS isso morre quando o SCAN form do dia sai (~tarde).
 *     Alerta em minutos = dinheiro recuperável; relatório no fim do dia = tarde
 *     demais (Bruno rejeitou explicitamente fim-de-dia-only);
 *  4. 16:15 NY (antes do SCAN form típico) → digest do dia, 1x (dedupe via
 *     audit_log action 'freight_digest').
 *
 * NUNCA escreve estoque, NUNCA posta no canal dos operadores (custo de frete é
 * decisão de admin). Estilo das mensagens (memória): curto, direto, humano, sem
 * em dash, no máximo 1 emoji. OPT-IN: WORKER_FREIGHT_WATCH_ENABLED=true.
 */
const EDT = 'America/New_York';
const freight = require('../v3/freight/service');

const money = (v) => '$' + Number(v || 0).toFixed(2);

class FreightWatch {
  constructor(deps = {}) {
    this.db = deps.db;
    this.veeqo = deps.veeqo;                     // client veeqo-api (getOrdersPage)
    this.slack = deps.slack || null;             // { postAs }
    this.channelId = deps.channelId || 'C0B36DR5MP1';  // admin-orin, NUNCA operador
    this.enabled = deps.enabled !== undefined ? deps.enabled
      : (process.env.WORKER_FREIGHT_WATCH_ENABLED === 'true');
    this.heartbeat = deps.heartbeat || null;
    this.now = deps.now || (() => new Date());
    this.startHour = deps.startHour != null ? deps.startHour : 8;
    this.endHour = deps.endHour != null ? deps.endHour : 19;
    this.digestMin = deps.digestMin != null ? deps.digestMin : (16 * 60 + 15); // 16:15 NY
    this.maxPages = deps.maxPages || 4;          // gentil: 400 pedidos/tick dá folga
    this.lookbackHours = deps.lookbackHours || 48;
    this._t = null; this._kick = null; this._ticking = false;
  }

  start(ms = 5 * 60 * 1000) {
    this._kick = setTimeout(() => this.tick().catch((e) => console.error('[freight] erro:', e.message)), 45 * 1000);
    this._t = setInterval(() => this.tick().catch((e) => console.error('[freight] erro:', e.message)), ms);
    console.log('[V3] freight-watch ligado (' + (this.enabled ? 'ON' : 'OFF') + ', janela ' + this.startHour + 'h-' + this.endHour + 'h NY)');
  }
  stop() { if (this._t) clearInterval(this._t); if (this._kick) clearTimeout(this._kick); this._t = null; this._kick = null; }

  _ny() {
    const now = this.now();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: EDT, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
    const get = (t) => Number((parts.find((p) => p.type === t) || {}).value || 0);
    return {
      hour: get('hour') % 24, minute: get('minute'),
      date: now.toLocaleDateString('en-CA', { timeZone: EDT }),
    };
  }

  _nyDate(iso) { return iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: EDT }) : null; }

  /** Pedido cru da Veeqo → linha de shipment_costs (ou null sem shipment). */
  _rowOf(o) {
    const alloc = (o && o.allocations && o.allocations[0]) || null;
    const sh = alloc && alloc.shipment;
    if (!sh || sh.id == null) return null;
    const charges = sh.outbound_label_charges;
    const cost = charges && charges.value != null ? Number(charges.value) : null;
    return {
      shipment_id: sh.id,
      order_id: o.id != null ? o.id : null,
      order_number: o.number != null ? String(o.number) : null,
      channel: (o.channel && o.channel.name) || null,
      service: sh.service_name || null,
      weight_g: sh.weight != null ? Number(sh.weight) : null,
      cost,
      currency: 'USD',
      bought_at: sh.created_at || null,
      due_date: o.due_date || null,
      dispatch_date: o.dispatch_date || null,
      dest_state: (o.deliver_to && o.deliver_to.state) || null,
      dest_zip: (o.deliver_to && o.deliver_to.zip) || null,
      ny_day: this._nyDate(sh.created_at),
    };
  }

  /** Pedidos shipped das últimas ~48h (páginas até esfriar; gentil com a API). */
  async _fetchRecent() {
    const cutoff = this.now().getTime() - this.lookbackHours * 3600 * 1000;
    const since = new Date(cutoff).toISOString();
    const rows = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const orders = await this.veeqo.getOrdersPage({ status: 'shipped', updatedSince: since, page, pageSize: 100 });
      if (!orders || !orders.length) break;
      let anyFresh = false;
      for (const o of orders) {
        const r = this._rowOf(o);
        if (!r) continue;
        const t = r.bought_at ? Date.parse(r.bought_at) : null;
        if (t != null && t < cutoff) continue;     // etiqueta velha: fora do watch
        anyFresh = true;
        rows.push(r);
      }
      if (orders.length < 100) break;
      if (!anyFresh) break;                        // página inteira já esfriou
    }
    return rows;
  }

  /** '2026-09-04' → '04/09' (NY). */
  _ddmm(iso) {
    if (!iso) return null;
    try { return new Date(iso).toLocaleDateString('pt-BR', { timeZone: EDT, day: '2-digit', month: '2-digit' }); }
    catch (_) { return null; }
  }

  /** Dias de folga entre agora e o due_date (inteiro, piso). */
  _slackDays(due) {
    if (!due) return null;
    const ms = Date.parse(due) - this.now().getTime();
    if (!Number.isFinite(ms)) return null;
    return Math.floor(ms / (24 * 3600 * 1000));
  }

  /** Texto do alerta imediato (curto, direto, sem em dash, 1 emoji). */
  _alertText(row) {
    const ped = 'Pedido ' + (row.order_number || row.order_id || row.shipment_id) +
      (row.channel ? ' (' + row.channel + ')' : '');
    const svc = row.service || 'etiqueta';
    let base;
    if (row.expected_cost != null) {
      base = svc + ' saiu ' + money(row.cost) + ', o normal dessa faixa e ' + money(row.expected_cost) + '.';
    } else {
      base = svc + ' saiu ' + money(row.cost) + ', passou do teto de ' + money(freight.CEILING_COST) + ' pra pacote de menos de 1lb.';
    }
    const slack = this._slackDays(row.due_date);
    const dueLine = (row.due_date && slack != null && slack >= 2)
      ? ' Cliente aceita ate ' + this._ddmm(row.due_date) + ', folga de ' + slack + ' dias.'
      : '';
    return ':money_with_wings: *Etiqueta acima do normal* ' + ped + ': ' + base + dueLine +
      ' Se ainda nao despachou: deleta o envio na Veeqo que o estorno e automatico, e recompra mais barato. Antes do SCAN form do dia.';
  }

  async _post(text) {
    if (!(this.slack && this.slack.postAs)) return false;
    try {
      await this.slack.postAs({
        channel: this.channelId,
        sender: { name: 'HealthFare Frete', icon: ':money_with_wings:' },
        thread_ts: null, unfurl_links: false, unfurl_media: false, text,
      });
      return true;
    } catch (e) { console.error('[freight] post falhou:', e.message); return false; }
  }

  async _digestDone(nyDate) {
    const r = await this.db.query(
      `SELECT 1 FROM v3.audit_log
        WHERE action = 'freight_digest' AND metadata->>'ny_date' = $1 LIMIT 1`, [nyDate]);
    return (r.rowCount || 0) > 0;
  }

  async _markDigest(nyDate, info) {
    await this.db.query(
      `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
       VALUES ('system', NULL, 'freight_digest', 'freight', NULL, $1::jsonb)`,
      [JSON.stringify({ ny_date: nyDate, ...info })]).catch(() => {});
  }

  /** Digest 16:15 NY: 1 linha quando o dia está normal, detalhe quando não. */
  async _digest(nyDate) {
    if (await this._digestDone(nyDate)) return { skipped: 'done' };
    const sum = await freight.summary(this.db, { days: 1 });
    const today = (sum.days || []).find((d) => d.day === nyDate) ||
      { labeled: 0, walmart_zero: 0, total_cost: 0, avg_cost: null, outliers: 0, outlier_excess: 0 };
    const outliers = await freight.todayOutliers(this.db);
    const avg = today.avg_cost != null ? money(today.avg_cost) : '-';
    const avg30 = sum.avg_30d != null ? ' (30d: ' + money(sum.avg_30d) + ')' : '';
    const wal = today.walmart_zero > 0 ? ', mais ' + today.walmart_zero + ' do Walmart sem custo' : '';
    let text = 'Frete de hoje: ' + today.labeled + ' etiquetas, ' + money(today.total_cost) +
      ', media ' + avg + avg30 + wal + '.';
    const withinNormal = sum.avg_30d != null && today.avg_cost != null
      ? Math.abs(today.avg_cost - sum.avg_30d) <= sum.avg_30d * 0.10
      : true;
    if (outliers.length === 0 && withinNormal) {
      // dia normal = UMA linha, sem blablabla
      text += ' Nenhuma acima do normal.';
    } else if (outliers.length === 0) {
      text += ' Nenhuma acima do normal, mas a media fugiu mais de 10% do padrao de 30d.';
    } else {
      text += ' ' + outliers.length + ' acima do normal, excesso de ' + money(today.outlier_excess) + '.';
      for (const o of outliers) {
        const exp = o.expected_cost != null ? ' vs ' + money(o.expected_cost) : ' (teto absoluto)';
        text += '\n' + (o.order_number || o.shipment_id) + (o.channel ? ' (' + o.channel + ')' : '') +
          ': ' + (o.service || 'etiqueta') + ' ' + money(o.cost) + exp;
      }
    }
    const ok = await this._post(text);
    if (ok) await this._markDigest(nyDate, { labeled: today.labeled, total: today.total_cost, outliers: outliers.length });
    return { posted: ok, outliers: outliers.length };
  }

  async tick() {
    if (this._ticking || !this.enabled || !this.db || !this.veeqo) return { skipped: true };
    this._ticking = true;
    try { this.heartbeat && this.heartbeat(); } catch (_) {}
    try {
      const { hour, minute, date } = this._ny();
      // janela 8h-19h NY: fora dela ninguém compra etiqueta nem deleta envio
      if (hour < this.startHour || hour >= this.endHour) return { skipped: 'window' };

      // 1. espelha o que a Veeqo comprou nas últimas 48h
      const fetched = await this._fetchRecent();
      const upserted = await freight.upsertShipments(this.db, fetched);

      // 2. julga só as linhas NOVAS (as velhas já foram julgadas quando entraram)
      let judged = 0;
      for (const row of upserted) {
        if (!row.inserted) continue;
        const band = freight.bandOf(row.service, row.weight_g);
        const { expected, samples } = await freight.expectedFor(this.db, band);
        const verdict = freight.judge({ cost: row.cost, expected, samples, weight_g: row.weight_g });
        await freight.saveJudgement(this.db, row.shipment_id, {
          band, expected_cost: expected,
          outlier: verdict.outlier, outlier_reason: verdict.reason,
        });
        judged++;
      }

      // 3. alerta IMEDIATO de cada outlier de hoje ainda não avisado (cobre
      //    também um tick anterior que julgou mas caiu antes de postar)
      let alerted = 0;
      const pending = (await freight.todayOutliers(this.db)).filter((o) => !o.alerted_at);
      for (const o of pending) {
        if (!(await this._post(this._alertText(o)))) continue;
        await freight.markAlerted(this.db, o.shipment_id);
        alerted++;
      }

      // 4. digest do dia, 16:15 NY em diante (antes do SCAN form típico)
      let digest = null;
      if (hour * 60 + minute >= this.digestMin) digest = await this._digest(date);

      return { fetched: fetched.length, judged, alerted, digest };
    } finally {
      this._ticking = false;
    }
  }
}

module.exports = { FreightWatch };
