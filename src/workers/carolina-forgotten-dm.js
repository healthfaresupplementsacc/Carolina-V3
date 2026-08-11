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
        `SELECT fc.id, fc.person_id, fc.last_task_description, p.display_name, p.slack_user_id,
                p.clock_code, fc.discovered_at::date AS fc_date,
                disc.display_name AS discovered_by,
                -- esqueceu TAMBÉM o relógio? (Bruno 07-22): tinha relógio mapeado e a
                -- última batida do dia foi cedo (<15h) ou nem bateu → sem punch-out
                (p.clock_code IS NOT NULL AND p.clock_code <> '' AND COALESCE(
                   (SELECT MAX(ap.punch_time) FROM v3.att_punch ap
                     WHERE ap.person_id = p.id AND ap.att_date = fc.discovered_at::date),
                   'epoch'::timestamptz) < (fc.discovered_at::date + TIME '15:00') AT TIME ZONE 'America/New_York'
                ) AS forgot_clock_too
         FROM v3.forgotten_checkouts fc JOIN v3.persons p ON p.id = fc.person_id
         LEFT JOIN v3.persons disc ON disc.id = fc.discovered_by_person_id
         WHERE fc.carolina_dm_sent_at IS NULL
           AND fc.carolina_dm_scheduled_for IS NOT NULL
           AND fc.carolina_dm_scheduled_for <= NOW()
           AND fc.carolina_dm_scheduled_for > NOW() - INTERVAL '6 hours'
         ORDER BY fc.carolina_dm_scheduled_for LIMIT 50`);
      if (!due.rowCount) return 0;
      if (!this.slack || !this.slack.postAs) return 0;
      // REGRA NOVA (Bruno 07-22, relógio de ponto): quem TEM relógio mapeado e BATEU
      // a saída não leva bronca por esquecer o checkout do sistema — a batida resolve
      // o dia. Só cobra: (a) quem esqueceu AMBOS (versão séria), (b) quem não tem relógio.
      const skip = due.rows.filter((r) => r.clock_code && !r.forgot_clock_too);
      for (const fc of skip) {
        await this.db.query("UPDATE v3.forgotten_checkouts SET carolina_dm_sent_at = NOW(), resolved_at = COALESCE(resolved_at, NOW()), resolution = 'clock_out_ok' WHERE id = $1", [fc.id]).catch(() => {});
      }
      due.rows = due.rows.filter((r) => !(r.clock_code && !r.forgot_clock_too));
      if (!due.rows.length) return 0;
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
              text: 'Você saiu ontem sem fazer o checkout e o sistema teve que corrigir. Não esquece de dar logout no fim do dia, por favor.',
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

  /** UMA mensagem no canal dos operadores, do BOT, com TODOS os nomes. Quem
   *  esqueceu TAMBÉM o relógio (forgot_clock_too) recebe a versão SÉRIA em caps,
   *  citando quem informou o horário (Bruno 07-22). */
  async _postChannelBatch(rows) {
    const mention = (fc) => (fc.slack_user_id ? `<@${fc.slack_user_id}>` : `*${fc.display_name}*`);
    const joinList = (arr) => arr.length === 1 ? arr[0] : arr.slice(0, -1).join(', ') + ' e ' + arr[arr.length - 1];
    const normal = rows.filter((r) => !r.forgot_clock_too);
    const severe = rows.filter((r) => r.forgot_clock_too);
    const parts = [];
    if (normal.length) {
      const list = joinList(normal.map(mention));
      parts.push(normal.length > 1
        ? `${list}, vocês saíram ontem sem fazer o checkout e o sistema teve que corrigir. Isso bagunça horários e contagem. Não esqueçam de dar logout no fim do dia.`
        : `${list}, você saiu ontem sem fazer o checkout e o sistema teve que corrigir. Isso bagunça horários e contagem. Não esquece de dar logout no fim do dia.`);
    }
    for (const fc of severe) {
      const adjusted = fc.discovered_by
        ? `Ajustei o seu horário conforme a informação que *${fc.discovered_by}* me passou sobre a hora que você saiu.`
        : `Ajustei o seu horário pelo último registro de atividade no sistema.`;
      parts.push(`:rotating_light: ${mention(fc)}, ontem você esqueceu o checkout no sistema *e* o ponto no relógio. Isso é sério, redobre o cuidado. ${adjusted}`);
    }
    try {
      await this.slack.postAs({ channel: this.operatorsChannel, sender: BOT, thread_ts: null, unfurl_links: false, unfurl_media: false, text: parts.join('\n\n') });
      return true;
    } catch (e) { console.error('[forgotten-dm] envio falhou:', e.message); return false; }
  }
}

module.exports = { CarolinaForgottenDM };
