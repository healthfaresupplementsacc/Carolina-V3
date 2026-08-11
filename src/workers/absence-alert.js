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
const { isMuted } = require('../v3/alert-gate');
const presence = require('../v3/presence');   // presença REAL (Bruno 07-18: ignora phantom do EMS)
const { onDemandActive, getPlan, setPlan, nyToday } = require('../v3/workday');

class AbsenceAlert {
  constructor(deps = {}) {
    this.db = deps.db;
    this.slack = deps.slack;
    this.channelId = deps.channelId;
    this.adminChannelId = deps.adminChannelId || 'C0B36DR5MP1'; // supervisão sensível vai pro chat do admin
    // ON por padrão (Bruno: regra combinada — >15min sem função → avisa no grupo).
    // Desliga só com ABSENCE_ALERT_ENABLED=false.
    this.enabled = deps.enabled !== undefined ? deps.enabled : (process.env.ABSENCE_ALERT_ENABLED !== 'false');
    this.thresholdMin = deps.thresholdMin || parseInt(process.env.ABSENCE_THRESHOLD_MIN, 10) || 15;
    this.repeatMin = deps.repeatMin || parseInt(process.env.ABSENCE_REPEAT_MIN, 10) || 30;
    this.heartbeat = deps.heartbeat || null; // vigia (wire.js) — prova que o tick roda
    this._now = deps.now || Date.now;        // injetável (testes de janela/sábado)
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
  async findAbsent(thresholdMin = this.thresholdMin) {
    // Idle medido a partir do FIM DA ÚLTIMA TASK (qualquer tipo) — re-login NÃO
    // zera o relógio (kiosk compartilhado: logar de novo não é "estar em função").
    // O login serve só de PISO p/ quem ainda não fez nenhuma task hoje → usa o
    // PRIMEIRO login (MIN), não o último, senão re-logar mascarava o ocioso (caso
    // da Simone: terminou 12:49, re-logou 13:07 e o sistema "esquecia" os 26min).
    const refExpr = `GREATEST(
        COALESCE((SELECT MAX(e.ended_at) FROM v3.events e WHERE e.person_id=p.id AND e.deleted_at IS NULL AND e.ended_at IS NOT NULL AND (e.ended_at AT TIME ZONE '${EDT}')::date=(NOW() AT TIME ZONE '${EDT}')::date),'epoch'::timestamptz),
        COALESCE((SELECT MIN(s.created_at) FROM v3.operator_sessions s WHERE s.person_id=p.id AND (s.created_at AT TIME ZONE '${EDT}')::date=(NOW() AT TIME ZONE '${EDT}')::date),'epoch'::timestamptz))`;
    const r = await this.db.query(
      `SELECT p.id, p.display_name, p.slack_user_id,
              ROUND(EXTRACT(EPOCH FROM (NOW() - ${refExpr})) / 60)::int AS idle_min,
              ${refExpr} AS ref,
              -- 1º check-in de HOJE (login ou 1ª task) — âncora do expediente
              LEAST(
                COALESCE((SELECT MIN(s.created_at) FROM v3.operator_sessions s WHERE s.person_id=p.id AND (s.created_at AT TIME ZONE '${EDT}')::date=(NOW() AT TIME ZONE '${EDT}')::date), 'infinity'::timestamptz),
                COALESCE((SELECT MIN(e.started_at) FROM v3.events e WHERE e.person_id=p.id AND e.deleted_at IS NULL AND (e.started_at AT TIME ZONE '${EDT}')::date=(NOW() AT TIME ZONE '${EDT}')::date), 'infinity'::timestamptz)
              ) AS first_checkin,
              -- fim de expediente da ESCALA de hoje (se cadastrada), como timestamptz
              (SELECT ((NOW() AT TIME ZONE '${EDT}')::date + sc.expected_end_time) AT TIME ZONE '${EDT}'
                 FROM v3.operator_schedules sc
                WHERE sc.person_id = p.id AND sc.is_workday = true
                  AND sc.day_of_week = EXTRACT(DOW FROM (NOW() AT TIME ZONE '${EDT}'))::int
                  AND sc.expected_end_time IS NOT NULL LIMIT 1) AS sched_end
       FROM v3.persons p
       WHERE p.role = 'operator' AND p.active = true AND p.deleted_at IS NULL AND COALESCE(p.is_sandbox,false) = false
         -- PRESENTE HOJE (Bruno 07-02): TRABALHOU hoje OU logou hoje OU tem sessão viva
         -- (o PWA do kiosk mantém a sessão viva sem criar linha nova; "sessão criada
         -- hoje" sozinho deixava todo mundo invisível — caso Ana 12:40→13:05).
         -- Bruno 07-18: presença REAL ignora ems_auto — uma task automática do EMS
         -- NÃO conta como presença (senão cobra "ocioso" de quem nem está aqui, caso
         -- Bruno 18/07: o EMS o reportou, ev fantasma, e o alarme de ausência disparou).
         AND (
           ${presence.confirmedPresenceSQL('p')}
           OR EXISTS (SELECT 1 FROM v3.operator_sessions s WHERE s.person_id = p.id
                      AND s.logged_out_at IS NULL)
         )
         -- LOGIN POR ENGANO (Bruno 08-01): se a ÚNICA prova de presença é uma sessão
         -- de kiosk mas a pessoa (a) NÃO bateu ponto no NGTeco hoje E (b) NÃO tem
         -- NENHUMA task hoje E (c) não tem sessão viva agora → foi login por engano,
         -- NÃO cobra ociosidade. (caso Ana 08-01: Bruno logou na conta dela por engano,
         -- ela não trabalha hoje, e o sistema ficou spammando "ociosa há 30min".)
         AND NOT (
           NOT EXISTS (SELECT 1 FROM v3.att_punch ap WHERE ap.person_id = p.id
                       AND ap.att_date = (NOW() AT TIME ZONE '${EDT}')::date)
           AND NOT EXISTS (SELECT 1 FROM v3.events e WHERE e.person_id = p.id AND e.deleted_at IS NULL
                       AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
                       AND e.source <> 'ems_auto')
           AND NOT EXISTS (SELECT 1 FROM v3.operator_sessions s WHERE s.person_id = p.id
                       AND s.logged_out_at IS NULL)
         )
         -- nenhuma task aberta agora (lunch/pausa abertos = ocupado, não ocioso)
         AND NOT EXISTS (SELECT 1 FROM v3.events e WHERE e.person_id = p.id AND e.ended_at IS NULL AND e.deleted_at IS NULL)
         -- não encerrou o dia (end_of_day) — aí foi embora, não está "ocioso"
         AND NOT EXISTS (SELECT 1 FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
                         WHERE e.person_id = p.id AND e.deleted_at IS NULL AND at.slug = 'end_of_day'
                           AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date)
         -- entrou em LIMPEZA (fim de dia) e ficou ocioso → provavelmente foi embora
         -- sem bater a saída: NÃO cobra "ocioso" (o aviso de check-out esquecido cobre
         -- isso no dia seguinte). Se voltar a trabalhar, a última atividade deixa de
         -- ser limpeza e ele volta ao radar normal. (Bruno 07-11)
         AND COALESCE((SELECT at.slug FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
                        WHERE e.person_id = p.id AND e.deleted_at IS NULL AND e.ended_at IS NOT NULL
                          AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
                        ORDER BY e.ended_at DESC LIMIT 1), '') NOT IN ('cleaning','cleaning_other')`);
    // só os realmente ociosos (entre threshold e 3h — acima disso provavelmente foi
    // embora sem marcar end_of_day) e com ref de hoje (não 1º login epoch).
    // ── JANELA DE EXPEDIENTE (Bruno 07-04 — fim do flood pós-horário) ──
    // Fim esperado = MAX(1º check-in + 9h, fim da escala de hoje). Fora da
    // janela (antes do 1º check-in / depois do fim / fora de 06–21h NY) =
    // NENHUM aviso. Ex.: entrou 8h → some às 17h; entrou 9:30 → 18:30.
    const now = this._now();
    const nyHour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour12: false, hour: '2-digit' }).format(new Date(now)), 10);
    return r.rows.filter((x) => {
      if (!(x.idle_min >= thresholdMin) || !x.ref || new Date(x.ref).getUTCFullYear() <= 2000) return false;
      if (nyHour < 6 || nyHour >= 21) return false;                    // guarda-chuva: nunca de madrugada
      const first = x.first_checkin ? new Date(x.first_checkin).getTime() : null;
      if (!first || !Number.isFinite(first)) return false;             // sem check-in hoje → não é "ausente"
      const nineH = first + 9 * 3600 * 1000;
      const sched = x.sched_end ? new Date(x.sched_end).getTime() : 0;
      const expectedEnd = Math.max(nineH, sched);
      if (now < first || now > expectedEnd) return false;              // fora do expediente → silêncio
      return true;
    });
  }

  /** Sábado em NY? (fluxo diferente: pergunta ✅/❌ em vez de cobrar direto) */
  _isSaturdayNy() {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(this._now())) === 'Sat';
  }

  async _didToday(personId, actionType) {
    const r = await this.db.query(
      `SELECT 1 FROM v3.operator_action_log WHERE person_id = $1 AND action_type = $2
        AND (created_at AT TIME ZONE 'America/New_York')::date = (NOW() AT TIME ZONE 'America/New_York')::date LIMIT 1`,
      [personId, actionType]);
    return r.rowCount > 0;
  }

  /** 1h sem ação = considerado SAÍDO: fecha as sessões, avisa 1x e para de cobrar.
   *  Se os avisos estiverem MUTADOS pelo admin: faz o logoff em SILÊNCIO (higiene
   *  de sessão continua — só não posta no canal). */
  async _autoLogoff(a, muted) {
    if (await this._didToday(a.id, 'absence_auto_logoff')) return false;
    await this.db.query(
      `UPDATE v3.operator_sessions SET logged_out_at = NOW(), logoff_reason = 'auto_idle_1h'
        WHERE person_id = $1 AND logged_out_at IS NULL`, [a.id]);
    if (!muted && this.slack && this.slack.postAs && this.channelId) {
      try {
        await this.slack.postAs({
          channel: this.channelId,
          sender: { name: 'HealthFare Tracker', icon: ':door:' },
          thread_ts: null, unfurl_links: false, unfurl_media: false,
          text: `${a.display_name} ficou sem tarefa *${a.idle_min}min*, considerei que saiu e fiz o checkout. Se ainda tá aí, é só entrar numa tarefa.`,
        });
      } catch (e) { console.error('[absence] post logoff falhou:', e.message); }
    }
    try {
      await this.db.query(
        `INSERT INTO v3.operator_action_log (person_id, person_name, action_type, source, payload)
         VALUES ($1, $2, 'absence_auto_logoff', 'system', $3::jsonb)`,
        [a.id, a.display_name, JSON.stringify({ idle_min: a.idle_min })]);
    } catch (_) {}
    return true;
  }

  /** SÁBADO: pergunta no canal ("foi embora?") e espera reação ✅/❌ de QUALQUER um. */
  async _saturdayAsk(a) {
    if (await this._didToday(a.id, 'saturday_idle_question')) return false;
    if (!this.slack || !this.slack.postAs || !this.channelId) return false;
    let posted;
    try {
      posted = await this.slack.postAs({
        channel: this.channelId,
        sender: { name: 'HealthFare Tracker', icon: ':question:' },
        thread_ts: null, unfurl_links: false, unfurl_media: false,
        text: `${a.display_name} sem tarefa há *${a.idle_min}min*. Foi embora? Reaja ✅ sim (faço checkout) ou ❌ não (peço pra registrar).`,
      });
    } catch (e) { console.error('[absence] pergunta de sábado falhou:', e.message); return false; }
    try {
      await this.db.query(
        `INSERT INTO v3.notifications (type, payload, status) VALUES ('saturday_idle_check', $1::jsonb, 'pending')`,
        [JSON.stringify({ person_id: a.id, display_name: a.display_name, slack_user_id: a.slack_user_id || null, msg_ts: posted && posted.ts, channel: this.channelId, idle_min: a.idle_min })]);
      await this.db.query(
        `INSERT INTO v3.operator_action_log (person_id, person_name, action_type, source, payload)
         VALUES ($1, $2, 'saturday_idle_question', 'system', $3::jsonb)`,
        [a.id, a.display_name, JSON.stringify({ idle_min: a.idle_min, msg_ts: posted && posted.ts })]);
    } catch (_) {}
    return true;
  }

  async _alertedRecently(personId, repeatMin = this.repeatMin) {
    const r = await this.db.query(
      `SELECT 1 FROM v3.operator_action_log WHERE person_id = $1 AND action_type = 'absence_alert' AND created_at > NOW() - INTERVAL '${repeatMin} minutes' LIMIT 1`, [personId]);
    return r.rowCount > 0;
  }

  /** FDS/sob demanda: heads-up SENSÍVEL vai pro CHAT DO ADMIN (nunca no canal do
   *  operador) — "fulano parado, costumam enrolar no fim de semana". 1×/dia/pessoa. */
  async _weekendAdminHeadsUp(a) {
    if (await this._didToday(a.id, 'weekend_idle_headsup')) return false;
    if (!this.slack || !this.slack.postAs || !this.adminChannelId) return false;
    try {
      await this.slack.postAs({
        channel: this.adminChannelId,
        sender: { name: 'HealthFare Tracker', icon: ':eyes:' },
        thread_ts: null, unfurl_links: false, unfurl_media: false,
        text: `:eyes: ${a.display_name} sem tarefa há *${a.idle_min}min* (serviço extra). Fiquem de olho. Se saiu, o checkout automático entra em 1h.`,
      });
      await this.db.query(
        `INSERT INTO v3.operator_action_log (person_id, person_name, action_type, source, payload)
         VALUES ($1, $2, 'weekend_idle_headsup', 'system', $3::jsonb)`,
        [a.id, a.display_name, JSON.stringify({ idle_min: a.idle_min })]);
    } catch (e) { console.error('[absence] heads-up admin falhou:', e.message); return false; }
    return true;
  }

  /** FDS/sob demanda: NÃO pergunta o horário de saída — LÊ do relógio (NGTeco).
   *  Bruno 08-01: "você tem o NGTeco, sabe a que horas eles saem, pare de perguntar".
   *  A saída de cada pessoa é a batida de saída no relógio (v3.att_state.checkout_at,
   *  populada pelo attendance-sync). Não há UM horário do dia — cada um sai na sua
   *  batida. Aqui só registramos silenciosamente que o dia está sendo governado pelo
   *  relógio (plano 'clock'), pra o resto do sistema saber que não precisa perguntar
   *  nem esperar anúncio. Quem já bateu a saída sai do radar de cobrança (ver tick). */
  async _deriveLeaveTimeFromClock(today) {
    const plan = await getPlan(this.db);
    if (plan && plan.note === 'clock') return false; // já marcado como governado pelo relógio
    // Se um admin ANUNCIOU explicitamente um horário (note !== 'asked'/'clock'), respeita.
    if (plan && plan.end && plan.note !== 'asked') return false;
    try { await setPlan(this.db, { date: today.d, end: null, note: 'clock' }); } catch (_) {}
    return true;
  }

  /** Quem já bateu a SAÍDA no relógio hoje (NGTeco) — set de person_id. Esses não
   *  são cobrados por ociosidade nem recebem "foi embora?": o relógio já respondeu. */
  async _clockedOutToday() {
    try {
      const r = await this.db.query(
        `SELECT person_id FROM v3.att_state
          WHERE att_date = (NOW() AT TIME ZONE '${EDT}')::date
            AND checkout_at IS NOT NULL`);
      return new Set(r.rows.map((x) => x.person_id));
    } catch (_) { return new Set(); }
  }

  async tick() {
    if (this._ticking || !this.enabled) return { skipped: true };
    this._ticking = true;
    try { this.heartbeat && this.heartbeat(); } catch (_) {}
    try {
      // KILL-SWITCH (Bruno 07-05): admin pausou os avisos → não posta nada no
      // canal. O logoff de 1h AINDA roda (silencioso) pra manter as sessões limpas.
      const muted = await isMuted(this.db, this._now());
      // MODO SOB DEMANDA (fds/dia sem escala fixa, alguém trabalhando): ATENÇÃO
      // DOBRADA — idle mais curto (8min) e cobrança mais frequente (15min). Sábado
      // eles enrolam e não marcam. Bruno 07-11.
      const onDemand = await onDemandActive(this.db);
      const th = onDemand ? Math.min(this.thresholdMin, 8) : this.thresholdMin;
      const rep = onDemand ? 15 : this.repeatMin;
      const absent = await this.findAbsent(th);
      let sent = 0;
      // FDS: o horário de saída vem do RELÓGIO (NGTeco), não de pergunta (Bruno 08-01).
      if (onDemand) { try { await this._deriveLeaveTimeFromClock(await nyToday(this.db)); } catch (_) {} }
      // Quem JÁ bateu a saída no relógio hoje sai do radar (o relógio já respondeu
      // "foi embora") — nada de cobrar ociosidade nem perguntar "foi embora?".
      const clockedOut = await this._clockedOutToday();
      for (const a of absent) {
        if (clockedOut.has(a.id)) continue; // bateu a saída no NGTeco → não cobra
        // 1h SEM AÇÃO = SAIU (Bruno 07-04): checkout automático, 1 aviso só,
        // e o flood morre (a pessoa sai do radar até logar/trabalhar de novo).
        if (a.idle_min >= 60) { if (await this._autoLogoff(a, muted)) sent++; continue; }
        if (muted) continue; // avisos pausados → nenhuma cobrança de ociosidade
        // FDS: heads-up SENSÍVEL vai pro chat do admin (supervisão), não pro operador.
        if (onDemand && a.idle_min >= 30) { await this._weekendAdminHeadsUp(a); }
        if (await this._alertedRecently(a.id, rep)) continue;
        let dmSent = false;
        if (this.slack && this.slack.postAs && this.channelId) {
          try {
            // CANAL SEMPRE (regra Bruno 07-03: managers têm que ver no
            // #orders-and-inventory) — menciona a pessoa quando tem Slack.
            const who = a.slack_user_id ? `<@${a.slack_user_id}>` : `*${a.display_name}*`;
            await this.slack.postAs({
              channel: this.channelId,
              sender: { name: 'HealthFare Tracker', icon: ':hourglass_flowing_sand:' },
              thread_ts: null, unfurl_links: false, unfurl_media: false,
              text: `${who} sem tarefa registrada há *${a.idle_min}min*. Registra aí, ou avisa o que tá fazendo.`,
            });
          } catch (e) { console.error('[absence] post falhou:', e.message); continue; }
          // DM EM ADIÇÃO (nunca no lugar do canal; falha de DM não bloqueia nada)
          if (a.slack_user_id && this.slack.postDm) {
            try {
              await this.slack.postDm({
                userId: a.slack_user_id,
                sender: { name: 'HealthFare Tracker', icon: ':hourglass_flowing_sand:' },
                text: `Você está sem tarefa registrada há *${a.idle_min}min*. Registra aí, por favor. (Também avisei no canal.)`,
              });
              dmSent = true;
            } catch (e) { console.error('[absence] DM falhou (canal já saiu):', e.message); }
          }
        }
        try {
          await this.db.query(
            `INSERT INTO v3.operator_action_log (person_id, person_name, action_type, source, payload)
             VALUES ($1, $2, 'absence_alert', 'system', $3::jsonb)`,
            [a.id, a.display_name, JSON.stringify({ idle_min: a.idle_min, dm_sent: dmSent })]);
        } catch (e) { /* log opcional */ }
        sent++;
      }
      // visibilidade nos logs do Railway (diagnóstico: "achou N ociosos, avisou M")
      if (absent.length) console.log('[absence] ociosos: ' + absent.map((a) => a.display_name + '=' + a.idle_min + 'min').join(', ') + ' → avisou ' + sent);
      return { absent: absent.length, sent };
    } finally { this._ticking = false; }
  }
}
module.exports = { AbsenceAlert };
