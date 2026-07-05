'use strict';
/**
 * HEALTHFARE V3 — Encapsulation-off monitor (regra Bruno 07-02).
 *
 * Entre 8h–20h (NY), se a máquina de ENCAPSULAÇÃO ficar ≥1h sem produzir
 * (nenhum evento 'encapsulation' aberto nem cobrindo a última hora), avisa o
 * canal dos operadores — É EMERGÊNCIA — e REPETE a cada hora enquanto durar.
 * A mensagem acumula o total de horas paradas do dia (união dos períodos sem
 * encapsulação dentro da janela 8h–20h).
 *
 * Guardas anti-ruído:
 *  - só em dia ATIVO (≥1 evento não-sandbox começado hoje) → fim de semana/feriado não spamma;
 *  - dedupe por hora via v3.audit_log (action='encap_off_alert') → sobrevive a redeploy.
 * ON por padrão; desliga com ENCAP_MONITOR_ENABLED=false.
 */
const EDT = 'America/New_York';
const { isMuted, anyonePresent } = require('../v3/alert-gate');

class EncapMonitor {
  constructor(deps = {}) {
    this.db = deps.db;
    this.slack = deps.slack || null; // { postAs }
    this.channelId = deps.channelId; // canal dos operadores
    this.enabled = deps.enabled !== undefined ? deps.enabled : (process.env.ENCAP_MONITOR_ENABLED !== 'false');
    this.startHour = deps.startHour || 8;
    this.endHour = deps.endHour || 20;
    this.offThresholdMin = deps.offThresholdMin || 60;
    this.repeatMin = deps.repeatMin || 60;
    this.heartbeat = deps.heartbeat || null; // vigia (wire.js) — prova que o tick roda
    this._t = null; this._kick = null; this._ticking = false;
  }
  start(ms = 10 * 60 * 1000) {
    this._kick = setTimeout(() => this.tick().catch((e) => console.error('[encap] erro:', e.message)), 30 * 1000);
    this._t = setInterval(() => this.tick().catch((e) => console.error('[encap] erro:', e.message)), ms);
    console.log('[V3] encap-monitor ligado (' + (this.enabled ? 'ON' : 'OFF') + ', janela ' + this.startHour + 'h–' + this.endHour + 'h, limiar ' + this.offThresholdMin + 'min)');
  }
  stop() { if (this._t) clearInterval(this._t); if (this._kick) clearTimeout(this._kick); this._t = null; this._kick = null; }

  /** Estado atual: { off_min, off_since_t, total_off_min } ou null (rodando/fora da janela). */
  async check() {
    // hora NY atual + dia ativo
    const env = (await this.db.query(
      `SELECT EXTRACT(HOUR FROM (NOW() AT TIME ZONE '${EDT}'))::int AS h,
              to_char(NOW() AT TIME ZONE '${EDT}', 'HH24:MI') AS now_t,
              EXISTS (SELECT 1 FROM v3.events e WHERE e.deleted_at IS NULL AND COALESCE(e.is_test,false) = false
                      AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date) AS factory_active`)).rows[0];
    if (env.h < this.startHour || env.h >= this.endHour || !env.factory_active) return null;
    // intervalos de encapsulação de hoje (clampados na janela 8h–agora)
    const ivs = (await this.db.query(
      `SELECT GREATEST(e.started_at, ((NOW() AT TIME ZONE '${EDT}')::date + INTERVAL '${this.startHour} hours') AT TIME ZONE '${EDT}') AS s,
              LEAST(COALESCE(e.ended_at, NOW()), NOW()) AS en,
              (e.ended_at IS NULL) AS open
         FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
        WHERE at.slug = 'encapsulation' AND e.deleted_at IS NULL AND COALESCE(e.is_test,false) = false
          AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
        ORDER BY e.started_at`)).rows;
    if (ivs.some((x) => x.open)) return null; // máquina rodando AGORA → tudo certo
    // off desde: fim da última encapsulação (ou 8h, se nenhuma hoje)
    const boundsRow = (await this.db.query(
      `SELECT (((NOW() AT TIME ZONE '${EDT}')::date + INTERVAL '${this.startHour} hours') AT TIME ZONE '${EDT}') AS win_start, NOW() AS now`)).rows[0];
    const winStart = new Date(boundsRow.win_start).getTime();
    const nowMs = new Date(boundsRow.now).getTime();
    let lastEnd = winStart;
    const merged = [];
    for (const x of ivs) {
      const s = new Date(x.s).getTime(), en = new Date(x.en).getTime();
      if (!(Number.isFinite(s) && Number.isFinite(en) && en > s)) continue;
      if (merged.length && s <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], en);
      else merged.push([s, en]);
    }
    let covered = 0;
    for (const [s, en] of merged) { covered += (en - s); lastEnd = Math.max(lastEnd, en); }
    const offMin = Math.round((nowMs - lastEnd) / 60000);
    if (offMin < this.offThresholdMin) return null;
    const totalOffMin = Math.max(0, Math.round(((nowMs - winStart) - covered) / 60000));
    const sinceT = new Date(lastEnd).toLocaleTimeString('pt-BR', { timeZone: EDT, hour: '2-digit', minute: '2-digit' });
    return { off_min: offMin, off_since_t: sinceT, total_off_min: totalOffMin, now_t: env.now_t };
  }

  async _alertedRecently() {
    const r = await this.db.query(
      `SELECT 1 FROM v3.audit_log WHERE action = 'encap_off_alert' AND created_at > NOW() - INTERVAL '${this.repeatMin - 5} minutes' LIMIT 1`);
    return r.rowCount > 0;
  }

  async tick() {
    if (this._ticking || !this.enabled) return { skipped: true };
    this._ticking = true;
    try { this.heartbeat && this.heartbeat(); } catch (_) {}
    try {
      const st = await this.check();
      if (!st) return { off: false };
      // KILL-SWITCH (Bruno 07-05): admin pausou os avisos → silêncio.
      if (await isMuted(this.db)) return { off: true, muted: true };
      // "MÁQUINA PARADA" só faz sentido se TEM ALGUÉM aqui pra ligá-la. Se todo
      // mundo já saiu / foi auto-deslogado (caso 07-04: checkout às 15h e a
      // máquina gritando até 19h), a máquina parada é ESPERADO → não alerta.
      if (!(await anyonePresent(this.db))) return { off: true, nobody_present: true };
      if (await this._alertedRecently()) return { off: true, deduped: true };
      const fmt = (m) => (m >= 60 ? Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') : m + 'min');
      if (this.slack && this.slack.postAs && this.channelId) {
        try {
          await this.slack.postAs({
            channel: this.channelId,
            sender: { name: 'HealthFare Tracker', icon: ':rotating_light:' },
            thread_ts: null, unfurl_links: false, unfurl_media: false,
            text: `:rotating_light: *MÁQUINA DE ENCAPSULAÇÃO PARADA* — sem produzir há *${fmt(st.off_min)}* (desde ${st.off_since_t}). Está correto?\n`
              + `Hoje a máquina já ficou *${fmt(st.total_off_min)}* parada (janela 8h–20h). `
              + `Se estiver encapsulando, registrem no aplicativo da linha de produção AGORA.`,
          });
        } catch (e) { console.error('[encap] post falhou:', e.message); return { off: true, post_failed: true }; }
      }
      try {
        await this.db.query(
          `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
           VALUES ('system', NULL, 'encap_off_alert', 'system', 0, $1::jsonb)`,
          [JSON.stringify({ off_min: st.off_min, total_off_min: st.total_off_min, since: st.off_since_t })]);
      } catch (e) { /* dedupe fica só em memória se audit falhar */ }
      console.log('[encap] ALERTA: parada há ' + st.off_min + 'min, total hoje ' + st.total_off_min + 'min');
      return { off: true, alerted: true };
    } finally { this._ticking = false; }
  }
}

module.exports = { EncapMonitor };
