'use strict';
/**
 * Absence alert — operador LOGADO mas SEM função (foreground) registrada há > 15 min
 * → avisa no Slack do grupo dos operadores (#orders-and-inventory). Tarefa de
 * BACKGROUND (encapsulação/mistura na máquina) NÃO conta como "estar em função"
 * (o operador deveria pegar outra coisa enquanto a máquina roda). Não re-alerta a
 * mesma pessoa dentro de repeatMin. Gated por ABSENCE_ALERT_ENABLED. Sandbox fora.
 */
const EDT = 'America/New_York';

class AbsenceAlert {
  constructor(deps = {}) {
    this.db = deps.db;
    this.slack = deps.slack;
    this.channelId = deps.channelId;
    this.enabled = deps.enabled !== undefined ? deps.enabled : (process.env.ABSENCE_ALERT_ENABLED === 'true');
    this.thresholdMin = deps.thresholdMin || parseInt(process.env.ABSENCE_THRESHOLD_MIN, 10) || 15;
    this.repeatMin = deps.repeatMin || parseInt(process.env.ABSENCE_REPEAT_MIN, 10) || 30;
    this._t = null; this._ticking = false;
  }
  start(ms = 5 * 60 * 1000) {
    this._t = setInterval(() => this.tick().catch((e) => console.error('[absence] erro:', e.message)), ms);
    console.log('[V3] absence-alert ligado (' + (this.enabled ? 'ON' : 'OFF') + ', limiar ' + this.thresholdMin + 'min)');
  }
  stop() { if (this._t) clearInterval(this._t); this._t = null; }

  // operadores LOGADOS, sem foreground aberto, ociosos > threshold (testável).
  async findAbsent() {
    const refExpr = `GREATEST(
        COALESCE((SELECT MAX(e.ended_at) FROM v3.events e WHERE e.person_id=p.id AND e.deleted_at IS NULL AND e.is_long_running=false AND e.ended_at IS NOT NULL AND (e.ended_at AT TIME ZONE '${EDT}')::date=(NOW() AT TIME ZONE '${EDT}')::date),'epoch'::timestamptz),
        COALESCE((SELECT MAX(s.created_at) FROM v3.operator_sessions s WHERE s.person_id=p.id AND (s.created_at AT TIME ZONE '${EDT}')::date=(NOW() AT TIME ZONE '${EDT}')::date),'epoch'::timestamptz))`;
    const r = await this.db.query(
      `SELECT p.id, p.display_name,
              ROUND(EXTRACT(EPOCH FROM (NOW() - ${refExpr})) / 60)::int AS idle_min,
              ${refExpr} AS ref
       FROM v3.persons p
       WHERE p.role = 'operator' AND p.active = true AND p.deleted_at IS NULL AND COALESCE(p.is_sandbox,false) = false
         AND EXISTS (SELECT 1 FROM v3.operator_sessions s WHERE s.person_id = p.id AND s.logged_out_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM v3.events e WHERE e.person_id = p.id AND e.ended_at IS NULL AND e.deleted_at IS NULL AND e.is_long_running = false)`);
    // só os realmente ociosos (> threshold) e com ref de hoje (não 1º login epoch)
    return r.rows.filter((x) => x.idle_min >= this.thresholdMin && x.idle_min < 600 && x.ref && new Date(x.ref).getUTCFullYear() > 2000);
  }

  async _alertedRecently(personId) {
    const r = await this.db.query(
      `SELECT 1 FROM v3.operator_action_log WHERE person_id = $1 AND action_type = 'absence_alert' AND created_at > NOW() - INTERVAL '${this.repeatMin} minutes' LIMIT 1`, [personId]);
    return r.rowCount > 0;
  }

  async tick() {
    if (this._ticking || !this.enabled) return { skipped: true };
    this._ticking = true;
    try {
      const absent = await this.findAbsent();
      let sent = 0;
      for (const a of absent) {
        if (await this._alertedRecently(a.id)) continue;
        if (this.slack && this.slack.postAs && this.channelId) {
          try {
            await this.slack.postAs({
              channel: this.channelId,
              sender: { name: 'HealthFare Tracker', icon: ':hourglass_flowing_sand:' },
              thread_ts: null, unfurl_links: false, unfurl_media: false,
              text: `:hourglass_flowing_sand: *${a.display_name}* está sem função registrada há *${a.idle_min} min*.\n`
                + `Se estiver trabalhando, registre a tarefa no /op (ou avise o que está fazendo).`,
            });
          } catch (e) { console.error('[absence] post falhou:', e.message); continue; }
        }
        try {
          await this.db.query(
            `INSERT INTO v3.operator_action_log (person_id, person_name, action_type, source, payload)
             VALUES ($1, $2, 'absence_alert', 'system', $3::jsonb)`,
            [a.id, a.display_name, JSON.stringify({ idle_min: a.idle_min })]);
        } catch (e) { /* log opcional */ }
        sent++;
      }
      return { absent: absent.length, sent };
    } finally { this._ticking = false; }
  }
}
module.exports = { AbsenceAlert };
