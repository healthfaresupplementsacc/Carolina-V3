'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.6 — ProductionCountService (V3 doc §3.12)
 *
 * Contagens de garrafas (v3.production_counts).
 *
 * REGRA SUPERSEDE: correção de contagem NUNCA deleta. supersede()
 * cria uma row nova e marca a antiga com superseded_by → a nova.
 * Histórico preservado. Totais sempre excluem superseded
 * (WHERE superseded_by IS NULL). Chain A→B→C: só C conta.
 *
 * REGRA PARCIAL vs TOTAL: a DECISÃO semântica (a EOD "Rutin-684" é
 * total do dia ou incremento?) é do LLM Observer. Este service só
 * EXECUTA: expõe record() (nova contagem) e supersede() (substitui).
 * O Observer escolhe qual chamar.
 *
 * Princípio #24: toda query é schema-qualificada v3.*.
 */

const { VALID_ACTOR_TYPES } = require('./EventService');

const CONFIDENCE = ['high', 'medium', 'low', 'unconfirmed'];

class ProductionCountService {
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
       VALUES ($1, $2, $3, 'production_count', $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
      [actorType, actorPersonId || null, action, targetId || null,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        metadata ? JSON.stringify(metadata) : null]);
  }

  async _patch(c, id, fields) {
    const keys = Object.keys(fields);
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const r = await c.query(
      `UPDATE v3.production_counts SET ${set}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, ...keys.map((k) => fields[k])]);
    return r.rows[0];
  }

  async _insert(c, p) {
    const cols = ['product_id', 'product_batch_id', 'bottles', 'reported_at',
      'production_date', 'reported_by_person_id', 'source_message_ts', 'source_event_id',
      'notes', 'confidence', 'unit', 'possible_duplicate_of'];
    const vals = [
      p.product_id, p.product_batch_id || null, p.bottles, p.reported_at,
      p.production_date, p.reported_by_person_id, p.source_message_ts || null,
      p.source_event_id || null, p.notes || null, p.confidence || 'high',
      p.unit || 'bottle', p.possible_duplicate_of || null];
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
    const r = await c.query(
      `INSERT INTO v3.production_counts (${cols.join(', ')}) VALUES (${ph}) RETURNING *`, vals);
    return r.rows[0];
  }

  async _getById(c, id) {
    const r = await c.query('SELECT * FROM v3.production_counts WHERE id = $1', [id]);
    return r.rows[0] || null;
  }

  _checkBottles(bottles) {
    if (!Number.isInteger(bottles) || bottles < 0) {
      throw new Error('bottles inválido (precisa ser inteiro >= 0): ' + bottles);
    }
  }

  // ── record ─────────────────────────────────────────────────

  /**
   * Registra uma contagem. Idempotente por source_message_ts —
   * re-processar a mesma mensagem devolve a contagem existente.
   * product_batch_id pode ser NULL (batch ambíguo → proposta admin).
   */
  async record(p = {}) {
    const actorType = this._actor(p.actor_type);
    if (!p.product_id) throw new Error('record: product_id obrigatório');
    if (!p.reported_by_person_id) throw new Error('record: reported_by_person_id obrigatório');
    if (!p.production_date) throw new Error('record: production_date obrigatório');
    this._checkBottles(p.bottles);
    if (p.confidence && !CONFIDENCE.includes(p.confidence)) {
      throw new Error('record: confidence inválida: ' + p.confidence);
    }
    return this._withTx(async (c) => {
      if (p.source_message_ts) {
        const ex = await c.query(
          `SELECT * FROM v3.production_counts
           WHERE source_message_ts = $1 AND deleted_at IS NULL
           ORDER BY id LIMIT 1`, [p.source_message_ts]);
        if (ex.rows[0]) return ex.rows[0]; // idempotente — não duplica
      }
      // Anti-duplicação §7.6: mesmo número, mesmo produto/lote/dia, já
      // registrado e vivo → marca a suspeita (possible_duplicate_of).
      // NÃO soma, NÃO rejeita — grava marcado; o realizado ignora marcados.
      const dup = await c.query(
        `SELECT id FROM v3.production_counts
         WHERE product_id = $1 AND bottles = $2 AND production_date = $3
           AND product_batch_id IS NOT DISTINCT FROM $4
           AND superseded_by IS NULL AND deleted_at IS NULL AND possible_duplicate_of IS NULL
         ORDER BY id LIMIT 1`,
        [p.product_id, p.bottles, p.production_date, p.product_batch_id || null]);
      const possibleDuplicateOf = dup.rows[0] ? dup.rows[0].id : null;

      const row = await this._insert(c, {
        product_id: p.product_id,
        product_batch_id: p.product_batch_id || null,
        bottles: p.bottles,
        reported_at: p.reported_at || this._now(),
        production_date: p.production_date,
        reported_by_person_id: p.reported_by_person_id,
        source_message_ts: p.source_message_ts || null,
        source_event_id: p.source_event_id || null,
        notes: p.notes || null,
        confidence: p.confidence || 'high',
        unit: p.unit || 'bottle',
        possible_duplicate_of: possibleDuplicateOf,
      });
      await this._audit(c, {
        actorType, actorPersonId: p.actor_person_id, action: 'count.recorded',
        targetId: row.id, after: row,
        metadata: {
          ambiguous_batch: !p.product_batch_id,
          possible_duplicate_of: possibleDuplicateOf,
        },
      });
      return row;
    });
  }

  // ── supersede ──────────────────────────────────────────────

  /**
   * Corrige uma contagem: cria uma row nova com new_bottles e marca
   * a antiga com superseded_by. NUNCA deleta a antiga.
   */
  async supersede(countId, newBottles, byPersonId, note, actorTypeRaw = 'admin') {
    const actorType = this._actor(actorTypeRaw);
    this._checkBottles(newBottles);
    return this._withTx(async (c) => {
      const old = await this._getById(c, countId);
      if (!old) throw new Error('supersede: count ' + countId + ' não existe');
      if (old.superseded_by != null) {
        throw new Error('supersede: count ' + countId + ' já foi superseded por ' + old.superseded_by);
      }
      // nova row — herda contexto da antiga; a correção não é
      // derivada de mensagem, então source_message_ts/event ficam NULL.
      const fresh = await this._insert(c, {
        product_id: old.product_id,
        product_batch_id: old.product_batch_id,
        bottles: newBottles,
        reported_at: old.reported_at,
        production_date: old.production_date,
        reported_by_person_id: old.reported_by_person_id,
        source_message_ts: null,
        source_event_id: null,
        notes: note || null,
        confidence: old.confidence,
      });
      const updatedOld = await this._patch(c, countId, { superseded_by: fresh.id });
      await this._audit(c, {
        actorType, actorPersonId: byPersonId, action: 'count.superseded',
        targetId: countId, before: old, after: { old: updatedOld, fresh },
        metadata: { new_count_id: fresh.id, old_bottles: old.bottles, new_bottles: newBottles, note: note || null },
      });
      return fresh;
    });
  }

  // ── reassign / soft delete ─────────────────────────────────

  async reassign(countId, newBatchId, byPersonId, actorTypeRaw = 'admin') {
    const actorType = this._actor(actorTypeRaw);
    return this._withTx(async (c) => {
      const before = await this._getById(c, countId);
      if (!before) throw new Error('reassign: count ' + countId + ' não existe');
      const after = await this._patch(c, countId, { product_batch_id: newBatchId });
      await this._audit(c, {
        actorType, actorPersonId: byPersonId, action: 'count.reassigned',
        targetId: countId, before, after,
        metadata: { from: before.product_batch_id, to: newBatchId },
      });
      return after;
    });
  }

  async softDelete(countId, byPersonId, reason, actorTypeRaw = 'admin') {
    const actorType = this._actor(actorTypeRaw);
    return this._withTx(async (c) => {
      const before = await this._getById(c, countId);
      if (!before) throw new Error('softDelete: count ' + countId + ' não existe');
      const after = await this._patch(c, countId, { deleted_at: this._now(), deleted_by: byPersonId || null });
      await this._audit(c, {
        actorType, actorPersonId: byPersonId, action: 'count.deleted',
        targetId: countId, before, after, metadata: { reason: reason || null },
      });
      return after;
    });
  }

  async restore(countId, byPersonId, actorTypeRaw = 'admin') {
    const actorType = this._actor(actorTypeRaw);
    return this._withTx(async (c) => {
      const before = await this._getById(c, countId);
      if (!before) throw new Error('restore: count ' + countId + ' não existe');
      const after = await this._patch(c, countId, { deleted_at: null, deleted_by: null });
      await this._audit(c, {
        actorType, actorPersonId: byPersonId, action: 'count.restored',
        targetId: countId, before, after,
      });
      return after;
    });
  }

  /**
   * Confirma que uma contagem marcada como suspeita de duplicata é, na
   * verdade, produção ADICIONAL: limpa possible_duplicate_of → ela passa
   * a entrar na soma do realizado. Decisão do admin (Bloco 3 §7.6).
   */
  async confirmNotDuplicate(countId, byPersonId, actorTypeRaw = 'admin') {
    const actorType = this._actor(actorTypeRaw);
    return this._withTx(async (c) => {
      const before = await this._getById(c, countId);
      if (!before) throw new Error('confirmNotDuplicate: count ' + countId + ' não existe');
      const after = await this._patch(c, countId, { possible_duplicate_of: null });
      await this._audit(c, {
        actorType, actorPersonId: byPersonId, action: 'count.confirmed_not_duplicate',
        targetId: countId, before, after,
      });
      return after;
    });
  }

  // ── leitura ────────────────────────────────────────────────

  /** Contagens vivas (não-superseded, não-deletadas) de um batch. */
  async listForBatch(batchId) {
    const r = await this.db.query(
      `SELECT * FROM v3.production_counts
       WHERE product_batch_id = $1 AND superseded_by IS NULL AND deleted_at IS NULL
       ORDER BY reported_at`, [batchId]);
    return r.rows;
  }

  /** Contagens vivas de um produto num dia (ET). */
  async listForProductDay(productId, productionDate) {
    const r = await this.db.query(
      `SELECT * FROM v3.production_counts
       WHERE product_id = $1 AND production_date = $2
         AND superseded_by IS NULL AND deleted_at IS NULL
       ORDER BY reported_at`, [productId, productionDate]);
    return r.rows;
  }

  /** Total de garrafas do batch — exclui superseded e deletadas. */
  async totalForBatch(batchId) {
    const rows = await this.listForBatch(batchId);
    return rows.reduce((s, c) => s + Number(c.bottles || 0), 0);
  }

  /** Total do produto no dia — exclui superseded e deletadas. */
  async totalForProductDay(productId, productionDate) {
    const rows = await this.listForProductDay(productId, productionDate);
    return rows.reduce((s, c) => s + Number(c.bottles || 0), 0);
  }
}

module.exports = { ProductionCountService, CONFIDENCE };
