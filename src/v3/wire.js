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
const { getProductionProvider } = require('./llm/LLMProvider');
const { PersonResolver } = require('./services/PersonResolver');
const { PromptBuilder } = require('./llm/prompt-builder');
const { EventService } = require('./services/EventService');
const { BatchService } = require('./services/BatchService');
const { ProductionCountService } = require('./services/ProductionCountService');
const { GoalService } = require('./services/GoalService');
const { Observer } = require('./llm/Observer');
const { CommandHandler } = require('./services/CommandHandler');
const slackSender = require('./slack/sender');
const { eventsV2Handler } = require('./slack/events-v2');
const adminV3 = require('./admin-v3/routes');
const dataApi = require('./data/router');
const imagesApi = require('./images/router');
const architectApi = require('../routes/architect');
const opApi = require('../routes/op');

let _pool = null;
let _svc = null;
let _observer = null;

function _init() {
  if (_pool) return;
  _pool = makeV3Pool();
  // Pivot 12/jun: LLM_PROVIDER=gemini (default) com fallback Anthropic
  // automático; LLM_PROVIDER=anthropic = rollback de 1 env var.
  const provider = getProductionProvider();
  console.log('[V3] LLM provider: ' + provider.name);
  const eventService = new EventService({ db: _pool });
  const batchService = new BatchService({ db: _pool });
  // Bloco 30/mai-noite — CommandHandler pra comandos admin via @Carolina.
  const commandHandler = new CommandHandler({
    db: _pool, provider, eventService, batchService,
    slack: { postAs: slackSender.postAs, addReaction: slackSender.addReaction },
    productionChannelId: process.env.V3_PRODUCTION_CHANNEL || 'C09UNBXFRKK',
    adminChannelId: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
  });
  // Deploy 3 — notificações do dedupe (✅/❌/📝 no admin-orin).
  const { NotificationHandler } = require('./services/NotificationHandler');
  const notificationHandler = new NotificationHandler({
    db: _pool,
    slack: { postAs: slackSender.postAs, updateMessage: slackSender.updateMessage },
    adminChannelId: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
  });
  _svc = {
    provider, eventService, batchService, commandHandler, notificationHandler,
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
  const adminChannelId = process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1';

  // webhook — reaproveita req.rawBody que o middleware /slack legado
  // já captura (rawBodySaver). Não usa express.raw próprio.
  app.post('/slack/events-v2', async (req, res) => {
    try {
      const out = await eventsV2Handler(req.rawBody || '', req.headers || {}, {
        db: _pool,
        productionChannelId,
        adminChannelId,
        eventService: _svc.eventService,
        commandHandler: _svc.commandHandler,
        notificationHandler: _svc.notificationHandler,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
      });
      res.status(out.status).send(out.body);
    } catch (e) {
      console.error('[V3] events-v2 erro:', e.message);
      res.status(500).send('erro');
    }
  });

  // Fase D — headers de segurança SÓ nas rotas novas (V4 legado intocado).
  const { securityHeaders, makeBruteForceGuard } = require('../middleware/security');
  for (const prefix of ['/op', '/admin', '/api/v3/op', '/api/v3/architect', '/api/adminpanel']) {
    app.use(prefix, securityHeaders);
  }
  // brute-force guard compartilhado (login admin + operador)
  const bruteForce = makeBruteForceGuard({
    db: _pool, slack: { postAs: slackSender.postAs }, adminChannelId,
  });
  // Fase D — re-hidrata bans persistidos (v3.blocked_ips) no boot e aplica gate
  // global 403 nas rotas novas: IP banido não acessa NADA, não só o login.
  bruteForce.hydrate().then((n) => { if (n) console.log(`[V3] brute-force: ${n} IP(s) banido(s) re-hidratado(s)`); }).catch(() => {});
  for (const prefix of ['/op', '/admin', '/api/v3/op', '/api/v3/architect', '/api/adminpanel']) {
    app.use(prefix, bruteForce.globalGate);
  }

  // endpoints de inspeção shadow
  app.use('/', adminV3.createRouter({ db: _pool }));
  // Fase 1 (Operator Page bloco) — Architect API read-only. Auth por
  // ARCHITECT_API_TOKEN / OPERATOR_PAGE_TOKEN (env). Sem env setada,
  // nenhum token autentica (rotas respondem 401) — seguro deployar antes
  // de setar as vars.
  app.use('/', architectApi.createArchitectRouter({ db: _pool }));
  // Deploy 2 — Operator Page: API de writes estruturados (sem LLM) + UI
  // estática em /op. config.js dinâmico vem ANTES do static (precedência).
  app.use('/', opApi.createOpRouter({
    db: _pool,
    slack: { postAs: slackSender.postAs },
    adminChannelId: adminChannelId,
    bruteForce,
  }));
  {
    const express2 = require('express');
    const path2 = require('path');
    // Redesign: design system compartilhado (/op, /admin, /admin/metrics, /dashboard-v4).
    app.use('/shared', express2.static(path2.join(process.cwd(), 'src', 'shared')));
    app.use('/op', express2.static(path2.join(process.cwd(), 'src', 'op')));
    // Fases B+C — Admin Panel (path NOVO; dashboard V4 intocado).
    const adminPanel = require('../routes/admin');
    app.use('/', adminPanel.createAdminRouter({
      db: _pool,
      slack: { postAs: slackSender.postAs, updateMessage: slackSender.updateMessage },
      bruteForce,
    }));
    const adminDir = path2.join(process.cwd(), 'src', 'admin');
    app.use('/admin', express2.static(adminDir));
    // SPA: /admin/operators e /admin/notifications servem o mesmo index
    app.get(['/admin', '/admin/operators', '/admin/notifications', '/admin/analytics', '/admin/metrics', '/admin/voices', '/admin/audit'], (_req, res) => {
      res.sendFile(path2.join(adminDir, 'index.html'));
    });
  }
  // Bloco 0 — API de dados JSON (contrato pros clientes). Aditivo.
  app.use('/', dataApi.createDataRouter({ db: _pool }));
  // Bloco 3 — SPA do dashboard (cliente puro da API). Estática,
  // buildada em public/dashboard/. Aditivo — não toca nada.
  const express = require('express');
  const path = require('path');
  app.use('/dashboard', express.static(path.join(process.cwd(), 'public', 'dashboard')));
  // V4 (redesign, E4) — SPA paralela em /dashboard-v4. Cliente puro do
  // mesmo /api/v3/data/* (PIN-authed). dashboard/ atual segue intacto.
  // Switch de URL (E8) só rola quando a lista de paridade estiver verde.
  app.use('/dashboard-v4', express.static(path.join(process.cwd(), 'public', 'dashboard-v4')));
  // FOTO — page standalone pra Simone subir foto pro #images (C0B6AQX6LJV).
  // SLACK_BOT_TOKEN no backend; cliente envia base64 com token leve `?k=`.
  // 503 enquanto IMAGES_UPLOAD_TOKEN não tiver no env (Bruno seta no Railway).
  // Lateral total — não toca v3.events/messages/Observer/dashboard.
  app.use('/foto', express.static(path.join(process.cwd(), 'public', 'foto')));
  app.use('/', imagesApi.createImagesRouter({}));
  console.log('[V3] rotas montadas: /slack/events-v2 + /api/admin/v3/* + /api/v3/data/* + /dashboard + /dashboard-v4 + /foto + /api/images/upload');
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
  // ── ITEM 1 — MASTER KILL-SWITCH: Carolina NUNCA posta autonomamente ──
  // Default ON (silencioso) enquanto o sistema não está 100% estável. Sobrescreve
  // qualquer worker autônomo. Só posts SÍNCRONOS (disparados por ação do operador,
  // voz "HealthFare Tracker (Sistema)") seguem — esses NÃO passam por aqui.
  const carolinaSilent = process.env.CAROLINA_SILENT_MODE !== 'false';
  async function auditSilentBlocked(worker) {
    try {
      await _pool.query(
        `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
         VALUES ('system', NULL, 'carolina.silent_mode.blocked', 'worker', NULL, $1::jsonb)`,
        [JSON.stringify({ worker, suppressed_at_startup: true })]);
    } catch (e) { /* best-effort */ }
  }
  if (carolinaSilent) console.log('[V3] 🤫 CAROLINA_SILENT_MODE ON — workers autônomos NÃO postam no Slack');

  _observer = new Observer(Object.assign({
    db: _pool, botUserId, mode: 'shadow',
    // Bloco 29/mai-noite #3 — alertas Slack quando worker bate em
    // billing/rate-limit. Default ON em prod. Pode desligar via env
    // WORKER_ALERTS_DISABLED=1. Silenciado também pelo kill-switch Carolina.
    enableWorkerAlerts: process.env.WORKER_ALERTS_DISABLED !== '1' && !carolinaSilent,
    slack: { postAs: slackSender.postAs, addReaction: slackSender.addReaction },
  }, _svc));
  _observer.start(5000);
  console.log('[V3] Observer worker SHADOW ligado (tick 5s, bot=' + (botUserId || '?') + ')');

  // Fase G — alertas proativos (idle/stale/anomaly). Liga via flag E só se NÃO-silent.
  if (process.env.WORKER_PROACTIVE_ALERTS_ENABLED === 'true' && !carolinaSilent) {
    const { ProactiveAlerts } = require('../workers/proactive-alerts');
    new ProactiveAlerts({
      db: _pool, slack: { postAs: slackSender.postAs },
      adminChannelId: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
    }).start(30 * 60 * 1000);
  } else if (process.env.WORKER_PROACTIVE_ALERTS_ENABLED === 'true' && carolinaSilent) {
    auditSilentBlocked('proactive-alerts'); // queria rodar mas o kill-switch barrou
  }

  // Fase 4 — Carolina manda DM no dia seguinte pra quem esqueceu checkout.
  // Off por padrão E só se NÃO-silent.
  if (process.env.WORKER_FORGOTTEN_DM_ENABLED === 'true' && !carolinaSilent) {
    const { CarolinaForgottenDM } = require('../workers/carolina-forgotten-dm');
    new CarolinaForgottenDM({
      db: _pool, slack: { postAs: slackSender.postAs },
      ordersChannel: process.env.V3_ORDERS_CHANNEL,
      adminChannelId: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
    }).start(10 * 60 * 1000);
  } else if (process.env.WORKER_FORGOTTEN_DM_ENABLED === 'true' && carolinaSilent) {
    auditSilentBlocked('carolina-forgotten-dm');
  }

  // FASE 1.5 — action_log APPEND-ONLY: retém 5 dias, limpa 1×/dia (só > 5 dias).
  // NÃO toca registros recentes; é a rede de segurança de investigação.
  setInterval(async () => {
    try {
      const r = await _pool.query("DELETE FROM v3.operator_action_log WHERE created_at < NOW() - INTERVAL '5 days' RETURNING id");
      if (r.rowCount > 0) console.log('[V3] action_log cleanup: ' + r.rowCount + ' registros > 5 dias removidos');
    } catch (e) { console.error('[V3] action_log cleanup erro:', e.message); }
  }, 24 * 60 * 60 * 1000);

  // Item A — sandbox cleanup: HARD-delete dos dados de teste a cada 5s (no-op
  // barato se não houver operador sandbox). Off só via WORKER_SANDBOX_CLEANUP_ENABLED=false.
  if (process.env.WORKER_SANDBOX_CLEANUP_ENABLED !== 'false') {
    const { SandboxCleanup } = require('../workers/sandbox-cleanup');
    new SandboxCleanup({ db: _pool }).start(5000);
  }

  // Fase 5 — refresh da matview de métricas a cada 10min (best-effort).
  setInterval(async () => {
    try { await _pool.query('SELECT v3.refresh_events_enriched()'); }
    catch (e) { console.error('[V3] refresh events_enriched erro:', e.message); }
  }, 10 * 60 * 1000);

  // Fase D — session cleanup: fecha operator_sessions ociosas >8h (hard limit),
  // 1×/h. Não derruba sessões legítimas (last_activity < 8h). Loga quantas.
  setInterval(async () => {
    try {
      const r = await _pool.query(
        `UPDATE v3.operator_sessions
         SET logged_out_at = NOW(), logoff_reason = 'session_expired_cleanup'
         WHERE logged_out_at IS NULL AND last_activity_at < NOW() - INTERVAL '8 hours'
         RETURNING id`);
      if (r.rowCount > 0) {
        await _pool.query(
          `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
           VALUES ('system', NULL, 'session_cleanup', 'api', NULL, $1::jsonb)`,
          [JSON.stringify({ closed: r.rowCount })]);
        console.log('[V3] session cleanup: ' + r.rowCount + ' sessões ociosas fechadas');
      }
    } catch (e) { console.error('[V3] session cleanup erro:', e.message); }
  }, 60 * 60 * 1000);

  // Bloco 30/mai-noite — cron de expiração de pending_commands.
  // Roda a cada 60s; marca status='expired' os com expires_at < NOW()
  // e posta timeout reply na thread. Pode desligar via env.
  // Deploy 3 — dedupe watcher (Slack ↔ Operator Page). Liga só com a flag.
  if (process.env.WORKER_DEDUPE_ENABLED === 'true') {
    const { DedupeWatcher } = require('../workers/dedupe-watcher');
    const watcher = new DedupeWatcher({
      db: _pool,
      slack: { postAs: slackSender.postAs },
      adminChannelId: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
      // kill-switch Carolina força inbox-only (sem Slack); captura info, não spamma
      silentMode: carolinaSilent || (process.env.WORKER_DEDUPE_NOTIFICATIONS_SILENT_MODE === 'true'),
    });
    watcher.start(60 * 1000);
  }

  if (process.env.V3_PENDING_COMMANDS_CRON_DISABLED !== '1') {
    setInterval(async () => {
      try {
        const n = await _svc.commandHandler.expireOldPending();
        if (n > 0) console.log(`[V3] pending_commands cron: ${n} comandos expirados`);
      } catch (e) {
        console.error('[V3] pending_commands cron erro:', e.message);
      }
    }, 60 * 1000);
    console.log('[V3] pending_commands cron ligado (tick 60s)');
  }
}

module.exports = { mount, startWorker, getObserver: () => _observer, getPool: () => _pool };
