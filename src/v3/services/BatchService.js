'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.5 — BatchService (V3 doc §3.12 + §6.11)
 *
 * Gestão de v3.product_batches: criar/achar, fechar, mesclar,
 * reatribuir events, listar ativos, e o getSummary com DEDUP de
 * cowork (§6.11) — 3 pessoas juntas 10:00-11:30 contam 1h30, não
 * 4h30, via UNIÃO temporal dos intervalos.
 *
 * EXCEÇÃO AUTORIZADA à porta-única do EventService (§6.4):
 * reassignEvents e mergeBatches fazem UPDATE direto (bulk) em
 * v3.events.product_batch_id. É move estrutural de FK — não toca
 * lifecycle/timeline/cowork/idempotência (o que a porta-única
 * protege). A atomicidade do merge exige. Auditado via
 * 'batch.events_reassigned' / 'batch.merged'. Aprovado por Bruno
 * Camp. É a ÚNICA exceção autorizada — NÃO usar como precedente
 * pra outras escritas diretas em v3.events.
 *
 * Princípio #24: toda query é schema-qualificada v3.*.
 */

const { VALID_ACTOR_TYPES } = require('./EventService');

const BATCH_STATUS = ['in_progress', 'completed', 'cancelled', 'on_hold'];
const uniq = (a) => [...new Set(a)];

/**
 * Soma a duração da UNIÃO de intervalos — sobreposição (cowork)
 * conta uma vez só.
 * @param {Array<{start:Date,end:Date}>} intervals
 * @returns {number} segundos
 */
function unionSeconds(intervals) {
  const sorted = intervals
    .filter((i) => i.start && i.end && i.end > i.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = null;
  let curEnd = null;
  for (const { start, end } of sorted) {
    if (curStart === null) { curStart = start; curEnd = end; }
    else if (start <= curEnd) { if (end > curEnd) curEnd = end; }
    else { total += curEnd - curStart; curStart = start; curEnd = end; }
  }
  if (curStart !== null) total += curEnd - curStart;
  return Math.round(total / 1000);
}

class BatchService {
  /** @param {object} deps  deps.db = pool pg (search_path v3,public) */
  constructor(deps = {}) {
    this.db = deps.db;
    this._now = deps.now || (() => new Date());
  }

  // ── infra ──────────────────────────────────────────────────

  async _withTx(fn) {
    const hasPool = typeof this.db.connect === 'function';
    const client = hasPool ? await this.db.connect() : this.db;
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignora */ }
      throw e;
    } finally {
      if (hasPool && typeof client.release === 'function') client.release();
    }
  }

  _actor(type) {
    const t = type || 'system';
    if (!VALID_ACTOR_TYPES.includes(t)) throw new Error('actor_type inválido: ' + type);
    return t;
  }

  async _audit(c, { actorType, actorPersonId, action, targetId, before, after, metadata }) {
    await c.query(
      `INSERT INTO v3.audit_log
         (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data, metadata)
       VALUES ($1, $2, $3, 'product_batch', $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
      [actorType, actorPersonId || null, action, targetId || null,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        metadata ? JSON.stringify(metadata) : null]);
  }

  async _patchBatch(c, id, fields) {
    const keys = Object.keys(fields);
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const r = await c.query(
      `UPDATE v3.product_batches SET ${set}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, ...keys.map((k) => fields[k])]);
    return r.rows[0];
  }

  async _getBatch(c, id) {
    const r = await c.query('SELECT * FROM v3.product_batches WHERE id = $1', [id]);
    return r.rows[0] || null;
  }

  // ── métodos ────────────────────────────────────────────────

  /**
   * Acha o batch de um produto+número (não-deletado) ou cria um
   * novo in_progress. (UNIQUE(product_id,batch_number) garante 1 só.)
   */
  async findOrCreateActive(productId, batchNumber, startedAt, opts = {}) {
    const actorType = this._actor(opts.actorType);
    if (!productId) throw new Error('findOrCreateActive: product_id obrigatório');
    if (batchNumber == null) throw new Error('findOrCreateActive: batch_number obrigatório');
    return this._withTx(async (c) => {
      const ex = await c.query(
        `SELECT * FROM v3.product_batches
         WHERE product_id = $1 AND batch_number = $2 AND deleted_at IS NULL
         ORDER BY id LIMIT 1`, [productId, batchNumber]);
      if (ex.rows[0]) return ex.rows[0];
      const ins = await c.query(
        `INSERT INTO v3.product_batches (product_id, batch_number, started_at, status)
         VALUES ($1, $2, $3, 'in_progress') RETURNING *`,
        [productId, batchNumber, startedAt || this._now()]);
      await this._audit(c, {
        actorType, actorPersonId: opts.actorPersonId, action: 'batch.created',
        targetId: ins.rows[0].id, after: ins.rows[0],
      });
      return ins.rows[0];
    });
  }

  async closeBatch(id, finishedAt, status, opts = {}) {
    const actorType = this._actor(opts.actorType || 'admin');
    if (!BATCH_STATUS.includes(status) || status === 'in_progress') {
      throw new Error('closeBatch: status inválido p/ fechar: ' + status);
    }
    return this._withTx(async (c) => {
      const before = await this._getBatch(c, id);
      if (!before) throw new Error('closeBatch: batch ' + id + ' não existe');
      const after = await this._patchBatch(c, id, {
        status, finished_at: finishedAt || this._now(),
      });
      await this._audit(c, {
        actorType, actorPersonId: opts.actorPersonId, action: 'batch.closed',
        targetId: id, before, after, metadata: { status },
      });
      return after;
    });
  }

  /** Move todos os events de um batch p/ outro (UPDATE direto — ver NOTA). */
  async reassignEvents(fromBatchId, toBatchId, opts = {}) {
    const actorType = this._actor(opts.actorType || 'admin');
    return this._withTx(async (c) => {
      // EXCEÇÃO AUTORIZADA à porta-única do EventService (ver NOTA no
      // topo): bulk UPDATE de FK. NÃO usar como precedente.
      const r = await c.query(
        `UPDATE v3.events SET product_batch_id = $2, updated_at = NOW()
         WHERE product_batch_id = $1 AND deleted_at IS NULL RETURNING id`,
        [fromBatchId, toBatchId]);
      const ids = r.rows.map((x) => x.id);
      await this._audit(c, {
        actorType, actorPersonId: opts.actorPersonId, action: 'batch.events_reassigned',
        targetId: toBatchId, metadata: { from: fromBatchId, to: toBatchId, event_ids: ids },
      });
      return { reassigned: ids };
    });
  }

  /**
   * Funde N batches em 1. Sobrevivente = menor started_at. Events e
   * production_counts dos outros migram pro sobrevivente; os outros
   * viram soft-deleted. Tudo numa transação.
   */
  async mergeBatches(batchIds = [], opts = {}) {
    const actorType = this._actor(opts.actorType || 'admin');
    if (!Array.isArray(batchIds) || batchIds.length < 2) {
      throw new Error('mergeBatches: precisa de >= 2 batch_ids');
    }
    return this._withTx(async (c) => {
      const batches = [];
      for (const id of batchIds) {
        const b = await this._getBatch(c, id);
        if (!b) throw new Error('mergeBatches: batch ' + id + ' não existe');
        batches.push(b);
      }
      batches.sort((a, b) => (new Date(a.started_at) - new Date(b.started_at)) || (a.id - b.id));
      const survivor = batches[0];
      const losers = batches.slice(1);
      for (const lo of losers) {
        // EXCEÇÃO AUTORIZADA à porta-única do EventService (ver NOTA no
        // topo): bulk UPDATE de FK. NÃO usar como precedente.
        await c.query(
          `UPDATE v3.events SET product_batch_id = $2, updated_at = NOW()
           WHERE product_batch_id = $1 AND deleted_at IS NULL`, [lo.id, survivor.id]);
        await c.query(
          `UPDATE v3.production_counts SET product_batch_id = $2, updated_at = NOW()
           WHERE product_batch_id = $1 AND deleted_at IS NULL`, [lo.id, survivor.id]);
        await this._patchBatch(c, lo.id, {
          deleted_at: this._now(), deleted_by: opts.actorPersonId || null,
        });
      }
      await this._audit(c, {
        actorType, actorPersonId: opts.actorPersonId, action: 'batch.merged',
        targetId: survivor.id, before: { batches },
        metadata: { survivor: survivor.id, merged_ids: losers.map((x) => x.id) },
      });
      return await this._getBatch(c, survivor.id);
    });
  }

  async listActive() {
    const r = await this.db.query(
      `SELECT * FROM v3.product_batches
       WHERE status = 'in_progress' AND deleted_at IS NULL
       ORDER BY started_at`);
    return r.rows;
  }

  /**
   * Resumo do batch. tempo_total com DEDUP de cowork (§6.11):
   * intervalos sobrepostos contam uma vez só (unionSeconds).
   */
  async getSummary(batchId) {
    const batch = (await this.db.query(
      'SELECT * FROM v3.product_batches WHERE id = $1', [batchId])).rows[0];
    if (!batch) throw new Error('getSummary: batch ' + batchId + ' não existe');

    const events = (await this.db.query(
      `SELECT id, person_id, activity_type_id, started_at, ended_at
       FROM v3.events
       WHERE product_batch_id = $1 AND deleted_at IS NULL
       ORDER BY started_at`, [batchId])).rows;

    const counts = (await this.db.query(
      `SELECT bottles FROM v3.production_counts
       WHERE product_batch_id = $1 AND superseded_by IS NULL AND deleted_at IS NULL`,
      [batchId])).rows;

    const now = this._now();
    const intervals = events.map((e) => ({
      start: e.started_at ? new Date(e.started_at) : null,
      end: e.ended_at ? new Date(e.ended_at) : now,
    }));
    const totalSeconds = unionSeconds(intervals);

    // fases na ordem cronológica de 1ª ocorrência
    const phaseIds = uniq(events.map((e) => e.activity_type_id).filter((x) => x != null));
    let phases = [];
    if (phaseIds.length) {
      const ats = (await this.db.query(
        'SELECT id, slug, display_name FROM v3.activity_types WHERE id = ANY($1)', [phaseIds]))
        .rows;
      const byId = new Map(ats.map((a) => [a.id, a]));
      phases = phaseIds.map((id) => {
        const a = byId.get(id);
        return { activity_type_id: id, slug: a ? a.slug : null, display_name: a ? a.display_name : null };
      });
    }

    // pessoas envolvidas
    const personIds = uniq(events.map((e) => e.person_id).filter((x) => x != null));
    let people = [];
    if (personIds.length) {
      const ps = (await this.db.query(
        'SELECT id, display_name FROM v3.persons WHERE id = ANY($1)', [personIds])).rows;
      const byId = new Map(ps.map((p) => [p.id, p]));
      people = personIds.map((id) => ({
        person_id: id, display_name: byId.get(id) ? byId.get(id).display_name : null,
      }));
    }

    return {
      batch_id: batch.id,
      product_id: batch.product_id,
      batch_number: batch.batch_number,
      status: batch.status,
      started_at: batch.started_at,
      finished_at: batch.finished_at,
      total_seconds: totalSeconds,
      event_count: events.length,
      people,
      phases,
      bottles: counts.reduce((s, c) => s + Number(c.bottles || 0), 0),
    };
  }
}

module.exports = { BatchService, unionSeconds, BATCH_STATUS };
