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
 * V3 (FASE A do copiloto, estudo S15-VEEQO-LABEL-API-STUDY): antes de
 * aconselhar, o watch COTA (Rate Shopping API via deps.rates, até 25 por tick,
 * mais velhas primeiro) e guarda quoted_* na linha. O alerta ficou HONESTO:
 * provado em 8/8 outliers recentes que o pago JÁ ERA o mais barato válido, e o
 * Bruno cravou "vc vai ficar mandando td mundo deletar, e se nao tiver opcao e
 * essa eh a unica opcao oferecida no veeqo?" — então "deleta e recompra" só
 * sai quando a alternativa EXISTE; sem alternativa o alerta diz isso; sem
 * cotação ele manda conferir. Cotar é acessório: falha de cotação NUNCA
 * derruba o tick (o rates-client devolve null pra toda falha).
 *
 * NUNCA escreve estoque, NUNCA posta no canal dos operadores (custo de frete é
 * decisão de admin). Estilo das mensagens (memória): curto, direto, humano, sem
 * em dash, no máximo 1 emoji. OPT-IN: WORKER_FREIGHT_WATCH_ENABLED=true.
 */
const EDT = 'America/New_York';
const freight = require('../v3/freight/service');
const rates = require('../v3/freight/rates-client');   // validQuotes/bestValid (puras)

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
    // FASE A: cliente de cotação (rates-client). null = sem copiloto, o watch
    // segue igual ao v2 e o alerta cai no texto "nao consegui cotar".
    this.rates = deps.rates || null;
    this.quoteCap = deps.quoteCap != null ? deps.quoteCap : 25;  // gentil com a API de rates
    this._t = null; this._kick = null; this._ticking = false;
    // scope do julgamento por shipment_id ('estado' | 'banda'), só em memória:
    // o alerta precisa saber qual mediana julgou pra falar certo, e coluna nova
    // no banco pra isso seria exagero. Reinício entre julgar e postar = cai no
    // texto de faixa, que continua verdadeiro.
    this._scopes = new Map();
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

  /** O que a cotação disse desta etiqueta: 'cheaper' (tem válida mais barata,
   *  margem $0.25) | 'best' (cotou e o pago já era o melhor) | 'none' (sem
   *  cotação: falhou ou ainda na fila do tick). */
  _quoteVerdict(row) {
    if (row.quoted_best_cost != null
      && Number(row.quoted_best_cost) < Number(row.cost) - freight.QUOTE_MARGIN) return 'cheaper';
    if (row.quoted_at != null) return 'best';
    return 'none';
  }

  /** Texto do alerta imediato (curto, direto, sem em dash, 1 emoji).
   *  V3: o conselho depende da COTAÇÃO. "Deleta e recompra" só quando a
   *  alternativa existe (objeção do Bruno: sem opção, deletar é só retrabalho). */
  _alertText(row) {
    const ped = 'Pedido ' + (row.order_number || row.order_id || row.shipment_id) +
      (row.channel ? ' (' + row.channel + ')' : '');
    const svc = row.service || 'etiqueta';
    let base;
    if (row.expected_cost != null) {
      // scope 'estado' = a mediana que julgou foi a do destino, e o texto diz
      const normal = (row.expected_scope === 'estado' && row.dest_state)
        ? 'o normal pra ' + String(row.dest_state).toUpperCase() + ' e '
        : 'o normal dessa faixa e ';
      base = svc + ' saiu ' + money(row.cost) + ', ' + normal + money(row.expected_cost) + '.';
    } else {
      base = svc + ' saiu ' + money(row.cost) + ', passou do teto de ' + money(freight.CEILING_COST) + ' pra pacote de menos de 1lb.';
    }
    const slack = this._slackDays(row.due_date);
    const dueLine = (row.due_date && slack != null && slack >= 2)
      ? ' Cliente aceita ate ' + this._ddmm(row.due_date) + ', folga de ' + slack + ' dias.'
      : '';
    const verdict = this._quoteVerdict(row);
    let advice;
    if (verdict === 'cheaper') {
      advice = ' Cotei agora: tem ' + row.quoted_best_service + ' por ' + money(row.quoted_best_cost) +
        '. Se ainda nao despachou: deleta o envio na Veeqo que o estorno e automatico, e recompra. Antes do SCAN form do dia.';
    } else if (verdict === 'best') {
      advice = ' Cotei agora: ja era o melhor preco valido disponivel. Nao adianta recomprar; a causa e tarifa ou peso declarado.';
    } else {
      advice = ' Nao consegui cotar agora; confere na Veeqo se tem opcao mais barata antes de decidir.';
    }
    return ':money_with_wings: *Etiqueta acima do normal* ' + ped + ': ' + base + dueLine + advice;
  }

  /** Vários outliers no mesmo tick = UMA mensagem, uma linha por etiqueta. */
  _groupAlertText(rows) {
    const excesso = rows.reduce((a, r) => a + (Number(r.cost) - Number(r.expected_cost || 0)), 0);
    const lines = rows.slice(0, 12).map((r) => {
      const ped = (r.order_number || r.order_id || r.shipment_id) + (r.channel ? ' (' + r.channel + ')' : '');
      const normal = r.expected_cost != null
        ? ((r.expected_scope === 'estado' && r.dest_state)
          ? ', normal pra ' + String(r.dest_state).toUpperCase() + ' ' + money(r.expected_cost)
          : ', normal ' + money(r.expected_cost))
        : ', teto ' + money(freight.CEILING_COST);
      const slack = this._slackDays(r.due_date);
      const folga = (r.due_date && slack != null && slack >= 2) ? ', folga de ' + slack + ' dias' : '';
      // sufixo do copiloto: o que a cotação achou DESTA etiqueta
      const v = this._quoteVerdict(r);
      const cotei = v === 'cheaper'
        ? ' | cotei: da ' + money(r.quoted_best_cost) + ' (' + r.quoted_best_service + ')'
        : (v === 'best' ? ' | ja era o melhor' : ' | sem cotacao');
      return '• ' + ped + ': ' + money(r.cost) + normal + folga + cotei;
    });
    if (rows.length > 12) lines.push('• e mais ' + (rows.length - 12));
    // a linha de ação só manda deletar quando EXISTE alternativa em alguma linha
    const anyCheaper = rows.some((r) => this._quoteVerdict(r) === 'cheaper');
    const action = anyCheaper
      ? '\nSe ainda nao despachou: deleta o envio na Veeqo que o estorno e automatico, e recompra as que tem opcao mais barata. Antes do SCAN form do dia.'
      : '\nNenhuma com opcao mais barata na cotacao. Nao adianta recomprar; a causa e tarifa ou peso declarado.';
    return ':money_with_wings: *' + rows.length + ' etiquetas acima do normal* (excesso de ' + money(excesso) + ')\n'
      + lines.join('\n') + action;
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
      // copiloto: quanto ainda da pra recuperar deletando e recomprando
      try {
        const cop = await freight.copilotSummary(this.db, nyDate);
        if (cop.with_cheaper.n > 0) {
          text += ' ' + cop.with_cheaper.n + ' com opcao mais barata (da pra recuperar ' + money(cop.with_cheaper.saving) + ').';
        }
      } catch (e) { console.error('[freight] copilotSummary no digest:', e.message); }
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
        // state-aware: com 5+ amostras do (faixa, estado) em 30d a régua é a
        // mediana do próprio estado (Havaí caro é Havaí, não erro da Veeqo)
        const { expected, samples, scope } = await freight.expectedFor(this.db, band, row.dest_state);
        const verdict = freight.judge({ cost: row.cost, expected, samples, weight_g: row.weight_g });
        await freight.saveJudgement(this.db, row.shipment_id, {
          band, expected_cost: expected,
          outlier: verdict.outlier, outlier_reason: verdict.reason,
        });
        if (verdict.outlier) this._scopes.set(String(row.shipment_id), scope);
        judged++;
      }

      // 2.5. FASE A: cota as etiquetas novas ANTES de aconselhar (até 25 por
      //      tick, mais velhas primeiro; o resto fica pro próximo tick via a
      //      fila quoted_at IS NULL). Cotar é conselho: QUALQUER falha aqui é
      //      engolida e o alerta sai com "nao consegui cotar".
      let quoted = 0;
      if (this.rates) {
        try {
          const fila = await freight.unquoted(this.db, { hours: this.lookbackHours, limit: this.quoteCap });
          for (const row of fila) {
            let q = null;
            try {
              q = await this.rates.quoteParcel({
                dest_zip: row.dest_zip, dest_state: row.dest_state,
                weight_g: row.weight_g, reference: row.order_number || row.shipment_id,
              });
            } catch (e) { q = null; }        // cliente já devolve null, mas cinto e suspensório
            if (!q) continue;                // sem cotação: fica na fila, tenta no próximo tick
            const valid = rates.validQuotes(q.quotes);
            // FASE A (advisory): SEMPRE a mais barata valida, SEM filtro de prazo.
            // Com o filtro, quando a estimativa do cotador pro GA passa do due_date
            // so sobram os expressos e o "melhor" vira FedEx $14 — absurdo visto em
            // producao 09-01. O prazo entra na FASE B (na hora de COMPRAR), nao aqui.
            const best = rates.bestValid(q.quotes);
            await freight.saveQuote(this.db, row.shipment_id, {
              quoted_best_cost: best ? best.price : null,
              quoted_best_service: best ? best.name : null,
              quoted_valid_count: valid.length,
            });
            quoted++;
          }
        } catch (e) { console.error('[freight] cotacao falhou (segue sem):', e.message); }
      }

      // 3. alerta IMEDIATO dos outliers de hoje ainda não avisados (cobre
      //    também um tick anterior que julgou mas caiu antes de postar).
      //    AGRUPADO num post só por tick: a Simone compra em rajada, então um
      //    tick pega vários de uma vez; 10+ pings soltos por dia ensinariam o
      //    admin a ignorar o canal, e alerta ignorado não recupera estorno.
      let alerted = 0;
      const pending = (await freight.todayOutliers(this.db))
        .filter((o) => !o.alerted_at)
        .map((o) => ({ ...o, expected_scope: this._scopes.get(String(o.shipment_id)) || 'banda' }));
      if (pending.length) {
        const text = pending.length === 1
          ? this._alertText(pending[0])
          : this._groupAlertText(pending);
        if (await this._post(text)) {
          for (const o of pending) {
            await freight.markAlerted(this.db, o.shipment_id); alerted++;
            this._scopes.delete(String(o.shipment_id));
          }
        }
      }

      // 4. digest do dia, 16:15 NY em diante (antes do SCAN form típico)
      let digest = null;
      if (hour * 60 + minute >= this.digestMin) digest = await this._digest(date);

      return { fetched: fetched.length, judged, quoted, alerted, digest };
    } finally {
      this._ticking = false;
    }
  }
}

module.exports = { FreightWatch };
