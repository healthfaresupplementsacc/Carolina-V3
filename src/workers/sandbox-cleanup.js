'use strict';
/**
 * HEALTHFARE V3 — Sandbox cleanup (conta de teste do Bruno).
 *
 * HARD-delete (não soft) dos dados de sandbox pra eles sumirem rápido e ficarem
 * invisíveis pro resto do sistema:
 *  - events is_test=true que JÁ terminaram há >15s, OU abertos há >5min (esquecidos);
 *  - production_counts vinculados a esses events;
 *  - product_batches auto-criados por operador sandbox que ficaram sem nenhum event;
 *  - audit_log dos atores sandbox (puro ruído de teste).
 *
 * Tick rápido (5s). No-op barato quando não há operador sandbox.
 */
class SandboxCleanup {
  constructor(deps = {}) {
    this.db = deps.db;
    this._timer = null;
    this._ticking = false;
  }
  start(intervalMs = 5000) {
    this._timer = setInterval(() => this.tick().catch((e) => console.error('[sandbox-cleanup] tick erro:', e.message)), intervalMs);
    console.log('[V3] sandbox-cleanup ligado (tick ' + Math.round(intervalMs / 1000) + 's)');
  }
  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; }

  async tick() {
    if (this._ticking) return { skipped: true };
    this._ticking = true;
    try {
      const sb = await this.db.query('SELECT id FROM v3.persons WHERE is_sandbox = true');
      const sbIds = sb.rows.map((r) => r.id);
      if (!sbIds.length) return { events: 0 };

      // events de teste já vencidos (terminados há >15s, OU abertos há >5min)
      const exp = await this.db.query(
        `SELECT id FROM v3.events
         WHERE is_test = true
           AND (ended_at < NOW() - INTERVAL '15 seconds'
                OR (ended_at IS NULL AND started_at < NOW() - INTERVAL '5 minutes'))`);
      const ids = exp.rows.map((r) => r.id);
      if (ids.length) {
        await this.db.query('DELETE FROM v3.production_counts WHERE source_event_id = ANY($1::int[])', [ids]);
        await this.db.query('DELETE FROM v3.events WHERE id = ANY($1::int[])', [ids]);
      }
      // lotes auto-criados por sandbox que ficaram órfãos (sem nenhum event referenciando)
      await this.db.query(
        `DELETE FROM v3.product_batches pb
         WHERE pb.created_by_person_id = ANY($1::int[]) AND pb.origin = 'operator_created'
           AND NOT EXISTS (SELECT 1 FROM v3.events e WHERE e.product_batch_id = pb.id)`, [sbIds]);
      // ruído de auditoria do sandbox
      await this.db.query('DELETE FROM v3.audit_log WHERE actor_person_id = ANY($1::int[])', [sbIds]);
      return { events: ids.length };
    } finally { this._ticking = false; }
  }
}
module.exports = { SandboxCleanup };
