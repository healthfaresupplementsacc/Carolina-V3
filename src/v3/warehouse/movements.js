'use strict';
/**
 * HEALTHFARE V3 — Warehouse hub — O LIVRO (Fase B, Bruno 09-10).
 *
 * "Toda ação tem que ficar anotada no log e salva" — e VISÍVEL. Este módulo lê
 * v3.stock_movements com filtros (produto, pessoa, motivo, verbo, período) e
 * devolve a lista da página Movimentos e o CSV. Só leitura: quantidade continua
 * entrando apenas pelo StockService.
 *
 * Também lista os motivos (v3.stock_reasons) e os lotes recentes de um produto
 * com o total produzido (pra "Receber a produção" oferecer o lote certo).
 */

const CSV_MAX = 5000;
const LIST_MAX = 500;

function createMovements(deps = {}) {
  const { db } = deps;

  async function reasons() {
    const r = await db.query(
      `SELECT code, label_pt, direction, sort FROM v3.stock_reasons WHERE active ORDER BY sort, code`);
    return r.rows;
  }

  /** Valida um motivo pela direção. Devolve a linha ou lança erro em PT. */
  async function requireReason(code, directions) {
    const bad = (msg) => { const e = new Error(msg); e.status = 400; e.code = 'bad_reason'; return e; };
    const c = String(code || '').trim();
    if (!c) throw bad('motivo obrigatório');
    const r = (await db.query(
      `SELECT code, label_pt, direction FROM v3.stock_reasons WHERE code = $1 AND active`, [c])).rows[0];
    if (!r) throw bad('motivo inválido: ' + c);
    if (directions && directions.length && !directions.includes(r.direction)) {
      throw bad(`motivo "${r.label_pt}" não vale pra esta ação`);
    }
    return r;
  }

  /**
   * opts: {product_id?, q? (nome/apelido/SKU), person? (texto), reason?, kind?,
   *        from? (YYYY-MM-DD), to?, include_test?, limit?, offset?}
   */
  async function list(opts = {}) {
    const where = ['1=1']; const args = [];
    const add = (sql, v) => { args.push(v); where.push(sql.replace('?', '$' + args.length)); };
    if (opts.product_id) add('m.product_id = ?', Number(opts.product_id));
    if (opts.q) add(`(p.canonical_name ILIKE ? OR p.nickname ILIKE $${args.length + 1})`, '%' + String(opts.q).trim() + '%');
    if (opts.q) args.push('%' + String(opts.q).trim() + '%');
    if (opts.person) add('COALESCE(pe.display_name, m.actor_name) ILIKE ?', '%' + String(opts.person).trim() + '%');
    if (opts.reason) add('m.reason_code = ?', String(opts.reason));
    if (opts.kind) add('m.kind = ?', String(opts.kind));
    if (opts.from) add('m.created_at >= ?::date', String(opts.from));
    if (opts.to) add('m.created_at < (?::date + 1)', String(opts.to));
    if (!opts.include_test) where.push('COALESCE(m.is_test, false) = false');
    const lim = Math.min(LIST_MAX, Math.max(1, Number(opts.limit) || 100));
    const off = Math.max(0, Number(opts.offset) || 0);
    const sql = `
      SELECT m.id, m.kind, m.qty, m.source, m.source_ref, m.note, m.created_at, m.is_test,
             m.reason_code, r.label_pt AS reason_label, m.ref_type, m.ref_id, m.reverses_movement_id,
             EXISTS (SELECT 1 FROM v3.stock_movements x WHERE x.reverses_movement_id = m.id) AS reversed,
             (m.created_at > NOW() - INTERVAL '24 hours') AS within_24h,
             m.product_id, COALESCE(p.nickname, p.canonical_name) AS product, p.canonical_name AS product_name,
             b.bin_code, x.box_number,
             COALESCE(pe.display_name, m.actor_name) AS person, m.actor_name, m.person_id,
             COUNT(*) OVER () AS total_rows
        FROM v3.stock_movements m
        LEFT JOIN v3.products p ON p.id = m.product_id
        LEFT JOIN v3.stock_reasons r ON r.code = m.reason_code
        LEFT JOIN v3.stock_bins b ON b.id = m.bin_id
        LEFT JOIN v3.stock_boxes x ON x.id = m.box_id
        LEFT JOIN v3.persons pe ON pe.id = m.person_id
       WHERE ${where.join(' AND ')}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ${lim} OFFSET ${off}`;
    const rows = (await db.query(sql, args)).rows;
    const total = rows.length ? Number(rows[0].total_rows) : 0;
    return { rows: rows.map(({ total_rows, ...m }) => m), total, limit: lim, offset: off };
  }

  /** CSV do mesmo filtro (até CSV_MAX linhas). Sem em dash; ponto e vírgula = Excel PT. */
  async function csv(opts = {}) {
    const { rows } = await list({ ...opts, limit: CSV_MAX, offset: 0 });
    const esc = (v) => { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const head = ['quando', 'produto', 'verbo', 'quantidade', 'motivo', 'referencia', 'local', 'quem', 'origem', 'desfeito', 'nota'];
    const lines = rows.map((m) => [
      String(m.created_at).slice(0, 19).replace('T', ' '), m.product, m.kind, m.qty,
      m.reason_label || m.reason_code || '', [m.ref_type, m.ref_id].filter(Boolean).join(':'),
      m.bin_code || m.box_number || (m.kind === 'store_in' ? 'a organizar' : ''),
      m.person || '', m.source, m.reversed ? 'sim' : (m.reverses_movement_id ? 'e um desfazer de ' + m.reverses_movement_id : ''),
      m.note || '',
    ].map(esc).join(';'));
    return [head.join(';')].concat(lines).join('\n');
  }

  /** Lotes recentes do produto com o total produzido (pra "Receber a produção"). */
  async function batches(productId, limit = 12) {
    const r = await db.query(`
      SELECT b.id, b.batch_number, b.status, b.started_at, b.finished_at, b.target_bottles,
             COALESCE((SELECT SUM(pc.bottles) FROM v3.production_counts pc
                        WHERE pc.product_batch_id = b.id AND pc.deleted_at IS NULL AND pc.superseded_by IS NULL), 0)::int AS produced,
             COALESCE((SELECT SUM(-m.qty) FROM v3.stock_movements m
                        WHERE m.product_id = b.product_id AND m.ref_type = 'batch' AND m.ref_id = b.batch_number
                          AND m.kind IN ('store_in') AND m.reverses_movement_id IS NULL), 0)::int AS received
        FROM v3.product_batches b
       WHERE b.product_id = $1 AND b.deleted_at IS NULL
       ORDER BY COALESCE(b.finished_at, b.started_at, b.created_at) DESC
       LIMIT $2`, [Number(productId), Math.min(50, Math.max(1, Number(limit) || 12))]);
    // received acima sai negativo por causa do -qty; corrige o sinal aqui (store_in e +)
    return r.rows.map((b) => ({ ...b, received: Math.abs(Number(b.received) || 0) }));
  }

  return { reasons, requireReason, list, csv, batches };
}

module.exports = { createMovements, CSV_MAX, LIST_MAX };
