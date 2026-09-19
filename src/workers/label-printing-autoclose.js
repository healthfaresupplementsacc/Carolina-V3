'use strict';
/**
 * LABEL PRINTING AUTOCLOSE (Bruno 09-12): "como alguém imprime labels por 732 horas?"
 *
 * A tarefa "Impressão de Labels" nasce sozinha quando a pessoa loga no PC de impressão
 * (.28) e fecha quando ela sai (closed_reason 'operator_page'). Quando o logoff não
 * chega (PC desligado na tomada, sessão de teste do Sandbox, queda), ela ficava aberta
 * pra sempre. Este worker é o cinto de segurança:
 *
 *   - fecha toda label_printing aberta há mais de MAX_HOURS (12 h), OU
 *   - depois das 20:45 NY fecha as que começaram antes das 20:00 (fim do expediente), OU
 *   - do Sandbox: fecha depois de 30 min.
 *   ended_at = o ÚLTIMO sinal real (última impressão ligada ao evento, ou o último
 *   heartbeat do lock da estação se for a mesma pessoa), nunca "agora" — o tempo
 *   registrado é o que a pessoa de fato ficou lá. Marca closed_reason 'auto_label_eod'
 *   ou 'auto_label_stale' e audita.
 *
 * Nunca toca em quem está de fato imprimindo: uma impressão nos últimos 30 min segura.
 */
const MAX_HOURS = 12;
const EOD_MIN = 20 * 60 + 45;   // 20:45 NY
const SANDBOX_MIN = 30;

function nyMinutesNow(now) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(now || new Date());
  return parseInt(p.find((x) => x.type === 'hour').value, 10) * 60 + parseInt(p.find((x) => x.type === 'minute').value, 10);
}
function nyDate(iso) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso)); }

/** Decisão pura. row: { started_at, is_sandbox, last_print_at, last_heartbeat_at }. now: Date. */
function decide(row, now) {
  const t = now || new Date();
  const ageMin = (t - new Date(row.started_at)) / 60000;
  const lastSignal = [row.last_print_at, row.last_heartbeat_at].filter(Boolean).map((x) => new Date(x)).sort((a, b) => b - a)[0] || null;
  const quietMin = lastSignal ? (t - lastSignal) / 60000 : ageMin;
  if (quietMin < 30) return null;                                          // imprimiu/mexeu há pouco: deixa
  if (row.is_sandbox && ageMin >= SANDBOX_MIN) return 'auto_label_stale';
  if (ageMin >= MAX_HOURS * 60) return 'auto_label_stale';
  const startedToday = nyDate(row.started_at) === nyDate(t);
  if (nyMinutesNow(t) >= EOD_MIN && (!startedToday || nyMinutesNow(new Date(row.started_at)) < 20 * 60)) return 'auto_label_eod';
  return null;
}
function endAtFor(row) {
  const cands = [row.last_print_at, row.last_heartbeat_at].filter(Boolean).map((x) => new Date(x));
  const floor = new Date(new Date(row.started_at).getTime() + 60000);
  const best = cands.sort((a, b) => b - a)[0];
  return (best && best > floor) ? best : floor;
}

class LabelPrintingAutoclose {
  constructor({ db, heartbeat, now, log } = {}) { this.db = db; this.heartbeat = heartbeat || (() => {}); this.now = now || (() => new Date()); this.log = log || console.log; this._t = null; }
  async tick() {
    const rows = (await this.db.query(`
      SELECT e.id, e.person_id, pe.display_name AS person, COALESCE(pe.is_sandbox, false) AS is_sandbox, e.started_at,
             (SELECT MAX(COALESCE(pj.phys_ended_at, pj.created_at)) FROM v3.print_jobs pj WHERE pj.label_event_id = e.id) AS last_print_at   -- carimbo do servidor: completed_at vem do .28 e já chegou com fuso errado,
             (SELECT CASE WHEN (s.value->>'person_id')::int = e.person_id THEN s.updated_at END FROM v3.settings s WHERE s.key = 'print_station_operator') AS last_heartbeat_at
        FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id JOIN v3.persons pe ON pe.id = e.person_id
       WHERE at.slug = 'label_printing' AND e.ended_at IS NULL AND e.deleted_at IS NULL`)).rows;
    let closed = 0;
    for (const r of rows) {
      const reason = decide(r, this.now()); if (!reason) continue;
      const endAt = endAtFor(r);
      await this.db.query(`UPDATE v3.events SET ended_at = $2, closed_reason = $3, updated_at = NOW() WHERE id = $1 AND ended_at IS NULL`, [r.id, endAt.toISOString(), reason]);
      try { await this.db.query(`INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata) VALUES ('system', NULL, 'event.auto_closed', 'event', $1, $2::jsonb)`, [r.id, JSON.stringify({ reason, person: r.person, started_at: r.started_at, ended_at: endAt.toISOString(), worker: 'label-printing-autoclose' })]); } catch (_) { /* nunca derruba */ }
      this.log(`[label-autoclose] fechou ev${r.id} (${r.person}) ${reason}: ${new Date(r.started_at).toISOString().slice(0, 16)} → ${endAt.toISOString().slice(0, 16)}`);
      closed++;
    }
    this.heartbeat();
    return { open: rows.length, closed };
  }
  start(ms) { const run = () => this.tick().catch((e) => console.error('[label-autoclose]', e.message)); run(); this._t = setInterval(run, ms || 5 * 60 * 1000); return this; }
  stop() { if (this._t) clearInterval(this._t); }
}

module.exports = { LabelPrintingAutoclose, decide, endAtFor, MAX_HOURS, EOD_MIN, SANDBOX_MIN };
