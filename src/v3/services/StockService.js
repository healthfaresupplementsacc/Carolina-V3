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

// 'import' (S15 Fase 3, migration 072): entrada inicial espelhada da Veeqo. Fica
// distinguível pra sempre de uma entrada real da linha — o dia que a gente virar
// a fonte da verdade, dá pra saber o que era saldo importado e o que era produção.
const KINDS = ['store_in', 'pick', 'restock', 'adjust', 'damaged', 'count', 'place', 'move', 'import'];

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

  /** "A organizar" do produto (bucket 071). Sem linha = 0. */
  async _getUnplaced(c, productId, { lock = true } = {}) {
    const r = await c.query(
      `SELECT * FROM v3.stock_unplaced WHERE product_id = $1${lock ? ' FOR UPDATE' : ''}`,
      [productId]);
    return r.rows[0] ? Number(r.rows[0].qty) : 0;
  }

  async _setUnplaced(c, productId, qty) {
    await c.query(
      `INSERT INTO v3.stock_unplaced (product_id, qty, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (product_id) DO UPDATE SET qty = $2, updated_at = NOW()`,
      [productId, Math.max(0, qty)]);
  }

  async _flagDiscrepancy(p) {
    if (!this.onDiscrepancy) return;
    try { await this.onDiscrepancy(p); } catch (_) { /* alerta nunca derruba a operação */ }
  }

  // ── operações ──────────────────────────────────────────────

  /**
   * Entrada de estoque: operador guarda garrafas num bin OU numa caixa.
   * SEM bin e SEM caixa (Bruno 08-18): a garrafa entrou no armazém mas ainda não
   * foi organizada — vai pro bucket "A organizar" (v3.stock_unplaced) e o produto
   * fica com status 'organizar' até alguém dar place(). Conta no total do mesmo
   * jeito: total = prateleira + caixa + a organizar.
   * p: {product_id, qty, bin_id?, box_id?, person_id, source, source_ref?,
   *     authorized_by?, note?, is_test?, actor_type?, kind?}
   * `kind` (S15 F3) só existe pra marcar 'import' (saldo inicial vindo da Veeqo).
   * Qualquer outro valor cai em 'store_in': a semântica da operação é a mesma,
   * o que muda é a ETIQUETA do movimento no livro-razão.
   */
  async storeIn(p = {}) {
    this._checkQty(p.qty);
    if (!p.product_id) throw new Error('storeIn: product_id obrigatório');
    if (p.bin_id && p.box_id) throw new Error('storeIn: bin_id OU box_id, não os dois');
    const unplaced = !p.bin_id && !p.box_id;
    const kind = p.kind === 'import' ? 'import' : 'store_in';
    return this._withTx(async (c) => {
      const baseNote = unplaced ? ('a organizar' + (p.note ? ' — ' + p.note : '')) : p.note;
      const note = p.authorized_by ? `autorizado por ${p.authorized_by}${baseNote ? ' — ' + baseNote : ''}` : baseNote;
      const ins = await this._insertMovement(c, { ...p, kind, qty: p.qty, note });
      if (ins.duplicate) return { ...ins, applied: 0 };
      if (unplaced) {
        const have = await this._getUnplaced(c, p.product_id);
        await this._setUnplaced(c, p.product_id, have + p.qty);
        await this._audit(c, {
          actorType: p.actor_type || 'operator', actorPersonId: p.person_id,
          action: 'stock.store_in', targetId: ins.movement.id,
          after: { product_id: p.product_id, qty: p.qty, unplaced: have + p.qty },
        });
        return { ...ins, applied: p.qty, unplaced: have + p.qty };
      }
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
   * p: {product_id, qty, bin_id?, person_id?, source, source_ref, note?, is_test?,
   *     allow_box?}
   * bin_id opcional: sem bin, resolve o bin ativo do produto (maior qty primeiro).
   * allow_box (Bruno 08-18): PRATELEIRA PRIMEIRO, CAIXA DEPOIS. Se nenhum bin ativo
   * tem estoque, deduz da caixa in_storage com mais garrafas (movimento 'pick' com
   * box_id). É o que o veeqo-order-sync usa: a garrafa saiu do armazém de verdade,
   * então o total tem que cair mesmo quando a prateleira já estava vazia.
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
      let box = null;
      if (p.allow_box && !p.bin_id && (!bin || bin.qty <= 0)) {
        const rb = await c.query(
          `SELECT * FROM v3.stock_boxes
            WHERE product_id = $1 AND status = 'in_storage' ORDER BY qty DESC LIMIT 1 FOR UPDATE`,
          [p.product_id]);
        if (rb.rows[0] && rb.rows[0].qty > 0) { box = rb.rows[0]; bin = null; }
      }
      const target = box || bin;
      const have = target ? target.qty : 0;
      const applied = Math.min(have, p.qty);
      const ins = await this._insertMovement(c, {
        ...p, kind: 'pick', qty: -applied,
        bin_id: bin ? bin.id : null, box_id: box ? box.id : null,
        note: applied < p.qty ? `pedido ${p.qty}, havia ${have}${p.note ? ' — ' + p.note : ''}` : p.note,
      });
      if (ins.duplicate) return { ...ins, applied: 0 };
      if (applied > 0) {
        if (box) await this._setBoxQty(c, box.id, have - applied);
        else if (bin) await this._setBinQty(c, bin.id, have - applied);
      }
      if (applied < p.qty) {
        await this._flagDiscrepancy({
          kind: 'insufficient_stock', product_id: p.product_id,
          bin_id: bin ? bin.id : null, box_id: box ? box.id : null, wanted: p.qty, applied,
          note: box ? `caixa ${box.box_number} tinha ${have}, pedido pedia ${p.qty}`
            : (bin ? `bin ${bin.bin_code} tinha ${have}, pedido pedia ${p.qty}` : 'produto sem bin ativo'),
        });
      }
      await this._audit(c, {
        actorType: p.actor_type || 'system', actorPersonId: p.person_id,
        action: 'stock.pick', targetId: ins.movement.id,
        after: { product_id: p.product_id, wanted: p.qty, applied,
          bin_id: bin ? bin.id : null, box_id: box ? box.id : null },
        metadata: { source: p.source, source_ref: p.source_ref },
      });
      return { ...ins, applied, bin, box };
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
   * PLACE (Bruno 08-18): "A organizar" → prateleira ou caixa. O total NÃO muda,
   * só o lugar físico. Floor no que existe no bucket + discrepância (REGRA #0:
   * organiza o que dá, avisa o admin, nunca trava o operador na frente do palete).
   * p: {product_id, qty, bin_id?|box_id?, person_id, source, source_ref?, note?, is_test?}
   */
  async place(p = {}) {
    this._checkQty(p.qty);
    if (!p.product_id) throw new Error('place: product_id obrigatório');
    if (!p.bin_id && !p.box_id) throw new Error('place: bin_id ou box_id obrigatório');
    if (p.bin_id && p.box_id) throw new Error('place: bin_id OU box_id, não os dois');
    return this._withTx(async (c) => {
      const have = await this._getUnplaced(c, p.product_id);
      const applied = Math.min(have, p.qty);
      const ins = await this._insertMovement(c, {
        ...p, kind: 'place', qty: applied,
        note: applied < p.qty ? `organizar ${p.qty}, havia ${have} a organizar${p.note ? ' — ' + p.note : ''}` : p.note,
      });
      if (ins.duplicate) return { ...ins, applied: 0 };
      if (applied > 0) {
        await this._setUnplaced(c, p.product_id, have - applied);
        if (p.bin_id) {
          const bin = await this._getBin(c, p.bin_id);
          if (!bin.product_id) {
            await c.query('UPDATE v3.stock_bins SET product_id = $2 WHERE id = $1', [p.bin_id, p.product_id]);
          } else if (bin.product_id !== p.product_id) {
            await this._flagDiscrepancy({
              kind: 'bin_product_mismatch', product_id: p.product_id, bin_id: p.bin_id,
              note: `organizando produto ${p.product_id} num bin do produto ${bin.product_id}`,
            });
          }
          await this._setBinQty(c, p.bin_id, bin.qty + applied);
        } else {
          const box = await this._getBox(c, p.box_id);
          if (!box.product_id) {
            await c.query('UPDATE v3.stock_boxes SET product_id = $2 WHERE id = $1', [p.box_id, p.product_id]);
          }
          await this._setBoxQty(c, p.box_id, box.qty + applied);
        }
      }
      if (applied < p.qty) {
        await this._flagDiscrepancy({
          kind: 'unplaced_short', product_id: p.product_id,
          bin_id: p.bin_id || null, box_id: p.box_id || null, wanted: p.qty, applied,
          note: `a organizar tinha ${have}, place pedia ${p.qty}`,
        });
      }
      await this._audit(c, {
        actorType: p.actor_type || 'operator', actorPersonId: p.person_id,
        action: 'stock.place', targetId: ins.movement.id,
        before: { unplaced: have }, after: { unplaced: have - applied, qty: applied,
          bin_id: p.bin_id || null, box_id: p.box_id || null },
      });
      return { ...ins, applied, unplaced: have - applied };
    });
  }

  /**
   * MOVE genérico: transfere qty entre dois lugares (bin↔bin, bin↔caixa,
   * caixa↔caixa). Total do produto NÃO muda. restock() continua sendo o caminho
   * do kiosk pro caso caixa→bin (com contagem "de carona"); move é o caminho do
   * hub, sem reconciliação implícita.
   * p: {product_id?, qty, from:{bin_id?|box_id?}, to:{bin_id?|box_id?}, person_id,
   *     source, source_ref?, note?, is_test?}
   */
  async move(p = {}) {
    this._checkQty(p.qty);
    const from = p.from || {}; const to = p.to || {};
    if (!from.bin_id && !from.box_id) throw new Error('move: from bin_id ou box_id obrigatório');
    if (!to.bin_id && !to.box_id) throw new Error('move: to bin_id ou box_id obrigatório');
    if (from.bin_id && from.bin_id === to.bin_id) throw new Error('move: origem e destino iguais');
    if (from.box_id && from.box_id === to.box_id) throw new Error('move: origem e destino iguais');
    return this._withTx(async (c) => {
      const src = from.bin_id ? await this._getBin(c, from.bin_id) : await this._getBox(c, from.box_id);
      const dst = to.bin_id ? await this._getBin(c, to.bin_id) : await this._getBox(c, to.box_id);
      const productId = p.product_id || src.product_id || dst.product_id || null;
      const applied = Math.min(src.qty, p.qty);
      const ins = await this._insertMovement(c, {
        ...p, kind: 'move', product_id: productId, qty: applied,
        bin_id: to.bin_id || from.bin_id || null, box_id: to.box_id || from.box_id || null,
        note: applied < p.qty ? `mover ${p.qty}, origem tinha ${src.qty}${p.note ? ' — ' + p.note : ''}` : p.note,
      });
      if (ins.duplicate) return { ...ins, applied: 0 };
      if (applied > 0) {
        if (from.bin_id) await this._setBinQty(c, from.bin_id, src.qty - applied);
        else await this._setBoxQty(c, from.box_id, src.qty - applied);
        if (to.bin_id) {
          if (!dst.product_id && productId) {
            await c.query('UPDATE v3.stock_bins SET product_id = $2 WHERE id = $1', [to.bin_id, productId]);
          }
          await this._setBinQty(c, to.bin_id, dst.qty + applied);
        } else {
          if (!dst.product_id && productId) {
            await c.query('UPDATE v3.stock_boxes SET product_id = $2 WHERE id = $1', [to.box_id, productId]);
          }
          await this._setBoxQty(c, to.box_id, dst.qty + applied);
        }
      }
      if (applied < p.qty) {
        await this._flagDiscrepancy({
          kind: 'move_short', product_id: productId,
          bin_id: from.bin_id || null, box_id: from.box_id || null, wanted: p.qty, applied,
          note: `origem tinha ${src.qty}, mover pedia ${p.qty}`,
        });
      }
      await this._audit(c, {
        actorType: p.actor_type || 'operator', actorPersonId: p.person_id,
        action: 'stock.move', targetId: ins.movement.id,
        after: { product_id: productId, qty: applied, from, to },
      });
      return { ...ins, applied, from_left: src.qty - applied, to_now: dst.qty + applied };
    });
  }

  /**
   * SEPARAR (Bruno 08-18): garrafa sai do vendável e vai pro balde "Separadas".
   *  - label/seal/other = a garrafa estava aqui e tem problema → deduz a prateleira
   *    (mesma regra do damaged()) e abre a issue.
   *  - return = DEVOLUÇÃO de cliente: a garrafa voltou de fora, nunca esteve no bin
   *    → NÃO deduz nada; só abre a issue (com order_number). Só vira vendável
   *    depois que um manager aprova a volta pro estoque.
   * p: {product_id, qty, reason ('label'|'seal'|'other'|'return'), bin_id?,
   *     order_number?, person_id, note?, is_test?}
   */
  async separate(p = {}) {
    this._checkQty(p.qty);
    if (!p.product_id) throw new Error('separate: product_id obrigatório');
    const reason = ['label', 'seal', 'other', 'return'].includes(p.reason) ? p.reason : 'other';
    if (reason !== 'return') {
      const r = await this.damaged({ ...p, reason });
      if (r.issue && p.order_number) {
        await this.db.query('UPDATE v3.stock_issues SET order_number = $2 WHERE id = $1',
          [r.issue.id, String(p.order_number)]);
        r.issue.order_number = String(p.order_number);
      }
      return r;
    }
    // devolução: nada sai da prateleira, a garrafa entra direto nas Separadas
    return this._withTx(async (c) => {
      const issue = await c.query(
        `INSERT INTO v3.stock_issues (product_id, qty, reason, bin_id, person_id, note, is_test, order_number)
         VALUES ($1,$2,'return',$3,$4,$5,$6,$7) RETURNING *`,
        [p.product_id, p.qty, p.bin_id || null, p.person_id || null,
          p.note || null, !!p.is_test, p.order_number ? String(p.order_number) : null]);
      await this._audit(c, {
        actorType: p.actor_type || 'operator', actorPersonId: p.person_id,
        action: 'stock.separate_return', targetId: issue.rows[0].id,
        after: { product_id: p.product_id, qty: p.qty, reason: 'return',
          order_number: p.order_number || null, issue_id: issue.rows[0].id },
      });
      return { movement: null, duplicate: false, applied: 0, issue: issue.rows[0] };
    });
  }

  /**
   * RESOLVER uma Separada. 'restocked' devolve as garrafas ao vendável via
   * storeIn (bin, caixa ou "a organizar" quando não disseram onde), com
   * source_ref 'issue:<id>' — reprocessar a mesma issue NÃO duplica o estoque.
   * 'relabeled' e 'discarded' só fecham a issue (a garrafa já tinha saído do
   * vendável quando foi separada; devolução nunca esteve nele).
   * p: {issue_id, action:'restocked'|'relabeled'|'discarded', bin_id?|box_id?,
   *     person_id, source, source_ref?, note?, is_test?}
   */
  async resolveIssue(p = {}) {
    if (!p.issue_id) throw new Error('resolveIssue: issue_id obrigatório');
    const action = p.action;
    if (!['restocked', 'relabeled', 'discarded'].includes(action)) {
      throw new Error('resolveIssue: action inválido (restocked|relabeled|discarded)');
    }
    const cur = await this.db.query('SELECT * FROM v3.stock_issues WHERE id = $1', [p.issue_id]);
    const issue = cur.rows[0];
    if (!issue) throw new Error('issue não existe: ' + p.issue_id);
    if (issue.status !== 'separated') return { issue, applied: 0, duplicate: true };
    let stored = null;
    if (action === 'restocked') {
      stored = await this.storeIn({
        product_id: issue.product_id, qty: issue.qty,
        bin_id: p.bin_id || null, box_id: p.box_id || null,
        person_id: p.person_id, actor_type: p.actor_type || 'admin',
        source: p.source || 'warehouse_hub',
        source_ref: p.source_ref || ('issue:' + issue.id),
        note: p.note || `volta das separadas (issue ${issue.id})`,
        is_test: p.is_test != null ? p.is_test : issue.is_test,
      });
    }
    return this._withTx(async (c) => {
      const upd = await c.query(
        `UPDATE v3.stock_issues
            SET status = $2, resolved_by_person_id = $3, resolved_at = NOW(),
                note = COALESCE($4, note)
          WHERE id = $1 RETURNING *`,
        [issue.id, action, p.person_id || null, p.note || null]);
      await this._audit(c, {
        actorType: p.actor_type || 'admin', actorPersonId: p.person_id,
        action: 'stock.issue_' + action, targetId: issue.id,
        before: { status: issue.status },
        after: { status: action, product_id: issue.product_id, qty: issue.qty,
          movement_id: stored && stored.movement ? stored.movement.id : null },
      });
      return { issue: upd.rows[0], applied: stored ? stored.applied : 0,
        movement: stored ? stored.movement : null, duplicate: false };
    });
  }

  /**
   * MOVE PRODUCT (Bruno 08-19, SKU parenting): todo o estoque físico do produto A
   * passa a pertencer ao produto B. É o que falta pro merge de SKUs limpar de
   * verdade: casepack não existe fisicamente, então quando duas linhas do hub são
   * a MESMA garrafa, o que estava sob a linha fantasma tem que ir pro pai — bins,
   * caixas e o "a organizar" — senão o merge some com o SKU e deixa o estoque
   * órfão numa linha que ninguém mais vê.
   *
   * NÃO é uma quantidade nova: o total do armazém não muda, só troca de dono.
   * Por isso cada peça vira um PAR de movimentos (−qty no produto de origem,
   * +qty no destino, mesmo bin/caixa) e a soma dos dois é zero no livro-razão.
   *
   * Bins e caixas seguem junto (reapontam product_id): o local pertence ao PAI,
   * que é a regra do Bruno. O "a organizar" soma nos dois buckets.
   *
   * IDEMPOTENTE por source_ref: o merge em lote pode ser reenviado (clique duplo,
   * retry) sem mover nada duas vezes. Cada peça tem seu próprio sufixo de ref
   * porque um merge parcial que voltasse a rodar precisa completar o que faltou.
   *
   * p: {from_product_id, to_product_id, person_id?, source, source_ref, note?,
   *     actor_type?, is_test?}
   * @returns {{moved_qty, bins, boxes, unplaced, movements, duplicate}}
   */
  async moveProduct(p = {}) {
    const from = Number(p.from_product_id); const to = Number(p.to_product_id);
    if (!from || !to) throw new Error('moveProduct: from_product_id e to_product_id obrigatórios');
    if (from === to) throw new Error('moveProduct: produtos iguais');
    if (!p.source) throw new Error('moveProduct: source obrigatório');
    if (!p.source_ref) throw new Error('moveProduct: source_ref obrigatório (idempotência)');
    const src = p.source; const ref = p.source_ref;

    return this._withTx(async (c) => {
      const movements = []; let movedQty = 0; let anyNew = false;

      // um par de movimentos (−origem, +destino) pro mesmo lugar físico
      const pair = async (suffix, qty, place) => {
        if (!qty || qty <= 0) return;
        const outIns = await this._insertMovement(c, {
          kind: 'move', product_id: from, qty: -qty,
          bin_id: place.bin_id || null, box_id: place.box_id || null,
          person_id: p.person_id || null, source: src, source_ref: `${ref}:${suffix}:out`,
          note: p.note || `merge de SKU: estoque passa pro produto ${to}`, is_test: p.is_test,
        });
        const inIns = await this._insertMovement(c, {
          kind: 'move', product_id: to, qty,
          bin_id: place.bin_id || null, box_id: place.box_id || null,
          person_id: p.person_id || null, source: src, source_ref: `${ref}:${suffix}:in`,
          note: p.note || `merge de SKU: estoque vem do produto ${from}`, is_test: p.is_test,
        });
        if (outIns.duplicate && inIns.duplicate) return;   // essa peça já foi movida
        anyNew = true; movedQty += qty;
        movements.push(outIns.movement, inIns.movement);
      };

      // bins: o local passa a ser do pai (a prateleira é do produto físico)
      const bins = (await c.query(
        `SELECT id, bin_code, qty FROM v3.stock_bins
          WHERE product_id = $1 ORDER BY id FOR UPDATE`, [from])).rows;
      for (const b of bins) {
        await pair('bin' + b.id, Number(b.qty) || 0, { bin_id: b.id });
        await c.query('UPDATE v3.stock_bins SET product_id = $2, updated_at = NOW() WHERE id = $1',
          [b.id, to]);
      }

      // caixas: idem
      const boxes = (await c.query(
        `SELECT id, box_number, qty FROM v3.stock_boxes
          WHERE product_id = $1 ORDER BY id FOR UPDATE`, [from])).rows;
      for (const x of boxes) {
        await pair('box' + x.id, Number(x.qty) || 0, { box_id: x.id });
        await c.query('UPDATE v3.stock_boxes SET product_id = $2, updated_at = NOW() WHERE id = $1',
          [x.id, to]);
      }

      // "a organizar": bucket por produto, então soma no destino e zera na origem
      const unplaced = await this._getUnplaced(c, from);
      if (unplaced > 0) {
        const before = await this._getUnplaced(c, to);
        await pair('unplaced', unplaced, {});
        if (anyNew) {
          await this._setUnplaced(c, to, before + unplaced);
          await this._setUnplaced(c, from, 0);
        }
      }

      // Separadas seguem a garrafa: a issue é do produto físico, não da listagem.
      await c.query('UPDATE v3.stock_issues SET product_id = $2 WHERE product_id = $1', [from, to]);

      if (anyNew) {
        await this._audit(c, {
          actorType: p.actor_type || 'admin', actorPersonId: p.person_id,
          action: 'stock.move_product', targetId: to,
          before: { product_id: from }, after: { product_id: to, moved_qty: movedQty,
            bins: bins.length, boxes: boxes.length, unplaced },
          metadata: { source: src, source_ref: ref },
        });
      }
      return { moved_qty: movedQty, bins: bins.length, boxes: boxes.length,
        unplaced, movements, duplicate: !anyNew };
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

  /**
   * OVERVIEW do hub (Bruno 08-18): uma linha por produto com TODOS os números
   * do §3 do estudo. Só banco — a coluna Veeqo é preenchida pelo router
   * (o service nunca sai pra rede).
   *
   *   total     = prateleira + caixa + a organizar
   *   reservado = Σ linhas abertas (não shipped/cancelled) qty × units_per_pack
   *   pendente  = fila de aprovação (out/in), NUNCA dentro do total
   *   disponível = total − reservado − pendente_out   (a saída provisória do O2)
   *   separadas = Σ stock_issues status 'separated'   (nunca vendável)
   *
   * VELOCIDADE (Bruno 08-19): sold_7d / sold_30d saem das linhas JÁ ENVIADAS
   * (status 'shipped', shipped_at dentro da janela, em garrafas = qty ×
   * units_per_pack), e days_of_stock = disponível ÷ (sold_7d ÷ 7), uma casa.
   * Sem venda na semana o número não existe (null) — dividir por zero viraria
   * "infinito dias de estoque", que é pior que não dizer nada.
   *
   * SKU PARENTING (Bruno 08-19): UMA LINHA POR PRODUTO FÍSICO. Produto absorvido
   * por outro (merged_into_product_id) NÃO aparece — o fantasma do merge some da
   * lista sem nunca ser apagado do banco. `include_retired: true` traz os
   * absorvidos de volta (só o unmerge e a auditoria pedem isso).
   *
   * @param {object} opts opts.product_id → filtra um produto só
   *                      opts.include_retired → inclui absorvidos (default false)
   */
  async overview(opts = {}) {
    const only = opts.product_id ? Number(opts.product_id) : null;
    const args = only ? [only] : [];
    // Filtro do fantasma num lugar SÓ. Quando pedem um produto específico, ele
    // vem mesmo absorvido: quem abriu a ficha por id quer ver aquela linha.
    const notRetired = (opts.include_retired || only) ? '' : 'p.merged_into_product_id IS NULL';
    // O hub é o estoque de GARRAFAS. TODO SKU da Veeqo está registrado (Bruno
    // 08-19: "se um dia vender 1 de um sku que nunca vendeu nós vamos saber o que
    // houve"), inclusive plano da clínica, medicação manipulada e insumo. Esses
    // resolvem o pedido e aparecem na picklist, mas não são garrafa e não podem
    // encher a tela de quem organiza a prateleira. `kind` decide, num lugar só.
    const onlyBottles = (opts.include_all_kinds || only) ? '' : "p.kind = 'bottle'";
    const conds = [only ? 'p.id = $1' : null, notRetired || null, onlyBottles || null].filter(Boolean);
    const whereProd = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = (await this.db.query(`
      SELECT p.id AS product_id, p.canonical_name, p.nickname, p.bottle_color,
             p.merged_into_product_id,
             COALESCE(b.qty, 0)  AS shelf_qty,
             COALESCE(x.qty, 0)  AS box_qty,
             COALESCE(u.qty, 0)  AS unplaced_qty,
             COALESCE(r.qty, 0)  AS reserved,
             COALESCE(sp.qty, 0) AS separated,
             COALESCE(po.qty, 0) AS pending_out,
             COALESCE(pi.qty, 0) AS pending_in,
             t.min_units,
             COALESCE(nb.n, 0)   AS restock_bins,
             COALESCE(sv.sold_7d, 0)  AS sold_7d,
             COALESCE(sv.sold_30d, 0) AS sold_30d
        FROM v3.products p
        LEFT JOIN (SELECT product_id, SUM(qty)::int qty FROM v3.stock_bins
                    WHERE active GROUP BY product_id) b ON b.product_id = p.id
        LEFT JOIN (SELECT product_id, SUM(qty)::int qty FROM v3.stock_boxes
                    WHERE status = 'in_storage' GROUP BY product_id) x ON x.product_id = p.id
        LEFT JOIN v3.stock_unplaced u ON u.product_id = p.id
        LEFT JOIN (SELECT l.product_id, SUM(l.qty * COALESCE(ps.units_per_pack, 1))::int qty
                     FROM v3.pnp_order_lines l
                     LEFT JOIN v3.product_skus ps
                       ON ps.channel = l.source AND UPPER(ps.sku) = UPPER(l.sku)
                    WHERE l.product_id IS NOT NULL
                      AND l.status NOT IN ('shipped','cancelled')
                    GROUP BY l.product_id) r ON r.product_id = p.id
        LEFT JOIN (SELECT product_id, SUM(qty)::int qty FROM v3.stock_issues
                    WHERE status = 'separated' GROUP BY product_id) sp ON sp.product_id = p.id
        LEFT JOIN (SELECT product_id, SUM(qty)::int qty FROM v3.stock_change_requests
                    WHERE status = 'pending' AND direction = 'out'
                    GROUP BY product_id) po ON po.product_id = p.id
        LEFT JOIN (SELECT product_id, SUM(qty)::int qty FROM v3.stock_change_requests
                    WHERE status = 'pending' AND direction = 'in'
                    GROUP BY product_id) pi ON pi.product_id = p.id
        LEFT JOIN v3.stock_thresholds t ON t.product_id = p.id
        LEFT JOIN (SELECT product_id, COUNT(*)::int n FROM v3.stock_bins
                    WHERE active AND min_qty > 0 AND qty <= min_qty
                    GROUP BY product_id) nb ON nb.product_id = p.id
        LEFT JOIN (SELECT l.product_id,
                          SUM(CASE WHEN l.shipped_at > NOW() - INTERVAL '7 days'
                                   THEN l.qty * COALESCE(ps.units_per_pack, 1) ELSE 0 END)::int AS sold_7d,
                          SUM(l.qty * COALESCE(ps.units_per_pack, 1))::int AS sold_30d
                     FROM v3.pnp_order_lines l
                     LEFT JOIN v3.product_skus ps
                       ON ps.channel = l.source AND UPPER(ps.sku) = UPPER(l.sku)
                    WHERE l.product_id IS NOT NULL AND l.status = 'shipped'
                      AND l.shipped_at > NOW() - INTERVAL '30 days'
                    GROUP BY l.product_id) sv ON sv.product_id = p.id
        ${whereProd}
       ORDER BY COALESCE(p.nickname, p.canonical_name)`, args)).rows;

    const binRows = (await this.db.query(`
      SELECT id, product_id, bin_code, shelf_code, area, qty, min_qty
        FROM v3.stock_bins WHERE active AND product_id IS NOT NULL
       ORDER BY bin_code`)).rows;
    const boxRows = (await this.db.query(`
      SELECT id, product_id, box_number, area, qty
        FROM v3.stock_boxes WHERE status = 'in_storage' AND product_id IS NOT NULL
       ORDER BY box_number`)).rows;
    const skuRows = (await this.db.query(`
      SELECT id, product_id, sku, channel, units_per_pack, barcode, is_base, confirmed_at
        FROM v3.product_skus ORDER BY product_id, units_per_pack, sku`)).rows;

    const byProd = (list) => {
      const m = new Map();
      for (const x of list) {
        if (!m.has(x.product_id)) m.set(x.product_id, []);
        m.get(x.product_id).push(x);
      }
      return m;
    };
    const bins = byProd(binRows); const boxes = byProd(boxRows); const skus = byProd(skuRows);

    return rows.map((row) => this._buildRow(row, {
      bins: bins.get(row.product_id) || [],
      boxes: boxes.get(row.product_id) || [],
      skus: skus.get(row.product_id) || [],
    }));
  }

  /** Monta uma Row do contrato a partir dos agregados + listas do produto. */
  _buildRow(row, lists) {
    const n = (v) => Number(v || 0);
    const shelf = n(row.shelf_qty); const box = n(row.box_qty); const unplaced = n(row.unplaced_qty);
    const total = shelf + box + unplaced;
    const reserved = n(row.reserved);
    const pendingOut = n(row.pending_out); const pendingIn = n(row.pending_in);
    const available = total - reserved - pendingOut;
    const minUnits = row.min_units == null ? null : Number(row.min_units);

    // Velocidade: quanto saiu de verdade (linhas 'shipped') e por quantos dias o
    // disponível aguenta nesse ritmo. Sem venda na semana → null (não é zero dias,
    // é "não dá pra dizer"). Disponível negativo já está no status 'negative'.
    const sold7 = n(row.sold_7d); const sold30 = n(row.sold_30d);
    const daysOfStock = sold7 > 0 ? Math.max(0, Math.round((available / (sold7 / 7)) * 10) / 10) : null; // negativo = 0 dias (não existe "-0,8 dia")

    const binsOut = lists.bins.map((b) => ({
      id: b.id, bin_code: b.bin_code, shelf_code: b.shelf_code || null, area: b.area || null,
      qty: n(b.qty), min_qty: n(b.min_qty),
      needs_restock: n(b.min_qty) > 0 && n(b.qty) <= n(b.min_qty),
    }));
    const boxesOut = lists.boxes.map((x) => ({
      id: x.id, box_number: x.box_number, area: x.area || null, qty: n(x.qty),
    }));

    // base = o SKU FÍSICO da família (a garrafa avulsa). Três tentativas, nesta
    // ordem (Bruno 08-19, SKU parenting):
    //   1) is_base marcado por um humano — vence sempre;
    //   2) units_per_pack=1 no canal veeqo (V1 08-18: na Veeqo o base é
    //      ProductVariant e os casepacks são Kits derivados dele);
    //   3) o MENOR units_per_pack que existir, mesmo sendo kit. É o caso do print
    //      do Bruno: 'Apple Cider Vinegar' só tem o "x4 kit". Sem esse passo o
    //      produto fica sem base_sku pra sempre e a comparação com a Veeqo nunca
    //      sai de 'unknown' — melhor comparar contra o kit e marcar que é derivado.
    const veeqoSkus = lists.skus.filter((s) => s.channel === 'veeqo');
    const marked = lists.skus.find((s) => s.is_base);
    const unit1 = veeqoSkus.find((s) => Number(s.units_per_pack) === 1);
    const smallest = veeqoSkus.slice().sort(
      (a, b) => (Number(a.units_per_pack) || 1) - (Number(b.units_per_pack) || 1))[0] || null;
    const baseRow = marked || unit1 || smallest || null;
    const baseId = baseRow ? baseRow.id : null;
    const baseUnits = baseRow ? (Number(baseRow.units_per_pack) || 1) : 1;
    const skusOut = lists.skus.map((s) => ({
      id: s.id, sku: s.sku, channel: s.channel,
      units_per_pack: Number(s.units_per_pack) || 1,
      barcode: s.barcode || null,
      is_base: !!s.is_base,
      role: s.id === baseId ? 'base' : 'member',
      veeqo_type: null,           // preenchido pelo router (cache Veeqo)
      veeqo_qty: null,            // idem
      confirmed: !!s.confirmed_at,
    }));
    const baseSku = baseRow ? baseRow.sku : null;
    // children = a família SEM o base: os casepacks/listagens que fisicamente são
    // a MESMA garrafa. O hub mostra UMA linha e abre estes embaixo.
    const children = skusOut.filter((s) => s.id !== baseId);
    const hasConfirmedVeeqo = lists.skus.some((s) => s.channel === 'veeqo' && s.confirmed_at);

    const status = [];
    if (available < 0) status.push('negative');
    if (total <= 0) status.push('out');
    if (minUnits != null && available <= minUnits) status.push('low');
    if (unplaced > 0) status.push('organizar');
    if (pendingOut > 0 || pendingIn > 0) status.push('pendente');
    if (binsOut.some((b) => b.needs_restock)) status.push('repor');
    if (!binsOut.length && !boxesOut.length && total > 0) status.push('sem_local');
    if (!hasConfirmedVeeqo) status.push('sku_nao_mapeado');
    if (!status.length) status.push('ok');

    return {
      product_id: row.product_id,
      name: row.canonical_name,
      nickname: row.nickname || row.canonical_name,
      bottle_color: row.bottle_color || null,
      base_sku: baseSku,
      base_units_per_pack: baseUnits,   // >1 = a família só tem kit (sem avulsa)
      skus: skusOut,
      // FAMÍLIA (Bruno 08-19): uma linha por produto físico; os filhos são as
      // outras listagens da MESMA garrafa. sku_count é o "3 SKUs" da tela.
      children,
      sku_count: skusOut.length,
      veeqo_total: null,                // router (base físico, NUNCA base + kits)
      merged_into_product_id: row.merged_into_product_id || null,
      retired: row.merged_into_product_id != null,
      shelf_qty: shelf, box_qty: box, unplaced_qty: unplaced, total,
      reserved, pending_out: pendingOut, pending_in: pendingIn,
      available, separated: n(row.separated),
      min_units: minUnits,
      sold_7d: sold7, sold_30d: sold30, days_of_stock: daysOfStock,
      days_cover: daysOfStock,    // nome antigo do mesmo número (compat)
      veeqo: null,                // router
      veeqo_match: 'unknown',     // router
      status,
      bins: binsOut, boxes: boxesOut,
    };
  }

  /**
   * Ficha do produto: a Row + pedidos abertos, últimos 100 movimentos, Separadas
   * e propostas. Tudo leitura; a família/Veeqo vem do router.
   */
  async productDetail(productId) {
    const id = Number(productId);
    const rows = await this.overview({ product_id: id });
    const product = rows[0] || null;
    if (!product) return null;

    const openOrders = (await this.db.query(`
      SELECT l.order_number, l.channel, l.sku, l.qty, l.status, l.order_date,
             (l.qty * COALESCE(ps.units_per_pack, 1))::int AS bottles,
             EXTRACT(EPOCH FROM (NOW() - l.synced_at))::int / 60 AS age_min
        FROM v3.pnp_order_lines l
        LEFT JOIN v3.product_skus ps
          ON ps.channel = l.source AND UPPER(ps.sku) = UPPER(l.sku)
       WHERE l.product_id = $1 AND l.status NOT IN ('shipped','cancelled')
       ORDER BY l.order_date DESC NULLS LAST, l.order_number`, [id])).rows;

    const movements = (await this.db.query(`
      SELECT m.id, m.kind, m.qty, m.source, m.note, m.created_at,
             b.bin_code, x.box_number, pe.display_name AS person
        FROM v3.stock_movements m
        LEFT JOIN v3.stock_bins b ON b.id = m.bin_id
        LEFT JOIN v3.stock_boxes x ON x.id = m.box_id
        LEFT JOIN v3.persons pe ON pe.id = m.person_id
       WHERE m.product_id = $1
       ORDER BY m.created_at DESC, m.id DESC LIMIT 100`, [id])).rows;

    const issues = (await this.db.query(`
      SELECT i.id, i.qty, i.reason, i.status, i.order_number, i.note, i.created_at,
             pe.display_name AS person
        FROM v3.stock_issues i
        LEFT JOIN v3.persons pe ON pe.id = i.person_id
       WHERE i.product_id = $1
       ORDER BY (i.status = 'separated') DESC, i.created_at DESC LIMIT 100`, [id])).rows;

    const requests = (await this.db.query(`
      SELECT q.id, q.kind, q.direction, q.qty, q.status, q.reason, q.note, q.created_at,
             q.decided_by_login AS decided_by, q.decided_at,
             COALESCE(q.proposed_by_login, pe.display_name) AS proposed_by
        FROM v3.stock_change_requests q
        LEFT JOIN v3.persons pe ON pe.id = q.proposed_by_person_id
       WHERE q.product_id = $1
       ORDER BY (q.status = 'pending') DESC, q.created_at DESC LIMIT 100`, [id])).rows;

    return { product, open_orders: openOrders, movements, issues, requests };
  }
}

module.exports = { StockService, KINDS };
