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
const { isMuted } = require('../v3/alert-gate');
const { onDemandActive, getPlan } = require('../v3/workday');
// Tarefas que NÃO contam como "operador trabalhando" (limpeza / pausa / fim de dia).
const NON_WORK_SLUGS = "('cleaning','cleaning_other','break','lunch','end_of_day')";

/** Esse nome de máquina é a ENCAPSULADORA? Insensível a acento e maiúscula, pra
 *  casar tanto "Capsule Dispensing Machine" (v3.camera_zones id 4 e 6) quanto
 *  "Encapsuladora" ou "encapsulação". Bruno 08-25. */
function isEncapName(name) {
  if (!name) return false;
  const n = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return /encapsul|capsul/.test(n);
}

class EncapMonitor {
  constructor(deps = {}) {
    this.db = deps.db;
    this.slack = deps.slack || null; // { postAs }
    this.channelId = deps.channelId; // canal dos operadores
    this.adminChannelId = deps.adminChannelId || 'C0B36DR5MP1'; // admin-orin (pergunta antes de auto-registrar)
    this.fs = deps.fs || null;                                  // só existe na máquina que tem o G: (dossiê)
    // idade máx do sinal da câmera pra confiar nele (o .28 faz push ~30s; 3min = folga)
    this.cameraMaxAgeMs = deps.cameraMaxAgeMs || 3 * 60 * 1000;
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
    // hora NY atual + dia ativo + JANELA DA ESCALA de hoje (Bruno 07-06: "segue o
    // horário de trabalho pra não gritar com a parede"). A janela sai da
    // v3.operator_schedules do dia da semana atual — do 1º início ao último fim
    // dos operadores escalados. Sem escala pra hoje (folga) → não alerta. Sem
    // NENHUMA escala cadastrada → cai no fallback fixo startHour–endHour.
    const env = (await this.db.query(
      `SELECT EXTRACT(HOUR FROM (NOW() AT TIME ZONE '${EDT}'))::int AS h,
              to_char(NOW() AT TIME ZONE '${EDT}', 'HH24:MI') AS now_t,
              (NOW() AT TIME ZONE '${EDT}')::time AS now_time,
              (SELECT COUNT(*) FROM v3.operator_schedules)::int AS sched_total,
              (SELECT MIN(expected_start_time) FROM v3.operator_schedules
                 WHERE is_workday = true AND expected_start_time IS NOT NULL
                   AND day_of_week = EXTRACT(DOW FROM (NOW() AT TIME ZONE '${EDT}'))::int) AS sched_start,
              (SELECT MAX(expected_end_time) FROM v3.operator_schedules
                 WHERE is_workday = true AND expected_end_time IS NOT NULL
                   AND day_of_week = EXTRACT(DOW FROM (NOW() AT TIME ZONE '${EDT}'))::int) AS sched_end,
              EXISTS (SELECT 1 FROM v3.events e WHERE e.deleted_at IS NULL AND COALESCE(e.is_test,false) = false
                      AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date) AS factory_active,
              to_char((SELECT MIN(e2.started_at) FROM v3.events e2 WHERE e2.deleted_at IS NULL AND COALESCE(e2.is_test,false) = false
                       AND (e2.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date)
                      AT TIME ZONE '${EDT}', 'HH24:MI') AS first_ev`)).rows[0];
    if (!env.factory_active) return null;
    // JANELA (Bruno 07-10 "por que berrando depois das 8pm?"): a escala pode
    // ESTREITAR a janela (alguém começa mais tarde / termina antes), mas NUNCA a
    // ESTENDE além do teto fixo startHour–endHour. Antes o MAX(fim) da escala
    // (Bruno Sarmento até 20:30) empurrava o alarme da cápsula pra depois das
    // 8pm — a máquina já tava parada desde ~16h (todo mundo na limpeza/fim de
    // dia) e mesmo assim gritava 17h→20h. Agora o teto é endHour (20h).
    const toMin = (t) => { if (!t) return null; const m = /^(\d{1,2}):(\d{2})/.exec(String(t)); return m ? (Number(m[1]) * 60 + Number(m[2])) : null; };
    const nowMin = toMin(env.now_time);
    let winS = this.startHour * 60, winE = this.endHour * 60;
    if (env.sched_total > 0 && !env.sched_start) {
      // dia SEM escala fixa (sáb/dom/folga): DORME, a não ser que o modo sob demanda
      // esteja LIGADO (alguém trabalhando / admin anunciou). Aí usa o teto do plano
      // do dia (horário de saída) se houver. (Bruno 07-11)
      if (!(await onDemandActive(this.db))) return null;
      const plan = await getPlan(this.db);
      const pe = plan && plan.end ? toMin(plan.end) : null;
      if (pe != null) winE = Math.min(winE, pe);
      // INÍCIO do dia sob demanda = plano.start OU 1ª atividade de hoje (NÃO 8am
      // fixo) — senão num sábado que começa 13h o alarme dizia "parada desde 08:00".
      const ps = plan && plan.start ? toMin(plan.start) : null;
      const eff = ps != null ? ps : toMin(env.first_ev);
      if (eff != null) winS = Math.max(winS, eff);
    } else if (env.sched_total > 0) {
      const ss = toMin(env.sched_start), se = toMin(env.sched_end);
      if (ss != null) winS = Math.max(winS, ss);
      if (se != null) winE = Math.min(winE, se);                           // escala só ESTREITA
    }
    if (nowMin == null || nowMin < winS || nowMin >= winE) return null;    // fora do expediente (teto 8pm)
    // intervalos de encapsulação de hoje (clampados na janela 8h–agora)
    const ivs = (await this.db.query(
      `SELECT GREATEST(e.started_at, ((NOW() AT TIME ZONE '${EDT}')::date + INTERVAL '${winS} minutes') AT TIME ZONE '${EDT}') AS s,
              LEAST(COALESCE(e.ended_at, NOW()), NOW()) AS en,
              (e.ended_at IS NULL) AS open
         FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
        WHERE at.slug = 'encapsulation' AND e.deleted_at IS NULL AND COALESCE(e.is_test,false) = false
          AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
        ORDER BY e.started_at`)).rows;
    if (ivs.some((x) => x.open)) return null; // máquina rodando AGORA → tudo certo
    // off desde: fim da última encapsulação (ou 8h, se nenhuma hoje)
    const boundsRow = (await this.db.query(
      `SELECT (((NOW() AT TIME ZONE '${EDT}')::date + INTERVAL '${winS} minutes') AT TIME ZONE '${EDT}') AS win_start, NOW() AS now`)).rows[0];
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

  /** Existe um OPERADOR DE MÁQUINA (is_machine_operator) presente com uma task
   *  ABERTA que não é limpeza/pausa? = alguém que pode rodar a cápsula está aqui
   *  e trabalhando, mas a máquina está parada. (Ocioso não conta — Bruno 07-11.) */
  async _machineOperatorWorking() {
    const r = await this.db.query(
      `SELECT EXISTS (
         SELECT 1 FROM v3.events e
           JOIN v3.activity_types at ON at.id = e.activity_type_id
           JOIN v3.persons p ON p.id = e.person_id
          WHERE p.is_machine_operator = true AND p.active = true AND p.deleted_at IS NULL
            AND e.ended_at IS NULL AND e.deleted_at IS NULL AND COALESCE(e.is_test,false) = false
            AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
            AND e.source <> 'ems_auto'  -- Bruno 07-18: task auto do EMS não prova presença
            AND at.slug NOT IN ${NON_WORK_SLUGS}
       ) AS working`);
    return !!(r.rows[0] && r.rows[0].working);
  }

  async _alertedRecently() {
    const r = await this.db.query(
      `SELECT 1 FROM v3.audit_log WHERE action = 'encap_off_alert' AND created_at > NOW() - INTERVAL '${this.repeatMin - 5} minutes' LIMIT 1`);
    return r.rowCount > 0;
  }

  /** A CÂMERA (machinemon .28) diz que a ENCAPSULADORA está SE MEXENDO agora?
   *  Sinal vem por push em v3.settings 'machine_state'. RULE #1: cruza câmera ↔ eventos
   *  antes de gritar "parada".
   *
   *  BUG CONSERTADO (Bruno 08-25): antes isto era `machines.some(m => m.moving || m.running)`.
   *  QUALQUER máquina se mexendo calava o alarme DA CÁPSULA. Na prática o último
   *  payload real do .28 só trazia { name:'Production Line', moving:true } — a linha
   *  de produção rodando calava o alerta da encapsuladora, que podia estar parada
   *  de verdade. Agora casa a ENCAPSULADORA pelo nome (sem acento, /encapsul|capsul/),
   *  e quando ela NÃO aparece no payload isso é 'não sei' (matched:false), não
   *  'está rodando'.
   *
   *  Retorna { moving, fresh, at, matched, machines }:
   *    fresh=false   → sinal velho/ausente: não bloqueia o alarme (não sabemos)
   *    matched=false → sinal fresco mas SEM a encapsuladora: também não bloqueia,
   *                    e o tick abre o incidente camera_no_encap_zone (é a fresta
   *                    invisível que gerou este bug). */
  async _cameraSaysMoving() {
    try {
      const r = await this.db.query("SELECT value FROM v3.settings WHERE key='machine_state'");
      const v = r.rows[0] && r.rows[0].value;
      if (!v || !v.at) return { moving: false, fresh: false, at: null, matched: false, machines: [] };
      const ageMs = Date.now() - new Date(v.at).getTime();
      const machines = Array.isArray(v.machines) ? v.machines : [];
      if (ageMs > this.cameraMaxAgeMs) return { moving: false, fresh: false, at: v.at, matched: false, machines };
      const hit = machines.find((m) => m && isEncapName(m.name));
      if (!hit) return { moving: false, fresh: true, at: v.at, matched: false, machines };
      return {
        moving: hit.moving === true || hit.running === true,
        fresh: true, at: v.at, matched: true, machine: hit, machines,
      };
    } catch (_) { return { moving: false, fresh: false, at: null, matched: false, machines: [] }; }
  }

  /** Nomes de máquina que a câmera CONHECE como encapsuladora (v3.camera_zones,
   *  kind='machine'). Só pro dossiê do incidente: mostra que a zona existe no
   *  cadastro mas não aparece no payload. */
  async _encapZones() {
    try {
      const r = await this.db.query(
        "SELECT id, cam, name, kind FROM v3.camera_zones WHERE kind = 'machine'");
      return (r.rows || []).filter((z) => isEncapName(z.name));
    } catch (_) { return []; }
  }

  /** Sinal de câmera fresco mas SEM a encapsuladora: abre incidente 1x por dia NY.
   *  Passa pelo mesmo pipeline do watchdog (dossiê no Obsidian + 1 linha no
   *  admin-orin), porque essa é a falha silenciosa que ninguém vê acontecer. */
  async _noEncapZoneIncident(cam) {
    const date = new Date().toLocaleDateString('en-CA', { timeZone: EDT });
    try {
      const seen = await this.db.query(
        `SELECT 1 FROM v3.audit_log
          WHERE action = 'signal_incident'
            AND metadata->>'signal' = 'camera_no_encap_zone'
            AND metadata->>'ny_date' = $1 LIMIT 1`, [date]);
      if ((seen.rowCount || 0) > 0) return false;
    } catch (_) { return false; }

    const zones = await this._encapZones();
    const nomes = (cam.machines || []).map((m) => (m && m.name) || '?');
    try {
      const { openIncident } = require('../v3/health/incident');
      const res = await openIncident(
        { db: this.db, slack: this.slack, channelId: this.adminChannelId, fs: this.fs || null },
        {
          code: 'camera_no_encap_zone',
          title: 'Câmera não manda a encapsuladora',
          oneLine: `A câmera do .28 está mandando sinal, mas a encapsuladora não vem dentro dele. Só chegou: ${nomes.join(', ') || 'nada'}.`,
          detail: { cam_at: cam.at, machines: cam.machines, zonas_cadastradas: zones },
          fix_hint: 'No .28, conferir quais zonas o machinemon está publicando. A encapsuladora está cadastrada em v3.camera_zones mas não aparece no payload.',
          dossier: {
            o_que_aconteceu: 'O machinemon do .28 está vivo e mandando estado de máquina, mas a encapsuladora não aparece na lista. Sem ela, o cruzamento câmera contra eventos nunca consegue confirmar se a cápsula está rodando.',
            desde: cam.at ? String(cam.at) : 'desconhecido',
            esperado: 'Uma entrada de máquina com nome de encapsuladora (Capsule Dispensing Machine) dentro de machines[].',
            observado: `Payload fresco de ${cam.at}, com as máquinas: ${nomes.join(', ') || 'nenhuma'}.`,
            afeta: [
              'O alarme da encapsulação fica cego: não consegue distinguir máquina parada de tarefa não registrada.',
              'A linha de produção rodando não pode mais ser usada como prova de que a cápsula roda (e nem devia ser).',
            ],
            dados_crus: { payload_machines: cam.machines, camera_zones_encap: zones, cam_at: cam.at },
          },
        });
      await this.db.query(
        `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
         VALUES ('system', NULL, 'signal_incident', 'signal', NULL, $1::jsonb)`,
        [JSON.stringify({ signal: 'camera_no_encap_zone', ny_date: date, incident_id: res.id })]).catch(() => {});
      return true;
    } catch (e) { console.error('[encap] incidente no-encap-zone falhou:', e.message); return false; }
  }

  async _adminAsk(text) {
    if (!this.slack || !this.slack.postAs || !this.adminChannelId) return;
    try {
      await this.slack.postAs({ channel: this.adminChannelId, sender: { name: 'HealthFare Tracker', icon: ':camera:' }, thread_ts: null, unfurl_links: false, unfurl_media: false, text });
    } catch (e) { console.error('[encap] admin ask falhou:', e.message); }
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
      // "Máquina parada" só importa se TEM UM OPERADOR DE MÁQUINA presente E
      // TRABALHANDO (Bruno 07-10/11). Só Vitor/Bruno (is_machine_operator, futuro=só
      // marcar a flag) rodam a cápsula. Se o operador está OCIOSO, na LIMPEZA, em
      // PAUSA ou AUSENTE — ou se só tem não-operador (Simone/Ana) por aqui — a
      // parada é esperada → silêncio. Sexta a máquina desliga ~17h pra limpeza →
      // operadores entram em limpeza → cai aqui em silêncio automático.
      if (!(await this._machineOperatorWorking())) return { off: true, no_operator_working: true };
      const fmt = (m) => (m >= 60 ? Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') : m + 'min');
      // CRUZA COM A CÂMERA (Bruno 08-03, RULE #1): antes de gritar "parada" pros
      // operadores, confere se a câmera vê a máquina SE MEXENDO. Se vê → NÃO é parada,
      // é evento não-registrado. NÃO manda o alarme falso pro operador; pergunta no
      // admin-orin (1x por hora, dedupe próprio) pra Bruno confirmar quem está
      // encapsulando. (RULE #0 — auto-registrar — fica pra quando o sinal for 100%.)
      const cam = await this._cameraSaysMoving();
      // FRESTA INVISÍVEL (Bruno 08-25): sinal CHEGANDO, mas sem a encapsuladora
      // dentro dele. Era exatamente esse o caso — o último payload real do .28 só
      // trazia { name:'Production Line' }, então nem com sinal vivo a supressão
      // conseguiria casar a máquina certa. Isso NÃO cala o alarme (não sabemos se
      // ela roda), mas vira incidente 1x por dia pra alguém consertar o machinemon.
      if (cam.fresh && !cam.matched) {
        await this._noEncapZoneIncident(cam);
      }
      if (cam.fresh && cam.matched && cam.moving) {
        if (!(await this._alertedRecently())) {   // reusa o dedupe horário
          await this._adminAsk(
            `:camera: Câmera mostra a encapsulação rodando, mas ninguém registrou tarefa há ${fmt(st.off_min)}. Quem tá encapsulando? Confirma aqui que eu ajusto. (Não avisei os operadores pra não dar alarme falso.)`);
          try {
            await this.db.query(
              `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
               VALUES ('system', NULL, 'encap_off_alert', 'system', 0, $1::jsonb)`,
              [JSON.stringify({ suppressed: true, reason: 'camera_says_moving', off_min: st.off_min, cam_at: cam.at })]);
          } catch (_) {}
        }
        return { off: true, camera_moving: true, asked_admin: true };
      }
      if (await this._alertedRecently()) return { off: true, deduped: true };
      // CÂMERA CEGA na hora de gritar (Bruno 08-25): se o sinal está velho, o
      // motivo tem que ficar VISÍVEL no momento, no canal do ADMIN (não no do
      // operador, que não tem o que fazer com isso). Foi a falta disso que deixou
      // 42h de sinal morto passarem despercebidas.
      if (!cam.fresh) {
        const desdeT = cam.at
          ? new Date(cam.at).toLocaleString('pt-BR', { timeZone: EDT, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
          : 'nunca';
        await this._adminAsk(
          `:camera: Vou avisar os operadores que ninguém registrou encapsulação há ${fmt(st.off_min)}. Aviso que a câmera está cega desde ${desdeT}, então não deu pra confirmar se a máquina está rodando.`);
      }
      if (this.slack && this.slack.postAs && this.channelId) {
        try {
          // ALARME GRANDE de propósito (Bruno 07-06): a fábrica depende da máquina
          // rodando o tempo todo — o lembrete horário e o total acumulado são
          // IMPORTANTES. O que estava errado era só o HORÁRIO (gritar com a parede
          // fora do expediente); isso os gates de expediente + presença resolvem.
          //
          // TEXTO CORRIGIDO (Bruno 08-25): antes dizia "Encapsulação parada há X",
          // afirmando algo que o sistema NÃO SABE. Ele só sabe que ninguém
          // REGISTROU. Com a câmera cega em 23/08 isso virou mentira na cara dos
          // operadores. Agora a frase diz exatamente o que a gente enxerga, e o
          // total do dia também é tempo SEM REGISTRO, não tempo de máquina parada.
          await this.slack.postAs({
            channel: this.channelId,
            sender: { name: 'HealthFare Tracker', icon: ':rotating_light:' },
            thread_ts: null, unfurl_links: false, unfurl_media: false,
            text: `:rotating_light: Nenhuma encapsulação registrada desde as ${st.off_since_t} (${fmt(st.off_min)}). Se a máquina tá rodando, registrem agora. Se tá parada mesmo, tudo certo.\nHoje já são ${fmt(st.total_off_min)} sem registro de encapsulação.`,
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
