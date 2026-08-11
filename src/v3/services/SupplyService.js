'use strict';
/**
 * HEALTHFARE V3 — SupplyService (Bruno 08-03)
 *
 * ÚNICO caminho de escrita do estoque de SUPRIMENTOS (envelopes/caixas).
 * Mesma disciplina do StockService (058): todo movimento = row em
 * v3.supply_movements (append-only) + update do qty do supply_item NA MESMA
 * TRANSAÇÃO; idempotência por (source, source_ref) pra a MESMA label nunca
 * deduzir 2×; REGRA #0 = nunca travar (deduz até 0, registra o delta real,
 * avisa via onDiscrepancy).
 *
 * Regra de negócio (Bruno): cada TAMANHO de pacote (A/Y/B/BX) usa 1 supply.
 * Imprimiu 1 shipping label de tamanho T → consumeForSize(T, ref) deduz
 * qty_per do supply mapeado em v3.package_size_supply.
 */

const KINDS = ['consume', 'restock', 'adjust', 'count'];

class SupplyService {
  /**
   * @param {object} deps
   *   deps.db            pool pg
   *   deps.onLow         async ({item, qty, min_qty}) — supply cruzou o min → admin-orin
   *   deps.onDiscrepancy async ({item_id, wanted, applied, note})
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this._now = deps.now || (() => new Date());
    this.onLow = deps.onLow || null;
    this.onDiscrepancy = deps.onDiscrepancy || null;
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
      if (hasPool && client.release) client.release();
    }
  }

  /** Resolve o supply (e qty_per) de um package_size. null se não mapeado. */
  async supplyForSize(size, client = this.db) {
    if (!size) return null;
    const r = await client.query(
      `SELECT m.package_size, m.qty_per, s.id AS supply_item_id, s.name, s.qty, s.min_qty, s.active
         FROM v3.package_size_supply m
         JOIN v3.supply_items s ON s.id = m.supply_item_id
        WHERE m.package_size = $1`, [String(size).trim().toUpperCase()]);
    return r.rows[0] || null;
  }

  /**
   * Consome supply por TAMANHO de pacote (o caminho da impressão de label).
   * Idempotente por (source, source_ref). REGRA #0: nunca trava.
   * @returns {object} { applied, supply_item_id, qty_after, idempotent, unmapped }
   */
  async consumeForSize({ size, person_id = null, source = 'label_print', source_ref = null, note = null, is_test = false }) {
    return this._withTx(async (c) => {
      // idempotência: já processou essa label?
      if (source_ref) {
        const dup = await c.query(
          `SELECT id, supply_item_id, qty FROM v3.supply_movements WHERE source=$1 AND source_ref=$2 LIMIT 1`,
          [source, source_ref]);
        if (dup.rows[0]) return { idempotent: true, supply_item_id: dup.rows[0].supply_item_id, applied: dup.rows[0].qty };
      }
      const map = await this.supplyForSize(size, c);
      if (!map) {
        // tamanho sem supply mapeado → não deduz, mas avisa (não trava)
        if (this.onDiscrepancy) { try { await this.onDiscrepancy({ item_id: null, wanted: 1, applied: 0, note: 'package_size sem supply: ' + size }); } catch (_) {} }
        return { unmapped: true, size, applied: 0 };
      }
      const want = map.qty_per || 1;
      // deduz até o piso 0 (REGRA #0): aplica o delta real
      const applied = Math.min(want, map.qty);           // nunca deixa negativo
      const qtyAfter = map.qty - applied;
      await c.query(
        `INSERT INTO v3.supply_movements (kind, supply_item_id, qty, package_size, person_id, source, source_ref, note, is_test)
         VALUES ('consume',$1,$2,$3,$4,$5,$6,$7,$8)`,
        [map.supply_item_id, -applied, map.package_size, person_id, source, source_ref, note, is_test]);
      await c.query(`UPDATE v3.supply_items SET qty=$2, updated_at=NOW() WHERE id=$1`, [map.supply_item_id, qtyAfter]);

      // avisa se não deu pra deduzir tudo (estoque estourou)
      if (applied < want && this.onDiscrepancy) {
        try { await this.onDiscrepancy({ item_id: map.supply_item_id, wanted: want, applied, note: 'supply insuficiente: ' + map.name }); } catch (_) {}
      }
      // alerta de baixo (cruzou min) — só quando passou de acima→abaixo/igual
      if (map.min_qty > 0 && qtyAfter <= map.min_qty && map.qty > map.min_qty && this.onLow) {
        try { await this.onLow({ item: map.name, supply_item_id: map.supply_item_id, qty: qtyAfter, min_qty: map.min_qty }); } catch (_) {}
      }
      return { applied, supply_item_id: map.supply_item_id, qty_after: qtyAfter, size: map.package_size };
    });
  }

  /** Reabastece / ajusta / conta um supply (admin). qty com sinal p/ adjust. */
  async change({ supply_item_id, kind, qty, person_id = null, source = 'admin', source_ref = null, note = null, is_test = false }) {
    if (!KINDS.includes(kind)) throw new Error('kind inválido');
    if (!supply_item_id) throw new Error('supply_item_id obrigatório');
    return this._withTx(async (c) => {
      const cur = await c.query(`SELECT id, name, qty, min_qty FROM v3.supply_items WHERE id=$1 FOR UPDATE`, [supply_item_id]);
      if (!cur.rows[0]) throw new Error('supply não existe');
      const before = cur.rows[0].qty;
      let after, delta;
      if (kind === 'count') { after = Math.max(0, Number(qty) || 0); delta = after - before; }
      else if (kind === 'restock') { delta = Math.abs(Number(qty) || 0); after = before + delta; }
      else { delta = Number(qty) || 0; after = Math.max(0, before + delta); delta = after - before; } // adjust (com sinal), floor 0
      await c.query(
        `INSERT INTO v3.supply_movements (kind, supply_item_id, qty, person_id, source, source_ref, note, is_test)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [kind, supply_item_id, delta, person_id, source, source_ref, note, is_test]);
      await c.query(`UPDATE v3.supply_items SET qty=$2, updated_at=NOW() WHERE id=$1`, [supply_item_id, after]);
      // alerta de baixo se cruzou pra baixo
      if (cur.rows[0].min_qty > 0 && after <= cur.rows[0].min_qty && before > cur.rows[0].min_qty && this.onLow) {
        try { await this.onLow({ item: cur.rows[0].name, supply_item_id, qty: after, min_qty: cur.rows[0].min_qty }); } catch (_) {}
      }
      return { supply_item_id, before, after, delta };
    });
  }
}

module.exports = { SupplyService };
