'use strict';
/**
 * HEALTHFARE V4 — /api/v3/health/* (Bruno 08-25).
 *
 * POR QUE UM ROUTER NOVO E NÃO A PÁGINA DE SAÚDE QUE JÁ EXISTE:
 * `GET /api/v3/data/system-health` mora em src/v3/data/router.js, que tem 2106
 * linhas e está na lista do CLAUDE.md de arquivos que NÃO podem crescer. Dava pra
 * espremer a lógica lá dentro trocando linha por linha, mas isso deixaria a
 * leitura dos sinais escondida dentro do arquivo que já é grande demais pra
 * alguém ler inteiro. Aqui o módulo é pequeno, próprio, e a página de saúde
 * consome os dois endpoints lado a lado. Mesmo padrão de prefs/router.js e
 * review/router.js (Bruno 08-19).
 *
 * GET /api/v3/health/signals  → estado ao vivo de todo sinal externo + incidentes
 *                               abertos. Só LEITURA, nunca escreve nada.
 */

const express = require('express');
const { checkAll } = require('./signal-registry');

function createHealthRouter(deps = {}) {
  const db = deps.db;
  const router = express.Router();

  router.get('/api/v3/health/signals', async (req, res) => {
    try {
      const signals = await checkAll(db);
      // "problema" = velho E dentro da janela em que deveria estar vivo. Fora da
      // janela, silêncio é o esperado (o .28 desligado às 3 da manhã é normal).
      const problemas = signals.filter((s) => s.stale && s.in_window);

      let incidentes = [];
      try {
        const r = await db.query(
          `SELECT id, code, title, status, opened_at, resolved_at, dossier_path
             FROM v3.incidents
            WHERE status <> 'resolved'
            ORDER BY opened_at DESC LIMIT 50`);
        incidentes = r.rows || [];
      } catch (_) { incidentes = []; }

      res.json({
        data: {
          signals: signals.map((s) => ({
            key: s.key, label: s.label, how: s.how, source: s.source,
            at: s.at ? s.at.toISOString() : null,
            age_min: s.age_min, stale: s.stale, in_window: s.in_window,
            stale_after_min: s.stale_after_min, severity: s.severity,
            fix_hint: s.fix_hint,
            health: !s.in_window ? 'fora_da_janela' : (s.stale ? 'parado' : 'ok'),
          })),
          summary: {
            total: signals.length,
            ok: signals.filter((s) => !s.stale && s.in_window).length,
            parados: problemas.length,
            fora_da_janela: signals.filter((s) => !s.in_window).length,
            incidentes_abertos: incidentes.length,
          },
          incidents: incidentes,
        },
      });
    } catch (e) {
      console.error('[v3-health] signals:', e.message);
      res.status(500).json({ error: { code: 'internal', message: e.message } });
    }
  });

  return router;
}

module.exports = { createHealthRouter };
