'use strict';
/**
 * HEALTHFARE V3 — Bloco 0 — CatalogRepo (leitura).
 *
 * Dados de referência: pessoas, produtos, tipos de atividade.
 * Read-only. Princípio #3: nomes/produtos são dados, não código.
 */

class CatalogRepo {
  constructor(deps = {}) {
    this.db = deps.db;
  }

  /** Pessoas ativas (não-deletadas). */
  async persons() {
    const r = await this.db.query(
      `SELECT id, display_name, role, slack_user_id, active
       FROM v3.persons WHERE deleted_at IS NULL
       ORDER BY display_name`);
    return {
      persons: (r.rows || []).map((p) => ({
        id: p.id,
        display_name: p.display_name,
        role: p.role,
        slack_user_id: p.slack_user_id || null,
        active: p.active !== false,
      })),
    };
  }

  /** Catálogo de produtos com aliases. */
  async products() {
    const r = await this.db.query(
      `SELECT id, canonical_name, aliases, active
       FROM v3.products ORDER BY canonical_name`);
    return {
      products: (r.rows || []).map((p) => ({
        id: p.id,
        canonical_name: p.canonical_name,
        aliases: p.aliases || [],
        active: p.active !== false,
      })),
    };
  }

  /** Tipos de atividade (Bloco 1 vai anexar fluxo/fase aqui). */
  async activityTypes() {
    const r = await this.db.query(
      `SELECT id, slug, display_name, category, requires_product, active
       FROM v3.activity_types ORDER BY display_name`);
    return {
      activity_types: (r.rows || []).map((a) => ({
        id: a.id,
        slug: a.slug,
        display_name: a.display_name,
        category: a.category,
        requires_product: !!a.requires_product,
        active: a.active !== false,
      })),
    };
  }
}

module.exports = { CatalogRepo };
