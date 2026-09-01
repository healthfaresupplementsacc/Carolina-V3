'use strict';
/**
 * HEALTHFARE V4 — /api/v3/op-freight/* (FASE A do copiloto de frete).
 *
 * A leitura do copiloto pra CENTRAL DE P&P do operador: quantas etiquetas hoje,
 * quanto custou, quantas acima do normal e quantas dessas tinham alternativa
 * mais barata na cotação (com a economia possível). Fase A = só olhar: nenhum
 * botão, nenhuma compra, nenhum cancelamento.
 *
 * Router próprio e minúsculo porque src/routes/op.js (3450 linhas) NÃO PODE
 * crescer. Auth = a MESMA dupla do /op: Bearer OPERATOR_PAGE_TOKEN (a página
 * embute via /op/config.js) + X-Session-Token de sessão viva (op-auth), com os
 * MESMOS shapes de 401 do op.js — o api() da Central já trata os dois.
 */

const express = require('express');
const opAuth = require('../../lib/op-auth');
const freight = require('./service');

const EDT = 'America/New_York';

function extractBearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function createOpCopilotRouter(deps = {}) {
  const db = deps.db;
  const operatorToken = deps.operatorToken !== undefined
    ? deps.operatorToken : process.env.OPERATOR_PAGE_TOKEN;
  const nowFn = deps.now || (() => new Date());
  const router = express.Router();

  // GET /api/v3/op-freight/copilot → {data: copilotSummary(hoje NY)}
  router.get('/api/v3/op-freight/copilot', async (req, res) => {
    const t = extractBearer(req);
    if (!operatorToken || t !== operatorToken) {
      return res.status(401).json({ error: 'invalid_page_token' });
    }
    try {
      const s = await opAuth.getSession(db, req.headers['x-session-token']);
      if (!s) return res.status(401).json({ error: 'invalid_session' });
      const nyDay = nowFn().toLocaleDateString('en-CA', { timeZone: EDT });
      res.json({ data: await freight.copilotSummary(db, nyDay) });
    } catch (e) {
      console.error('[op-freight] copilot erro:', e.message);
      res.status(500).json({ error: 'internal', detail: e.message });
    }
  });

  return router;
}

module.exports = { createOpCopilotRouter };
