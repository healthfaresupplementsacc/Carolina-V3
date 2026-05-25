'use strict';
/**
 * HEALTHFARE V3 — SenderService.
 *
 * Porta-única do "Falar como" (manual post). Chama src/v3/slack/sender.js
 * pro Slack e ESCREVE NO AUDIT_LOG cada disparo — quem mandou (actor_type),
 * canal, persona, se tinha imagem, e o ts do post. Nada de "fire & forget".
 *
 * `sender` injetável (em teste passa fake). Em prod usa o módulo
 * src/v3/slack/sender.js direto.
 */

class SenderService {
  constructor(deps = {}) {
    this.db = deps.db;
    this.postFn = deps.postFn || require('../slack/sender').postAs;
  }

  /**
   * @param {object} opts
   *   channel       — 'production' | 'admin' | 'C...'
   *   text          — string (ou null se só imagem)
   *   sender        — { name, icon? }
   *   image         — { dataUrl, filename?, title? } opcional
   *   actorType     — 'admin' (default) | 'system'
   *   actorPersonId — opcional
   * @returns { ok, ts, channel, image_permalink?, audit_id }
   */
  async send(opts = {}) {
    const { channel, text, sender, image, actorType = 'admin', actorPersonId = null } = opts;
    if (!sender || !sender.name) throw new Error('sender.name obrigatório');
    if (!channel) throw new Error('channel obrigatório');
    if (!text && !image) throw new Error('text ou image obrigatório');

    // dispara no Slack PRIMEIRO; se Slack falhar, nada é gravado (rastro só
    // de posts efetivos). Erro propaga pra UI mostrar o motivo.
    const result = await this.postFn({ channel, text, sender, image });

    const meta = {
      channel: result.channel,
      slack_ts: result.ts,
      sender_name: sender.name,
      sender_icon: sender.icon || null,
      text_len: text ? text.length : 0,
      text_preview: text ? String(text).slice(0, 200) : null,
      has_image: !!image,
      image_filename: image && image.filename ? image.filename : null,
      image_permalink: result.image_permalink || null,
    };

    const a = await this.db.query(
      `INSERT INTO v3.audit_log
         (actor_type, actor_person_id, action, target_type, metadata)
       VALUES ($1, $2, 'manual_post.sent', 'slack', $3::jsonb)
       RETURNING id`,
      [actorType, actorPersonId, JSON.stringify(meta)]);

    return Object.assign({}, result, { audit_id: a.rows[0] && a.rows[0].id });
  }

  /** Lista os últimos N posts manuais (pra exibir "histórico" no dashboard). */
  async recentPosts(limit = 20) {
    const r = await this.db.query(
      `SELECT id, created_at, actor_type, actor_person_id, metadata
       FROM v3.audit_log
       WHERE action = 'manual_post.sent'
       ORDER BY created_at DESC
       LIMIT $1`, [Math.min(Math.max(1, parseInt(limit, 10) || 20), 100)]);
    return { posts: r.rows };
  }
}

module.exports = { SenderService };
