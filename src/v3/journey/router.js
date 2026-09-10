'use strict';
/**
 * HEALTHFARE V3 — JORNADA DO LOTE — API /api/v3/journey/* (Bruno 09-10).
 *
 * "Quando eu clico no produto deveria aparecer todo o tempo que cada coisa
 * que foi feita naquele produto/batch demorou até chegar ali."
 *
 *   GET /batch/:id  → o lote + TODOS os registros dele em todos os dias
 *                     (pessoa, atividade, início/fim, quantidade, pausa) +
 *                     contagens de garrafas. Agrupar por fase é do cliente
 *                     (BatchJourney.jsx); aqui só os fatos, em ordem.
 *
 * Só leitura. Router pequeno de propósito: o data router não cresce.
 * AUTH: makeAuthMiddleware (PIN válido); nenhum gate de função (é leitura
 * do que já aparece na linha do tempo).
 */
const express = require('express');
const { makeAuthMiddleware } = require('../data/auth');

const BASE = '/api/v3/journey';

function createJourneyRouter(deps = {}) {
  const db = deps.db;
  const router = express.Router();
  router.use(BASE, makeAuthMiddleware({ db }));
  const ok = (res, data) => res.json({ data });
  const err = (res, code, message, status) => res.status(status || 400).json({ error: { code, message } });

  router.get(BASE + '/batch/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return err(res, 'bad_request', 'id do lote inválido');
    try {
      const b = (await db.query(`
        SELECT pb.id, pb.batch_number, pb.status, pb.started_at, pb.finished_at, pb.target_bottles, pb.units_per_bottle,
               pb.product_id, COALESCE(pr.nickname, pr.canonical_name) AS product, pr.canonical_name
          FROM v3.product_batches pb
          LEFT JOIN v3.products pr ON pr.id = pb.product_id
         WHERE pb.id = $1 AND pb.deleted_at IS NULL`, [id])).rows[0];
      if (!b) return err(res, 'not_found', 'lote não encontrado', 404);
      const events = (await db.query(`
        SELECT e.id, e.person_id, pe.display_name AS person, at.slug, at.display_name AS activity,
               COALESCE(at.is_background, false) AS is_background, COALESCE(e.flow_override, at.flow) AS flow,
               e.started_at, e.ended_at, e.quantity, e.quantity_unit, COALESCE(e.total_paused_seconds, 0) AS total_paused_seconds,
               e.cowork_group_id, e.is_unfinished
          FROM v3.events e
          JOIN v3.persons pe ON pe.id = e.person_id
          LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
         WHERE e.product_batch_id = $1 AND e.deleted_at IS NULL AND COALESCE(e.is_test, false) = false
         ORDER BY e.started_at, e.id`, [id])).rows;
      const counts = (await db.query(`
        SELECT c.id, c.bottles, c.reported_at, c.kind, c.unit, pe.display_name AS person
          FROM v3.production_counts c
          LEFT JOIN v3.persons pe ON pe.id = c.reported_by_person_id
         WHERE c.product_batch_id = $1 AND c.deleted_at IS NULL AND c.superseded_by IS NULL
         ORDER BY c.reported_at`, [id])).rows;
      const bottles = counts.reduce((a, c) => a + (Number(c.bottles) || 0), 0);
      ok(res, { batch: b, events, counts, bottles });
    } catch (e) {
      console.error('[journey]', e.message);
      err(res, 'internal', e.message, 500);
    }
  });

  return router;
}

module.exports = { createJourneyRouter, BASE };
