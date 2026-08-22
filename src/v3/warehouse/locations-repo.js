'use strict';
/**
 * HEALTHFARE V3 — Warehouse hub — cadastro de LOCAIS (prateleiras/bins + caixas).
 *
 * Blocker #1 do estudo S15: hoje existem 0 bins e 0 caixas cadastrados, então a
 * picklist imprime "LOCAL A DEFINIR" e todo número do hub nasce zero. Esta página
 * é a cura: cadastrar código, prateleira, área, produto e mínimo.
 *
 * SQL cru aqui é seguro por construção: NADA nesta camada muda QUANTIDADE. Quem
 * mexe em qty continua sendo só o StockService (porta única). Um bin novo nasce
 * com qty 0 e só enche por movimento; upsert nunca escreve qty de bin.
 * Exceção consciente: a CAIXA pode nascer com uma qty inicial informada — nesse
 * caso o router faz a entrada pelo StockService, não daqui (ver router.postBox).
 *
 * Desativar, nunca deletar (regra do Deep-Study: código deprecado não é reusado).
 */

class LocationsRepo {
  constructor(deps = {}) { this.db = deps.db; }

  /** Bins ativos + caixas in_storage com o produto resolvido. */
  async list() {
    const bins = (await this.db.query(`
      SELECT b.id, b.bin_code, b.shelf_code, b.area, b.product_id, b.qty, b.min_qty, b.active,
             COALESCE(p.nickname, p.canonical_name) AS product
        FROM v3.stock_bins b
        LEFT JOIN v3.products p ON p.id = b.product_id
       ORDER BY b.active DESC, b.shelf_code NULLS LAST, b.bin_code`)).rows;
    const boxes = (await this.db.query(`
      SELECT x.id, x.box_number, x.area, x.product_id, x.qty, x.status,
             x.box_type_id, t.name AS box_type,
             COALESCE(p.nickname, p.canonical_name) AS product
        FROM v3.stock_boxes x
        LEFT JOIN v3.products p ON p.id = x.product_id
        LEFT JOIN v3.box_types t ON t.id = x.box_type_id
       ORDER BY x.status, x.box_number`)).rows;
    return { bins, boxes };
  }

  async binByCode(binCode) {
    const r = await this.db.query('SELECT * FROM v3.stock_bins WHERE bin_code = $1', [String(binCode).trim()]);
    return r.rows[0] || null;
  }

  async boxByNumber(boxNumber) {
    const r = await this.db.query('SELECT * FROM v3.stock_boxes WHERE box_number = $1', [String(boxNumber).trim()]);
    return r.rows[0] || null;
  }

  /**
   * Cria/atualiza um bin pelo código. NUNCA toca qty.
   * p: {bin_code, shelf_code?, area?, product_id?, min_qty?}
   */
  async upsertBin(p = {}) {
    const code = String(p.bin_code || '').trim();
    if (!code) throw new Error('bin_code obrigatório');
    const r = await this.db.query(`
      INSERT INTO v3.stock_bins (bin_code, shelf_code, area, product_id, min_qty)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (bin_code) DO UPDATE
        SET shelf_code = COALESCE(EXCLUDED.shelf_code, v3.stock_bins.shelf_code),
            area       = COALESCE(EXCLUDED.area,       v3.stock_bins.area),
            product_id = COALESCE(EXCLUDED.product_id, v3.stock_bins.product_id),
            min_qty    = COALESCE(EXCLUDED.min_qty,    v3.stock_bins.min_qty),
            active     = true,
            updated_at = NOW()
      RETURNING *`,
    [code, p.shelf_code || null, p.area || null,
      p.product_id ? Number(p.product_id) : null,
      p.min_qty != null && p.min_qty !== '' ? Number(p.min_qty) : null]);
    return r.rows[0];
  }

  /**
   * Cria/atualiza uma caixa pelo número. NUNCA toca qty (a entrada inicial passa
   * pelo StockService no router). box_type_id (S15.43) liga a caixa ao TAMANHO
   * dela ("20x20x20") — é de lá que a tara média + espalhamento vêm na pesagem.
   * p: {box_number, area?, product_id?, box_type_id?}
   */
  async upsertBox(p = {}) {
    const num = String(p.box_number || '').trim();
    if (!num) throw new Error('box_number obrigatório');
    const r = await this.db.query(`
      INSERT INTO v3.stock_boxes (box_number, area, product_id, box_type_id)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (box_number) DO UPDATE
        SET area        = COALESCE(EXCLUDED.area,        v3.stock_boxes.area),
            product_id  = COALESCE(EXCLUDED.product_id,  v3.stock_boxes.product_id),
            box_type_id = COALESCE(EXCLUDED.box_type_id, v3.stock_boxes.box_type_id),
            updated_at  = NOW()
      RETURNING *`,
    [num, p.area || null, p.product_id ? Number(p.product_id) : null,
      p.box_type_id ? Number(p.box_type_id) : null]);
    return r.rows[0];
  }

  /**
   * CADASTRO EM LOTE de bins (Bruno 08-19): a prateleira inteira de uma vez.
   * Cadastrar A01A1..A04C3 numa tela de um bin por vez é o motivo de existirem
   * zero bins hoje — e sem bin a picklist imprime "LOCAL A DEFINIR".
   *
   * ON CONFLICT DO NOTHING de propósito: um código que JÁ EXISTE volta em
   * `skipped` e não é tocado. Colar a lista de novo não pode reescrever o produto
   * nem o mínimo de um bin que alguém já ajustou na mão. Editar continua sendo o
   * upsertBin, um a um, consciente.
   *
   * NUNCA toca qty (bin novo nasce em 0 e só enche por movimento do StockService).
   * @param {Array<{bin_code, shelf_code?, area?, product_id?, capacity?, min_qty?}>} list
   * @returns {Promise<{created:number, skipped:string[]}>}
   */
  async bulkBins(list = []) {
    const skipped = []; let created = 0;
    for (const p of list) {
      const code = String((p && p.bin_code) || '').trim().toUpperCase();
      if (!code) continue;
      // COALESCE na capacity/min_qty: sem valor informado o bin fica com o DEFAULT
      // da tabela (48 e 0), não com NULL — min_qty é NOT NULL, um NULL explícito
      // derrubaria o INSERT inteiro, e o operador só queria cadastrar a prateleira.
      const r = await this.db.query(`
        INSERT INTO v3.stock_bins (bin_code, shelf_code, area, product_id, capacity, min_qty)
        VALUES ($1,$2,$3,$4,COALESCE($5, 48),COALESCE($6, 0))
        ON CONFLICT (bin_code) DO NOTHING
        RETURNING id, bin_code`,
      [code, p.shelf_code || null, p.area || null,
        p.product_id ? Number(p.product_id) : null,
        p.capacity != null && p.capacity !== '' ? Number(p.capacity) : null,
        p.min_qty != null && p.min_qty !== '' ? Number(p.min_qty) : null]);
      if (r.rows && r.rows[0]) created += 1; else skipped.push(code);
    }
    return { created, skipped };
  }

  /** Desativa um bin (nunca deleta — o histórico de movimentos aponta pra ele). */
  async deactivateBin(id) {
    const r = await this.db.query(
      'UPDATE v3.stock_bins SET active = false, updated_at = NOW() WHERE id = $1 RETURNING *',
      [Number(id)]);
    if (!r.rows[0]) throw new Error('bin não existe: ' + id);
    return r.rows[0];
  }
}

module.exports = { LocationsRepo };
