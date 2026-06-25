'use strict';
/**
 * Absence alert — operador LOGADO mas SEM nenhuma tarefa aberta há > 15 min
 * → avisa no Slack do grupo dos operadores (#orders-and-inventory). Decisão Bruno
 * (06-22): tarefa de BACKGROUND (encapsulação/mistura na máquina) CONTA como
 * ocupado — se tem qualquer task aberta (foreground OU background), não alerta.
 * Não re-alerta a mesma pessoa dentro de repeatMin. Gated por ABSENCE_ALERT_ENABLED.
 * Sandbox fora.
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
    // tick INICIAL ~25s após subir: setInterval só dispara o 1º tick em +5min, e
    // redeploys frequentes reiniciavam o timer antes disso → o alerta nunca saía.
    this._kick = setTimeout(() => this.tick().catch((e) => console.error('[absence] erro:', e.message)), 25 * 1000);
    this._t = setInterval(() => this.tick().catch((e) => console.error('[absence] erro:', e.message)), ms);
    console.log('[V3] absence-alert ligado (' + (this.enabled ? 'ON' : 'OFF') + ', limiar ' + this.thresholdMin + 'min)');
  }
  stop() { if (this._t) clearInterval(this._t); if (this._kick) clearTimeout(this._kick); this._t = null; this._kick = null; }

  // operadores LOGADOS, SEM nenhuma task aberta (fg OU bg), ociosos > threshold (testável).
  // Referência do ocioso = último fim de QUALQUER task hoje (bg conta como ocupado) ou login.
  async findAbsent() {
    // Idle medido a partir do FIM DA ÚLTIMA TASK (qualquer tipo) — re-login NÃO
    // zera o relógio (kiosk compartilhado: logar de novo não é "estar em função").
    // O login serve só de PISO p/ quem ainda não fez nenhuma task hoje → usa o
    // PRIMEIRO login (MIN), não o último, senão re-logar mascarava o ocioso (caso
    // da Simone: terminou 12:49, re-logou 13:07 e o sistema "esquecia" os 26min).
    const refExpr = `GREATEST(
        COALESCE((SELECT MAX(e.ended_at) FROM v3.events e WHERE e.person_id=p.id AND e.deleted_at IS NULL AND e.ended_at IS NOT NULL AND (e.ended_at AT TIME ZONE '${EDT}')::date=(NOW() AT TIME ZONE '${EDT}')::date),'epoch'::timestamptz),
        COALESCE((SELECT MIN(s.created_at) FROM v3.operator_sessions s WHERE s.person_id=p.id AND (s.created_at AT TIME ZONE '${EDT}')::date=(NOW() AT TIME ZONE '${EDT}')::date),'epoch'::timestamptz))`;
    const r = await this.db.query(
      `SELECT p.id, p.display_name,
              ROUND(EXTRACT(EPOCH FROM (NOW() - ${refExpr})) / 60)::int AS idle_min,
              ${refExpr} AS ref
       FROM v3.persons p
       WHERE p.role = 'operator' AND p.active = true AND p.deleted_at IS NULL AND COALESCE(p.is_sandbox,false) = false
         -- PRESENTE HOJE (Bruno 06-24): logou hoje (sessão CRIADA hoje, mesmo já
         -- deslogada — as sessões do kiosk caem em ~1min) OU tem sessão viva. Antes
         -- exigia SÓ sessão viva e perdia todo mundo (sessões efêmeras) → caso da
         -- Simone ociosa 11:50→12:26 sem nenhum aviso.
         AND EXISTS (SELECT 1 FROM v3.operator_sessions s WHERE s.person_id = p.id
                     AND (s.created_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date)
         -- nenhuma task aberta agora (lunch/pausa abertos = ocupado, não ocioso)
         AND NOT EXISTS (SELECT 1 FROM v3.events e WHERE e.person_id = p.id AND e.ended_at IS NULL AND e.deleted_at IS NULL)
         -- não encerrou o dia (end_of_day) — aí foi embora, não está "ocioso"
         AND NOT EXISTS (SELECT 1 FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
                         WHERE e.person_id = p.id AND e.deleted_at IS NULL AND at.slug = 'end_of_day'
                           AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date)`);
    // só os realmente ociosos (entre threshold e 3h — acima disso provavelmente foi
    // embora sem marcar end_of_day) e com ref de hoje (não 1º login epoch).
    return r.rows.filter((x) => x.idle_min >= this.thresholdMin && x.idle_min < 180 && x.ref && new Date(x.ref).getUTCFullYear() > 2000);
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
                + `Se estiver trabalhando, registre a tarefa no aplicativo da linha de produção (ou avise o que está fazendo).`,
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
