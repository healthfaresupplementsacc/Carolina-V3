'use strict';
/**
 * HEALTHFARE V3 — veeqo-mergeable-alert (Bruno 2026-08-02)
 *
 * De manhã cedo, lista no admin-orin os pedidos MERGEABLE da Veeqo — pedidos do
 * MESMO comprador pro MESMO endereço (a Veeqo agrupa via `mergeable_id`), que
 * precisam ser juntados num pacote só antes de imprimir. READ-ONLY: não merja
 * nada, só avisa. Posta 1× por dia na janela da manhã. NUNCA no canal do operador.
 *
 * Cancelamento: a Veeqo NÃO expõe pedido de cancelamento PENDENTE no eBay (só o
 * concluído: cancelled_at/cancel_reason). Por isso a msg SEMPRE lembra de conferir
 * o eBay antes de mergear. (Automatizar isso = precisaria da API do eBay.)
 *
 * OPT-IN: WORKER_MERGEABLE_ALERT_ENABLED=true (+ VEEQO_API_KEY). Canal = V3_ADMIN_CHANNEL.
 */
const EDT = 'America/New_York';

class VeeqoMergeableAlert {
  constructor(deps = {}) {
    this.db = deps.db;
    this.veeqo = deps.veeqo || null;
    this.slack = deps.slack || null;               // { postAs }
    this.channelId = deps.channelId;               // admin-orin
    this.enabled = deps.enabled !== undefined ? deps.enabled
      : (process.env.WORKER_MERGEABLE_ALERT_ENABLED === 'true');
    this.heartbeat = deps.heartbeat || null;
    this.startHour = deps.startHour != null ? deps.startHour : 7;   // >=7h NY (manhã)
    this.endHour = deps.endHour != null ? deps.endHour : 12;        // até meio-dia
    this.maxPages = deps.maxPages || 15;
    this._t = null; this._kick = null; this._ticking = false;
  }

  start(ms = 30 * 60 * 1000) {
    this._kick = setTimeout(() => this.tick().catch((e) => console.error('[mergeable-alert] erro:', e.message)), 40 * 1000);
    this._t = setInterval(() => this.tick().catch((e) => console.error('[mergeable-alert] erro:', e.message)), ms);
    console.log('[V3] veeqo-mergeable-alert ligado (' + (this.enabled ? 'ON' : 'OFF') + ')');
  }
  stop() { if (this._t) clearInterval(this._t); if (this._kick) clearTimeout(this._kick); this._t = null; this._kick = null; }

  _ny() {
    const now = new Date();
    const hs = now.toLocaleString('en-US', { timeZone: EDT, hour: '2-digit', hour12: false });
    const hour = Number((String(hs).match(/\d{1,2}/) || ['0'])[0]) % 24;
    const date = now.toLocaleDateString('en-CA', { timeZone: EDT });   // YYYY-MM-DD NY
    return { hour, date };
  }

  // --- normalizadores p/ o gate de segurança ---
  static _name(o) {
    const d = o.deliver_to || {};
    return ((d.first_name || '') + ' ' + (d.last_name || '')).replace(/\s+/g, ' ').trim().toLowerCase();
  }
  static _nameDisplay(o) {
    const d = o.deliver_to || {};
    return ((d.first_name || '') + ' ' + (d.last_name || '')).replace(/\s+/g, ' ').trim() || d.company || 'cliente';
  }
  static _street(o) {   // rua sem suite (address1), pra detectar forwarder
    const d = o.deliver_to || {};
    return (d.address1 || d.address_1 || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  static _suite(o) {    // suite/apto (address2) — o que separa clientes num forwarder
    const d = o.deliver_to || {};
    return (d.address2 || d.address_2 || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  static _zip(o) {
    const d = o.deliver_to || {};
    return String(d.zip || d.zip_code || d.post_code || '').trim();
  }

  /**
   * Grupos SEGUROS pra mergear. REGRA (Bruno 2026-08-03, ver [[merge-safety-rules]]):
   * merge SÓ quando o NOME do destinatário bate EXATO. `mergeable_id` da Veeqo é
   * só país+ZIP (agrupa ESTRANHOS) → NUNCA sozinho. Freight forwarder (mesma rua,
   * nomes diferentes) = NÃO mergear; se mesmo nome num forwarder, exigir a SUITE igual.
   */
  async computeGroups() {
    if (!this.veeqo || !this.veeqo.configured()) return [];
    let all = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const rows = await this.veeqo.getOrdersPage({ status: 'awaiting_fulfillment', page, pageSize: 100 });
      if (!rows.length) break;
      all = all.concat(rows);
      if (rows.length < 100) break;
    }

    // 1) Detectar FORWARDERS: rua+ZIP que hospeda 2+ nomes DIFERENTES nesse pull.
    const namesByStreet = new Map();
    for (const o of all) {
      const s = VeeqoMergeableAlert._street(o), z = VeeqoMergeableAlert._zip(o);
      if (!s) continue;
      const k = s + '|' + z;
      if (!namesByStreet.has(k)) namesByStreet.set(k, new Set());
      namesByStreet.get(k).add(VeeqoMergeableAlert._name(o));
    }
    const isForwarder = (o) => {
      const k = VeeqoMergeableAlert._street(o) + '|' + VeeqoMergeableAlert._zip(o);
      const set = namesByStreet.get(k);
      return !!set && set.size >= 2;
    };

    // 2) Agrupar por NOME EXATO + rua + ZIP (nunca por mergeable_id sozinho).
    //    Num forwarder, a chave inclui a SUITE (senão nomes iguais em suites
    //    diferentes — improvável mas possível — não seriam juntados por engano).
    const byKey = new Map();
    for (const o of all) {
      const name = VeeqoMergeableAlert._name(o);
      if (!name) continue;                                  // sem nome → nunca agrupa
      const fwd = isForwarder(o);
      const key = [name, VeeqoMergeableAlert._street(o), VeeqoMergeableAlert._zip(o),
        fwd ? VeeqoMergeableAlert._suite(o) : ''].join('|');
      if (!byKey.has(key)) byKey.set(key, { orders: [], forwarder: fwd });
      byKey.get(key).orders.push(o);
    }

    const groups = [];
    for (const { orders: g, forwarder } of byKey.values()) {
      if (g.length < 2) continue;                           // precisa 2+ do MESMO nome
      const d = g[0].deliver_to || {};
      const channels = [...new Set(g.map((o) => (o.channel && (o.channel.name || o.channel.type_code)) || '?'))];
      const cancelledSignal = g.some((o) => o.cancelled_at || o.cancel_reason);
      groups.push({
        patient: VeeqoMergeableAlert._nameDisplay(g[0]),
        city: [d.city, d.state].filter(Boolean).join(', '),
        channels,
        mixed: channels.length > 1,
        forwarder,                                          // avisa operador p/ conferir suite
        orders: g.map((o) => o.number || String(o.id)),
        cancelledSignal,
      });
    }
    groups.sort((a, b) => b.orders.length - a.orders.length || a.patient.localeCompare(b.patient));
    return groups;
  }

  _format(groups) {
    const totalOrders = groups.reduce((n, g) => n + g.orders.length, 0);
    let text = `:link: *Pedidos pra MERGEAR hoje*. *${groups.length}* grupos (${totalOrders} pedidos), *MESMO nome exato* + endereço:\n`;
    for (const g of groups) {
      text += `• *${g.patient}* (${g.channels.join(' + ')})`
        + (g.mixed ? ' :warning: _canais diferentes — confira o tracking de cada um_' : '')
        + (g.forwarder ? ' :package: _endereço tipo despachante (várias pessoas na mesma rua) — CONFIRME que a SUITE bate antes de juntar_' : '')
        + (g.cancelledSignal ? ' :x: _tem sinal de cancelamento na Veeqo_' : '')
        + ` , ${g.orders.join(', ')}\n`;
    }
    text += '\n:no_entry: *Só junte se for a MESMA pessoa (nome idêntico).* Nomes diferentes no mesmo endereço = despachante → *NUNCA* mergear.';
    text += '\n:warning: *Antes de mergear, confira se algum tem pedido de cancelamento PENDENTE no eBay*. '
      + 'a Veeqo não mostra isso; se tiver, questione antes de juntar.';
    return text;
  }

  async _alertedToday(nyDate) {
    try {
      const r = await this.db.query(
        `SELECT 1 FROM v3.audit_log WHERE action = 'mergeable_alert'
           AND metadata->>'ny_date' = $1 AND created_at > NOW() - INTERVAL '20 hours' LIMIT 1`,
        [nyDate]);
      return r.rowCount > 0;
    } catch (_) { return false; }
  }
  async _markAlerted(nyDate, groups) {
    try {
      await this.db.query(
        `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
         VALUES ('system', NULL, 'mergeable_alert', 'veeqo', NULL, $1::jsonb)`,
        [JSON.stringify({ ny_date: nyDate, groups: groups.length, orders: groups.reduce((n, g) => n + g.orders.length, 0) })]);
    } catch (_) { /* dedupe fica best-effort */ }
  }
  async _post(text) {
    if (!(this.slack && this.slack.postAs && this.channelId)) return false;
    try {
      await this.slack.postAs({
        channel: this.channelId,
        sender: { name: 'HealthFare P&P', icon: ':link:' },
        thread_ts: null, unfurl_links: false, unfurl_media: false, text,
      });
      return true;
    } catch (e) { console.error('[mergeable-alert] post falhou:', e.message); return false; }
  }

  async tick() {
    if (this._ticking || !this.enabled) return { skipped: true };
    this._ticking = true;
    try { this.heartbeat && this.heartbeat(); } catch (_) {}
    try {
      const { hour, date } = this._ny();
      if (hour < this.startHour || hour >= this.endHour) return { skipped: 'off_window', hour };
      if (await this._alertedToday(date)) return { skipped: 'already_today' };
      const groups = await this.computeGroups();
      if (!groups.length) return { groups: 0 };   // nada pra mergear → não posta, re-tenta no próximo tick da janela
      if (await this._post(this._format(groups))) {
        await this._markAlerted(date, groups);
        return { groups: groups.length, posted: true };
      }
      return { groups: groups.length, posted: false };
    } finally { this._ticking = false; }
  }
}

module.exports = { VeeqoMergeableAlert };
