'use strict';
/**
 * HEALTHFARE V3 — sender_profiles (CRUD).
 * Read repo + service-style helpers (create/update/softDelete + setDefault).
 * Auditado via v3.audit_log (action='sender_profile.*').
 */

class SenderProfilesRepo {
  constructor(deps = {}) {
    this.db = deps.db;
  }

  async list() {
    const r = await this.db.query(
      `SELECT id, name, icon, is_default, created_at FROM v3.sender_profiles
       WHERE deleted_at IS NULL ORDER BY is_default DESC, LOWER(name)`);
    return { profiles: r.rows };
  }

  async _audit(action, targetId, meta) {
    await this.db.query(
      `INSERT INTO v3.audit_log
         (actor_type, action, target_type, target_id, metadata)
       VALUES ('admin', $1, 'sender_profile', $2, $3::jsonb)`,
      [action, targetId || null, meta ? JSON.stringify(meta) : null]);
  }

  async create({ name, icon = null }) {
    if (!name || !String(name).trim()) throw new Error('name obrigatório');
    const trimmed = String(name).trim();
    if (icon != null && typeof icon !== 'string') throw new Error('icon inválido');
    try {
      const r = await this.db.query(
        `INSERT INTO v3.sender_profiles (name, icon) VALUES ($1, $2)
         RETURNING id, name, icon, is_default, created_at`, [trimmed, icon]);
      await this._audit('sender_profile.created', r.rows[0].id, { name: trimmed, icon });
      return r.rows[0];
    } catch (e) {
      if (/duplicate key/i.test(e.message)) throw new Error('persona com esse nome já existe');
      throw e;
    }
  }

  async update(id, { name, icon } = {}) {
    if (!id) throw new Error('id obrigatório');
    const before = (await this.db.query(
      'SELECT * FROM v3.sender_profiles WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
    if (!before) throw new Error('persona ' + id + ' não existe');
    const fields = {};
    if (name != null) fields.name = String(name).trim();
    if (icon !== undefined) fields.icon = icon === '' ? null : icon;
    if (!Object.keys(fields).length) throw new Error('nada pra atualizar');
    const keys = Object.keys(fields);
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const r = await this.db.query(
      `UPDATE v3.sender_profiles SET ${set} WHERE id = $1
       RETURNING id, name, icon, is_default, created_at`,
      [id, ...keys.map((k) => fields[k])]);
    await this._audit('sender_profile.updated', id, { before, after: r.rows[0] });
    return r.rows[0];
  }

  async softDelete(id) {
    if (!id) throw new Error('id obrigatório');
    const before = (await this.db.query(
      'SELECT * FROM v3.sender_profiles WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
    if (!before) throw new Error('persona ' + id + ' não existe ou já apagada');
    if (before.is_default) throw new Error('não dá pra apagar a persona default — desmarca default primeiro');
    const r = await this.db.query(
      'UPDATE v3.sender_profiles SET deleted_at = NOW() WHERE id = $1 RETURNING *', [id]);
    await this._audit('sender_profile.deleted', id, { before });
    return r.rows[0];
  }

  /** Marca uma como default (e desmarca as outras). Idempotente. */
  async setDefault(id) {
    if (!id) throw new Error('id obrigatório');
    const exists = (await this.db.query(
      'SELECT id FROM v3.sender_profiles WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
    if (!exists) throw new Error('persona ' + id + ' não existe');
    await this.db.query('UPDATE v3.sender_profiles SET is_default = false WHERE is_default = true');
    const r = await this.db.query(
      'UPDATE v3.sender_profiles SET is_default = true WHERE id = $1 RETURNING *', [id]);
    await this._audit('sender_profile.set_default', id, { id });
    return r.rows[0];
  }
}

module.exports = { SenderProfilesRepo };
