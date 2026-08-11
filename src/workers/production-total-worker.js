'use strict';
/**
 * PRODUCTION TOTAL WORKER (Bruno 07-27) — o lado "escuta e responde" do
 * follow-up de total de produção (ver src/v3/production-total-followup.js).
 *
 * Para cada followup ABERTO:
 *   1) lê as respostas NOVAS do operador na thread do Slack (conversations.replies);
 *   2) interpreta (LLM Gemini): número → registra o total e AGRADECE + fecha;
 *      motivo sem número → insiste 1x pedindo o número; nada claro → escala admin;
 *   3) se o operador ficou em silêncio e já insisti o suficiente → escala pro
 *      #admin-orin pra alguém investigar (NÃO fica spamando o operador).
 *
 * NÃO mexe em linha já resolvida. NÃO cita horário de relógio. Respeita o
 * kill-switch de avisos (alertGate) pro canal do operador.
 */

const { interpretReply, MAX_OPERATOR_PROMPTS, REPROMPT_AFTER_MIN } = require('../v3/production-total-followup');

class ProductionTotalWorker {
  constructor(deps = {}) {
    this.db = deps.db;
    this.slack = deps.slack || null;                    // { postAs }
    this.botToken = deps.botToken || process.env.SLACK_BOT_TOKEN || null;
    this.provider = deps.provider || null;              // LLM (Gemini)
    this.productionChannel = deps.productionChannel || process.env.V3_PRODUCTION_CHANNEL || 'C09UNBXFRKK';
    this.adminChannel = deps.adminChannel || process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1';
    this.alertGate = deps.alertGate || null;
    this.heartbeat = deps.heartbeat || null;
    this.recordTotal = deps.recordTotal || null;        // fn({ followup, bottles, via, byPersonId }) — grava production_count
    this._timer = null;
    this._ticking = false;
  }

  start(intervalMs = 30000) {
    this._timer = setInterval(() => this.tick().catch((e) => console.error('[total-worker] tick:', e.message)), intervalMs);
    console.log('[V3] production-total-worker ligado (tick ' + Math.round(intervalMs / 1000) + 's)');
    return this;
  }
  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; }

  async _admin(text) {
    if (!this.slack || !this.slack.postAs) return;
    try { await this.slack.postAs({ channel: this.adminChannel, sender: { name: 'HealthFare Tracker (Sistema)', icon: ':bar_chart:' }, thread_ts: null, text, unfurl_links: false, unfurl_media: false }); }
    catch (e) { console.error('[total-worker] admin:', e.message); }
  }
  async _thread(threadTs, text) {
    if (!this.slack || !this.slack.postAs) return;
    try {
      if (this.alertGate && await this.alertGate.isMuted(this.db)) return;   // operador não recebe se pausado
      await this.slack.postAs({ channel: this.productionChannel, sender: { name: 'HealthFare Tracker', icon: ':package:' }, thread_ts: threadTs, text, unfurl_links: false, unfurl_media: false });
    } catch (e) { console.error('[total-worker] thread:', e.message); }
  }

  /** Lê respostas de uma thread do Slack via conversations.replies (raw). */
  async _threadReplies(threadTs) {
    if (!this.botToken || !threadTs) return [];
    try {
      const r = await (await fetch(
        'https://slack.com/api/conversations.replies?channel=' + this.productionChannel + '&ts=' + threadTs + '&limit=50',
        { headers: { Authorization: 'Bearer ' + this.botToken } })).json();
      if (!r.ok) return [];
      return r.messages || [];
    } catch (_) { return []; }
  }

  async tick() {
    if (this._ticking) return; this._ticking = true;
    try { this.heartbeat && this.heartbeat(); } catch (_) {}
    try {
      const open = (await this.db.query(
        `SELECT * FROM v3.production_total_followups WHERE status='open' ORDER BY created_at ASC LIMIT 25`)).rows;
      for (const f of open) {
        try { await this._process(f); }
        catch (e) { console.error('[total-worker] followup ' + f.id + ':', e.message); }
      }
      return { ok: true, open: open.length };
    } finally { this._ticking = false; }
  }

  async _process(f) {
    // segurança: se o evento já ganhou um total por qualquer caminho, encerra em silêncio.
    const already = (await this.db.query(
      `SELECT 1 FROM v3.production_counts WHERE source_event_id=$1 AND deleted_at IS NULL AND bottles IS NOT NULL LIMIT 1`, [f.event_id])).rows[0];
    if (already) { await this._close(f, { via: 'other', bottles: null, silent: true }); return; }

    const replies = await this._threadReplies(f.thread_ts);
    // respostas do OPERADOR (não-bot) depois do last_seen_ts
    const seen = f.last_seen_ts ? parseFloat(f.last_seen_ts) : (f.thread_ts ? parseFloat(f.thread_ts) : 0);
    const newOps = replies.filter((m) => !m.bot_id && !m.subtype && parseFloat(m.ts) > seen && String(m.text || '').trim());

    if (newOps.length) {
      const latest = newOps[newOps.length - 1];
      await this.db.query(`UPDATE v3.production_total_followups SET last_seen_ts=$2, updated_at=NOW() WHERE id=$1`, [f.id, latest.ts]);
      // interpreta a resposta mais recente (com contexto de produto/lote)
      const verdict = await interpretReply({ provider: this.provider, text: latest.text, productName: f.product_name, batchNumber: f.batch_number });

      if (verdict.kind === 'number') {
        // REGISTRA o total e agradece.
        let recorded = false;
        try {
          if (this.recordTotal) { await this.recordTotal({ followup: f, bottles: verdict.bottles, via: 'slack_reply', byPersonId: f.person_id }); recorded = true; }
        } catch (e) { console.error('[total-worker] recordTotal:', e.message); }
        await this._thread(f.thread_ts,
          `Anotado: *${verdict.bottles}*` +
          (f.product_name ? ` de ${f.product_name}` : '') + (f.batch_number ? ` (${f.batch_number})` : '') +
          `. Valeu!`);
        await this._close(f, { via: 'slack_reply', bottles: verdict.bottles });
        await this._admin(`Total via Slack, ${f.person_name || '?'}: *${verdict.bottles}*` +
          (f.product_name ? ` de ${f.product_name}` : '') + (f.batch_number ? ` (${f.batch_number})` : '') +
          (recorded ? '' : ' _(⚠️ falha ao gravar, conferir)_') + '.');
        return;
      }

      if (verdict.kind === 'reason') {
        // deu explicação mas sem número. Insiste 1x; se já insisti demais → escala.
        if (f.attempts >= MAX_OPERATOR_PROMPTS) { await this._escalate(f, latest.text); return; }
        await this.db.query(`UPDATE v3.production_total_followups SET attempts=attempts+1, last_prompt_at=NOW(), updated_at=NOW() WHERE id=$1`, [f.id]);
        await this._thread(f.thread_ts,
          `Entendi. Mas ainda preciso do número pra fechar: quantas unidades no total${f.product_name ? ' do ' + f.product_name : ''}? Só o número.`);
        return;
      }

      // não deu pra entender → escala (o admin investiga com o operador)
      await this._escalate(f, latest.text);
      return;
    }

    // sem resposta nova: re-cobra o operador se passou tempo e ainda não esgotei as tentativas;
    // senão, escala pro admin (não fica repetindo).
    const sinceMin = f.last_prompt_at ? (Date.now() - new Date(f.last_prompt_at).getTime()) / 60000 : 999;
    if (sinceMin >= REPROMPT_AFTER_MIN) {
      if (f.attempts < MAX_OPERATOR_PROMPTS) {
        await this.db.query(`UPDATE v3.production_total_followups SET attempts=attempts+1, last_prompt_at=NOW(), updated_at=NOW() WHERE id=$1`, [f.id]);
        await this._thread(f.thread_ts,
          `Ainda falta o total de unidades` +
          (f.product_name ? ` do ${f.product_name}` : '') + `. Quando puder, me manda o número.`);
      } else {
        await this._escalate(f, null);
      }
    }
  }

  async _escalate(f, lastText) {
    await this.db.query(`UPDATE v3.production_total_followups SET status='escalated', state='escalated', escalated_at=NOW(), updated_at=NOW() WHERE id=$1`, [f.id]);
    await this._admin(
      `:rotating_light: Total pendente, precisa investigar. ${f.person_name || '?'}, ` +
      `${f.product_name || '?'} (${f.batch_number || '?'}). ` +
      (f.close_reason ? `Motivo ao fechar: "${f.close_reason}". ` : '') +
      (lastText ? `Última resposta: "${String(lastText).slice(0, 150)}". ` : `Sem resposta. `) +
      `Alguém precisa ir atrás e registrar (linha #${f.event_id}).`);
    // avisa na thread do operador que passei pro pessoal resolver (sem cobrar mais)
    await this._thread(f.thread_ts, `Sem problema, vou pedir pra gestão te ajudar a fechar esse total. Valeu!`);
  }

  async _close(f, { via, bottles, silent }) {
    await this.db.query(
      `UPDATE v3.production_total_followups
          SET status='resolved', state='done', total_bottles=$2, resolved_via=$3, resolved_at=NOW(), updated_at=NOW()
        WHERE id=$1`, [f.id, bottles != null ? bottles : null, via || null]);
    if (!silent) { /* o agradecimento já foi na thread */ }
  }
}

module.exports = { ProductionTotalWorker };
