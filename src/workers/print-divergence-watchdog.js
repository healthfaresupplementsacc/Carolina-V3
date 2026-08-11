'use strict';
/**
 * HEALTHFARE V3 — print-divergence-watchdog (Bruno 08-06)
 *
 * Todo dia às 12pm NY (Simone já terminou de imprimir): compara o total digitado
 * nas tasks de impressão (1ª + 2ª, order_printing + order_printing_2, não-teste)
 * com o que o Veeqo registrou como impresso no dia. Se divergir, PERGUNTA pra
 * Simone no #orders-and-inventory citando **SÓ A DIFERENÇA** — nunca os totais
 * (pedido explícito do Bruno: assim ela conta o motivo real em vez de ajustar
 * o número). A resposta dela na thread é gravada TODO dia em
 * v3.print_divergence_log → histórico pra investigar com calma.
 *
 * Kill-switch: respeita o mute de alertas do canal do operador (alert-gate).
 * OPT-IN: WORKER_PRINT_DIVERGENCE_ENABLED=true. Canal: #orders-and-inventory.
 */
const { isMuted } = require('../v3/alert-gate');
const EDT = 'America/New_York';

class PrintDivergenceWatchdog {
  constructor(deps = {}) {
    this.db = deps.db;
    this.veeqo = deps.veeqo || null;
    this.slack = deps.slack || null;                  // { postAs }
    this.slackWeb = deps.slackWeb || null;            // WebClient (ler thread)
    this.channelId = deps.channelId || 'C09UNBXFRKK'; // #orders-and-inventory
    this.enabled = deps.enabled !== undefined ? deps.enabled
      : (process.env.WORKER_PRINT_DIVERGENCE_ENABLED === 'true');
    this.heartbeat = deps.heartbeat || null;
    this.askHour = deps.askHour != null ? deps.askHour : 12;    // 12pm NY
    this.askUntil = deps.askUntil != null ? deps.askUntil : 15; // até 15h — restart à noite NÃO pergunta fora de hora (Bruno 08-06)
    this.tolerance = deps.tolerance != null ? deps.tolerance : 20; // Bruno 08-06: só pergunta se |diff| > 20 (diferença SUSPEITA; ruído TikTok/clínica não incomoda). Loga TODO dia igual.
    this._t = null; this._kick = null; this._ticking = false;
  }

  start(ms = 15 * 60 * 1000) {
    this._kick = setTimeout(() => this.tick().catch((e) => console.error('[print-div] erro:', e.message)), 50 * 1000);
    this._t = setInterval(() => this.tick().catch((e) => console.error('[print-div] erro:', e.message)), ms);
    console.log('[V3] print-divergence-watchdog ligado (' + (this.enabled ? 'ON' : 'OFF') + ')');
  }
  stop() { if (this._t) clearInterval(this._t); if (this._kick) clearTimeout(this._kick); this._t = null; this._kick = null; }

  _ny() {
    const now = new Date();
    const hour = Number((String(now.toLocaleString('en-US', { timeZone: EDT, hour: '2-digit', hour12: false })).match(/\d{1,2}/) || ['0'])[0]) % 24;
    const date = now.toLocaleDateString('en-CA', { timeZone: EDT });
    return { hour, date };
  }

  /** Totais do dia: digitado (1ª+2ª impressão, não-teste) vs Veeqo impresso. */
  async computeDay(nyDate) {
    const op = await this.db.query(`
      SELECT COALESCE(SUM(e.orders_printed),0)::int AS total
        FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
       WHERE at.slug IN ('order_printing','order_printing_2')
         AND e.orders_printed IS NOT NULL AND COALESCE(e.is_test,false) = false
         AND to_char(e.started_at AT TIME ZONE '${EDT}','YYYY-MM-DD') = $1`, [nyDate]);
    const operator_total = op.rows[0].total;
    const v = await this.veeqo.shippedByDay(nyDate);
    return { operator_total, veeqo_total: v.total_orders || 0 };
  }

  _question(diff) {
    const abs = Math.abs(diff);
    // SÓ a diferença — nunca os totais (decisão do Bruno 08-06).
    return 'Simone, hoje deu *' + abs + ' ' + (abs === 1 ? 'ordem' : 'ordens') + '* de diferença '
      + 'entre o que você colocou no sistema (1ª + 2ª impressão) e o que o Veeqo registrou. '
      + 'Sabe o porquê? Me fala aqui na thread.';
  }

  /** Pergunta do dia (se divergiu e ainda não perguntou). */
  async askIfNeeded() {
    const { hour, date } = this._ny();
    if (hour < this.askHour) return { skipped: 'before_noon' };
    if (hour >= this.askUntil) {
      // fora da janela (ex.: deploy/restart à noite): LOGA o dia em silêncio, sem perguntar
      const logged = await this.db.query('SELECT 1 FROM v3.print_divergence_log WHERE ny_date = $1', [date]);
      if (!logged.rowCount && this.veeqo && this.veeqo.configured()) {
        const c = await this.computeDay(date);
        await this.db.query(
          `INSERT INTO v3.print_divergence_log (ny_date, operator_total, veeqo_total, diff, asked)
           VALUES ($1,$2,$3,$4,false) ON CONFLICT (ny_date) DO NOTHING`,
          [date, c.operator_total, c.veeqo_total, c.operator_total - c.veeqo_total]);
      }
      return { skipped: 'after_window' };
    }
    const done = await this.db.query('SELECT 1 FROM v3.print_divergence_log WHERE ny_date = $1', [date]);
    if (done.rowCount) return { skipped: 'already_logged' };
    if (!this.veeqo || !this.veeqo.configured()) return { skipped: 'no_veeqo' };

    const { operator_total, veeqo_total } = await this.computeDay(date);
    const diff = operator_total - veeqo_total;
    const diverged = Math.abs(diff) > this.tolerance;

    let question_ts = null, asked = false;
    if (diverged && operator_total > 0) {              // só pergunta se houve impressão digitada
      const muted = await isMuted(this.db, new Date()).catch(() => false);
      if (!muted && this.slack && this.slack.postAs) {
        try {
          const r = await this.slack.postAs({
            channel: this.channelId,
            sender: { name: 'HealthFare Tracker', icon: ':printer:' },
            thread_ts: null, unfurl_links: false, unfurl_media: false,
            text: this._question(diff),
          });
          question_ts = (r && (r.ts || (r.message && r.message.ts))) || null;
          asked = true;
        } catch (e) { console.error('[print-div] post falhou:', e.message); }
      }
    }
    await this.db.query(`
      INSERT INTO v3.print_divergence_log (ny_date, operator_total, veeqo_total, diff, asked, question_ts, question_channel)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (ny_date) DO NOTHING`,
      [date, operator_total, veeqo_total, diff, asked, question_ts, asked ? this.channelId : null]);
    return { date, operator_total, veeqo_total, diff, asked };
  }

  /** Captura respostas nas threads das perguntas ainda sem resposta (últimos 3 dias). */
  async captureAnswers() {
    if (!this.slackWeb) return 0;
    const open = await this.db.query(`
      SELECT id, question_channel, question_ts FROM v3.print_divergence_log
       WHERE asked AND answer_text IS NULL AND question_ts IS NOT NULL
         AND ny_date > CURRENT_DATE - 3`);
    let captured = 0;
    for (const q of open.rows) {
      try {
        const r = await this.slackWeb.conversations.replies({ channel: q.question_channel, ts: q.question_ts, limit: 10 });
        const reply = (r.messages || []).find((m) => m.ts !== q.question_ts && !m.bot_id && (m.text || '').trim());
        if (reply) {
          await this.db.query(
            `UPDATE v3.print_divergence_log SET answer_text=$2, answer_by=$3, answered_at=to_timestamp($4::float) WHERE id=$1`,
            [q.id, reply.text.slice(0, 2000), reply.user || null, Number(reply.ts)]);
          captured++;
        }
      } catch (e) { console.error('[print-div] replies falhou:', e.message); }
    }
    return captured;
  }

  async tick() {
    if (this._ticking || !this.enabled) return { skipped: true };
    this._ticking = true;
    try { this.heartbeat && this.heartbeat(); } catch (_) {}
    try {
      const ask = await this.askIfNeeded();
      const answers = await this.captureAnswers();
      return { ask, answers };
    } finally { this._ticking = false; }
  }
}

module.exports = { PrintDivergenceWatchdog };
