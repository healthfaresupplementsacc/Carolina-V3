'use strict';
/**
 * HEALTHFARE V3 — Centro de Estoque — StockService (Bruno 08-01)
 *
 * O ÚNICO caminho de escrita do estoque físico do armazém (bins + caixas).
 * Nenhuma rota escreve SQL de estoque diretamente — a lição do dual-path do
 * production_counts (op.js com INSERT cru pulou a detecção de duplicata).
 *
 * REGRAS:
 *  - Todo movimento = row em v3.stock_movements (append-only) + update do qty
 *    do bin/caixa NA MESMA TRANSAÇÃO. Nunca UPDATE de qty sem movimento.
 *  - Idempotência por (source, source_ref): re-processar o mesmo pedido/linha
 *    devolve o movimento existente e NÃO deduz de novo (mesmo padrão do
 *    ON CONFLICT do print-event).
 *  - REGRA #0: nunca bloquear a operação. Dedução que estouraria o estoque
 *    faz floor em 0, registra o movimento com o delta real aplicado e chama
 *    onDiscrepancy (admin-orin) — avisa, não trava.
 *  - is_test: sessões sandbox marcam movimentos que o sandbox-cleanup pode
 *    limpar sem quebrar o livro-razão real.
 *  - Princípio #24: toda query schema-qualificada v3.*.
 */

const KINDS = ['store_in', 'pick', 'restock', 'adjust', 'damaged', 'count'];

class StockService {
  /**
   * @param {object} deps
   *   deps.db            pool pg
   *   deps.onDiscrepancy async ({kind, product_id, bin_id, box_id, wanted, applied, note}) — avisa admin
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this._now = deps.now || (() => new Date());
    this.onDiscrepancy = deps.onDiscrepancy || null;
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

  async _audit(c, { actorType, actorPersonId, action, targetId, before, after, metadata }) {
    await c.query(
      `INSERT INTO v3.audit_log
         (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data, metadata)
       VALUES ($1, $2, $3, 'stock_movement', $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
      [actorType || 'system', actorPersonId || null, action, targetId || null,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        metadata ? JSON.stringify(metadata) : null]);
  }

  /** Devolve movimento existente se (source, source_ref) já foi processado. */
  async _existing(c, source, sourceRef) {
    if (!sourceRef) return null;
    const r = await c.query(
      'SELECT * FROM v3.stock_movements WHERE source = $1 AND source_ref = $2',
      [source, sourceRef]);
    return r.rows[0] || null;
  }

  async _insertMovement(c, m) {
    const r = await c.query(
      `INSERT INTO v3.stock_movements
         (kind, product_id, qty, bin_id, box_id, person_id, source, source_ref, snapshot_url, note, is_test)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING
       RETURNING *`,
      [m.kind, m.product_id || null, m.qty, m.bin_id || null, m.box_id || null,
        m.person_id || null, m.source, m.source_ref || null, m.snapshot_url || null,
        m.note || null, !!m.is_test]);
    if (r.rows[0]) return { movement: r.rows[0], duplicate: false };
    // conflito de idempotência — devolve o existente, sem tocar quantidades
    const ex = await this._existing(c, m.source, m.source_ref);
    return { movement: ex, duplicate: true };
  }

  async _getBin(c, binId, { lock = true } = {}) {
    const r = await c.query(
      `SELECT * FROM v3.stock_bins WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [binId]);
    if (!r.rows[0]) throw new Error('bin não existe: ' + binId);
    return r.rows[0];
  }

  async _getBox(c, boxId, { lock = true } = {}) {
    const r = await c.query(
      `SELECT * FROM v3.stock_boxes WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [boxId]);
    if (!r.rows[0]) throw new Error('caixa não existe: ' + boxId);
    return r.rows[0];
  }

  async _setBinQty(c, binId, qty) {
    await c.query('UPDATE v3.stock_bins SET qty = $2, updated_at = NOW() WHERE id = $1', [binId, qty]);
  }

  async _setBoxQty(c, boxId, qty) {
    const status = qty <= 0 ? 'empty' : 'in_storage';
    await c.query(
      'UPDATE v3.stock_boxes SET qty = $2, status = $3, updated_at = NOW() WHERE id = $1',
      [boxId, qty, status]);
  }

  _checkQty(qty) {
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new Error('qty inválido (inteiro > 0): ' + qty);
    }
  }

  async _flagDiscrepancy(p) {
    if (!this.onDiscrepancy) return;
    try { await this.onDiscrepancy(p); } catch (_) { /* alerta nunca derruba a operação */ }
  }

  // ── operações ──────────────────────────────────────────────

  /**
   * Entrada de estoque: operador guarda garrafas num bin OU numa caixa.
   * p: {product_id, qty, bin_id?, box_id?, person_id, source, source_ref?,
   *     authorized_by?, note?, is_test?, actor_type?}
   */
  async storeIn(p = {}) {
    this._checkQty(p.qty);
    if (!p.product_id) throw new Error('storeIn: product_id obrigatório');
    if (!p.bin_id && !p.box_id) throw new Error('storeIn: bin_id ou box_id obrigatório');
    if (p.bin_id && p.box_id) throw new Error('storeIn: bin_id OU box_id, não os dois');
    return this._withTx(async (c) => {
      const note = p.authorized_by ? `autorizado por ${p.authorized_by}${p.note ? ' — ' + p.note : ''}` : p.note;
      const ins = await this._insertMovement(c, { ...p, kind: 'store_in', qty: p.qty, note });
      if (ins.duplicate) return { ...ins, applied: 0 };
      if (p.bin_id) {
        const bin = await this._getBin(c, p.bin_id);
        // bin com produto diferente do que está entrando = confusão na certa; avisa, não trava
        if (bin.product_id && bin.product_id !== p.product_id) {
          await this._flagDiscrepancy({
            kind: 'bin_product_mismatch', product_id: p.product_id, bin_id: p.bin_id,
            note: `entrada de produto ${p.product_id} num bin do produto ${bin.product_id}`,
          });
        }
        if (!bin.product_id) {
          await c.query('UPDATE v3.stock_bins SET product_id = $2 WHERE id = $1', [p.bin_id, p.product_id]);
        }
        await this._setBinQty(c, p.bin_id, bin.qty + p.qty);
      } else {
        const box = await this._getBox(c, p.box_id);
        if (!box.product_id) {
          await c.query('UPDATE v3.stock_boxes SET product_id = $2 WHERE id = $1', [p.box_id, p.product_id]);
        }
        await this._setBoxQty(c, p.box_id, box.qty + p.qty);
      }
      await this._audit(c, {
        actorType: p.actor_type || 'operator', actorPersonId: p.person_id,
        action: 'stock.store_in', targetId: ins.movement.id,
        after: { product_id: p.product_id, qty: p.qty, bin_id: p.bin_id, box_id: p.box_id },
      });
      return { ...ins, applied: p.qty };
    });
  }

  /**
   * Dedução por venda (linha de pedido enviada). Idempotente por source_ref.
   * Se o bin não tem o suficiente: deduz o que dá (floor 0) e avisa admin.
   * p: {product_id, qty, bin_id?, person_id?, source, source_ref, note?, is_test?}
   * bin_id opcional: sem bin, resolve o bin ativo do produto (maior qty primeiro).
   */
  async pick(p = {}) {
    this._checkQty(p.qty);
    if (!p.product_id) throw new Error('pick: product_id obrigatório');
    if (!p.source) throw new Error('pick: source obrigatório');
    return this._withTx(async (c) => {
      const ex = await this._existing(c, p.source, p.source_ref);
      if (ex) return { movement: ex, duplicate: true, applied: 0 };
      let bin = null;
      if (p.bin_id) {
        bin = await this._getBin(c, p.bin_id);
      } else {
        const r = await c.query(
          `SELECT * FROM v3.stock_bins
            WHERE product_id = $1 AND active ORDER BY qty DESC LIMIT 1 FOR UPDATE`,
          [p.product_id]);
        bin = r.rows[0] || null;
      }
      const have = bin ? bin.qty : 0;
      const applied = Math.min(have, p.qty);
      const ins = await this._insertMovement(c, {
        ...p, kind: 'pick', qty: -applied, bin_id: bin ? bin.id : null,
        note: applied < p.qty ? `pedido ${p.qty}, havia ${have}${p.note ? ' — ' + p.note : ''}` : p.note,
      });
      if (ins.duplicate) return { ...ins, applied: 0 };
      if (bin && applied > 0) await this._setBinQty(c, bin.id, have - applied);
      if (applied < p.qty) {
        await this._flagDiscrepancy({
          kind: 'insufficient_stock', product_id: p.product_id,
          bin_id: bin ? bin.id : null, wanted: p.qty, applied,
          note: bin ? `bin ${bin.bin_code} tinha ${have}, pedido pedia ${p.qty}` : 'produto sem bin ativo',
        });
      }
      await this._audit(c, {
        actorType: p.actor_type || 'system', actorPersonId: p.person_id,
        action: 'stock.pick', targetId: ins.movement.id,
        after: { product_id: p.product_id, wanted: p.qty, applied, bin_id: bin ? bin.id : null },
        metadata: { source: p.source, source_ref: p.source_ref },
      });
      return { ...ins, applied, bin };
    });
  }

  /**
   * Restock: move qty de uma caixa pra um bin (caixa esvazia → status empty).
   * Se o operador informou o que ENCONTROU (found_bin_qty/found_box_qty),
   * divergência vs o sistema vira count implícito + aviso — a reconciliação
   * "de carona" no momento em que alguém já está na frente da prateleira.
   * p: {box_id, bin_id, qty, person_id, found_bin_qty?, found_box_qty?, note?, is_test?}
   */
  async restock(p = {}) {
    this._checkQty(p.qty);
    if (!p.box_id || !p.bin_id) throw new Error('restock: box_id e bin_id obrigatórios');
    return this._withTx(async (c) => {
      const box = await this._getBox(c, p.box_id);
      const bin = await this._getBin(c, p.bin_id);
      const productId = bin.product_id || box.product_id;
      if (box.product_id && bin.product_id && box.product_id !== bin.product_id) {
        await this._flagDiscrepancy({
          kind: 'restock_product_mismatch', product_id: productId,
          bin_id: p.bin_id, box_id: p.box_id,
          note: `caixa ${box.box_number} (produto ${box.product_id}) → bin ${bin.bin_code} (produto ${bin.product_id})`,
        });
      }
      // contagens encontradas ≠ sistema → registra count ANTES do movimento
      let binQty = bin.qty; let boxQty = box.qty;
      if (Number.isInteger(p.found_bin_qty) && p.found_bin_qty !== bin.qty) {
        await this._countInternal(c, {
          product_id: bin.product_id, bin_id: p.bin_id, found: p.found_bin_qty,
          expected: bin.qty, person_id: p.person_id, source: p.source || 'op_kiosk', is_test: p.is_test,
        });
        binQty = p.found_bin_qty;
      }
      if (Number.isInteger(p.found_box_qty) && p.found_box_qty !== box.qty) {
        await this._countInternal(c, {
          product_id: box.product_id, box_id: p.box_id, found: p.found_box_qty,
          expected: box.qty, person_id: p.person_id, source: p.source || 'op_kiosk', is_test: p.is_test,
        });
        boxQty = p.found_box_qty;
      }
      const applied = Math.min(boxQty, p.qty);
      if (applied < p.qty) {
        await this._flagDiscrepancy({
          kind: 'restock_box_short', product_id: productId, box_id: p.box_id,
          wanted: p.qty, applied, note: `caixa ${box.box_number} tinha ${boxQty}, restock pedia ${p.qty}`,
        });
      }
      const ins = await this._insertMovement(c, {
        ...p, kind: 'restock', product_id: productId, qty: applied,
        note: p.note,
      });
      if (ins.duplicate) return { ...ins, applied: 0 };
      await this._setBoxQty(c, p.box_id, boxQty - applied);
      await this._setBinQty(c, p.bin_id, binQty + applied);
      await this._audit(c, {
        actorType: p.actor_type || 'operator', actorPersonId: p.person_id,
        action: 'stock.restock', targetId: ins.movement.id,
        after: { product_id: productId, qty: applied, box_id: p.box_id, bin_id: p.bin_id,
          box_left: boxQty - applied, bin_now: binQty + applied },
      });
      return { ...ins, applied, box_left: boxQty - applied, bin_now: binQty + applied };
    });
  }

  /**
   * Garrafa com problema (label/lacre): 2 toques no kiosk. Deduz o bin e
   * abre v3.stock_issues — a garrafa separada FINALMENTE contabilizada.
   * p: {product_id, qty, reason ('label'|'seal'|'other'), bin_id?, person_id, note?, is_test?}
   */
  async damaged(p = {}) {
    this._checkQty(p.qty);
    if (!p.product_id) throw new Error('damaged: product_id obrigatório');
    const reason = ['label', 'seal', 'other'].includes(p.reason) ? p.reason : 'other';
    return this._withTx(async (c) => {
      let bin = null;
      if (p.bin_id) bin = await this._getBin(c, p.bin_id);
      else {
        const r = await c.query(
          `SELECT * FROM v3.stock_bins WHERE product_id = $1 AND active
            ORDER BY qty DESC LIMIT 1 FOR UPDATE`, [p.product_id]);
        bin = r.rows[0] || null;
      }
      const applied = bin ? Math.min(bin.qty, p.qty) : 0;
      const ins = await this._insertMovement(c, {
        ...p, kind: 'damaged', qty: -applied, bin_id: bin ? bin.id : null,
        note: `${reason}${p.note ? ' — ' + p.note : ''}`,
      });
      if (ins.duplicate) return { ...ins, applied: 0 };
      if (bin && applied > 0) await this._setBinQty(c, bin.id, bin.qty - applied);
      const issue = await c.query(
        `INSERT INTO v3.stock_issues (product_id, qty, reason, bin_id, person_id, note, is_test)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [p.product_id, p.qty, reason, bin ? bin.id : null, p.person_id || null,
          p.note || null, !!p.is_test]);
      await this._audit(c, {
        actorType: p.actor_type || 'operator', actorPersonId: p.person_id,
        action: 'stock.damaged', targetId: ins.movement.id,
        after: { product_id: p.product_id, qty: p.qty, reason, issue_id: issue.rows[0].id },
      });
      return { ...ins, applied, issue: issue.rows[0] };
    });
  }

  /**
   * Ajuste manual do admin (correção). qty com sinal (+/-). Sempre auditado.
   * p: {product_id?, qty (signed int ≠ 0), bin_id?, box_id?, person_id, note, is_test?}
   */
  async adjust(p = {}) {
    if (!Number.isInteger(p.qty) || p.qty === 0) throw new Error('adjust: qty inteiro ≠ 0');
    if (!p.bin_id && !p.box_id) throw new Error('adjust: bin_id ou box_id obrigatório');
    if (!p.note) throw new Error('adjust: note (motivo) obrigatório');
    return this._withTx(async (c) => {
      let productId = p.product_id || null; let before = null; let after = null;
      if (p.bin_id) {
        const bin = await this._getBin(c, p.bin_id);
        productId = productId || bin.product_id;
        before = bin.qty; after = Math.max(0, bin.qty + p.qty);
        await this._setBinQty(c, p.bin_id, after);
      } else {
        const box = await this._getBox(c, p.box_id);
        productId = productId || box.product_id;
        before = box.qty; after = Math.max(0, box.qty + p.qty);
        await this._setBoxQty(c, p.box_id, after);
      }
      const ins = await this._insertMovement(c, {
        ...p, kind: 'adjust', product_id: productId, qty: after - before,
      });
      await this._audit(c, {
        actorType: p.actor_type || 'admin', actorPersonId: p.person_id,
        action: 'stock.adjust', targetId: ins.movement ? ins.movement.id : null,
        before: { qty: before }, after: { qty: after }, metadata: { note: p.note },
      });
      return { ...ins, applied: after - before };
    });
  }

  /**
   * Contagem física: o operador diz o que ENCONTROU; o delta vira movimento
   * 'count' e o qty do bin/caixa passa a ser o encontrado (contagem física é
   * a única autoridade que corrige o livro — e mesmo ela, auditada).
   * p: {bin_id? | box_id?, found (int >= 0), person_id, source?, note?, is_test?}
   */
  async count(p = {}) {
    if (!Number.isInteger(p.found) || p.found < 0) throw new Error('count: found inteiro >= 0');
    if (!p.bin_id && !p.box_id) throw new Error('count: bin_id ou box_id obrigatório');
    return this._withTx(async (c) => {
      let productId, expected;
      if (p.bin_id) {
        const bin = await this._getBin(c, p.bin_id);
        productId = bin.product_id; expected = bin.qty;
      } else {
        const box = await this._getBox(c, p.box_id);
        productId = box.product_id; expected = box.qty;
      }
      return this._countInternal(c, {
        product_id: productId, bin_id: p.bin_id, box_id: p.box_id,
        found: p.found, expected, person_id: p.person_id,
        source: p.source || 'op_kiosk', note: p.note, is_test: p.is_test,
        actor_type: p.actor_type,
      });
    });
  }

  /** Interno: registra count + seta qty (chamado dentro de tx aberta). */
  async _countInternal(c, p) {
    const delta = p.found - p.expected;
    const ins = await this._insertMovement(c, {
      kind: 'count', product_id: p.product_id, qty: delta,
      bin_id: p.bin_id || null, box_id: p.box_id || null,
      person_id: p.person_id, source: p.source, source_ref: p.source_ref || null,
      note: `contou ${p.found}, sistema tinha ${p.expected}${p.note ? ' — ' + p.note : ''}`,
      is_test: p.is_test,
    });
    if (!ins.duplicate) {
      if (p.bin_id) await this._setBinQty(c, p.bin_id, p.found);
      if (p.box_id) await this._setBoxQty(c, p.box_id, p.found);
      if (delta !== 0) {
        await this._flagDiscrepancy({
          kind: 'count_variance', product_id: p.product_id,
          bin_id: p.bin_id || null, box_id: p.box_id || null,
          wanted: p.expected, applied: p.found,
          note: `contagem física: ${p.found} vs sistema ${p.expected} (delta ${delta > 0 ? '+' : ''}${delta})`,
        });
      }
      await this._audit(c, {
        actorType: p.actor_type || 'operator', actorPersonId: p.person_id,
        action: 'stock.count', targetId: ins.movement.id,
        before: { qty: p.expected }, after: { qty: p.found },
      });
    }
    return { ...ins, applied: delta };
  }

  // ── leitura ────────────────────────────────────────────────

  /** Estoque do armazém por produto: bins + caixas (exclui is_test por construção — qty real). */
  async warehouseByProduct() {
    const r = await this.db.query(`
      SELECT p.id AS product_id, p.canonical_name,
             COALESCE(b.bin_qty, 0)  AS bin_qty,
             COALESCE(x.box_qty, 0)  AS box_qty,
             COALESCE(b.bin_qty, 0) + COALESCE(x.box_qty, 0) AS total_qty
        FROM v3.products p
        LEFT JOIN (SELECT product_id, SUM(qty) AS bin_qty FROM v3.stock_bins
                    WHERE active GROUP BY product_id) b ON b.product_id = p.id
        LEFT JOIN (SELECT product_id, SUM(qty) AS box_qty FROM v3.stock_boxes
                    WHERE status = 'in_storage' GROUP BY product_id) x ON x.product_id = p.id
       WHERE COALESCE(b.bin_qty, 0) + COALESCE(x.box_qty, 0) > 0
       ORDER BY p.canonical_name`);
    return r.rows;
  }
}

module.exports = { StockService, KINDS };
