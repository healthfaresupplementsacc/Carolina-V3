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
// Mensagem do BOT (não assinada pela Carolina — decisão Bruno 07-08).
const BOT = { name: 'HealthFare Tracker', icon: ':hourglass_flowing_sand:' };

class CarolinaForgottenDM {
  constructor(deps = {}) {
    this.db = deps.db;
    this.slack = deps.slack || null; // { postAs }
    // canal dos OPERADORES (produção) — é onde a cobrança tem que aparecer.
    this.operatorsChannel = deps.operatorsChannel || process.env.V3_PRODUCTION_CHANNEL || 'C09UNBXFRKK';
    this.ordersChannel = deps.ordersChannel || process.env.V3_ORDERS_CHANNEL || deps.adminChannelId || process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1';
    this.heartbeat = deps.heartbeat || null; // vigia (wire.js) — prova que o tick roda
    this._timer = null; this._kick = null; this._ticking = false;
  }
  start(intervalMs = 10 * 60 * 1000) {
    // tick inicial ~30s pós-boot: redeploys reiniciavam o timer antes do 1º tick
    // de +10min → DM vencido esperava mais 10min a cada deploy (caso Ana 07-03).
    this._kick = setTimeout(() => this.tick().catch((e) => console.error('[forgotten-dm] tick erro:', e.message)), 30 * 1000);
    this._timer = setInterval(() => this.tick().catch((e) => console.error('[forgotten-dm] tick erro:', e.message)), intervalMs);
    console.log('[V3] carolina-forgotten-dm ligado (tick ' + Math.round(intervalMs / 60000) + 'min)');
  }
  stop() { if (this._timer) clearInterval(this._timer); if (this._kick) clearTimeout(this._kick); this._timer = null; this._kick = null; }

  async tick() {
    if (this._ticking) return; this._ticking = true;
    try { this.heartbeat && this.heartbeat(); } catch (_) {}
    try {
      const due = await this.db.query(
        `SELECT fc.id, fc.person_id, fc.last_task_description, p.display_name, p.slack_user_id
         FROM v3.forgotten_checkouts fc JOIN v3.persons p ON p.id = fc.person_id
         WHERE fc.carolina_dm_sent_at IS NULL
           AND fc.carolina_dm_scheduled_for IS NOT NULL
           AND fc.carolina_dm_scheduled_for <= NOW()
           AND fc.carolina_dm_scheduled_for > NOW() - INTERVAL '6 hours'
         ORDER BY fc.carolina_dm_scheduled_for LIMIT 50`);
      if (!due.rowCount) return 0;
      if (!this.slack || !this.slack.postAs) return 0;
      // UMA mensagem só, do BOT (não assinada pela Carolina), mencionando TODO
      // MUNDO que esqueceu — em vez de spamar uma por pessoa (Bruno 07-08).
      const posted = await this._postChannelBatch(due.rows);
      if (!posted) return 0; // não conseguiu postar no canal → não marca, tenta no próximo tick
      // DM privado por pessoa (também do bot) + marca cada uma + audit.
      for (const fc of due.rows) {
        if (fc.slack_user_id && this.slack.postDm) {
          try {
            await this.slack.postDm({
              userId: fc.slack_user_id, sender: BOT,
              text: 'Você saiu *sem fazer o checkout* no fim do expediente e o sistema teve que corrigir o seu registro. '
                + 'Por favor, não esqueça de fazer o logout/checkout no fim do dia. (Este lembrete também saiu no canal dos operadores.)',
            });
          } catch (e) { console.error('[forgotten-dm] DM adicional falhou (canal já saiu):', e.message); }
        }
        await this.db.query(
          "UPDATE v3.forgotten_checkouts SET carolina_dm_sent_at = NOW(), resolved_at = COALESCE(resolved_at, NOW()), resolution = 'dm_sent' WHERE id = $1", [fc.id]).catch(() => {});
        await this.db.query(
          `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
           VALUES ('system', $1, 'carolina_forgotten_dm_sent', 'person', $1, $2::jsonb)`,
          [fc.person_id, JSON.stringify({ forgotten_checkout_id: fc.id, channel: fc.slack_user_id ? 'dm+channel' : 'channel', batched_with: due.rowCount })]).catch(() => {});
      }
      return due.rowCount;
    } finally { this._ticking = false; }
  }

  /** UMA mensagem no canal dos operadores, do BOT, com TODOS os nomes. */
  async _postChannelBatch(rows) {
    const mentions = rows.map((fc) => (fc.slack_user_id ? `<@${fc.slack_user_id}>` : `*${fc.display_name}*`));
    // "A", "A e B", "A, B e C"
    const list = mentions.length === 1 ? mentions[0]
      : mentions.slice(0, -1).join(', ') + ' e ' + mentions[mentions.length - 1];
    const plural = rows.length > 1;
    const text = plural
      ? `:hourglass_flowing_sand: ${list} — vocês saíram *sem fazer o checkout* no fim do expediente e o sistema teve que corrigir os registros de vocês. `
        + `Isso bagunça os horários e a contagem de produção. Por favor, *não esqueçam de fazer o logout/checkout* no fim do dia — faz parte da rotina.`
      : `:hourglass_flowing_sand: ${list}, você saiu *sem fazer o checkout* no fim do expediente e o sistema teve que corrigir o seu registro. `
        + `Isso bagunça os horários e a contagem de produção. Por favor, *não esqueça de fazer o logout/checkout* no fim do dia — faz parte da rotina.`;
    try {
      await this.slack.postAs({ channel: this.operatorsChannel, sender: BOT, thread_ts: null, unfurl_links: false, unfurl_media: false, text });
      return true;
    } catch (e) { console.error('[forgotten-dm] envio falhou:', e.message); return false; }
  }
}

module.exports = { CarolinaForgottenDM };
