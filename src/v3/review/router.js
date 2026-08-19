'use strict';
/**
 * HEALTHFARE V3 — REVISÃO (dia) — API /api/v3/review/* (Bruno 08-19).
 *
 * O widget "Revisão" da Hoje mostrava uma média e parava por aí. O Bruno pediu
 * a pergunta inteira: escolher UM dia no mini calendário e ver o que aconteceu
 * nele — quem revisou o quê, quantas garrafas, quanto tempo levou, e se aquele
 * lote já rodou na linha de produção (o check verde) — mais uma barra lateral
 * com TUDO que está esperando revisão.
 *
 * TRÊS ROTAS, TODAS DE LEITURA:
 *   GET /api/v3/review/day?date=YYYY-MM-DD   → o dia inteiro, linha a linha
 *   GET /api/v3/review/calendar?month=YYYY-MM → quais dias têm revisão
 *   GET /api/v3/review/waiting                → a fila (vem do EMS)
 *
 * CONTRATO: envelope { data } / { error:{ code, message } } — o mesmo do data
 * router, do warehouse hub e do prefs.
 *
 * AUTH: makeAuthMiddleware (PIN → v3.app_logins), igual ao /api/v3/prefs. SEM
 * gate de função: isto é a mesma informação que o widget da Hoje já mostra pra
 * qualquer login autenticado, agora com um dia e um detalhe. Criar uma função
 * nova pra "ver revisão" trancaria a tela pra quem já a enxerga hoje.
 *
 * MÓDULO NOVO de propósito: o data router já é grande demais, e a regra da casa
 * é não crescer op.js / data/router.js. Aqui tudo que é revisão mora junto.
 *
 * NUNCA ESCREVE. Nenhum INSERT/UPDATE em lugar nenhum deste módulo.
 */

const express = require('express');
const { makeAuthMiddleware } = require('../data/auth');
const { ReviewService } = require('./service');
const { nyDate, isValidDate } = require('../data/ny-date');

const BASE = '/api/v3/review';

/** Mês YYYY-MM. */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const err = (res, code, message, status) =>
  res.status(status || 400).json({ error: { code, message } });

function createReviewRouter(deps = {}) {
  const db = deps.db;
  // O cliente do EMS é o MESMO singleton que o resto do sistema usa (wire.js
  // injeta o `ems` de services/ems-api). Instanciar outro aqui significaria
  // outra chave, outro timeout e outra foto da fábrica na mesma tela.
  const service = deps.service || new ReviewService({ db, ems: deps.ems || null });
  const router = express.Router();

  router.use(BASE, makeAuthMiddleware({ db }));

  const ok = (res, data) => res.json({ data });

  /** Envolve o handler: erro vira 500 com texto em português, nunca stack. */
  function route(path, handler) {
    router.get(BASE + path, async (req, res) => {
      try {
        await handler(req, res);
      } catch (e) {
        console.error('[review] GET', path, '-', e.message);
        return err(res, 'internal', 'não deu pra ler as revisões agora.', 500);
      }
    });
  }

  // ── O DIA ──────────────────────────────────────────────────
  // `date` ausente = hoje (NY). Data mal formada é 400 e não "hoje
  // silenciosamente": o Bruno clicou num dia, e responder outro dia sem avisar
  // seria mostrar o número errado com cara de certo.
  route('/day', async (req, res) => {
    const raw = req.query && req.query.date;
    if (raw != null && String(raw).trim() !== '' && !isValidDate(String(raw).trim())) {
      return err(res, 'bad_date', 'data inválida: use YYYY-MM-DD.', 400);
    }
    const date = raw != null && String(raw).trim() !== '' ? String(raw).trim() : nyDate();
    return ok(res, await service.day(date));
  });

  // ── O CALENDÁRIO ───────────────────────────────────────────
  // Só os dias COM revisão voltam. Mês sem nenhuma → days:[] (não é erro: o mês
  // existiu, ninguém revisou nada nele).
  route('/calendar', async (req, res) => {
    const raw = req.query && req.query.month;
    const month = raw != null && String(raw).trim() !== '' ? String(raw).trim() : nyDate().slice(0, 7);
    if (!MONTH_RE.test(month)) {
      return err(res, 'bad_month', 'mês inválido: use YYYY-MM.', 400);
    }
    return ok(res, await service.calendar(month));
  });

  // ── A FILA ─────────────────────────────────────────────────
  // EMS fora do ar não é erro HTTP: volta `ems_ok:false` com o que o espelho
  // local tem. A barra lateral mostra o aviso e continua útil (regra #0).
  route('/waiting', async (_req, res) => ok(res, await service.waiting()));

  console.log('[V3] Revisão do dia montada: ' + BASE + '/* (day, calendar, waiting)');
  return router;
}

module.exports = { createReviewRouter, BASE, MONTH_RE };
