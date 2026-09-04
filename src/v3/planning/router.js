'use strict';
/**
 * HEALTHFARE V4 — /api/v3/planning/* — a API da página Planejamento
 * (Bruno 09-04, direção corrigida: funil do EMS, não reposição).
 *
 * TRÊS pedaços, espelhando a página:
 *   QUADRO   GET /board — as 7 colunas do funil (Formulando → Encaixotado),
 *            derivadas ao vivo pelo planning/model.js. Só leitura, o quadro é
 *            a VERDADE; a única escrita ligada a ele é o flag manual de
 *            Encaixotado (POST /board/boxed) enquanto stock_boxes está vazio.
 *   PLANO    GET/PUT /plan?date= + POST /plan/item + DELETE /plan/item/:id —
 *            os itens arrastados pra cada dia. PUT recebe a LISTA ORDENADA
 *            inteira (a persistência mais simples pro drag: o front manda o
 *            estado final, o servidor regrava as posições).
 *   NOTAS    GET/PUT /notes?date= — uma caixa de anotações livres por data.
 *
 * Auth = a MESMA família do warehouse (makeAuthMiddleware + hasFunction):
 * leitura pede view_stock ou manage_stock; escrita pede manage_stock.
 * Router próprio e pequeno (o data router tem 2106 linhas e não pode crescer).
 * NUNCA escreve quantidade de estoque — StockService intocado.
 */

const express = require('express');
const { makeAuthMiddleware, hasFunction } = require('../data/auth');
const { createPlanningBoard } = require('./model');

const BASE = '/api/v3/planning';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const err = (res, code, message, status) =>
  res.status(status || 400).json({ error: { code, message } });

function createPlanningRouter(deps = {}) {
  const db = deps.db;
  const board = deps.board || createPlanningBoard({ db, ems: deps.ems || null });
  const router = express.Router();
  router.use(BASE, express.json({ limit: '256kb' }));
  const auth = makeAuthMiddleware({ db });
  const canRead = (req) => hasFunction(req.login, 'view_stock') || hasFunction(req.login, 'manage_stock');
  const canWrite = (req) => hasFunction(req.login, 'manage_stock');

  const wrap = (handler) => async (req, res) => {
    try {
      const data = await handler(req, res);
      if (data !== undefined) res.json({ data });
    } catch (e) {
      console.error('[planning-api]', req.path, e.message);
      err(res, 'internal', e.message, 500);
    }
  };
  const needDate = (req, res) => {
    const d = String((req.query && req.query.date) || '');
    if (!DATE_RE.test(d)) { err(res, 'bad_request', 'date obrigatória (YYYY-MM-DD).'); return null; }
    return d;
  };

  // ── QUADRO ────────────────────────────────────────────────────────────

  // GET /board → { columns:[{id,title,count,cards}], generated_at, ems_ok }
  router.get(BASE + '/board', auth, wrap(async (req, res) => {
    if (!canRead(req)) { err(res, 'forbidden', 'Sem permissão pra ver o planejamento.', 403); return undefined; }
    return board.board();
  }));

  // POST /board/boxed {batch_number, manual_boxed} — o ÚNICO toque manual no
  // quadro: marca/desmarca Encaixotado enquanto a carga física (stock_boxes)
  // não existe. Linha-flag com plan_date NULL (índice único por lote).
  router.post(BASE + '/board/boxed', auth, wrap(async (req, res) => {
    if (!canWrite(req)) { err(res, 'forbidden', 'Só quem gerencia estoque marca encaixotado.', 403); return undefined; }
    const b = req.body || {};
    const bn = String(b.batch_number || '').trim();
    if (!bn) { err(res, 'bad_request', 'batch_number obrigatório.'); return undefined; }
    const flag = b.manual_boxed === true;
    const q = await db.query(
      `INSERT INTO v3.production_plan_items (plan_date, batch_number, manual_boxed, created_by)
       VALUES (NULL, $1, $2, $3)
       ON CONFLICT (batch_number) WHERE plan_date IS NULL
       DO UPDATE SET manual_boxed = EXCLUDED.manual_boxed, updated_at = NOW()
       RETURNING batch_number, manual_boxed`,
      [bn, flag, (req.login && req.login.name) || null]);
    return q.rows[0];
  }));

  // ── PLANO ─────────────────────────────────────────────────────────────

  // GET /plan?date=YYYY-MM-DD → itens do dia em ordem de posição
  router.get(BASE + '/plan', auth, wrap(async (req, res) => {
    if (!canRead(req)) { err(res, 'forbidden', 'Sem permissão pra ver o planejamento.', 403); return undefined; }
    const d = needDate(req, res); if (!d) return undefined;
    const r = await db.query(
      `SELECT id, plan_date, position, batch_number, product_id, custom_title,
              note, manual_boxed, done, created_by, created_at, updated_at
         FROM v3.production_plan_items
        WHERE plan_date = $1
        ORDER BY position, id`, [d]);
    return { date: d, items: r.rows };
  }));

  // PUT /plan?date= {items:[{batch_number?|custom_title?, product_id?, note?, done?}]}
  // — a lista ORDENADA inteira do dia (drag = mandar o estado final).
  // Regrava o dia: apaga e insere com position = índice. Sem transação de
  // propósito: um admin por vez nesta tela; a pior corrida perde 1 reorder.
  router.put(BASE + '/plan', auth, wrap(async (req, res) => {
    if (!canWrite(req)) { err(res, 'forbidden', 'Só quem gerencia estoque edita o plano.', 403); return undefined; }
    const d = needDate(req, res); if (!d) return undefined;
    const items = (req.body && req.body.items);
    if (!Array.isArray(items) || items.length > 200) {
      err(res, 'bad_request', 'items precisa ser uma lista (máx 200).'); return undefined;
    }
    for (const it of items) {
      const hasBatch = it && typeof it.batch_number === 'string' && it.batch_number.trim();
      const hasTitle = it && typeof it.custom_title === 'string' && it.custom_title.trim();
      if (!hasBatch && !hasTitle) {
        err(res, 'bad_request', 'Cada item precisa de batch_number ou custom_title.'); return undefined;
      }
    }
    const by = (req.login && req.login.name) || null;
    await db.query('DELETE FROM v3.production_plan_items WHERE plan_date = $1', [d]);
    const saved = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const q = await db.query(
        `INSERT INTO v3.production_plan_items
           (plan_date, position, batch_number, product_id, custom_title, note, done, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, plan_date, position, batch_number, product_id, custom_title, note, done`,
        [d, i,
          (it.batch_number && String(it.batch_number).trim()) || null,
          Number.isInteger(it.product_id) ? it.product_id : null,
          (it.custom_title && String(it.custom_title).trim()) || null,
          (it.note && String(it.note)) || null,
          it.done === true, by]);
      saved.push(q.rows[0]);
    }
    return { date: d, items: saved };
  }));

  // POST /plan/item {plan_date, batch_number?|custom_title?, ...} → 1 item no fim
  router.post(BASE + '/plan/item', auth, wrap(async (req, res) => {
    if (!canWrite(req)) { err(res, 'forbidden', 'Só quem gerencia estoque edita o plano.', 403); return undefined; }
    const b = req.body || {};
    const d = String(b.plan_date || '');
    if (!DATE_RE.test(d)) { err(res, 'bad_request', 'plan_date obrigatória (YYYY-MM-DD).'); return undefined; }
    const bn = (b.batch_number && String(b.batch_number).trim()) || null;
    const title = (b.custom_title && String(b.custom_title).trim()) || null;
    if (!bn && !title) { err(res, 'bad_request', 'Item precisa de batch_number ou custom_title.'); return undefined; }
    const q = await db.query(
      `INSERT INTO v3.production_plan_items
         (plan_date, position, batch_number, product_id, custom_title, note, created_by)
       VALUES ($1,
               COALESCE((SELECT MAX(position) + 1 FROM v3.production_plan_items WHERE plan_date = $1), 0),
               $2, $3, $4, $5, $6)
       RETURNING id, plan_date, position, batch_number, product_id, custom_title, note, done`,
      [d, bn, Number.isInteger(b.product_id) ? b.product_id : null, title,
        (b.note && String(b.note)) || null, (req.login && req.login.name) || null]);
    return q.rows[0];
  }));

  // DELETE /plan/item/:id
  router.delete(BASE + '/plan/item/:id', auth, wrap(async (req, res) => {
    if (!canWrite(req)) { err(res, 'forbidden', 'Só quem gerencia estoque edita o plano.', 403); return undefined; }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { err(res, 'bad_request', 'id inválido.'); return undefined; }
    const q = await db.query(
      'DELETE FROM v3.production_plan_items WHERE id = $1 AND plan_date IS NOT NULL RETURNING id', [id]);
    if (!q.rows[0]) { err(res, 'not_found', 'Item não existe.', 404); return undefined; }
    return { deleted: id };
  }));

  // ── NOTAS ─────────────────────────────────────────────────────────────

  // GET /notes?date= → { date, body, updated_at } (vazio se nunca escreveu)
  router.get(BASE + '/notes', auth, wrap(async (req, res) => {
    if (!canRead(req)) { err(res, 'forbidden', 'Sem permissão pra ver o planejamento.', 403); return undefined; }
    const d = needDate(req, res); if (!d) return undefined;
    const r = await db.query('SELECT plan_date, body, updated_at FROM v3.planning_notes WHERE plan_date = $1', [d]);
    return r.rows[0] || { plan_date: d, body: '', updated_at: null };
  }));

  // PUT /notes?date= {body} → upsert (autosave da página, debounced no front)
  router.put(BASE + '/notes', auth, wrap(async (req, res) => {
    if (!canWrite(req)) { err(res, 'forbidden', 'Só quem gerencia estoque escreve anotações.', 403); return undefined; }
    const d = needDate(req, res); if (!d) return undefined;
    const body = String((req.body && req.body.body) || '');
    if (body.length > 20000) { err(res, 'bad_request', 'Anotação grande demais (máx 20000).'); return undefined; }
    const q = await db.query(
      `INSERT INTO v3.planning_notes (plan_date, body, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (plan_date) DO UPDATE SET body = EXCLUDED.body, updated_at = NOW()
       RETURNING plan_date, body, updated_at`, [d, body]);
    return q.rows[0];
  }));

  return router;
}

module.exports = { createPlanningRouter };
