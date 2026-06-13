'use strict';
/**
 * HEALTHFARE V3 — Proactive Alerts (Fase G bloco-zerar). Cron 30min.
 *
 * 3 checagens que viram notification (deduplicadas) + Carolina avisa admin:
 *  1. operator_long_idle — sessão logada sem atividade há 2h (dedupe por session_id).
 *  2. event_stale_no_close — task foreground aberta há 3h+ (dedupe por event_id).
 *  3. bottle_count_anomaly — count com desvio >70% da média 30d do supplement
 *     (dedupe por production_count id).
 *
 * Liga via WORKER_PROACTIVE_ALERTS_ENABLED=true.
 */
const ANOMALY_PCT = 0.70;

class ProactiveAlerts {
  constructor(deps = {}) {
    this.db = deps.db;
    this.slack = deps.slack || null;
    this.adminChannelId = deps.adminChannelId || process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1';
    this._ticking = false;
    this._timer = null;
  }
  start(intervalMs = 30 * 60 * 1000) {
    this._timer = setInterval(() => this.tick().catch((e) => console.error('[proactive] tick erro:', e.message)), intervalMs);
    console.log('[V3] proactive-alerts ligado (tick ' + Math.round(intervalMs / 60000) + 'min)');
  }
  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; }

  /** Cria notification + posta Carolina, deduplicando por chave em metadata. */
  async _notify(type, dedupeField, dedupeVal, payload, text) {
    const exists = await this.db.query(
      `SELECT 1 FROM v3.notifications WHERE type=$1 AND status='pending'
         AND (payload->>$2) = $3 LIMIT 1`, [type, dedupeField, String(dedupeVal)]);
    if (exists.rows.length) return false;
    const notif = await this.db.query(
      `INSERT INTO v3.notifications (type, payload, status) VALUES ($1, $2::jsonb, 'pending') RETURNING id`,
      [type, JSON.stringify(payload)]);
    let ts = null;
    if (this.slack && this.slack.postAs) {
      try {
        const r = await this.slack.postAs({ channel: this.adminChannelId, sender: { name: 'Carolina' }, thread_ts: null, text });
        ts = r && r.ts;
        if (ts) await this.db.query('UPDATE v3.notifications SET carolina_slack_ts=$2 WHERE id=$1', [notif.rows[0].id, ts]);
      } catch (e) { console.error('[proactive] post falhou:', e.message); }
    }
    return true;
  }

  async tick() {
    if (this._ticking) return { skipped: 'overlap' };
    this._ticking = true;
    const out = { idle: 0, stale: 0, anomaly: 0 };
    try {
      // 1 ── operator_long_idle ──
      const idle = await this.db.query(`
        SELECT s.id AS session_id, p.display_name,
               to_char(s.created_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS logged_edt,
               ROUND(EXTRACT(EPOCH FROM (NOW() - s.last_activity_at)) / 60) AS idle_min
        FROM v3.operator_sessions s JOIN v3.persons p ON p.id = s.person_id
        WHERE s.logged_out_at IS NULL AND s.last_activity_at < NOW() - INTERVAL '2 hours'`);
      for (const r of idle.rows) {
        const ok = await this._notify('operator_long_idle', 'session_id', r.session_id,
          { session_id: r.session_id, person: r.display_name, logged_at: r.logged_edt, idle_min: Number(r.idle_min) },
          `💤 ${r.display_name} está logado mas sem atividade há ${Math.round(r.idle_min)}min (entrou ${r.logged_edt}). Esqueceu de sair?\n✅ ok   💤 force logout`);
        if (ok) out.idle += 1;
      }
      // 2 ── event_stale_no_close ──
      const stale = await this.db.query(`
        SELECT e.id, p.display_name, at.slug, pb.batch_number,
               ROUND(EXTRACT(EPOCH FROM (NOW() - e.started_at)) / 3600, 1) AS h_aberto
        FROM v3.events e JOIN v3.persons p ON p.id = e.person_id
        LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
        LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
        WHERE e.deleted_at IS NULL AND e.ended_at IS NULL AND e.is_long_running = false
          AND e.started_at < NOW() - INTERVAL '3 hours'`);
      for (const r of stale.rows) {
        const ok = await this._notify('event_stale_no_close', 'event_id', r.id,
          { event_id: r.id, slack_event_id: r.id, person: r.display_name, slug: r.slug, batch: r.batch_number, h_open: Number(r.h_aberto) },
          `⏰ Task ev${r.id} de ${r.display_name} (${r.slug || '?'}${r.batch_number ? ' ' + r.batch_number : ''}) aberta há ${r.h_aberto}h. Esqueceu de fechar?\n✅ ignora   ⏱️ fecha agora`);
        if (ok) out.stale += 1;
      }
      // 3 ── bottle_count_anomaly ──
      const counts = await this.db.query(`
        SELECT pc.id, pc.bottles, pr.canonical_name AS product, pb.batch_number, pb.product_id
        FROM v3.production_counts pc
        JOIN v3.product_batches pb ON pb.id = pc.product_batch_id
        JOIN v3.products pr ON pr.id = pb.product_id
        WHERE pc.deleted_at IS NULL AND pc.created_at > NOW() - INTERVAL '24 hours'`);
      for (const c of counts.rows) {
        const avgR = await this.db.query(`
          SELECT ROUND(AVG(pc.bottles)) AS avg FROM v3.production_counts pc
          JOIN v3.product_batches pb ON pb.id = pc.product_batch_id
          WHERE pb.product_id = $1 AND pc.deleted_at IS NULL
            AND pc.created_at BETWEEN NOW() - INTERVAL '30 days' AND NOW() - INTERVAL '24 hours'`, [c.product_id]);
        const avg = avgR.rows[0] && avgR.rows[0].avg ? Number(avgR.rows[0].avg) : null;
        if (!avg || avg <= 0) continue;
        const dev = Math.abs(c.bottles - avg) / avg;
        if (dev < ANOMALY_PCT) continue;
        const pct = Math.round((c.bottles - avg) / avg * 100);
        const ok = await this._notify('bottle_count_anomaly', 'count_id', c.id,
          { count_id: c.id, product: c.product, batch: c.batch_number, bottles: c.bottles, avg, deviation_pct: pct },
          `📊 Count anômalo: ${c.product} ${c.batch_number || ''} = ${c.bottles} bottles (média recente: ${avg}, ${pct > 0 ? '+' : ''}${pct}%). Erro de digitação?\n✅ ok   📝 corrigir`);
        if (ok) out.anomaly += 1;
      }
      // 4 ── high_orders_printed_anomaly (Fase G addition) ──
      out.orders = 0;
      const op = await this.db.query(`
        SELECT e.id, e.orders_printed, e.person_id, p.display_name,
               (SELECT ROUND(AVG(e2.orders_printed)) FROM v3.events e2
                WHERE e2.person_id = e.person_id AND e2.orders_printed > 0 AND e2.deleted_at IS NULL
                  AND e2.created_at BETWEEN NOW() - INTERVAL '30 days' AND NOW() - INTERVAL '24 hours') AS avg_orders
        FROM v3.events e JOIN v3.persons p ON p.id = e.person_id
        WHERE e.deleted_at IS NULL AND e.orders_printed > 0 AND e.created_at > NOW() - INTERVAL '24 hours'`);
      for (const r of op.rows) {
        const avg = r.avg_orders ? Number(r.avg_orders) : null;
        if (!avg || avg <= 0 || r.orders_printed <= avg * 3) continue;
        const ok = await this._notify('high_orders_printed_anomaly', 'event_id', r.id,
          { event_id: r.id, person: r.display_name, orders_printed: r.orders_printed, avg },
          `🔢 ${r.display_name} registrou ${r.orders_printed} ordens (média dele: ${avg}). Erro de digitação no teclado?\n✅ ok   📝 corrigir`);
        if (ok) out.orders += 1;
      }
      // 5 ── voice_storage_quota_warning (Fase G addition) ──
      out.quota = 0;
      const vq = await this.db.query(`SELECT COALESCE(SUM(audio_size_bytes),0)::bigint b FROM v3.voice_recordings WHERE deleted_at IS NULL`);
      const usedMb = Math.round(Number(vq.rows[0].b) / 1048576);
      if (usedMb >= 400) { // PG volume é 500MB
        const ok = await this._notify('voice_storage_quota_warning', 'bucket', 'voice',
          { used_mb: usedMb, limit_mb: 500 },
          `💾 Armazenamento de áudio em ${usedMb}MB / 500MB. Limpa gravações antigas (>90d) ou aumenta o plano.`);
        if (ok) out.quota += 1;
      }
      return out;
    } finally {
      this._ticking = false;
    }
  }
}

module.exports = { ProactiveAlerts, ANOMALY_PCT };
