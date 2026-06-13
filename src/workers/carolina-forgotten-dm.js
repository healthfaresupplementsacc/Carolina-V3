'use strict';
/**
 * HEALTHFARE V3 — Carolina forgotten-checkout DM (Fase 4).
 *
 * Manda o lembrete gentil no dia seguinte pra quem esqueceu o checkout.
 * Liga via WORKER_FORGOTTEN_DM_ENABLED=true (off por padrão → seguro
 * deployar sem mandar nada até o Bruno habilitar).
 *
 * Pega forgotten_checkouts com carolina_dm_scheduled_for vencido e ainda
 * não enviado (janela de 1h pra não mandar lembrete muito atrasado).
 * Se a pessoa tem slack_user_id → DM; senão posta no canal de orders
 * mencionando (fallback). Deduplica via carolina_dm_sent_at.
 */
class CarolinaForgottenDM {
  constructor(deps = {}) {
    this.db = deps.db;
    this.slack = deps.slack || null; // { postAs }
    this.ordersChannel = deps.ordersChannel || process.env.V3_ORDERS_CHANNEL || deps.adminChannelId || process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1';
    this._timer = null; this._ticking = false;
  }
  start(intervalMs = 10 * 60 * 1000) {
    this._timer = setInterval(() => this.tick().catch((e) => console.error('[forgotten-dm] tick erro:', e.message)), intervalMs);
    console.log('[V3] carolina-forgotten-dm ligado (tick ' + Math.round(intervalMs / 60000) + 'min)');
  }
  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; }

  async tick() {
    if (this._ticking) return; this._ticking = true;
    try {
      const due = await this.db.query(
        `SELECT fc.id, fc.person_id, fc.last_task_description, p.display_name, p.slack_user_id
         FROM v3.forgotten_checkouts fc JOIN v3.persons p ON p.id = fc.person_id
         WHERE fc.carolina_dm_sent_at IS NULL
           AND fc.carolina_dm_scheduled_for IS NOT NULL
           AND fc.carolina_dm_scheduled_for <= NOW()
           AND fc.carolina_dm_scheduled_for > NOW() - INTERVAL '6 hours'
         ORDER BY fc.carolina_dm_scheduled_for LIMIT 50`);
      for (const fc of due.rows) {
        const sent = await this._sendDM(fc);
        if (sent) {
          await this.db.query(
            "UPDATE v3.forgotten_checkouts SET carolina_dm_sent_at = NOW(), resolved_at = COALESCE(resolved_at, NOW()), resolution = 'dm_sent' WHERE id = $1", [fc.id]);
          await this.db.query(
            `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
             VALUES ('system', $1, 'carolina_forgotten_dm_sent', 'person', $1, $2::jsonb)`,
            [fc.person_id, JSON.stringify({ forgotten_checkout_id: fc.id, channel: fc.slack_user_id ? 'dm' : 'orders_channel' })]).catch(() => {});
        }
      }
      return due.rowCount;
    } finally { this._ticking = false; }
  }

  async _sendDM(fc) {
    if (!this.slack || !this.slack.postAs) return false;
    const dmText = `Bom dia ${fc.display_name}! Ontem você esqueceu de fazer checkout no sistema. `
      + `Não se preocupa, foi corrigido automaticamente.\n\n`
      + `Por favor, não esquece da próxima vez — isso faz suas tasks parecerem mais longas que o normal `
      + `e pode baixar sua pontuação de produção.\n\nSempre faz logout no final do dia, tá? Obrigada! 💚`;
    try {
      if (fc.slack_user_id) {
        await this.slack.postAs({ channel: fc.slack_user_id, sender: { name: 'Carolina' }, thread_ts: null, text: dmText });
      } else {
        await this.slack.postAs({
          channel: this.ordersChannel, sender: { name: 'Carolina' }, thread_ts: null,
          text: `${fc.display_name}, ontem você esqueceu de fazer checkout. Foi corrigido automaticamente. `
            + `Não esquece da próxima vez — baixa sua pontuação de produção. Obrigada! 💚`,
        });
      }
      return true;
    } catch (e) { console.error('[forgotten-dm] envio falhou:', e.message); return false; }
  }
}

module.exports = { CarolinaForgottenDM };
