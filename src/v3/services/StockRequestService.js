'use strict';
/**
 * HEALTHFARE V3 — Warehouse hub — StockRequestService (Bruno 08-18, estudo S15).
 *
 * A FILA DE APROVAÇÃO. Regra do Bruno: o operador PROPÕE, o admin/manager DECIDE.
 * Tudo que mexe no total do produto entra aqui como 'pending' e só vira estoque
 * quando alguém aprova.
 *
 * REGRAS:
 *  - REGRA #0: propor NUNCA é bloqueado. A proposta é registrada sempre; o que
 *    espera é o efeito no livro-razão, não o registro do que aconteceu.
 *  - A proposta 'out' (took) já sai do Disponível na hora ("deduzido
 *    provisoriamente", O2 round 2) mas NUNCA sai do total: o número pendente
 *    aparece do lado, o total só muda quando o movimento existe de verdade.
 *  - Aprovar APLICA via StockService — a porta única de escrita continua única.
 *    Este service nunca escreve bin/caixa/movimento por conta própria.
 *  - Idempotente: aprovar/recusar uma proposta já decidida devolve a linha como
 *    está, sem aplicar de novo (a mesma disciplina do (source, source_ref)).
 *    O source_ref de toda aplicação é 'request:<id>' → mesmo que dois cliques
 *    passem pela trava, o StockService só deduz uma vez.
 *  - Toda decisão auditada em v3.audit_log ('stock_request.propose|approve|reject').
 */

const KINDS = ['take', 'entrada', 'count', 'return_in', 'issue_release', 'adjust'];
const DIRECTIONS = ['out', 'in'];

class StockRequestService {
  /**
   * @param {object} deps
   *   deps.db     pool pg
   *   deps.stock  StockService (porta única de escrita)
   *   deps.onDiscrepancy async (opcional) — repassado em avisos próprios
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this.stock = deps.stock;
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
      if (hasPool && typeof client.release === 'function') client.release();
    }
  }

  async _audit(c, { actorPersonId, action, targetId, before, after, metadata }) {
    await c.query(
      `INSERT INTO v3.audit_log
         (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data, metadata)
       VALUES ($1, $2, $3, 'stock_change_request', $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
      ['admin', actorPersonId || null, action, targetId || null,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        metadata ? JSON.stringify(metadata) : null]);
  }

  // ── propor ─────────────────────────────────────────────────

  /**
   * p: {product_id, kind, direction, qty, bin_id?, box_id?, issue_id?, reason?,
   *     note?, meta?, person_id?, login?, is_test?}
   *
   * `meta` (S15 Fase 3, migration 072) é o DETALHE de como a proposta nasceu:
   *  - contagem por peso: {gross_g, tare_g, unit_weight_g, computed_qty, residual_g,
   *    confidence} — sem isso o admin aprovaria um número sem saber de onde veio;
   *  - contagem manual: {computed_qty, method:'manual'} — carrega o found REAL,
   *    inclusive 0 (a fila exige qty > 0, mas "está vazio" é uma contagem válida);
   *  - caixa nova: {box:{new:true, batch_number, area, tare_g}} — o número da caixa
   *    é alocado só na aprovação (número de caixa nunca se repete, então não se
   *    queima um na proposta que pode ser recusada).
   * Na APROVAÇÃO o meta ganha `result` ({box_id, box_number}) com o que foi criado
   * — é por ali que o operador descobre o número da caixa que ele propôs.
   */
  async propose(p = {}) {
    if (!p.product_id) throw new Error('propose: product_id obrigatório');
    if (!KINDS.includes(p.kind)) throw new Error('propose: kind inválido (' + KINDS.join('|') + ')');
    if (!DIRECTIONS.includes(p.direction)) throw new Error('propose: direction inválido (out|in)');
    if (!Number.isInteger(p.qty) || p.qty <= 0) throw new Error('propose: qty inválido (inteiro > 0)');
    return this._withTx(async (c) => {
      const r = await c.query(
        `INSERT INTO v3.stock_change_requests
           (product_id, kind, direction, qty, bin_id, box_id, issue_id, reason, note,
            proposed_by_person_id, proposed_by_login, is_test, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING *`,
        [p.product_id, p.kind, p.direction, p.qty, p.bin_id || null, p.box_id || null,
          p.issue_id || null, p.reason || null, p.note || null,
          p.person_id || null, p.login || null, !!p.is_test,
          p.meta ? JSON.stringify(p.meta) : null]);
      const row = r.rows[0];
      await this._audit(c, {
        actorPersonId: p.person_id, action: 'stock_request.propose', targetId: row.id,
        after: { product_id: p.product_id, kind: p.kind, direction: p.direction, qty: p.qty },
        metadata: { login: p.login || null, reason: p.reason || null },
      });
      return row;
    });
  }

  // ── ler ────────────────────────────────────────────────────

  /** Lista propostas. opts: {status?, product_id?, limit?}
   *  status aceita 'pending' | 'approved' | 'rejected' | 'decided' (= approved OU rejected,
   *  o "histórico" da página de Aprovações). */
  async list(opts = {}) {
    const where = []; const args = [];
    if (opts.status === 'decided') where.push(`q.status IN ('approved','rejected')`);
    else if (opts.status) { args.push(opts.status); where.push('q.status = $' + args.length); }
    if (opts.product_id) { args.push(Number(opts.product_id)); where.push('q.product_id = $' + args.length); }
    const lim = Number(opts.limit) > 0 ? Math.min(500, Number(opts.limit)) : 200;
    const r = await this.db.query(`
      SELECT q.*, COALESCE(p.nickname, p.canonical_name) AS product,
             COALESCE(q.proposed_by_login, pe.display_name) AS proposed_by,
             b.bin_code, x.box_number,
             EXTRACT(EPOCH FROM (NOW() - q.created_at))::int / 60 AS age_min
        FROM v3.stock_change_requests q
        LEFT JOIN v3.products p ON p.id = q.product_id
        LEFT JOIN v3.persons pe ON pe.id = q.proposed_by_person_id
        LEFT JOIN v3.stock_bins b ON b.id = q.bin_id
        LEFT JOIN v3.stock_boxes x ON x.id = q.box_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY (q.status = 'pending') DESC, q.created_at DESC
       LIMIT ${lim}`, args);
    return r.rows;
  }

  /** {product_id: {out, in}} das propostas pendentes — alimenta a Row do hub. */
  async pendingByProduct() {
    const r = await this.db.query(`
      SELECT product_id, direction, SUM(qty)::int qty
        FROM v3.stock_change_requests
       WHERE status = 'pending'
       GROUP BY product_id, direction`);
    const out = {};
    for (const row of r.rows) {
      const k = row.product_id;
      if (!out[k]) out[k] = { out: 0, in: 0 };
      out[k][row.direction] = Number(row.qty) || 0;
    }
    return out;
  }

  async get(id) {
    const r = await this.db.query('SELECT * FROM v3.stock_change_requests WHERE id = $1', [Number(id)]);
    return r.rows[0] || null;
  }

  // ── decidir ────────────────────────────────────────────────

  /**
   * APROVAR: trava a linha, aplica via StockService, marca approved.
   * Já decidida → devolve como está (idempotente, nunca aplica duas vezes).
   * p: {id, login?, person_id?, note?}
   */
  async approve(p = {}) {
    const id = Number(p.id);
    if (!id) throw new Error('approve: id obrigatório');
    // 1) trava e confere o estado (tx curta: aplicar fora evita tx aninhada no service)
    const claimed = await this._withTx(async (c) => {
      const r = await c.query(
        'SELECT * FROM v3.stock_change_requests WHERE id = $1 FOR UPDATE', [id]);
      const row = r.rows[0];
      if (!row) throw new Error('proposta não existe: ' + id);
      return row;
    });
    if (claimed.status !== 'pending') return claimed;   // idempotente

    // 2) aplica pela porta única. source_ref 'request:<id>' = a mesma proposta
    //    nunca deduz/entra duas vezes, mesmo com dois cliques simultâneos.
    const applied = await this._apply(claimed, p);

    // 3) fecha a proposta
    return this._withTx(async (c) => {
      const upd = await c.query(
        `UPDATE v3.stock_change_requests
            SET status = 'approved', decided_by_login = $2, decided_by_person_id = $3,
                decided_at = NOW(), decision_note = $4, applied_movement_id = $5
          WHERE id = $1 AND status = 'pending' RETURNING *`,
        [id, p.login || null, p.person_id || null, p.note || null,
          applied && applied.movement ? applied.movement.id : null]);
      const row = upd.rows[0] || claimed;
      await this._audit(c, {
        actorPersonId: p.person_id, action: 'stock_request.approve', targetId: id,
        before: { status: 'pending' },
        after: { status: 'approved', applied: applied ? applied.applied : 0,
          movement_id: applied && applied.movement ? applied.movement.id : null },
        metadata: { login: p.login || null, kind: claimed.kind },
      });
      return row;
    });
  }

  /** meta da proposta como objeto (a coluna é jsonb; driver pode devolver string). */
  _metaOf(req) {
    const m = req && req.meta;
    if (!m) return {};
    if (typeof m === 'string') { try { return JSON.parse(m) || {}; } catch (_) { return {}; } }
    return m;
  }

  /**
   * Aloca o PRÓXIMO número de caixa: BX-0451, sequencial, nunca reusado (S15 F3).
   * Olha o maior número já existente com o prefixo e soma 1 — caixa deletada ou
   * esvaziada NÃO libera o número (o histórico de movimentos aponta pra ele).
   */
  async _allocateBoxNumber(c) {
    const r = await c.query(
      `SELECT box_number FROM v3.stock_boxes
        WHERE box_number ~ '^BX-[0-9]+$'
        ORDER BY (substring(box_number from 4))::int DESC LIMIT 1`);
    const last = r.rows[0] ? parseInt(String(r.rows[0].box_number).slice(3), 10) : 0;
    const next = (Number.isFinite(last) ? last : 0) + 1;
    return 'BX-' + String(next).padStart(4, '0');
  }

  /**
   * Guarda no meta da proposta O QUE A APROVAÇÃO CRIOU (hoje: a caixa e o número
   * dela). Merge no meta existente — a pesagem/box da proposta original continua
   * lá, senão o admin perderia de onde o número veio. Nunca derruba a aprovação:
   * é registro de resultado, não parte da escrita do estoque.
   */
  async _recordResult(id, meta, result) {
    try {
      await this.db.query(
        'UPDATE v3.stock_change_requests SET meta = $2::jsonb WHERE id = $1',
        [Number(id), JSON.stringify({ ...(meta || {}), result: { ...result } })]);
    } catch (e) {
      console.error('[stock-request] meta.result não gravado:', e.message);
    }
  }

  /** Aplica a proposta pelo StockService, conforme o kind. */
  async _apply(req, p = {}) {
    const sourceRef = 'request:' + req.id;
    const meta = this._metaOf(req);
    const common = {
      product_id: req.product_id, person_id: p.person_id || req.proposed_by_person_id || null,
      source: 'request', source_ref: sourceRef, actor_type: 'admin',
      note: (p.login ? `[${p.login}] ` : '') + (req.reason || req.note || 'aprovado'),
      is_test: !!req.is_test,
    };
    switch (req.kind) {
      case 'take':
        return this.stock.pick({ ...common, qty: req.qty, bin_id: req.bin_id || null, allow_box: true });
      case 'entrada': {
        // CAIXA NOVA (S15 F3): o operador propôs "chegou uma caixa"; o número é
        // alocado agora, na aprovação, e a entrada vai direto pra essa caixa.
        let boxId = req.box_id || null;
        if (!boxId && meta.box && meta.box.new) {
          const created = await this._withTx(async (c) => {
            const number = await this._allocateBoxNumber(c);
            const ins = await c.query(
              `INSERT INTO v3.stock_boxes
                 (box_number, product_id, area, batch_number, tare_g, created_by_person_id)
               VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
              [number, req.product_id, meta.box.area || null, meta.box.batch_number || null,
                meta.box.tare_g != null ? meta.box.tare_g : null,
                req.proposed_by_person_id || null]);
            return { box_id: ins.rows[0].id, box_number: number };
          });
          boxId = created.box_id;
          // O NÚMERO VOLTA PRO OPERADOR (Bruno 08-19). Quem propôs a caixa precisa
          // saber qual número ela recebeu pra escrever/colar a etiqueta certa; o
          // número nasce aqui e sem isso ele só existiria em stock_boxes, longe da
          // linha do "Registrado hoje". Gravado no meta.result da própria proposta.
          await this._recordResult(req.id, meta, created);
        }
        return this.stock.storeIn({ ...common, qty: req.qty,
          bin_id: req.bin_id || null, box_id: boxId });
      }
      case 'count': {
        // o found REAL mora no meta (contagem-no-zero: qty da fila é > 0 por CHECK,
        // mas "está vazio" tem que aplicar 0 mesmo).
        const found = Number.isInteger(meta.computed_qty) ? meta.computed_qty : req.qty;
        return this.stock.count({ ...common, found,
          bin_id: req.bin_id || null, box_id: req.box_id || null });
      }
      case 'return_in':
      case 'issue_release':
        if (req.issue_id) {
          return this.stock.resolveIssue({ ...common, issue_id: req.issue_id, action: 'restocked',
            bin_id: req.bin_id || null, box_id: req.box_id || null });
        }
        return this.stock.storeIn({ ...common, qty: req.qty,
          bin_id: req.bin_id || null, box_id: req.box_id || null });
      case 'adjust':
        return this.stock.adjust({ ...common,
          qty: req.direction === 'out' ? -req.qty : req.qty,
          bin_id: req.bin_id || null, box_id: req.box_id || null,
          note: req.reason || req.note || 'ajuste aprovado' });
      default:
        throw new Error('kind sem aplicação definida: ' + req.kind);
    }
  }

  /** RECUSAR: fecha sem aplicar nada. Já decidida → devolve como está. */
  async reject(p = {}) {
    const id = Number(p.id);
    if (!id) throw new Error('reject: id obrigatório');
    return this._withTx(async (c) => {
      const r = await c.query(
        'SELECT * FROM v3.stock_change_requests WHERE id = $1 FOR UPDATE', [id]);
      const row = r.rows[0];
      if (!row) throw new Error('proposta não existe: ' + id);
      if (row.status !== 'pending') return row;         // idempotente
      const upd = await c.query(
        `UPDATE v3.stock_change_requests
            SET status = 'rejected', decided_by_login = $2, decided_by_person_id = $3,
                decided_at = NOW(), decision_note = $4
          WHERE id = $1 RETURNING *`,
        [id, p.login || null, p.person_id || null, p.note || null]);
      await this._audit(c, {
        actorPersonId: p.person_id, action: 'stock_request.reject', targetId: id,
        before: { status: 'pending' }, after: { status: 'rejected' },
        metadata: { login: p.login || null, kind: row.kind },
      });
      return upd.rows[0];
    });
  }
}

module.exports = { StockRequestService, KINDS, DIRECTIONS };
