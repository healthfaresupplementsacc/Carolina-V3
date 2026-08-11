'use strict';
/**
 * HEALTHFARE V3 — Dedupe Watcher (Deploy 3).
 *
 * Slack continua input ALTERNATIVO: o Observer segue criando events de
 * msgs do canal de produção. Este worker (cron 60s) reconcilia:
 *
 *   Pra cada event source='slack' dos últimos 5min (não-superseded,
 *   não-linkado, não-notificado):
 *     MATCH na página (P9: mesma pessoa + mesmo activity_type + started_at
 *     ±120s + batch igual-ou-um-NULL) →
 *       INSERT v3.dedupe_links + UPDATE slack event
 *       SET superseded_by_event_id = page_event (soft hidden, sem delete)
 *       + audit actor_type='dedupe_worker'.
 *     SEM match E o event já tem ≥120s de idade (a janela fechou de vez) →
 *       INSERT v3.notifications(type='slack_event_not_on_page') +
 *       Carolina posta no #admin-orin pedindo ✅ aceita / ❌ ignora /
 *       📝 editar. Salva carolina_slack_ts pro handler de reactions.
 *
 * Liga via env WORKER_DEDUPE_ENABLED=true (wire.startWorker).
 */

const MATCH_WINDOW_S = 120;
const LOOKBACK_MIN = 5;

class DedupeWatcher {
  /** @param {{db, slack?:{postAs}, adminChannelId?:string}} deps */
  constructor(deps = {}) {
    this.db = deps.db;
    this.slack = deps.slack || null;
    this.adminChannelId = deps.adminChannelId || process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1';
    // Silent mode: continua matchando + criando notifications, mas NÃO posta
    // no Slack (evita spam enquanto operadores não migraram pra /op/).
    this.silentMode = deps.silentMode !== undefined
      ? deps.silentMode
      : (process.env.WORKER_DEDUPE_NOTIFICATIONS_SILENT_MODE === 'true');
    this._ticking = false;
    this._timer = null;
  }

  start(intervalMs = 60 * 1000) {
    this._timer = setInterval(() => {
      this.tick().catch((e) => console.error('[dedupe] tick erro:', e.message));
    }, intervalMs);
    console.log('[V3] dedupe-watcher ligado (tick ' + Math.round(intervalMs / 1000) + 's)');
  }

  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; }

  async _audit(action, targetId, metadata) {
    try {
      await this.db.query(
        `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
         VALUES ('dedupe_worker', NULL, $1, 'event', $2, $3::jsonb)`,
        [action, targetId, JSON.stringify(metadata || {})]);
    } catch (e) { console.error('[dedupe] audit falhou:', e.message); }
  }

  /** 1 varredura. Retorna { scanned, matched, notified } (telemetria/tests). */
  async tick() {
    if (this._ticking) return { scanned: 0, matched: 0, notified: 0, skipped: 'overlap' };
    this._ticking = true;
    try {
      const candidates = await this.db.query(`
        SELECT e.id, e.person_id, e.activity_type_id, e.product_batch_id, e.started_at,
               e.description, p.display_name, at.slug, pb.batch_number,
               EXTRACT(EPOCH FROM (NOW() - e.created_at)) AS age_s
        FROM v3.events e
        JOIN v3.persons p ON p.id = e.person_id
        LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
        LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
        WHERE e.source = 'slack'
          AND e.created_at > NOW() - INTERVAL '${LOOKBACK_MIN} minutes'
          AND e.deleted_at IS NULL
          AND e.superseded_by_event_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM v3.dedupe_links dl WHERE dl.slack_event_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM v3.notifications n
                          WHERE n.type = 'slack_event_not_on_page'
                            AND (n.payload->>'slack_event_id')::bigint = e.id)
        ORDER BY e.id LIMIT 50`);

      let matched = 0; let notified = 0;
      for (const ev of candidates.rows) {
        const m = await this.db.query(`
          SELECT pg.id FROM v3.events pg
          WHERE pg.source = 'operator_page'
            AND pg.deleted_at IS NULL
            AND pg.person_id = $1
            AND pg.activity_type_id = $2
            AND ABS(EXTRACT(EPOCH FROM (pg.started_at - $3::timestamptz))) <= ${MATCH_WINDOW_S}
            AND ($4::int IS NULL OR pg.product_batch_id IS NULL OR pg.product_batch_id = $4)
            AND NOT EXISTS (SELECT 1 FROM v3.dedupe_links dl2 WHERE dl2.page_event_id = pg.id)
          ORDER BY ABS(EXTRACT(EPOCH FROM (pg.started_at - $3::timestamptz)))
          LIMIT 1`, [ev.person_id, ev.activity_type_id, ev.started_at, ev.product_batch_id]);

        if (m.rows.length) {
          const pageId = m.rows[0].id;
          await this.db.query(
            `INSERT INTO v3.dedupe_links (slack_event_id, page_event_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ev.id, pageId]);
          await this.db.query(
            `UPDATE v3.events SET superseded_by_event_id = $2, updated_at = NOW() WHERE id = $1`,
            [ev.id, pageId]);
          await this._audit('dedupe_matched', ev.id, { page_event_id: pageId, slug: ev.slug });
          matched += 1;
          continue;
        }

        // sem match: só notifica quando a janela de ±120s já fechou
        if (Number(ev.age_s) < MATCH_WINDOW_S) continue;

        const deliveryMethod = this.silentMode ? 'admin_inbox_only' : 'slack_and_inbox';
        const notif = await this.db.query(
          `INSERT INTO v3.notifications (type, payload, status, delivery_method)
           VALUES ('slack_event_not_on_page', $1::jsonb, 'pending', $2) RETURNING id`,
          [JSON.stringify({
            slack_event_id: ev.id, person: ev.display_name, slug: ev.slug,
            batch: ev.batch_number, started_at: ev.started_at,
            raw_slack_text: (ev.description || '').slice(0, 200),
          }), deliveryMethod]);
        const notifId = notif.rows[0].id;
        let carolinaTs = null;
        // silent mode: registra no inbox, NÃO posta no Slack
        if (!this.silentMode && this.slack && this.slack.postAs) {
          try {
            const r = await this.slack.postAs({
              channel: this.adminChannelId, sender: { name: 'Carolina' }, thread_ts: null,
              text: `🔔 *${ev.display_name}* postou no Slack:\n> ${(ev.description || ev.slug || '').slice(0, 180)}\n`
                + `(${ev.slug || '?'}${ev.batch_number ? ' · ' + ev.batch_number : ''}) , sem task correspondente na página.\n\n`
                + `✅ Aceita (mantém o registro)   ❌ Ignora (apaga)   📝 Editar`,
            });
            carolinaTs = r && r.ts;
            if (carolinaTs) {
              await this.db.query('UPDATE v3.notifications SET carolina_slack_ts = $2 WHERE id = $1', [notifId, carolinaTs]);
            }
          } catch (e) { console.error('[dedupe] post Carolina falhou:', e.message); }
        }
        await this._audit('dedupe_orphan_notified', ev.id, { notification_id: notifId, carolina_ts: carolinaTs, delivery_method: deliveryMethod });
        notified += 1;
      }
      return { scanned: candidates.rowCount, matched, notified };
    } finally {
      this._ticking = false;
    }
  }
}

module.exports = { DedupeWatcher, MATCH_WINDOW_S };
