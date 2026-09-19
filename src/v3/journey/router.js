'use strict';
/**
 * HEALTHFARE V3 — JORNADA DO LOTE — API /api/v3/journey/* (Bruno 09-10).
 *
 * "Quando eu clico no produto deveria aparecer todo o tempo que cada coisa
 * que foi feita naquele produto/batch demorou até chegar ali."
 *
 *   GET /label-event/:id → REGISTRO de uma "Impressão de Labels" (Bruno 09-12: "no
 *                     histórico da tarefa deveria ter: imprimiu tantos labels pro
 *                     suplemento tal, batch tal, e quanto tempo a impressora demorou").
 *                     Cada impressão ligada ao evento (v3.print_jobs.label_event_id):
 *                     produto, lote, labels (contagem da máquina quando tem), segundos
 *                     físicos, arquivo, status/erro; mais o resumo (total, tempo de
 *                     impressora, labels/min, por produto).
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

  router.get(BASE + '/label-event/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return err(res, 'bad_request', 'id do registro inválido');
    try {
      const ev = (await db.query(`
        SELECT e.id, e.person_id, pe.display_name AS person, e.started_at, e.ended_at, e.quantity, e.quantity_unit, e.closed_reason
          FROM v3.events e JOIN v3.persons pe ON pe.id = e.person_id
         WHERE e.id = $1 AND e.deleted_at IS NULL`, [id])).rows[0];
      if (!ev) return err(res, 'not_found', 'registro não encontrado', 404);
      const jobs = (await db.query(`
        SELECT pj.id, pj.document, pj.printer, pj.status, pj.error, pj.sheets, pj.pages, pj.copies,
               pj.submitted_at, pj.completed_at, pj.print_seconds, pj.phys_started_at, pj.phys_ended_at, pj.duration_sec,
               COALESCE(pj.phys_ended_at, pj.created_at) AS printed_at,   -- carimbo do servidor (o completed_at do .28 já veio com fuso errado)
               (pj.raw->>'machine_labels')::int AS machine_labels, (pj.raw->>'aggregated_jobs')::int AS aggregated_jobs,
               pj.product_id, COALESCE(pr.nickname, pr.canonical_name) AS product, pj.product_batch_id, pb.batch_number AS batch
          FROM v3.print_jobs pj
          LEFT JOIN v3.products pr ON pr.id = pj.product_id
          LEFT JOIN v3.product_batches pb ON pb.id = pj.product_batch_id
         WHERE pj.label_event_id = $1
         ORDER BY COALESCE(pj.phys_ended_at, pj.created_at), pj.id`, [id])).rows;
      const summary = summarizeJobs(jobs);
      ok(res, { event: ev, jobs, summary });
    } catch (e) {
      console.error('[journey label-event]', e.message);
      err(res, 'internal', e.message, 500);
    }
  });

  return router;
}

/** Resumo puro das impressões de um registro (testável): total de labels (contagem da
 *  máquina vence o spooler), segundos de impressora, labels/min, por produto+lote. */
function summarizeJobs(jobs) {
  let labels = 0, printSec = 0, timedLabels = 0, errors = 0;
  const byProduct = new Map();
  // Arquivos impressos em sequência sem a impressora parar dividem a MESMA janela física
  // (op.js grava o mesmo print_seconds/phys_ended_at em todos): conta a janela uma vez só.
  const seenWin = new Set();
  for (const j of jobs || []) {
    const n = Number(j.machine_labels != null ? j.machine_labels : j.sheets) || 0;
    labels += n;
    if (j.error || /err|fail|falh/i.test(String(j.status || ''))) errors++;
    const win = j.phys_ended_at ? `${j.phys_started_at || ''}|${j.phys_ended_at}` : `job:${j.id}`;
    const sec = (Number(j.print_seconds) > 0 && !seenWin.has(win)) ? Number(j.print_seconds) : 0;
    seenWin.add(win);
    if (Number(j.print_seconds) > 0) timedLabels += n;
    printSec += sec;
    const key = `${j.product || j.document || '?'}|${j.batch || ''}`;
    const cur = byProduct.get(key) || { product: j.product || j.document || '?', batch: j.batch || null, labels: 0, jobs: 0, print_seconds: 0 };
    cur.labels += n; cur.jobs++; cur.print_seconds += sec; byProduct.set(key, cur);
  }
  const perMin = (printSec > 0 && timedLabels > 0) ? Math.round((timedLabels / printSec) * 60) : null;
  return { jobs: (jobs || []).length, labels, print_seconds: printSec, labels_per_min: perMin, errors, by_product: [...byProduct.values()] };
}

module.exports = { createJourneyRouter, summarizeJobs, BASE };
