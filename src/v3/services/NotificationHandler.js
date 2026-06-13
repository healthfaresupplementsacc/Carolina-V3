'use strict';
/**
 * HEALTHFARE V3 — NotificationHandler: reações do admin nas notificações
 * da Carolina (#admin-orin). Plugado no events-v2 DEPOIS do fluxo de
 * pending_commands (se a reação não era de um comando, tenta notificação).
 *
 * Caminhos (notificação 'slack_event_not_on_page' e afins):
 *   ✅ (white_check_mark/+1/heavy_check_mark) → admin_accepted.
 *      O slack event vira canônico (NADA é apagado). chat.update na msg.
 *   ❌ (x/no_entry_sign/red_circle) → admin_rejected.
 *      Soft-delete do slack event (deleted_at + audit; sem apagar a msg).
 *   📝 (memo/pencil/pencil2) → admin_edited (pendente de comando).
 *      Carolina orienta usar o fluxo de comando JÁ EXISTENTE e testado:
 *      "@Carolina muda o batch do ev<id> pra 0181" (CommandHandler
 *      edit_field, com preview + confirmação ✅). O TEXTO DO ADMIN é a
 *      entrada final — a Carolina não inventa campos.
 */

const ACCEPT = new Set(['white_check_mark', '+1', 'heavy_check_mark']);
const REJECT = new Set(['x', 'no_entry_sign', 'red_circle']);
const EDIT = new Set(['memo', 'pencil', 'pencil2']);

class NotificationHandler {
  /** @param {{db, slack?:{postAs,updateMessage}, adminChannelId?:string}} deps */
  constructor(deps = {}) {
    this.db = deps.db;
    this.slack = deps.slack || null;
    this.adminChannelId = deps.adminChannelId || process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1';
  }

  async _audit(action, notifId, metadata, personId) {
    try {
      await this.db.query(
        `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
         VALUES ('admin', $1, $2, 'notification', $3, $4::jsonb)`,
        [personId || null, action, notifId, JSON.stringify(metadata || {})]);
    } catch (e) { console.error('[notif] audit falhou:', e.message); }
  }

  async _updateCarolinaMsg(channel, ts, text) {
    if (!this.slack || !this.slack.updateMessage || !ts) return;
    try { await this.slack.updateMessage({ channel, ts, text }); }
    catch (e) { console.error('[notif] chat.update falhou:', e.message); }
  }

  /**
   * Tenta tratar uma reação como resposta a notificação pendente.
   * @returns {{handled:boolean, action?:string, reason?:string}}
   */
  async handleReaction({ carolinaMsgTs, emoji, reactorPersonId, reactorName, channel }) {
    const r = await this.db.query(
      `SELECT id, type, payload, status FROM v3.notifications
       WHERE carolina_slack_ts = $1 AND status = 'pending' LIMIT 1`, [carolinaMsgTs]);
    if (!r.rows.length) return { handled: false, reason: 'no_pending_notification' };
    const notif = r.rows[0];
    const payload = notif.payload || {};
    const slackEventId = payload.slack_event_id ? parseInt(payload.slack_event_id, 10) : null;
    const ch = channel || this.adminChannelId;
    const who = reactorName || ('admin#' + reactorPersonId);
    const headline = `${payload.person || '?'} — ${payload.slug || '?'}${payload.batch ? ' · ' + payload.batch : ''}`;

    if (ACCEPT.has(emoji)) {
      await this.db.query(
        `UPDATE v3.notifications SET status='admin_accepted', admin_action_by=$2, resolved_at=NOW() WHERE id=$1`,
        [notif.id, reactorPersonId]);
      await this._audit('notification_accepted', notif.id, { slack_event_id: slackEventId }, reactorPersonId);
      await this._updateCarolinaMsg(ch, carolinaMsgTs, `✅ Aceito por ${who} — ${headline} (registro do Slack mantido)`);
      return { handled: true, action: 'accepted' };
    }

    if (REJECT.has(emoji)) {
      await this.db.query(
        `UPDATE v3.notifications SET status='admin_rejected', admin_action_by=$2, resolved_at=NOW() WHERE id=$1`,
        [notif.id, reactorPersonId]);
      if (slackEventId) {
        await this.db.query(
          `UPDATE v3.events SET deleted_at = NOW(), deleted_by = $2, updated_at = NOW()
           WHERE id = $1 AND deleted_at IS NULL`, [slackEventId, reactorPersonId]);
        await this._audit('notification_rejected_event_deleted', notif.id,
          { slack_event_id: slackEventId, reason: 'admin_rejected_via_notification' }, reactorPersonId);
      }
      await this._updateCarolinaMsg(ch, carolinaMsgTs, `❌ Ignorado por ${who} — ${headline} (registro apagado)`);
      return { handled: true, action: 'rejected' };
    }

    if (EDIT.has(emoji)) {
      await this.db.query(
        `UPDATE v3.notifications SET status='admin_edited', admin_action_by=$2, resolved_at=NOW() WHERE id=$1`,
        [notif.id, reactorPersonId]);
      await this._audit('notification_edit_requested', notif.id, { slack_event_id: slackEventId }, reactorPersonId);
      if (this.slack && this.slack.postAs) {
        try {
          await this.slack.postAs({
            channel: ch, sender: { name: 'Carolina' }, thread_ts: null,
            text: `📝 Beleza, ${who}. Me manda o ajuste mencionando a Carolina — o que você escrever é o que vale. Ex.:\n`
              + `> @Carolina muda o batch do ev${slackEventId || 'NNN'} pra 0181\n`
              + `> @Carolina ajusta started_at do ev${slackEventId || 'NNN'} pra 11:15 AM\n`
              + `(eu mostro o preview e você confirma com ✅)`,
          });
        } catch (e) { console.error('[notif] reply edit falhou:', e.message); }
      }
      await this._updateCarolinaMsg(ch, carolinaMsgTs, `📝 Em edição por ${who} — ${headline}`);
      return { handled: true, action: 'edit_requested' };
    }

    return { handled: false, reason: 'emoji_ignored' };
  }
}

module.exports = { NotificationHandler };
