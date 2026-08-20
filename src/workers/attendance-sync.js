'use strict';
/**
 * HEALTHFARE — sync do relógio de ponto NGTeco (NG-TC2). Bruno 07-22.
 *
 * Puxa as batidas do dia (cloud NGTeco) a cada 60s pros mapeados
 * (persons.clock_code) e mantém a máquina de estados do dia em v3.att_state.
 *
 * REGRAS (Bruno):
 *  - Horários do relógio são INTERNOS: aparecem SÓ no dashboard admin e no
 *    #admin-orin. NUNCA na página do funcionário nem no canal dos operadores.
 *  - 1ª batida do dia = CHEGOU → quadrado no dashboard + admin-orin
 *    ("X bateu o ponto e começou a trabalhar").
 *  - Batida de SAÍDA (fim de dia) = checkout autoritativo → admin-orin + fecha as
 *    tasks abertas (não-máquina) e sessões da pessoa naquele horário. Não
 *    perguntamos mais "esqueceu de dar checkout no sistema".
 *  - ALMOÇO: o clique de almoço no /op é o que vale pra SAIR de almoço (batida de
 *    saída pro almoço no relógio é só registro interno). A batida de VOLTA fecha o
 *    almoço aberto no sistema automaticamente.
 *  - Voltou/chegou e não registrou tarefa em 15min → aviso no canal dos operadores
 *    ("registra a tarefa por favor") — SEM horários.
 *  - Começou tarefa no sistema SEM ter batido o ponto → chama atenção no canal
 *    ("esqueceu de bater o ponto; considero o início da tarefa como seu início").
 */
const TZ = 'America/New_York';
const NUDGE_MIN = 15;          // min sem tarefa depois de bater o ponto → cobrar
const NOCLOCK_GRACE_MIN = 30;  // min de tarefa aberta sem ponto antes de perguntar (margem pro sync NGTeco — Bruno 07-28)
// margem pro NGTeco entregar a batida (às vezes demora minutos). Antes de concluir
// "esqueceu de bater", espera isso — senão marca quem BATEU mas o dado atrasou.
// Caso Simone 07-27: bateu 15:04, batida chegou 15:09 (5min), worker disparou 15:06.
const NGTECO_SYNC_GRACE_MIN = 15;
// janela em que uma batida de saída é tratada como ALMOÇO (fora dela = saída do dia)
const LUNCH_WIN = { from: 10 * 60, to: 15 * 60 + 30 };  // 10:00–15:30 NY
// Batida a partir daqui (17:00 NY) = SAÍDA do dia, nunca volta de almoço (Bruno 08-01:
// "se saem depois das 6-7pm estão indo embora; almoço não dura 6h"). Fim do expediente
// mais cedo é 18:30 (escala); 17:00 dá margem e ainda pega quem sai cedo. Uma batida
// noturna classificada como "volta" era o bug do Vitor (bateu a saída 18:36 e o sistema
// achou que ele voltou do almoço → floodou "está sem função" com ele já em casa).
const CHECKOUT_MIN = 17 * 60;  // 17:00 NY
const LUNCH_SLUGS = ['lunch', 'break'];   // mesmos slugs do /op (almoço + pausa)
// SÓ almoço de verdade. Pausa curta (descarregar caminhão, banheiro) NÃO gera batida
// no relógio, então cobrar batida de pausa é acusar quem não fez nada errado.
const ONLY_LUNCH = ['lunch'];

class AttendanceSync {
  constructor(deps = {}) {
    this.db = deps.db;
    this.ngteco = deps.ngteco;
    this.slack = deps.slack || null;
    this.adminChannelId = deps.adminChannelId || process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1';
    this.operatorChannelId = deps.operatorChannelId || process.env.V3_PRODUCTION_CHANNEL || 'C09UNBXFRKK';
    this.alertGate = deps.alertGate || null;
    this.heartbeat = deps.heartbeat || null;
    this._timer = null;
    this._ticking = false;
    this._devCheckAt = 0;       // último check de saúde do TC2 (a cada 5min)
    this._devOffline = false;   // estado do relógio (pra alertar só na transição)
  }
  start(intervalMs = 60000) {
    this._timer = setInterval(() => this.tick().catch((e) => console.error('[att-sync] tick erro:', e.message)), intervalMs);
    console.log('[V3] attendance-sync ligado (tick ' + Math.round(intervalMs / 1000) + 's)');
  }
  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; }

  _norm(code) { return String(code == null ? '' : code).trim().replace(/^0+/, ''); }
  _nyMinutes(ts) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' })
      .format(ts).split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }
  _fmtNY(ts) {
    return new Date(ts).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  }

  async _admin(text) {
    if (!this.slack || !this.slack.postAs) return null;
    try {
      const r = await this.slack.postAs({ channel: this.adminChannelId, sender: { name: 'HealthFare Tracker (Ponto)', icon: ':alarm_clock:' }, thread_ts: null, unfurl_links: false, unfurl_media: false, text });
      return (r && (r.ts || r.message_ts)) || null;   // ts pra casar reação de aprovação
    } catch (e) { console.error('[att-sync] admin slack:', e.message); return null; }
  }
  async _operators(text) {
    if (!this.slack || !this.slack.postAs) return;
    try {
      if (this.alertGate && await this.alertGate.isMuted(this.db)) return;   // kill-switch
      await this.slack.postAs({ channel: this.operatorChannelId, sender: { name: 'HealthFare Tracker', icon: ':alarm_clock:' }, thread_ts: null, unfurl_links: false, unfurl_media: false, text });
    } catch (e) { console.error('[att-sync] op slack:', e.message); }
  }

  /** GATE DE VERIFICAÇÃO (Bruno 07-27): NENHUM aviso de ponto pro operador sai sem
   *  RECONFERIR contra a VERDADE VIVA no instante do envio — não contra a att_state
   *  derivada (que pode estar velha). O grace period não basta: atrasar um aviso
   *  errado e mandar mesmo assim é inútil. Re-puxa as batidas DO NGTeco AGORA e
   *  re-lê os eventos AGORA; só deixa passar se a acusação AINDA for verdade.
   *
   *  Retorna { ok:true } se pode enviar, ou { ok:false, reason } se a verdade viva
   *  contradiz a acusação (ex.: a batida chegou; a pessoa voltou). SINCRONIZAÇÃO:
   *  punches + eventos + att_state têm que concordar — se discordam, NÃO acusa e
   *  ainda RESSINCRONIZA a att_state pela verdade.
   *
   *  kind: 'lunch_punch_missing' | 'forgot_lunch_return' | 'missed_clockout' | 'no_clockin'
   */
  async _verifyClaim(person, today, kind) {
    // 1) Re-puxa as batidas FRESCAS do NGTeco (o delay de sync é a causa nº1 de erro).
    //    Se a re-leitura falhar, NÃO manda (na dúvida, cala — melhor que acusar errado).
    let freshPunches = null;
    try {
      const agg = await this.ngteco.aggregationDay(today);
      const rec = (agg || []).find((r) => this._norm(r.employee_code) === this._norm(person.clock_code));
      freshPunches = rec && Array.isArray(rec.attendance_status) ? rec.attendance_status : [];
      // grava as que ainda não tínhamos (mantém att_punch em dia) e ressincroniza estado
      if (rec) { try { await this._syncPerson(person, today, rec, freshPunches); } catch (_) {} }
    } catch (e) {
      return { ok: false, reason: 'ngteco re-fetch falhou (na dúvida, não acusa): ' + e.message };
    }

    // 2) Lê a verdade viva do banco DEPOIS do re-sync.
    const punches = (await this.db.query(
      `SELECT punch_time FROM v3.att_punch WHERE person_id=$1 AND att_date=$2::date ORDER BY punch_time`,
      [person.id, today])).rows.map((r) => new Date(r.punch_time));
    const lunch = (await this.db.query(
      `SELECT MIN(e.started_at) AS lunch_out, MAX(e.ended_at) AS lunch_in
         FROM v3.events e JOIN v3.activity_types at ON at.id=e.activity_type_id
        WHERE e.person_id=$1 AND e.deleted_at IS NULL AND at.slug = ANY($2::text[])
          AND (e.started_at AT TIME ZONE '${TZ}')::date = $3::date AND e.ended_at IS NOT NULL`,
      [person.id, kind === 'lunch_punch_missing' ? ONLY_LUNCH : LUNCH_SLUGS, today])).rows[0];
    const near = (ts, target, mins = 20) => ts && target && Math.abs(new Date(ts).getTime() - new Date(target).getTime()) <= mins * 60000;
    const hasPunchNear = (target, mins) => punches.some((p) => near(p, target, mins));

    switch (kind) {
      case 'lunch_punch_missing': {
        // acusação: faltou batida no almoço. VERDADE = tem batida perto da saída E da volta?
        if (!lunch || !lunch.lunch_out || !lunch.lunch_in) return { ok: false, reason: 'sem almoço fechado — nada a cobrar' };
        const outOk = hasPunchNear(lunch.lunch_out);
        const inOk = hasPunchNear(lunch.lunch_in);
        if (outOk && inOk) return { ok: false, reason: `batidas presentes (saída ${this._fmtNY(lunch.lunch_out)} e volta ${this._fmtNY(lunch.lunch_in)}) — NÃO faltou` };
        return { ok: true, missing: { out: !outOk, in: !inOk } };
      }
      case 'forgot_lunch_return': {
        // acusação: voltou do almoço e não bateu a volta. VERDADE = já tem batida de volta?
        if (!lunch || !lunch.lunch_in) return { ok: true };   // sem volta registrada → segue lógica original
        if (hasPunchNear(lunch.lunch_in)) return { ok: false, reason: `bateu a volta ${this._fmtNY(lunch.lunch_in)}` };
        return { ok: true };
      }
      case 'missed_clockout': {
        // acusação: não bateu saída ONTEM. Re-puxa ONTEM do NGTeco (saída pode ter
        // sincronizado tarde) e re-checa a paridade. VERDADE = nº de batidas ainda ímpar?
        const yISO = (await this.db.query(`SELECT (($1::date)-1)::text d`, [today])).rows[0].d;
        try {
          const agg = await this.ngteco.aggregationDay(yISO);
          const rec = (agg || []).find((r) => this._norm(r.employee_code) === this._norm(person.clock_code));
          if (rec) { try { await this._syncPerson(person, yISO, rec, rec.attendance_status || []); } catch (_) {} }
        } catch (e) { return { ok: false, reason: 'ngteco re-fetch de ontem falhou: ' + e.message }; }
        const yPunches = (await this.db.query(
          `SELECT COUNT(*) n FROM v3.att_punch WHERE person_id=$1 AND att_date=(($2::date)-1)`, [person.id, today])).rows[0];
        if (Number(yPunches.n) % 2 === 0) return { ok: false, reason: `nº de batidas de ontem agora é PAR (${yPunches.n}) — saída chegou` };
        return { ok: true };
      }
      case 'no_clockin': {
        // acusação: começou tarefa mas NÃO bateu o ponto da manhã (caso Ana 07-28: o
        // relógio entregou a batida ~6h atrasada, então às 8:26 o sistema acusou sendo
        // que ela BATEU). VERDADE = depois do re-fetch ao vivo, tem alguma batida perto
        // do início da 1ª tarefa (±60min)? Se tem, a batida existe → NÃO acusa.
        const firstTask = (await this.db.query(
          `SELECT MIN(e.started_at) t FROM v3.events e
            WHERE e.person_id=$1 AND e.deleted_at IS NULL AND e.source NOT IN ('ems_auto')
              AND (e.started_at AT TIME ZONE '${TZ}')::date=$2::date`, [person.id, today])).rows[0];
        if (!firstTask || !firstTask.t) return { ok: false, reason: 'sem 1ª tarefa — nada a cobrar' };
        const punchNearStart = punches.some((p) => new Date(p).getTime() <= new Date(firstTask.t).getTime() + 60 * 60000);
        if (punchNearStart) return { ok: false, reason: `batida presente perto do início (1ª tarefa ${this._fmtNY(firstTask.t)}) — bateu sim` };
        return { ok: true };
      }
      default:
        return { ok: true };
    }
  }

  /** Pessoas mapeadas: clock_code → person. */
  async _mapped() {
    const r = await this.db.query(
      `SELECT id, display_name, clock_code FROM v3.persons
        WHERE clock_code IS NOT NULL AND clock_code <> '' AND active = true AND deleted_at IS NULL`);
    const byCode = new Map();
    for (const p of r.rows) byCode.set(this._norm(p.clock_code), p);
    return byCode;
  }

  /** Converte punch (att_date + punch_time do NGTeco) num Date. Aceita
   *  "HH:MM:SS" (combina com att_date em NY) ou ISO completo. */
  _punchDate(attDate, punchTime) {
    const s = String(punchTime || '').trim();
    if (!s) return null;
    if (/\d{4}-\d{2}-\d{2}/.test(s)) { const d = new Date(s); return isNaN(d) ? null : d; }
    return { nyLocal: `${attDate} ${s}` };   // marcador: converter no SQL (AT TIME ZONE NY)
  }

  async tick() {
    if (this._ticking) return { skipped: true };
    this._ticking = true;
    try { this.heartbeat && this.heartbeat(); } catch (_) {}
    try {
      if (!this.ngteco || !this.ngteco.configured()) return { ngteco: false };
      const byCode = await this._mapped();
      if (!byCode.size) return { mapped: 0 };
      const today = this.ngteco.nyToday();
      let agg = null;
      try { agg = await this.ngteco.aggregationDay(today); }
      catch (e) { console.error('[att-sync] pull:', e.message); return { pull: false }; }

      for (const rec of (agg || [])) {
        const person = byCode.get(this._norm(rec.employee_code));
        if (!person) continue;   // não mapeado — ignora (só armazenamos os nossos)
        const punches = Array.isArray(rec.attendance_status) ? rec.attendance_status : [];
        try { await this._syncPerson(person, today, rec, punches); }
        catch (e) { console.error('[att-sync] person ' + person.id + ':', e.message); }
      }
      await this._checkNudges(byCode, today);
      await this._checkNoClockin(byCode, today);
      await this._checkForgotLunchPunch(today);   // voltou do almoço sem bater a volta
      await this._checkLunchPunchPair(today);     // almoço com batida faltando (precisa das 2)
      await this._nightSweep(today);              // 22h+: quem "ficou aberto" já foi embora
      await this._alertMissedClockout(today);     // dia seguinte: não bateu SAÍDA no relógio (Bruno 07-23)
      await this._checkDevice();   // TC2 caiu? (Bruno 07-22 — a cada 5min)
      return { ok: true };
    } finally { this._ticking = false; }
  }

  /** Pessoa "em pausa" no relógio mas ABRIU tarefa no sistema = voltou do almoço e
   *  esqueceu de bater a VOLTA. Chama no grupo + a volta vira o início da tarefa.
   *  MARGEM PRO SYNC DO NGTeco (Bruno 07-27, caso Simone): o NGTeco pode demorar
   *  ATÉ ~vários min pra nos entregar a batida de volta. Se a gente concluir
   *  "esqueceu" cedo demais, marca errado quem BATEU mas o dado ainda não chegou.
   *  Por isso: só conclui se a tarefa foi aberta há >= NGTECO_SYNC_GRACE_MIN. */
  async _checkForgotLunchPunch(today) {
    const rows = (await this.db.query(
      `SELECT s.person_id, p.display_name, p.slack_user_id, p.clock_code, s.break_started_at,
              (SELECT MIN(e.started_at) FROM v3.events e
                WHERE e.person_id = s.person_id AND e.deleted_at IS NULL
                  AND e.source NOT IN ('ems_auto')
                  AND e.started_at > s.break_started_at + INTERVAL '10 minutes'
                  -- a tarefa precisa ter sido aberta há tempo suficiente pra a batida
                  -- de volta já ter chegado do NGTeco (senão marca quem bateu, atrasado)
                  AND e.started_at < NOW() - INTERVAL '${NGTECO_SYNC_GRACE_MIN} minutes'
                  AND NOT EXISTS (SELECT 1 FROM v3.activity_types at2
                                   WHERE at2.id = e.activity_type_id AND at2.slug = ANY($2::text[]))) AS task_after
         FROM v3.att_state s JOIN v3.persons p ON p.id = s.person_id
        WHERE s.att_date = $1::date AND s.state = 'break' AND s.break_started_at IS NOT NULL
          AND s.manual_return_at IS NULL`,
      [today, LUNCH_SLUGS])).rows;
    for (const r of rows) {
      if (!r.task_after) continue;
      // GATE: reconfere AGORA — a batida de volta pode ter chegado no meio-tempo.
      const v = await this._verifyClaim({ id: r.person_id, clock_code: r.clock_code, display_name: r.display_name }, today, 'forgot_lunch_return');
      if (!v.ok) {
        console.log(`[att-sync] forgot_lunch_return ${r.display_name} ABORTADO: ${v.reason}`);
        // ressincroniza: a batida chegou → tira o "break", deixa o estado correto (o
        // _verifyClaim já re-sincronizou via _syncPerson). Não acusa.
        continue;
      }
      const ret = new Date(r.task_after);
      await this.db.query(
        `UPDATE v3.att_state SET manual_return_at=$3, state='in', last_in_at=$3, break_started_at=NULL, updated_at=NOW()
          WHERE person_id=$1 AND att_date=$2::date`, [r.person_id, today, ret]);
      const who = r.slack_user_id ? `<@${r.slack_user_id}>` : `*${r.display_name}*`;
      await this._operators(`${who}, você esqueceu de bater a volta do almoço. Considerei a volta pela hora que retomou a tarefa. Bate saída e volta na próxima.`);
      await this._admin(`${r.display_name} voltou do almoço sem bater a volta. Volta = início da tarefa (${this._fmtNY(ret)}).`);
      await this._audit('att.forgot_lunch_return_punch', r.person_id, { return_at: ret });
    }
  }

  /** Almoço no SISTEMA já encerrado, mas o relógio não tem batida de SAÍDA nem de
   *  VOLTA perto do almoço real = faltou batida. Aviso 1x/dia pra caprichar.
   *
   *  Bruno 07-27 (caso Ana): NÃO usar janela fixa de relógio (10:00–15:30). O almoço
   *  da Ana foi 15:05→15:43 e ela BATEU a volta 15:43 — mas 15:43 é depois do 15:30,
   *  então a janela fixa não contava a batida e acusava "não bateu a volta". ERRADO.
   *  Agora medimos contra o ALMOÇO REAL do dia: tem batida perto da SAÍDA (±20min do
   *  started_at) E perto da VOLTA (±20min do ended_at)? Se as duas existem, está tudo
   *  certo — não alerta. Só alerta se faltar de verdade uma delas.
   *
   *  Bruno 08-20 (caso Vitor): aqui é SÓ 'lunch', NUNCA 'break'. O Vitor fez uma pausa
   *  de 30min pra descarregar arroz (break 10:52→11:22) e o worker acusou "faltou bater
   *  o ponto no almoço" às 11:52 — ele nem tinha saído pra almoçar ainda. Ninguém bate
   *  ponto pra descarregar caminhão: pausa curta não é almoço e não gera batida. Os
   *  outros usos de LUNCH_SLUGS continuam certos (estado de pausa, fechar na batida de
   *  volta, verificação), este não. */
  async _checkLunchPunchPair(today) {
    const rows = (await this.db.query(
      `WITH lunch AS (
         SELECT e.person_id, MIN(e.started_at) AS lunch_out, MAX(e.ended_at) AS lunch_in
           FROM v3.events e JOIN v3.activity_types at2 ON at2.id = e.activity_type_id
          WHERE e.deleted_at IS NULL AND at2.slug = ANY($2::text[])
            AND (e.started_at AT TIME ZONE '${TZ}')::date = $1::date
            AND e.ended_at IS NOT NULL AND e.ended_at < NOW() - INTERVAL '30 minutes'
          GROUP BY e.person_id )
       SELECT s.person_id, p.display_name, p.slack_user_id, p.clock_code
         FROM v3.att_state s
         JOIN v3.persons p ON p.id = s.person_id
         JOIN lunch l ON l.person_id = s.person_id
        WHERE s.att_date = $1::date AND s.lunch_punch_callout_at IS NULL
          -- tem batida perto da SAÍDA do almoço (±20min)?
          AND NOT (
            EXISTS (SELECT 1 FROM v3.att_punch ap WHERE ap.person_id = s.person_id AND ap.att_date = $1::date
                     AND ap.punch_time BETWEEN l.lunch_out - INTERVAL '20 minutes' AND l.lunch_out + INTERVAL '20 minutes')
            -- E batida perto da VOLTA do almoço (±20min)?
            AND EXISTS (SELECT 1 FROM v3.att_punch ap WHERE ap.person_id = s.person_id AND ap.att_date = $1::date
                     AND ap.punch_time BETWEEN l.lunch_in - INTERVAL '20 minutes' AND l.lunch_in + INTERVAL '20 minutes')
          )`,
      [today, ONLY_LUNCH])).rows;
    for (const r of rows) {
      // GATE: reconfere a verdade viva AGORA (re-puxa NGTeco) antes de acusar.
      const v = await this._verifyClaim({ id: r.person_id, clock_code: r.clock_code, display_name: r.display_name }, today, 'lunch_punch_missing');
      if (!v.ok) { console.log(`[att-sync] lunch_punch_missing ${r.display_name} ABORTADO: ${v.reason}`); continue; }
      await this.db.query(`UPDATE v3.att_state SET lunch_punch_callout_at=NOW(), updated_at=NOW() WHERE person_id=$1 AND att_date=$2::date`, [r.person_id, today]);
      const who = r.slack_user_id ? `<@${r.slack_user_id}>` : `*${r.display_name}*`;
      await this._operators(`${who}, faltou bater o ponto no almoço hoje (saída e volta). Já ajustei aqui, mas capricha na próxima.`);
      await this._audit('att.lunch_punch_missing', r.person_id, {});
    }
  }

  /** 22h+ NY: quem está "aberto" (sem saída no relógio nem no sistema) e SEM
   *  atividade no sistema há 1h30 = óbvio que já foi embora (Bruno: "se for o
   *  Bruno às 10pm você sabe que ele já saiu faz tempo"). Fecha pela última
   *  atividade, marca pra cobrança de amanhã, avisa admin. Se por exceção a
   *  pessoa AINDA estiver trabalhando, a atividade recente bloqueia o sweep. */
  async _nightSweep(today) {
    const nyHour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour12: false, hour: '2-digit' }).format(new Date()), 10);
    if (nyHour < 22) return;
    const rows = (await this.db.query(
      `SELECT s.person_id, p.display_name,
              GREATEST(
                COALESCE((SELECT MAX(os.last_activity_at) FROM v3.operator_sessions os WHERE os.person_id = s.person_id), 'epoch'),
                COALESCE((SELECT MAX(COALESCE(e.ended_at, e.started_at)) FROM v3.events e
                           WHERE e.person_id = s.person_id AND e.deleted_at IS NULL
                             AND (e.started_at AT TIME ZONE '${TZ}')::date = $1::date), 'epoch')
              ) AS last_sys,
              COALESCE((SELECT MAX(ap.punch_time) FROM v3.att_punch ap
                         WHERE ap.person_id = s.person_id AND ap.att_date = $1::date), 'epoch') AS last_punch
         FROM v3.att_state s JOIN v3.persons p ON p.id = s.person_id
        WHERE s.att_date = $1::date AND s.night_swept_at IS NULL
          AND s.checkout_at IS NULL AND s.state IN ('in','break')`,
      [today])).rows;
    for (const r of rows) {
      const lastSys = new Date(r.last_sys).getTime();
      const lastPunch = new Date(r.last_punch).getTime();
      const idleMs = Date.now() - Math.max(lastSys, lastPunch);
      if (idleMs < 90 * 60 * 1000) continue;   // atividade recente → pode estar trabalhando mesmo
      const closeAt = new Date(Math.max(lastSys, lastPunch));
      const closed = await this.db.query(
        `UPDATE v3.events SET ended_at=GREATEST(started_at, $2), closed_reason='night_sweep', updated_at=NOW()
          WHERE person_id=$1 AND ended_at IS NULL AND deleted_at IS NULL RETURNING id`, [r.person_id, closeAt]);
      await this.db.query(`UPDATE v3.operator_sessions SET logged_out_at=$2, logoff_reason='night_sweep' WHERE person_id=$1 AND logged_out_at IS NULL`, [r.person_id, closeAt]);
      await this.db.query(`UPDATE v3.att_state SET night_swept_at=NOW(), checkout_at=$3, state='out', checkout_notified=true, updated_at=NOW() WHERE person_id=$1 AND att_date=$2::date`, [r.person_id, today, closeAt]);
      // agenda a cobrança de amanhã (dia útil, 08:30) — o carolina-forgotten-dm decide
      // o tom: se também não tem batida de saída → versão SÉRIA (forgot_clock_too)
      try {
        await this.db.query(
          `INSERT INTO v3.forgotten_checkouts (person_id, discovered_via, last_activity_at, last_task_description, auto_logout_at, carolina_dm_scheduled_for, resolution)
           VALUES ($1, 'night_sweep', $2, NULL, NOW(),
                   (((CASE EXTRACT(DOW FROM ((NOW() AT TIME ZONE '${TZ}')::date + 1))::int
                        WHEN 6 THEN (NOW() AT TIME ZONE '${TZ}')::date + 3
                        WHEN 0 THEN (NOW() AT TIME ZONE '${TZ}')::date + 2
                        ELSE (NOW() AT TIME ZONE '${TZ}')::date + 1 END) + TIME '08:30') AT TIME ZONE '${TZ}',
                   'auto_logout')`, [r.person_id, closeAt]);
      } catch (e) { console.error('[att-sync] night fc:', e.message); }
      await this._admin(`${r.display_name} ficou sem saída (sistema e relógio). Fechei pela última atividade (${this._fmtNY(closeAt)})${closed.rows.length ? `, ${closed.rows.length} tarefa(s) fechada(s)` : ''}. Cobrança sai amanhã.`);
      await this._audit('att.night_sweep', r.person_id, { closed_at: closeAt, events: closed.rows.map((x) => x.id) });
    }
  }

  /** DIA SEGUINTE: quem no dia ANTERIOR não bateu a SAÍDA no relógio (nº ímpar de
   *  batidas / sem checkout) leva um aviso GRAVE no grupo — SEM mencionar horário,
   *  só que esqueceu de bater a saída e que estou notificando pra corrigir o
   *  clock-out. (Bruno 07-23: erro de ponto causa problemas, cobrança séria.)
   *  Roda de manhã (7h-11h NY), 1x por pessoa/dia. */
  async _alertMissedClockout(today) {
    const nyHour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour12: false, hour: '2-digit' }).format(new Date()), 10);
    if (nyHour < 7 || nyHour >= 11) return;   // só de manhã
    const rows = (await this.db.query(
      `SELECT s.person_id, p.display_name, p.slack_user_id, p.clock_code
         FROM v3.att_state s JOIN v3.persons p ON p.id = s.person_id
        WHERE s.att_date = (($1::date) - 1)              -- ONTEM
          AND s.checkout_at IS NULL                       -- não bateu saída
          AND s.checkin_at IS NOT NULL                    -- mas veio (bateu entrada)
          AND s.missed_clockout_alerted_at IS NULL        -- ainda não avisei
          -- nº ÍMPAR de batidas = par incompleto (saída faltando)
          AND (SELECT COUNT(*) FROM v3.att_punch ap WHERE ap.person_id = s.person_id AND ap.att_date = (($1::date) - 1)) % 2 = 1`,
      [today])).rows;
    for (const r of rows) {
      // GATE: reconfere ONTEM AGORA — a batida de saída pode ter sincronizado tarde.
      const v = await this._verifyClaim({ id: r.person_id, clock_code: r.clock_code, display_name: r.display_name }, today, 'missed_clockout');
      if (!v.ok) { console.log(`[att-sync] missed_clockout ${r.display_name} ABORTADO: ${v.reason}`); continue; }
      await this.db.query(`UPDATE v3.att_state SET missed_clockout_alerted_at = NOW() WHERE person_id=$1 AND att_date=(($2::date)-1)`, [r.person_id, today]);
      const who = r.slack_user_id ? `<@${r.slack_user_id}>` : `*${r.display_name}*`;
      // SEM horário. Grave. Aviso que estou notificando pra consertar o clock-out.
      await this._operators(
        `:rotating_light: ${who}, ontem você não bateu a saída no relógio. Isso é sério (folha, horas). Vou pedir pra corrigirem. Não esqueça de bater a saída ao ir embora.`);
      // admin recebe COM o horário pra poder corrigir (interno)
      await this._admin(
        `:rotating_light: ${r.display_name} não bateu a saída ontem. Corrijam o clock-out dela no NGTeco. (Avisei no grupo, sem horário.)`);
      await this._audit('att.missed_clockout_alert', r.person_id, { for_date: 'yesterday' });
    }
  }

  /** Relógio offline = ponto parado sem ninguém saber → alerta no admin (só na
   *  transição on→off e off→on; checa a cada 5min). */
  async _checkDevice() {
    if (Date.now() - this._devCheckAt < 5 * 60 * 1000) return;
    this._devCheckAt = Date.now();
    try {
      const devs = await this.ngteco.devices();
      if (!Array.isArray(devs) || !devs.length) return;
      // status do NGTeco: campo varia (status/is_online/state) — considera online
      // se QUALQUER indicador disser online; offline só com indicação explícita.
      const off = devs.filter((d) => {
        const s = String(d.status != null ? d.status : (d.is_online != null ? d.is_online : d.state || '')).toLowerCase();
        return /off|false|0|inactive|disconnect/.test(s) && !/on|true|1|active|connect/.test(s.replace(/off\w*/g, ''));
      });
      const isOff = off.length === devs.length;   // TODOS offline = relógio caiu
      if (isOff && !this._devOffline) {
        this._devOffline = true;
        await this._admin(':rotating_light: Relógio de ponto (NG-TC2) OFFLINE, as batidas não estão chegando. Confiram energia/WiFi.');
      } else if (!isOff && this._devOffline) {
        this._devOffline = false;
        await this._admin('Relógio de ponto (NG-TC2) voltou a ficar online.');
      }
    } catch (e) { /* API fora ≠ relógio fora — não alerta por erro de API */ }
  }

  async _syncPerson(person, today, rec, punches) {
    // upsert das batidas (ordem = seq). ON CONFLICT ignora as já vistas.
    let inserted = [];
    for (let i = 0; i < punches.length; i++) {
      const p = punches[i];
      const pd = this._punchDate(rec.att_date || today, p.punch_time);
      if (!pd) continue;
      const isLocal = pd && pd.nyLocal;
      const ins = await this.db.query(
        `INSERT INTO v3.att_punch (person_id, employee_code, att_date, punch_time, seq, status, raw)
         VALUES ($1, $2, $3::date, ${isLocal ? `($4::timestamp AT TIME ZONE '${TZ}')` : '$4::timestamptz'}, $5, $6, $7::jsonb)
         ON CONFLICT (employee_code, punch_time) DO NOTHING
         RETURNING id, punch_time`,
        [person.id, this._norm(rec.employee_code), rec.att_date || today,
          isLocal ? pd.nyLocal : pd.toISOString(), i + 1, p.status != null ? String(p.status) : null,
          JSON.stringify(p)]);
      if (ins.rows[0]) {
        inserted.push(ins.rows[0]);
        // ESTUDO DO NGTeco (Bruno 07-28): mede quanto tempo a batida levou pra chegar
        // (bateu no relógio → apareceu pra nós). Só observa, NÃO muda regra nenhuma.
        // Em alguns dias revisamos o padrão do atraso (é pior de manhã? tem motivo?).
        try {
          const pt = new Date(ins.rows[0].punch_time);
          const delaySec = Math.round((Date.now() - pt.getTime()) / 1000);
          const nyHour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour12: false, hour: '2-digit' }).format(pt), 10);
          // só grava atrasos plausíveis (>=0 e < 24h; ignora re-import de dias antigos)
          if (delaySec >= 0 && delaySec < 24 * 3600) {
            await this.db.query(
              `INSERT INTO v3.ngteco_sync_study (person_id, person_name, employee_code, punch_time, delay_sec, ny_hour)
               VALUES ($1,$2,$3,$4,$5,$6)`,
              [person.id, person.display_name, this._norm(rec.employee_code), pt.toISOString(), delaySec, nyHour]);
          }
        } catch (_) { /* estudo é best-effort, nunca derruba o sync */ }
      }
    }

    // estado do dia
    const st = (await this.db.query(
      `SELECT * FROM v3.att_state WHERE person_id=$1 AND att_date=$2::date`, [person.id, today])).rows[0] || null;
    const all = (await this.db.query(
      `SELECT punch_time FROM v3.att_punch WHERE person_id=$1 AND att_date=$2::date ORDER BY punch_time`,
      [person.id, today])).rows;
    if (!all.length) return;
    const known = st ? st.punches_count : 0;
    if (all.length === known && st) return;   // nada novo

    // reprocessa a sequência inteira do dia (idempotente e simples de raciocinar)
    let state = 'out', checkinAt = null, checkoutAt = null, breakStart = null, lastInAt = null;
    // ÂNCORA (caso Simone 07-22): se a entrada já foi registrada manualmente
    // (esqueceu a batida da manhã → entrada = início da 1ª tarefa), a paridade
    // muda — a 1ª batida do dia NÃO é entrada, é a saída pro almoço. Começa "in".
    if (st && st.noclockin_callout_at && st.checkin_at && all.length
        && new Date(st.checkin_at) < new Date(all[0].punch_time)) {
      state = 'in'; checkinAt = new Date(st.checkin_at); lastInAt = checkinAt;
    }
    // âncora de VOLTA manual (esqueceu de bater a volta do almoço; a volta = início
    // da tarefa no sistema — registrada pelo _checkForgotLunchPunch)
    const manualReturnAt = st && st.manual_return_at ? new Date(st.manual_return_at) : null;
    for (const row of all) {
      const t = new Date(row.punch_time);
      // aplica a volta manual ANTES de classificar uma batida posterior a ela
      if (state === 'break' && manualReturnAt && manualReturnAt > (breakStart || 0) && t > manualReturnAt) {
        state = 'in'; lastInAt = manualReturnAt; breakStart = null;
      }
      const mins = this._nyMinutes(t);
      const isEvening = mins >= CHECKOUT_MIN;          // 17:00+ NY = saída do dia (Bruno 08-01)
      if (state === 'out' && !checkinAt) {            // 1ª batida = chegou
        state = 'in'; checkinAt = t; lastInAt = t;
      } else if (state === 'in') {                    // batida com a pessoa "dentro" = saída (almoço ou dia)
        const openLunch = await this._openLunchEvent(person.id);
        // almoço SÓ na janela de almoço (10:00–15:30) e nunca à noite. Batida noturna
        // = checkout, ponto final. (Vitor: bateu 18:36 estando "in" → é saída, não almoço.)
        if (!isEvening && (openLunch || (mins >= LUNCH_WIN.from && mins <= LUNCH_WIN.to))) {
          state = 'break'; breakStart = t;            // almoço/pausa (interno)
        } else {
          state = 'out'; checkoutAt = t;              // saída do dia
        }
      } else {                                        // estava fora/break e bateu = voltou OU saiu
        // REGRA CHAVE (Bruno 08-01): uma batida à noite NÃO é "volta do almoço" — é a
        // SAÍDA. Almoço não dura 6h. Se estava em break e bate 18:36, ele FECHOU o
        // almoço mais cedo (pelo /op) e agora está indo embora → checkout, não volta.
        if (isEvening) {
          state = 'out'; checkoutAt = t;              // saída do dia (fim), não reabre
        } else {
          state = 'in'; lastInAt = t; breakStart = null;
          if (checkoutAt) checkoutAt = null;          // voltou de dia (cedo) → reabre
        }
      }
    }
    // volta manual depois da última batida (sem batida posterior ainda)
    if (state === 'break' && manualReturnAt && manualReturnAt > (breakStart || 0)) {
      state = 'in'; lastInAt = manualReturnAt; breakStart = null;
    }

    await this.db.query(
      `INSERT INTO v3.att_state (person_id, att_date, checkin_at, checkout_at, state, break_started_at, punches_count, last_in_at, updated_at)
       VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (person_id, att_date) DO UPDATE SET
         -- checkin: mantém o MAIS CEDO — se um admin registrou entrada manual (ex.:
         -- "esqueceu a batida da manhã, entrada = início da 1ª tarefa"), a 1ª batida
         -- da tarde NÃO pode sobrescrever (caso Simone 07-22)
         checkin_at=LEAST(COALESCE(v3.att_state.checkin_at, EXCLUDED.checkin_at), EXCLUDED.checkin_at),
         checkout_at=EXCLUDED.checkout_at, state=EXCLUDED.state,
         break_started_at=EXCLUDED.break_started_at, punches_count=EXCLUDED.punches_count,
         last_in_at=EXCLUDED.last_in_at, updated_at=NOW()`,
      [person.id, today, checkinAt, checkoutAt, state, breakStart, all.length, lastInAt]);

    // ── NOTIFICAÇÕES (só admin) + ações derivadas ──
    const st2 = (await this.db.query(
      `SELECT * FROM v3.att_state WHERE person_id=$1 AND att_date=$2::date`, [person.id, today])).rows[0];

    // chegada (1ª batida) — 1x. Bruno 07-28 (caso Ana): NÃO anuncia chegada com hora
    // VELHA. A batida da Ana chegou ~6h atrasada e o sistema postou "bateu às 08:11"
    // às 14:27 (ruído no admin). Só anuncia se o check-in é RECENTE (a chegada real foi
    // há < 30min); senão marca notified em silêncio (dado histórico já passou).
    if (checkinAt && !st2.checkin_notified) {
      await this.db.query(`UPDATE v3.att_state SET checkin_notified=true WHERE person_id=$1 AND att_date=$2::date`, [person.id, today]);
      const freshCheckin = (Date.now() - new Date(checkinAt).getTime()) < 30 * 60 * 1000;
      if (freshCheckin) {
        await this._admin(`${person.display_name} bateu o ponto às ${this._fmtNY(checkinAt)} e começou o dia.`);
      } else {
        console.log(`[att-sync] checkin de ${person.display_name} (${this._fmtNY(checkinAt)}) já é velho — marco notified sem anunciar (batida chegou atrasada)`);
      }
      await this._audit('att.checkin', person.id, { at: checkinAt, announced: freshCheckin });
    }

    // volta do almoço: fecha o almoço aberto no sistema na hora da batida
    if (state === 'in' && lastInAt && checkinAt && lastInAt.getTime() !== checkinAt.getTime()) {
      const closed = await this.db.query(
        `UPDATE v3.events e SET ended_at=$2, closed_reason='clock_back_in', updated_at=NOW()
          FROM v3.activity_types at
         WHERE at.id = e.activity_type_id AND e.person_id=$1 AND e.ended_at IS NULL AND e.deleted_at IS NULL
           AND at.slug = ANY($3::text[]) AND e.started_at < $2
         RETURNING e.id`,
        [person.id, lastInAt, LUNCH_SLUGS]);
      if (closed.rows.length) {
        await this._admin(`${person.display_name} voltou do almoço às ${this._fmtNY(lastInAt)}. Fechei o almoço no sistema.`);
        await this._audit('att.lunch_closed_by_clock', person.id, { at: lastInAt, events: closed.rows.map((r) => r.id) });
      }
    }

    // saída do dia — 1x: admin + fecha tasks (não-máquina) e sessões na hora da batida
    if (checkoutAt && !st2.checkout_notified) {
      await this.db.query(`UPDATE v3.att_state SET checkout_notified=true WHERE person_id=$1 AND att_date=$2::date`, [person.id, today]);
      const closed = await this.db.query(
        `UPDATE v3.events SET ended_at=GREATEST(started_at, $2), closed_reason='clock_out', updated_at=NOW()
         WHERE person_id=$1 AND ended_at IS NULL AND deleted_at IS NULL AND is_long_running = false
         RETURNING id`, [person.id, checkoutAt]);
      await this.db.query(
        `UPDATE v3.operator_sessions SET logged_out_at=$2, logoff_reason='clock_out'
         WHERE person_id=$1 AND logged_out_at IS NULL`, [person.id, checkoutAt]);
      await this._admin(`${person.display_name} bateu a saída às ${this._fmtNY(checkoutAt)}.`
        + (closed.rows.length ? ` Fechei ${closed.rows.length} tarefa(s).` : ''));
      await this._audit('att.checkout', person.id, { at: checkoutAt, closed_events: closed.rows.map((r) => r.id) });
    } else if (!checkoutAt && st2.checkout_notified) {
      // tinha saído e voltou (batida nova) — reabre o dia
      await this.db.query(`UPDATE v3.att_state SET checkout_notified=false WHERE person_id=$1 AND att_date=$2::date`, [person.id, today]);
      await this._admin(`${person.display_name} bateu o ponto de novo depois da saída. Considerei que voltou.`);
    }
  }

  async _openLunchEvent(personId) {
    const r = await this.db.query(
      `SELECT e.id FROM v3.events e JOIN v3.activity_types at ON at.id=e.activity_type_id
        WHERE e.person_id=$1 AND e.ended_at IS NULL AND e.deleted_at IS NULL AND at.slug = ANY($2::text[]) LIMIT 1`,
      [personId, LUNCH_SLUGS]);
    return r.rows[0] || null;
  }

  /** Bateu o ponto (chegou/voltou) e não registrou tarefa em 15min → cobra no canal
   *  dos operadores (SEM horários — regra: horário do relógio é interno). */
  async _checkNudges(byCode, today) {
    const rows = (await this.db.query(
      `SELECT s.person_id, p.display_name, p.slack_user_id, s.last_in_at, s.nudged_no_task_at
         FROM v3.att_state s JOIN v3.persons p ON p.id = s.person_id
        WHERE s.att_date = $1::date AND s.state = 'in' AND s.last_in_at IS NOT NULL
          AND s.last_in_at < NOW() - INTERVAL '${NUDGE_MIN} minutes'
          AND (s.nudged_no_task_at IS NULL OR s.nudged_no_task_at < s.last_in_at)
          AND NOT EXISTS (SELECT 1 FROM v3.events e WHERE e.person_id = s.person_id AND e.deleted_at IS NULL
                           AND (e.ended_at IS NULL OR e.started_at >= s.last_in_at))`,
      [today])).rows;
    for (const r of rows) {
      await this.db.query(`UPDATE v3.att_state SET nudged_no_task_at=NOW() WHERE person_id=$1 AND att_date=$2::date`, [r.person_id, today]);
      const who = r.slack_user_id ? `<@${r.slack_user_id}>` : `*${r.display_name}*`;
      await this._operators(`${who} chegou e ainda não registrou tarefa. Registra aí assim que puder.`);
      await this._audit('att.nudge_no_task', r.person_id, {});
    }
  }

  /** Começou tarefa no sistema mas NÃO bateu o ponto → chama atenção (1x/dia) e
   *  considera o início da 1ª tarefa como chegada (interno). Cobre também o caso
   *  Simone 07-22: SÓ bateu à tarde (nenhuma batida até 1h depois da 1ª tarefa) —
   *  esqueceu a batida da manhã mesmo tendo batidas mais tarde. */
  async _checkNoClockin(byCode, today) {
    const rows = (await this.db.query(
      `SELECT p.id, p.display_name, p.slack_user_id, p.clock_code, MIN(e.started_at) AS first_task
         FROM v3.persons p
         JOIN v3.events e ON e.person_id = p.id AND e.deleted_at IS NULL
          AND (e.started_at AT TIME ZONE '${TZ}')::date = $1::date
          AND e.source NOT IN ('ems_auto')
        WHERE p.clock_code IS NOT NULL AND p.clock_code <> '' AND p.active = true AND p.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM v3.att_state s WHERE s.person_id = p.id AND s.att_date = $1::date
                           AND s.noclockin_callout_at IS NOT NULL)
        GROUP BY p.id, p.display_name, p.slack_user_id
       HAVING MIN(e.started_at) < NOW() - INTERVAL '${NOCLOCK_GRACE_MIN} minutes'
          -- nenhuma batida ANTES de (1ª tarefa + 1h) = a entrada não foi batida
          AND NOT EXISTS (SELECT 1 FROM v3.att_punch ap WHERE ap.person_id = p.id AND ap.att_date = $1::date
                           AND ap.punch_time <= MIN(e.started_at) + INTERVAL '60 minutes')`,
      [today])).rows;
    for (const r of rows) {
      // GATE (Bruno 07-28, caso Ana): reconfere a batida AO VIVO no NGTeco antes de
      // acusar. Se a batida da manhã chegou (mesmo atrasada), NÃO cobra "esqueceu o ponto".
      const v = await this._verifyClaim({ id: r.id, clock_code: r.clock_code, display_name: r.display_name }, today, 'no_clockin');
      if (!v.ok) { console.log(`[att-sync] no_clockin ${r.display_name} ABORTADO: ${v.reason}`); continue; }
      // âncora interna (início da 1ª tarefa = chegada) — sempre grava, é dado do dia.
      await this.db.query(
        `INSERT INTO v3.att_state (person_id, att_date, state, checkin_at, last_in_at, noclockin_callout_at, updated_at)
         VALUES ($1, $2::date, 'in', $3, $3, NOW(), NOW())
         ON CONFLICT (person_id, att_date) DO UPDATE SET noclockin_callout_at=NOW(), updated_at=NOW()`,
        [r.id, today, r.first_task]);
      // Bruno 07-28: NÃO cobra o operador direto. PERGUNTA no admin-orin se pode cobrar;
      // só cobra no grupo se um admin REAGIR ✅ (processado em events-v2). Dá controle
      // à gestão e evita constranger quem talvez tenha um problema de relógio (caso Ana).
      const msgTs = await this._admin(
        `:warning: ${r.display_name} está trabalhando sem bater o ponto hoje (confirmei no NGTeco). ` +
        `Reaja :white_check_mark: pra eu cobrar no grupo, ou confiram o relógio dela.`);
      if (msgTs) {
        try {
          await this.db.query(
            `INSERT INTO v3.notifications (type, payload, status) VALUES ('noclockin_ask', $1::jsonb, 'pending')`,
            [JSON.stringify({ msg_ts: msgTs, person_id: r.id, display_name: r.display_name, slack_user_id: r.slack_user_id || null })]);
        } catch (_) {}
      }
      await this._audit('att.no_clockin_ask', r.id, { first_task: r.first_task, msg_ts: msgTs });
    }
  }

  async _audit(action, personId, meta) {
    try {
      await this.db.query(
        `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
         VALUES ('system', NULL, $1, 'person', $2, $3::jsonb)`, [action, personId, JSON.stringify(meta || {})]);
    } catch (_) { /* best-effort */ }
  }
}

module.exports = { AttendanceSync };
