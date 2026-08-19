'use strict';
/**
 * HEALTHFARE V3 — Warehouse hub — FAMÍLIA de SKUs por produto (Bruno 08-18).
 *
 * O modelo (V1 verificado na API da Veeqo, estudo S15 §10.4):
 *   • O estoque FÍSICO da família mora no SKU BASE — a garrafa (ProductVariant),
 *     units_per_pack = 1.
 *   • Os casepacks (-C2/-C3/-C4) são KITS do Veeqo: o Veeqo deriva a
 *     disponibilidade deles do base e, ao enviar um kit, decrementa o base pelas
 *     unidades. Nosso sync já deduz qty × units_per_pack garrafas do PRODUTO.
 *   • Logo: pacotes disponíveis por membro = floor(garrafas disponíveis ÷ units).
 *
 * Contradição #15 (memória 08-08 "nunca somar base + casepack") segue valendo pro
 * MATCHING/duplicata: são listagens distintas. Pro ESTOQUE são uma família só
 * sobre um estoque de garrafas. As duas coisas convivem.
 *
 * Este repo mexe SÓ em v3.product_skus (mapeamento). Nenhuma quantidade muda aqui:
 * merge reatribui SKUs, nunca move estoque.
 */

class FamilyRepo {
  /** @param {object} deps deps.db (pool pg), deps.veeqoCache (createVeeqoCache) */
  constructor(deps = {}) {
    this.db = deps.db;
    this.veeqoCache = deps.veeqoCache || null;
  }

  async _veeqoBySku() {
    if (!this.veeqoCache) return {};
    try { return await this.veeqoCache.bySku(); } catch (_) { return {}; }
  }

  /**
   * Família do produto: base + membros com tipo Veeqo, disponível do Veeqo e
   * pacotes derivados.
   * @param {number} productId
   * @param {number|null} availableBottles disponível NOSSO (pra derived_packs)
   */
  async forProduct(productId, availableBottles = null) {
    const id = Number(productId);
    const rows = (await this.db.query(`
      SELECT id, product_id, sku, channel, units_per_pack, barcode, confirmed_at
        FROM v3.product_skus WHERE product_id = $1
       ORDER BY units_per_pack, channel, sku`, [id])).rows;
    const vq = await this._veeqoBySku();
    const baseRow = rows.find((s) => s.channel === 'veeqo' && Number(s.units_per_pack) === 1) || null;
    const members = rows.map((s) => {
      const v = vq[String(s.sku).trim().toUpperCase()] || null;
      const units = Number(s.units_per_pack) || 1;
      const avail = availableBottles == null ? null : Number(availableBottles);
      return {
        id: s.id, sku: s.sku, channel: s.channel, units_per_pack: units,
        confirmed: !!s.confirmed_at,
        role: baseRow && s.id === baseRow.id ? 'base' : 'member',
        veeqo_type: v ? v.type : null,
        veeqo_available: v && v.wh ? v.wh.available : null,
        derived_packs: avail == null ? null : Math.max(0, Math.floor(avail / units)),
      };
    });
    return {
      base: baseRow ? { sku: baseRow.sku, channel: baseRow.channel } : null,
      members,
    };
  }

  /**
   * Anexa (ou corrige) um SKU de canal a este produto. Confirma na hora — quem
   * mexeu no hub sabe o que está fazendo e o rastro fica no audit do router.
   * p: {product_id, sku, channel, units_per_pack?, person_id?}
   */
  async attach(p = {}) {
    const sku = String(p.sku || '').trim();
    if (!sku) throw new Error('sku obrigatório');
    if (!p.product_id) throw new Error('product_id obrigatório');
    const channel = String(p.channel || 'veeqo').trim();
    const units = Number(p.units_per_pack) > 0 ? Number(p.units_per_pack) : 1;
    const r = await this.db.query(`
      INSERT INTO v3.product_skus (product_id, sku, channel, units_per_pack, confirmed_by_person_id, confirmed_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (channel, sku) DO UPDATE
        SET product_id = EXCLUDED.product_id,
            units_per_pack = EXCLUDED.units_per_pack,
            confirmed_by_person_id = EXCLUDED.confirmed_by_person_id,
            confirmed_at = NOW()
      RETURNING *`,
    [Number(p.product_id), sku, channel, units, p.person_id || null]);
    return r.rows[0];
  }

  /** Desvincula um SKU (remove o mapeamento; não mexe em estoque). */
  async detach(skuId) {
    const r = await this.db.query(
      'DELETE FROM v3.product_skus WHERE id = $1 RETURNING *', [Number(skuId)]);
    if (!r.rows[0]) throw new Error('SKU não existe: ' + skuId);
    return r.rows[0];
  }

  /**
   * MERGE: leva os SKUs do produto A pro produto B. Só mapeamento — bins, caixas,
   * movimentos e o "a organizar" do produto A ficam onde estão (o hub mostra os
   * dois até alguém mover fisicamente). 2 passos na UI antes de chegar aqui.
   */
  async merge({ from_product_id, into_product_id }) {
    const from = Number(from_product_id); const into = Number(into_product_id);
    if (!from || !into) throw new Error('from_product_id e into_product_id obrigatórios');
    if (from === into) throw new Error('merge: produtos iguais');
    const r = await this.db.query(
      'UPDATE v3.product_skus SET product_id = $2 WHERE product_id = $1 RETURNING *',
      [from, into]);
    return { moved: r.rows.length, skus: r.rows };
  }
}

module.exports = { FamilyRepo };
