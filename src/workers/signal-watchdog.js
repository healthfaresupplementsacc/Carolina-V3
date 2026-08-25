'use strict';
/**
 * HEALTHFARE V4 — WATCHDOG DE SINAIS (Bruno 08-25).
 *
 * "o pc esta ligado sim, checa um jeito disso nunca mais acontecer, se der erro eu
 *  quero que ele alerte vc ou algum webhook (...) temos que fechar todas as
 *  aberturas de esses erros repentinos e sem sentido de acontecer"
 *
 * O CASO QUE ORIGINOU ISTO: o machinemon do .28 parou de mandar em
 * 2026-08-23T23:39:15Z. Ninguém percebeu por 42 horas. O encap-monitor, sem sinal
 * de câmera, liberou o alarme e os operadores levaram "Encapsulação parada há
 * 1h04" com a máquina rodando.
 *
 * O QUE ESTE WORKER FAZ: a cada 5min lê o registro de sinais
 * (src/v3/health/signal-registry.js) e, pra cada sinal VELHO dentro da janela em
 * que ele deveria estar vivo, abre UM incidente por dia NY. Quando o sinal volta,
 * posta UMA linha de recuperação e fecha o incidente.
 *
 * O QUE ELE NÃO FAZ:
 *  - não tenta alcançar o .28 (o servidor não consegue: ARCHITECTURE.md, o .28 é
 *    quem sempre inicia). Só mede AUSÊNCIA;
 *  - não escreve estoque (StockService continua a porta única);
 *  - não posta no canal dos OPERADORES. Incidente vai pro admin-orin: operador
 *    não tem o que fazer com "um push parou de chegar";
 *  - não bloqueia nada (RULE #0).
 *
 * Dedupe: v3.audit_log action 'signal_incident' com metadata.signal + metadata.ny_date
 * (mesmo padrão do stock-drift-alert.js). Sobrevive a redeploy.
 * OPT-IN: WORKER_SIGNAL_WATCHDOG_ENABLED=true.
 */

const { checkAll } = require('../v3/health/signal-registry');
const { openIncident, resolveIncident, nyDate, nyTime } = require('../v3/health/incident');

const ADMIN_CHANNEL = 'C0B36DR5MP1';   // admin-orin

/** "1h04", "3 dias", "42h" — idade em português curto. */
function fmtAge(min) {
  if (min == null) return 'nunca';
  if (min < 60) return min + 'min';
  const h = Math.floor(min / 60);
  if (h < 48) return h + 'h' + String(min % 60).padStart(2, '0');
  return Math.floor(h / 24) + ' dias';
}

class SignalWatchdog {
  /**
   * @param {object} deps
   *   deps.db          pool pg
   *   deps.slack       { postAs }
   *   deps.channelId   admin-orin (NUNCA o canal dos operadores)
   *   deps.fs          fs opcional (só existe na máquina que tem o G:)
   *   deps.now         () => Date (testes)
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this.slack = deps.slack || null;
    this.channelId = deps.channelId || ADMIN_CHANNEL;
    this.fs = deps.fs || null;
    this.vaultDir = deps.vaultDir || null;
    this.enabled = deps.enabled !== undefined ? deps.enabled
      : (process.env.WORKER_SIGNAL_WATCHDOG_ENABLED === 'true');
    this.heartbeat = deps.heartbeat || null;
    this.now = deps.now || (() => new Date());
    this.checkAll = deps.checkAll || checkAll;
    this._t = null; this._kick = null; this._ticking = false;
  }

  start(ms = 5 * 60 * 1000) {
    // 1ª rodada 2min depois do boot: dá tempo dos workers subirem e carimbarem,
    // senão o próprio deploy abriria incidente de todo mundo.
    this._kick = setTimeout(() => this.tick().catch((e) => console.error('[signal-watchdog] erro:', e.message)), 2 * 60 * 1000);
    this._t = setInterval(() => this.tick().catch((e) => console.error('[signal-watchdog] erro:', e.message)), ms);
    console.log('[V3] signal-watchdog ligado (' + (this.enabled ? 'ON' : 'OFF') + ')');
  }

  stop() {
    if (this._t) clearInterval(this._t);
    if (this._kick) clearTimeout(this._kick);
    this._t = null; this._kick = null;
  }

  /** Já abri incidente pra esse sinal hoje? (dedupe por dia NY, via audit_log) */
  async _opened(key, date) {
    try {
      const r = await this.db.query(
        `SELECT 1 FROM v3.audit_log
          WHERE action = 'signal_incident'
            AND metadata->>'signal' = $1 AND metadata->>'ny_date' = $2 LIMIT 1`,
        [key, date]);
      return (r.rowCount || 0) > 0;
    } catch (_) { return false; }
  }

  async _markOpened(key, date, info) {
    await this.db.query(
      `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
       VALUES ('system', NULL, 'signal_incident', 'signal', NULL, $1::jsonb)`,
      [JSON.stringify(Object.assign({ signal: key, ny_date: date }, info || {}))]).catch(() => {});
  }

  /** Esse sinal está com incidente ABERTO (qualquer dia)? Base da recuperação. */
  async _hasOpen(key) {
    try {
      const r = await this.db.query(
        `SELECT 1 FROM v3.incidents WHERE code = $1 AND status <> 'resolved' LIMIT 1`,
        ['signal_' + key]);
      return (r.rowCount || 0) > 0;
    } catch (_) { return false; }
  }

  /** Já postei a recuperação desse sinal hoje? (evita repetir a linha boa) */
  async _recovered(key, date) {
    try {
      const r = await this.db.query(
        `SELECT 1 FROM v3.audit_log
          WHERE action = 'signal_recovered'
            AND metadata->>'signal' = $1 AND metadata->>'ny_date' = $2 LIMIT 1`,
        [key, date]);
      return (r.rowCount || 0) > 0;
    } catch (_) { return false; }
  }

  async _markRecovered(key, date, info) {
    await this.db.query(
      `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
       VALUES ('system', NULL, 'signal_recovered', 'signal', NULL, $1::jsonb)`,
      [JSON.stringify(Object.assign({ signal: key, ny_date: date }, info || {}))]).catch(() => {});
  }

  async _post(text) {
    if (!(this.slack && this.slack.postAs)) return null;
    try {
      const r = await this.slack.postAs({
        channel: this.channelId,
        sender: { name: 'HealthFare Vigia', icon: ':satellite_antenna:' },
        thread_ts: null, unfurl_links: false, unfurl_media: false, text,
      });
      return r || null;
    } catch (e) { console.error('[signal-watchdog] post falhou:', e.message); return null; }
  }

  /** O que quebra downstream quando esse sinal some. Vai pro dossiê. */
  _afeta(key) {
    const M = {
      machine_state: [
        'O alarme da encapsulação fica cego e pode gritar falso pros operadores (foi o que aconteceu em 23/08).',
        'Nenhuma leitura de câmera cruza com os eventos registrados.',
      ],
      print_event: [
        'Nenhum job de impressão é registrado: a task de Impressão de Labels fica sem produto e sem batch.',
        'A contagem de labels impressos do dia fica incompleta.',
      ],
      ems_sync: [
        'A atividade das máquinas no EMS não cruza com presença real.',
        'O aviso de estoque baixo perde a informação de o que já está na linha.',
      ],
      veeqo_sync: [
        'O pick sheet do dia congela no último espelhamento.',
        'A dedução de estoque por pedido para de acontecer.',
      ],
      ngteco_clock: [
        'O checkout autoritativo não fecha as tarefas abertas.',
        'A cobrança de ponto esquecido perde a base.',
      ],
    };
    return M[key] || ['Ainda não mapeado.'];
  }

  /** Abre o incidente de um sinal velho. Monta o dossiê com os dados crus. */
  async _openFor(s, date) {
    const desde = s.at ? `${nyTime(s.at)} (${s.at.toISOString()})` : 'nunca chegou';
    const oneLine = s.at
      ? `${s.label} parou de mandar sinal desde as ${nyTime(s.at)}, já são ${fmtAge(s.age_min)} sem nada.`
      : `${s.label} nunca mandou sinal nenhum.`;

    const res = await openIncident(
      { db: this.db, slack: this.slack, channelId: this.channelId, fs: this.fs, vaultDir: this.vaultDir, now: this.now },
      {
        code: 'signal_' + s.key,
        title: `Sinal parado: ${s.label}`,
        detail: {
          signal: s.key, source: s.source, age_min: s.age_min,
          last_at: s.at ? s.at.toISOString() : null,
          stale_after_min: s.stale_after_min, severity: s.severity,
          ny_date: date,
        },
        fix_hint: s.fix_hint,
        oneLine,
        dossier: {
          o_que_aconteceu: `${s.label} deixou de chegar. ${s.how}`,
          desde,
          esperado: `Sinal novo a cada ${s.stale_after_min} minutos no máximo, dentro da janela ${s.window ? `${s.window.startHour}h-${s.window.endHour}h${s.window.workdaysOnly ? ' em dia útil' : ''}` : '24 horas por dia'} (Nova York). Fonte: ${s.source}.`,
          observado: s.at
            ? `Último sinal em ${s.at.toISOString()}, ou seja ${fmtAge(s.age_min)} atrás. Nada chegou depois disso.`
            : 'Nenhum sinal registrado até agora.',
          afeta: this._afeta(s.key),
          dados_crus: { sinal: s, ultima_leitura: s.detail },
        },
      });

    await this._markOpened(s.key, date, {
      incident_id: res.id, age_min: s.age_min,
      last_at: s.at ? s.at.toISOString() : null,
    });
    return res;
  }

  async tick() {
    if (this._ticking || !this.enabled) return { skipped: true };
    this._ticking = true;
    try { this.heartbeat && this.heartbeat(); } catch (_) {}
    try {
      const now = this.now();
      const date = nyDate(now);
      const signals = await this.checkAll(this.db, now);
      const out = { checked: signals.length, opened: [], recovered: [], stale: [] };

      for (const s of signals) {
        if (s.stale && s.in_window) {
          out.stale.push(s.key);
          if (await this._opened(s.key, date)) continue;   // 1 por sinal por dia NY
          await this._openFor(s, date);
          out.opened.push(s.key);
          continue;
        }
        // VOLTOU: sinal fresco e existe incidente aberto → uma linha só, e fecha.
        if (!s.stale && (await this._hasOpen(s.key))) {
          if (await this._recovered(s.key, date)) continue;
          await this._post(
            `:white_check_mark: ${s.label} voltou a mandar sinal. Último dado de ${fmtAge(s.age_min)} atrás. Incidente fechado.`);
          await resolveIncident({ db: this.db }, 'signal_' + s.key,
            `sinal voltou em ${now.toISOString()}`);
          await this._markRecovered(s.key, date, { age_min: s.age_min });
          out.recovered.push(s.key);
        }
      }
      return out;
    } finally { this._ticking = false; }
  }
}

module.exports = { SignalWatchdog, fmtAge };
