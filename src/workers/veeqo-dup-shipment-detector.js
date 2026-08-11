'use strict';
/**
 * HEALTHFARE V3 — veeqo-dup-shipment-detector (Bruno 2026-08-03)
 *
 * REDE DE SEGURANÇA pós-envio. Depois que as etiquetas já saíram, detecta
 * pedidos que DEVIAM ter sido mergeados e foram em CAIXAS SEPARADAS:
 * MESMO cliente (nome EXATO) + MESMO endereço + MESMO dia → 2+ trackings distintos,
 * sem merge. Igual Fabian Garcia / Patricia Moffatt (08-03). Isso = postagem
 * desperdiçada + base pra claim de reembolso.
 *
 * SEGURANÇA (ver [[merge-safety-rules]]): merge SÓ com NOME idêntico. `mergeable_id`
 * da Veeqo é só país+ZIP (agrupa estranhos) → NUNCA. Freight forwarder (mesma rua,
 * nomes diferentes) = NÃO é dup; se mesmo nome num forwarder, exige a SUITE igual.
 * READ-ONLY: só avisa no admin-orin. NUNCA no canal do operador.
 *
 * OPT-IN: WORKER_DUP_SHIPMENT_ENABLED=true (+ VEEQO_API_KEY). Canal = V3_ADMIN_CHANNEL.
 */
const EDT = 'America/New_York';

class VeeqoDupShipmentDetector {
  constructor(deps = {}) {
    this.db = deps.db;
    this.veeqo = deps.veeqo || null;
    this.slack = deps.slack || null;                 // { postAs }
    this.channelId = deps.channelId;                 // admin-orin
    this.enabled = deps.enabled !== undefined ? deps.enabled
      : (process.env.WORKER_DUP_SHIPMENT_ENABLED === 'true');
    this.heartbeat = deps.heartbeat || null;
    this.startHour = deps.startHour != null ? deps.startHour : 13;  // fim de tarde NY (P&P do dia já saiu)
    this.endHour = deps.endHour != null ? deps.endHour : 20;
    this.maxPages = deps.maxPages || 25;
    this.lookbackDays = deps.lookbackDays != null ? deps.lookbackDays : 1;  // hoje + ontem
    this._t = null; this._kick = null; this._ticking = false;
  }

  start(ms = 60 * 60 * 1000) {
    this._kick = setTimeout(() => this.tick().catch((e) => console.error('[dup-shipment] erro:', e.message)), 55 * 1000);
    this._t = setInterval(() => this.tick().catch((e) => console.error('[dup-shipment] erro:', e.message)), ms);
    console.log('[V3] veeqo-dup-shipment-detector ligado (' + (this.enabled ? 'ON' : 'OFF') + ')');
  }
  stop() { if (this._t) clearInterval(this._t); if (this._kick) clearTimeout(this._kick); this._t = null; this._kick = null; }

  _ny() {
    const now = new Date();
    const hs = now.toLocaleString('en-US', { timeZone: EDT, hour: '2-digit', hour12: false });
    const hour = Number((String(hs).match(/\d{1,2}/) || ['0'])[0]) % 24;
    const date = now.toLocaleDateString('en-CA', { timeZone: EDT });
    return { hour, date };
  }
  _nyDay(iso) { return iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: EDT }) : null; }

  // --- normalizadores (idênticos ao merge-alert; mesma regra de segurança) ---
  static _name(o) { const d = o.deliver_to || {}; return ((d.first_name || '') + ' ' + (d.last_name || '')).replace(/\s+/g, ' ').trim().toLowerCase(); }
  static _nameDisplay(o) { const d = o.deliver_to || {}; return ((d.first_name || '') + ' ' + (d.last_name || '')).replace(/\s+/g, ' ').trim() || d.company || 'cliente'; }
  static _street(o) { const d = o.deliver_to || {}; return (d.address1 || d.address_1 || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  static _suite(o) { const d = o.deliver_to || {}; return (d.address2 || d.address_2 || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  static _zip(o) { const d = o.deliver_to || {}; return String(d.zip || d.zip_code || d.post_code || '').trim(); }
  static _tracks(o) {
    const t = [];
    for (const a of (o.allocations || [])) { let x = a.shipment && a.shipment.tracking_number; if (x && typeof x === 'object') x = x.tracking_number; if (x) t.push(String(x)); }
    for (const s of (o.shipments || [])) { let x = s.tracking_number; if (x && typeof x === 'object') x = x.tracking_number; if (x) t.push(String(x)); }
    return [...new Set(t)];
  }

  /**
   * Duplicatas de envio (pós-fato): MESMO nome + endereço + DIA, em 2+ trackings
   * distintos, sem merge. Aplica o mesmo gate anti-despachante do merge-alert.
   */
  async computeDuplicates() {
    if (!this.veeqo || !this.veeqo.configured()) return [];
    // janela: hoje (e opcionalmente ontem) pelo shipped_at NY. Puxa shipped recentes.
    const { date } = this._ny();
    const days = new Set([date]);
    for (let i = 1; i <= this.lookbackDays; i++) {
      const d = new Date(Date.parse(date + 'T00:00:00Z') - i * 86400000);
      days.add(d.toLocaleDateString('en-CA', { timeZone: EDT }));
    }
    // updated_at_min ~ 2 dias antes, cobre o fuso
    const since = new Date(Date.parse(date + 'T00:00:00Z') - (this.lookbackDays + 1) * 86400000).toISOString();

    let all = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const rows = await this.veeqo.getOrdersPage({ status: 'shipped', updatedSince: since, page, pageSize: 100 });
      if (!rows.length) break;
      all = all.concat(rows);
      if (rows.length < 100) break;
    }
    const inWin = all.filter((o) => days.has(this._nyDay(o.shipped_at)));

    // 1) forwarders no pull
    const namesByStreet = new Map();
    for (const o of inWin) {
      const s = VeeqoDupShipmentDetector._street(o), z = VeeqoDupShipmentDetector._zip(o);
      if (!s) continue;
      const k = s + '|' + z;
      if (!namesByStreet.has(k)) namesByStreet.set(k, new Set());
      namesByStreet.get(k).add(VeeqoDupShipmentDetector._name(o));
    }
    const isForwarder = (o) => {
      const set = namesByStreet.get(VeeqoDupShipmentDetector._street(o) + '|' + VeeqoDupShipmentDetector._zip(o));
      return !!set && set.size >= 2;
    };

    // 2) agrupar por NOME EXATO + rua + ZIP (+ suite se forwarder) + DIA de envio
    const byKey = new Map();
    for (const o of inWin) {
      const name = VeeqoDupShipmentDetector._name(o);
      if (!name) continue;
      const fwd = isForwarder(o);
      const day = this._nyDay(o.shipped_at);
      const key = [name, VeeqoDupShipmentDetector._street(o), VeeqoDupShipmentDetector._zip(o),
        fwd ? VeeqoDupShipmentDetector._suite(o) : '', day].join('|');
      if (!byKey.has(key)) byKey.set(key, { orders: [], forwarder: fwd, day });
      byKey.get(key).orders.push(o);
    }

    const dups = [];
    for (const { orders: g, forwarder, day } of byKey.values()) {
      if (g.length < 2) continue;
      const tracks = [...new Set(g.flatMap((o) => VeeqoDupShipmentDetector._tracks(o)))];
      const anyMerged = g.some((o) => o.merged_to_id || o.merged_order);
      if (tracks.length < 2 || anyMerged) continue;   // 1 tracking OU merged = OK, não é dup
      const channels = [...new Set(g.map((o) => (o.channel && (o.channel.name || o.channel.type_code)) || '?'))];
      dups.push({
        patient: VeeqoDupShipmentDetector._nameDisplay(g[0]),
        day, forwarder, channels,
        orders: g.map((o) => o.number || String(o.id)),
        tracks,
      });
    }
    dups.sort((a, b) => b.orders.length - a.orders.length || a.patient.localeCompare(b.patient));
    return dups;
  }

  _format(dups) {
    let text = `:package: *Duplicatas de envio detectadas*. *${dups.length}* cliente(s) receberam CAIXAS SEPARADAS que podiam ter sido 1 pacote (mesmo nome + endereço + dia):\n`;
    for (const d of dups) {
      text += `• *${d.patient}* (${d.channels.join(' + ')}). ${d.orders.join(', ')} , _${d.tracks.length} trackings_`
        + (d.forwarder ? ' :warning: _despachante: confirme se é a MESMA pessoa/suite antes de reclamar_' : '')
        + `\n`;
    }
    text += '\n:money_with_wings: Base pra *claim de reembolso de postagem* (mesmo destino, 2 labels). Ajuste o processo pra pegar antes na próxima.';
    return text;
  }

  async _alertedToday(nyDate) {
    try {
      const r = await this.db.query(
        `SELECT 1 FROM v3.audit_log WHERE action = 'dup_shipment_alert'
           AND metadata->>'ny_date' = $1 AND created_at > NOW() - INTERVAL '20 hours' LIMIT 1`, [nyDate]);
      return r.rowCount > 0;
    } catch (_) { return false; }
  }
  async _markAlerted(nyDate, dups) {
    try {
      await this.db.query(
        `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
         VALUES ('system', NULL, 'dup_shipment_alert', 'veeqo', NULL, $1::jsonb)`,
        [JSON.stringify({ ny_date: nyDate, dups: dups.length, orders: dups.reduce((n, d) => n + d.orders.length, 0) })]);
    } catch (_) { /* best-effort */ }
  }
  async _post(text) {
    if (!(this.slack && this.slack.postAs && this.channelId)) return false;
    try {
      await this.slack.postAs({
        channel: this.channelId,
        sender: { name: 'HealthFare P&P', icon: ':package:' },
        thread_ts: null, unfurl_links: false, unfurl_media: false, text,
      });
      return true;
    } catch (e) { console.error('[dup-shipment] post falhou:', e.message); return false; }
  }

  async tick() {
    if (this._ticking || !this.enabled) return { skipped: true };
    this._ticking = true;
    try { this.heartbeat && this.heartbeat(); } catch (_) {}
    try {
      const { hour, date } = this._ny();
      if (hour < this.startHour || hour >= this.endHour) return { skipped: 'off_window', hour };
      if (await this._alertedToday(date)) return { skipped: 'already_today' };
      const dups = await this.computeDuplicates();
      if (!dups.length) return { dups: 0 };
      if (await this._post(this._format(dups))) {
        await this._markAlerted(date, dups);
        return { dups: dups.length, posted: true };
      }
      return { dups: dups.length, posted: false };
    } finally { this._ticking = false; }
  }
}

module.exports = { VeeqoDupShipmentDetector };
