'use strict';
/**
 * HEALTHFARE V3 — Bloco 2 — GoalService (V3 doc §7).
 *
 * PORTA ÚNICA de escrita em v3.production_goals (a META / esperado).
 * Idempotência: quando a meta vem do canal, por (source_message_ts,
 * batch_number) — re-processar a mensagem do Henrique não duplica.
 * Audit em CADA mutação.
 *
 * Princípio #24: queries v3.* schema-qualificadas.
 */

const VALID_ACTOR_TYPES = ['admin', 'llm_observer', 'llm_assistant', 'system', 'app_home'];
const CORRECTABLE = new Set([
  'product_id', 'batch_number', 'expected_quantity', 'unit',
  'destinations', 'production_date', 'confidence', 'notes',
]);

/** Normaliza nº de lote p/ casar esperado×realizado: extrai o grupo
 *  numérico final. "BR-2026-0135"→"0135", "Plant (0135)"→"0135". */
function normalizeBatchNumber(raw) {
  if (raw == null) return null;
  const groups = String(raw).match(/\d+/g);
  if (!groups || !groups.length) return String(raw).trim() || null;
  return groups[groups.length - 1];
}

class GoalService {
  constructor(deps = {}) {
    this.db = deps.db;
  }

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
       VALUES ($1, $2, $3, 'production_goal', $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
      [actorType, actorPersonId || null, action, targetId || null,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        metadata ? JSON.stringify(metadata) : null]);
  }

  async _getById(c, id) {
    const r = await c.query('SELECT * FROM v3.production_goals WHERE id = $1', [id]);
    return r.rows[0] || null;
  }

  /** Notifica o admin quando uma meta nasce SEM produto identificado (vira "(?)"). */
  async _notifyNoProduct(c, goal, batchNorm, p) {
    try {
      await c.query(
        `INSERT INTO v3.notifications (type, payload, status)
         VALUES ('goal_no_product', $1::jsonb, 'pending')`,
        [JSON.stringify({
          goal_id: goal.id, batch_number: batchNorm || null,
          expected_quantity: p.expected_quantity, source: p.source || null,
          source_message_ts: p.source_message_ts || null,
          text: 'Meta criada sem produto identificado' + (batchNorm ? ' (lote ' + batchNorm + ')' : '') + ' — confirme qual suplemento.',
        })]);
    } catch (e) { /* notif é best-effort */ }
  }

  /** Meta já gravada da mesma mensagem + lote (idempotência). */
  async _findBySource(c, sourceTs, batchNumber) {
    if (!sourceTs) return null;
    const r = await c.query(
      `SELECT * FROM v3.production_goals
       WHERE source_message_ts = $1 AND batch_number IS NOT DISTINCT FROM $2
         AND deleted_at IS NULL ORDER BY id LIMIT 1`,
      [sourceTs, batchNumber]);
    return r.rows[0] || null;
  }

  async _patch(c, id, fields) {
    const keys = Object.keys(fields);
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const vals = keys.map((k) => (k === 'destinations' && fields[k] != null
      ? JSON.stringify(fields[k]) : fields[k]));
    const r = await c.query(
      `UPDATE v3.production_goals SET ${set}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, ...vals]);
    return r.rows[0];
  }

  async _insert(c, p) {
    const r = await c.query(
      `INSERT INTO v3.production_goals
         (product_id, batch_number, expected_quantity, unit, destinations,
          production_date, source, source_message_ts, created_by_person_id, confidence, notes)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [p.product_id || null, normalizeBatchNumber(p.batch_number),
        p.expected_quantity, p.unit || 'bottle',
        p.destinations != null ? JSON.stringify(p.destinations) : null,
        p.production_date, p.source || 'channel', p.source_message_ts || null,
        p.created_by_person_id || null, p.confidence || 'high', p.notes || null]);
    return r.rows[0];
  }

  /**
   * Grava (ou atualiza, idempotente) uma meta.
   * @param {object} p  product_id, batch_number, expected_quantity, unit,
   *   destinations, production_date, source, source_message_ts,
   *   created_by_person_id, confidence, actor_type
   */
  async record(p = {}) {
    const actorType = this._actor(p.actor_type);
    if (p.expected_quantity == null) throw new Error('record: expected_quantity obrigatório');
    if (!p.production_date) throw new Error('record: production_date obrigatório');
    return this._withTx(async (c) => {
      const batchNorm = normalizeBatchNumber(p.batch_number);
      const existing = await this._findBySource(c, p.source_message_ts, batchNorm);
      if (existing) {
        const after = await this._patch(c, existing.id, {
          product_id: p.product_id || null,
          batch_number: batchNorm,
          expected_quantity: p.expected_quantity,
          unit: p.unit || 'bottle',
          destinations: p.destinations != null ? p.destinations : null,
          production_date: p.production_date,
          confidence: p.confidence || 'high',
        });
        await this._audit(c, {
          actorType, actorPersonId: p.created_by_person_id, action: 'goal.updated',
          targetId: existing.id, before: existing, after,
          metadata: { idempotent: true, source_message_ts: p.source_message_ts },
        });
        return after;
      }
      const g = await this._insert(c, p);
      await this._audit(c, {
        actorType, actorPersonId: p.created_by_person_id, action: 'goal.created',
        targetId: g.id, before: null, after: g,
      });
      // AVISO (Bruno 06-26): meta criada SEM produto identificado vira "(?)" no
      // dashboard sem ninguém saber. Cria notificação no inbox admin (#admin-orin)
      // pra cobrar a identificação na hora. Best-effort — nunca quebra a meta.
      if (!p.product_id) await this._notifyNoProduct(c, g, batchNorm, p);
      return g;
    });
  }

  /** Edição de meta pelo admin. */
  async correct(goalId, changes = {}, byPersonId, note, actorTypeRaw = 'admin') {
    const actorType = this._actor(actorTypeRaw);
    const fields = {};
    for (const k of Object.keys(changes)) {
      if (!CORRECTABLE.has(k)) throw new Error('correct: campo não-corrigível: ' + k);
      fields[k] = k === 'batch_number' ? normalizeBatchNumber(changes[k]) : changes[k];
    }
    if (!Object.keys(fields).length) throw new Error('correct: nenhuma mudança válida');
    return this._withTx(async (c) => {
      const before = await this._getById(c, goalId);
      if (!before) throw new Error('correct: goal ' + goalId + ' não existe');
      const after = await this._patch(c, goalId, fields);
      await this._audit(c, {
        actorType, actorPersonId: byPersonId, action: 'goal.corrected',
        targetId: goalId, before, after, metadata: { note: note || null, fields: Object.keys(fields) },
      });
      return after;
    });
  }

  async softDelete(goalId, byPersonId, reason, actorTypeRaw = 'admin') {
    const actorType = this._actor(actorTypeRaw);
    return this._withTx(async (c) => {
      const before = await this._getById(c, goalId);
      if (!before) throw new Error('softDelete: goal ' + goalId + ' não existe');
      const after = await this._patch(c, goalId, { deleted_at: new Date(), deleted_by: byPersonId || null });
      await this._audit(c, {
        actorType, actorPersonId: byPersonId, action: 'goal.deleted',
        targetId: goalId, before, after, metadata: { reason: reason || null },
      });
      return after;
    });
  }
}

module.exports = { GoalService, normalizeBatchNumber, VALID_ACTOR_TYPES, CORRECTABLE };
