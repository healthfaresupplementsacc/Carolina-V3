'use strict';
/**
 * HEALTHFARE V4 — /api/v3/freight/* (Bruno 08-28).
 *
 * A leitura do freight cost watch: quanto foi de etiqueta por dia vs quantas
 * ordens, quais etiquetas saíram acima do normal, e as faixas com as medianas
 * atuais (a resposta ao "como que eu vou saber q o sistema ta pegando o valor
 * certo sempre?" é MOSTRAR a régua, não pedir confiança).
 *
 * Router próprio e pequeno (mesmo padrão de prefs/health/review): o data
 * router tem 2106 linhas e não pode crescer. Auth = a MESMA família do
 * warehouse (makeAuthMiddleware + hasFunction): leitura pede view_stock ou
 * manage_stock. Só GET, nunca escreve nada.
 */

const express = require('express');
const { makeAuthMiddleware, hasFunction } = require('../data/auth');
const freight = require('./service');

const BASE = '/api/v3/freight';

const err = (res, code, message, status) =>
  res.status(status || 400).json({ error: { code, message } });

function createFreightRouter(deps = {}) {
  const db = deps.db;
  const router = express.Router();
  const auth = makeAuthMiddleware({ db });
  const canRead = (req) => hasFunction(req.login, 'view_stock') || hasFunction(req.login, 'manage_stock');

  const route = (path, handler) => {
    router.get(BASE + path, auth, async (req, res) => {
      if (!canRead(req)) return err(res, 'forbidden', 'Sem permissão pra ver frete.', 403);
      try {
        const data = await handler(req);
        res.json({ data });
      } catch (e) {
        console.error('[freight-api]', path, e.message);
        err(res, 'internal', e.message, 500);
      }
    });
  };

  // GET /summary?days=14 → por dia: etiquetas, custo, média, outliers + média 30d
  route('/summary', async (req) => {
    const days = Number(req.query.days) || 14;
    return freight.summary(db, { days });
  });

  // GET /outliers?day=YYYY-MM-DD → etiquetas acima do normal do dia (default hoje)
  route('/outliers', async (req) => {
    const day = req.query.day && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day))
      ? String(req.query.day) : null;
    return { outliers: await freight.outliersOf(db, day) };
  });

  // GET /bands → mediana/min/max/amostras por faixa (transparência da régua)
  route('/bands', async () => ({ bands: await freight.bands(db) }));

  return router;
}

module.exports = { createFreightRouter };
