'use strict';
/**
 * HEALTHFARE V3 — Bloco 3 — CatalogService.
 * Escrita de v3.activity_types (editar/reordenar fases — princípio #13).
 * Pequeno: só updateActivityType, auditado.
 */

const VALID_ACTOR_TYPES = ['admin', 'llm_observer', 'llm_assistant', 'system', 'app_home'];
const EDITABLE = new Set([
  'display_name', 'category', 'requires_product', 'active', 'flow', 'phase_order', 'emoji', 'color',
  // Bloco Captura Aprimorada (A1): admin pode editar
  'is_background', 'expected_seconds',
]);

class CatalogService {
  constructor(deps = {}) {
    this.db = deps.db;
  }

  _actor(type) {
    const t = type || 'admin';
    if (!VALID_ACTOR_TYPES.includes(t)) throw new Error('actor_type inválido: ' + type);
    return t;
  }

  /** Edita um activity_type (fluxo, ordem da fase, nome, etc.). */
  async updateActivityType(id, changes = {}, byPersonId, actorTypeRaw = 'admin') {
    const actorType = this._actor(actorTypeRaw);
    const fields = {};
    for (const k of Object.keys(changes)) {
      if (!EDITABLE.has(k)) throw new Error('updateActivityType: campo não-editável: ' + k);
      fields[k] = changes[k];
    }
    if (!Object.keys(fields).length) throw new Error('updateActivityType: nenhuma mudança válida');
    const before = (await this.db.query(
      'SELECT * FROM v3.activity_types WHERE id = $1', [id])).rows[0];
    if (!before) throw new Error('updateActivityType: activity_type ' + id + ' não existe');
    const keys = Object.keys(fields);
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const r = await this.db.query(
      `UPDATE v3.activity_types SET ${set} WHERE id = $1 RETURNING *`,
      [id, ...keys.map((k) => fields[k])]);
    await this.db.query(
      `INSERT INTO v3.audit_log
         (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
      [actorType, byPersonId || null, 'activity_type.updated', 'activity_type', id,
        JSON.stringify(before), JSON.stringify(r.rows[0])]);
    return r.rows[0];
  }
}

module.exports = { CatalogService, EDITABLE };
