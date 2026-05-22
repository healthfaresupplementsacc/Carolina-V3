'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.12 — wiring do V3 no app legado.
 *
 * ADITIVO: monta 2 rotas novas e starta o Observer worker. NÃO
 * altera nenhuma rota ou comportamento legado.
 *   POST /slack/events-v2     webhook Events API v2
 *   GET  /api/admin/v3/*      inspeção shadow
 *   Observer worker           mode='shadow' (não reage/posta/DM)
 *
 * Pool próprio (makeV3Pool, search_path=v3,public). Em shadow e
 * com v3.messages vazia, o worker só dá heartbeat — zero custo de
 * LLM até chegar mensagem (webhook ligado ou backfill rodado).
 */
const { makeV3Pool } = require('./utils/v3-pool');
const { getProvider } = require('./llm/LLMProvider');
const { PersonResolver } = require('./services/PersonResolver');
const { PromptBuilder } = require('./llm/prompt-builder');
const { EventService } = require('./services/EventService');
const { BatchService } = require('./services/BatchService');
const { ProductionCountService } = require('./services/ProductionCountService');
const { GoalService } = require('./services/GoalService');
const { Observer } = require('./llm/Observer');
const { eventsV2Handler } = require('./slack/events-v2');
const adminV3 = require('./admin-v3/routes');
const dataApi = require('./data/router');

let _pool = null;
let _svc = null;
let _observer = null;

function _init() {
  if (_pool) return;
  _pool = makeV3Pool();
  const provider = getProvider('anthropic');
  _svc = {
    provider,
    eventService: new EventService({ db: _pool }),
    batchService: new BatchService({ db: _pool }),
    productionCountService: new ProductionCountService({ db: _pool }),
    goalService: new GoalService({ db: _pool }),
    personResolver: new PersonResolver({ db: _pool, provider }),
    promptBuilder: new PromptBuilder({ db: _pool }),
  };
}

/** Síncrono — registra as rotas v3. Chamar ANTES do dashboardRouter. */
function mount(app) {
  _init();
  const productionChannelId = process.env.V3_PRODUCTION_CHANNEL || 'C09UNBXFRKK';

  // webhook — reaproveita req.rawBody que o middleware /slack legado
  // já captura (rawBodySaver). Não usa express.raw próprio.
  app.post('/slack/events-v2', async (req, res) => {
    try {
      const out = await eventsV2Handler(req.rawBody || '', req.headers || {}, {
        db: _pool,
        productionChannelId,
        eventService: _svc.eventService,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
      });
      res.status(out.status).send(out.body);
    } catch (e) {
      console.error('[V3] events-v2 erro:', e.message);
      res.status(500).send('erro');
    }
  });

  // endpoints de inspeção shadow
  app.use('/', adminV3.createRouter({ db: _pool }));
  // Bloco 0 — API de dados JSON (contrato pros clientes). Aditivo.
  app.use('/', dataApi.createDataRouter({ db: _pool }));
  console.log('[V3] rotas montadas: POST /slack/events-v2 + GET /api/admin/v3/* + GET /api/v3/data/*');
}

/** Assíncrono — resolve o bot user id e starta o Observer worker. */
async function startWorker() {
  _init();
  let botUserId = process.env.V3_BOT_USER_ID || null;
  if (!botUserId) {
    try {
      const { WebClient } = require('@slack/web-api');
      const auth = await new WebClient(process.env.SLACK_BOT_TOKEN).auth.test();
      botUserId = auth && auth.user_id;
    } catch (e) {
      console.error('[V3] auth.test falhou (bot_self via cross-ref ainda funciona):', e.message);
    }
  }
  _observer = new Observer(Object.assign({
    db: _pool, botUserId, mode: 'shadow',
  }, _svc));
  _observer.start(5000);
  console.log('[V3] Observer worker SHADOW ligado (tick 5s, bot=' + (botUserId || '?') + ')');
}

module.exports = { mount, startWorker, getObserver: () => _observer, getPool: () => _pool };
