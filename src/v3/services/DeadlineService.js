'use strict';
/**
 * HEALTHFARE V3 — Bloco 3 — DeadlineService.
 * Porta única de escrita de v3.deadlines (config de deadlines).
 * create / update / remove — auditado. Princípio #12: configurável.
 */

const VALID_ACTOR_TYPES = ['admin', 'llm_observer', 'llm_assistant', 'system', 'app_home'];
const EDITABLE = new Set(['flow', 'label', 'kind', 'time_of_day', 'weekdays', 'due_date', 'active', 'notes']);

class DeadlineService {
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
      try { await client.query('ROLLBACK'); } catch (_) { /* */ }
      throw e;
    } finally {
      if (hasPool && typeof client.release === 'function') client.release();
    }
  }

  _actor(type) {
    const t = type || 'admin';
    if (!VALID_ACTOR_TYPES.includes(t)) throw new Error('actor_type inválido: ' + type);
    return t;
  }

  async _audit(c, { actorType, actorPersonId, action, targetId, before, after }) {
    await c.query(
      `INSERT INTO v3.audit_log
         (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data)
       VALUES ($1, $2, $3, 'deadline', $4, $5::jsonb, $6::jsonb)`,
      [actorType, actorPersonId || null, action, targetId || null,
        before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
  }

  async _getById(c, id) {
    const r = await c.query('SELECT * FROM v3.deadlines WHERE id = $1', [id]);
    return r.rows[0] || null;
  }

  async create(p = {}, byPersonId, actorTypeRaw = 'admin') {
    const actorType = this._actor(actorTypeRaw);
    if (!p.label) throw new Error('create: label obrigatório');
    return this._withTx(async (c) => {
      const r = await c.query(
        `INSERT INTO v3.deadlines (flow, label, kind, time_of_day, weekdays, due_date, active, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [p.flow || null, p.label, p.kind || 'recurring', p.time_of_day || null,
          p.weekdays || [1, 2, 3, 4, 5], p.due_date || null,
          p.active !== false, p.notes || null]);
      await this._audit(c, {
        actorType, actorPersonId: byPersonId, action: 'deadline.created',
        targetId: r.rows[0].id, after: r.rows[0],
      });
      return r.rows[0];
    });
  }

  async update(id, changes = {}, byPersonId, actorTypeRaw = 'admin') {
    const actorType = this._actor(actorTypeRaw);
    const fields = {};
    for (const k of Object.keys(changes)) {
      if (!EDITABLE.has(k)) throw new Error('update: campo não-editável: ' + k);
      fields[k] = changes[k];
    }
    if (!Object.keys(fields).length) throw new Error('update: nenhuma mudança válida');
    return this._withTx(async (c) => {
      const before = await this._getById(c, id);
      if (!before) throw new Error('update: deadline ' + id + ' não existe');
      const keys = Object.keys(fields);
      const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const r = await c.query(
        `UPDATE v3.deadlines SET ${set}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id, ...keys.map((k) => fields[k])]);
      await this._audit(c, {
        actorType, actorPersonId: byPersonId, action: 'deadline.updated',
        targetId: id, before, after: r.rows[0],
      });
      return r.rows[0];
    });
  }

  async remove(id, byPersonId, actorTypeRaw = 'admin') {
    const actorType = this._actor(actorTypeRaw);
    return this._withTx(async (c) => {
      const before = await this._getById(c, id);
      if (!before) throw new Error('remove: deadline ' + id + ' não existe');
      await c.query('DELETE FROM v3.deadlines WHERE id = $1', [id]);
      await this._audit(c, {
        actorType, actorPersonId: byPersonId, action: 'deadline.removed',
        targetId: id, before,
      });
      return { removed: id };
    });
  }
}

module.exports = { DeadlineService, EDITABLE };
