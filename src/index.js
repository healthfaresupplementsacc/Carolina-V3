'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const config = require('./config');
const db = require('./db');
const dashboardRouter = require('./dashboard/router');
const apiRouter = require('./routes/api');
const workflowRouter = require('./routes/workflow');
const { loadCustomSupplements } = apiRouter;
const poller = require('./slack/poller');
const { startPolling, startEodJob, startGreetingJob, startDetectJob, startActivityCheckJob } = require('./scheduler');

const app = express();

// ===== MIDDLEWARE =====
app.use(cors());

// Slack signature verification needs the exact raw body. Capture it for
// /slack/* routes only, before the JSON/urlencoded parsers consume it.
function rawBodySaver(req, _res, buf) {
  if (buf && buf.length) req.rawBody = buf.toString('utf8');
}
app.use('/slack', express.json({ verify: rawBodySaver }));
app.use('/slack', express.urlencoded({ extended: true, verify: rawBodySaver }));

// 10mb pra permitir base64 de imagem no POST /api/v3/data/send (porta de
// saída manual). PIN-gated, body chega só do dashboard admin. Resto das
// rotas usa o mesmo parser mas raramente passa de uns KB.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/archive', express.static(path.join(process.cwd(), 'public', 'archive')));

// ===== ROUTES =====
const slackEvents = require('./slack/events');
app.use('/', slackEvents.router); // Entrega 3 — /slack/events (Events API + Interactivity)
app.use('/api', apiRouter);
app.use('/api', workflowRouter); // Entrega 3 — workflow_templates et al

// V3 (shadow) — rotas ADITIVAS, montadas antes do dashboardRouter.
require('./v3/wire').mount(app);

// Raiz → dashboard-v4 (responsivo, canônico). O dashboard legado (template.js)
// tem container fixo de 1280px e NÃO é mobile-friendly; v4 é o atual. Só o
// GET exato de "/" redireciona — as outras rotas do dashboardRouter (APIs etc.)
// seguem funcionando. (Decisão do Bruno: raiz → v4.)
app.get('/', (req, res) => res.redirect(302, '/dashboard-v4/'));

// Câmeras (view-only, PIN-gated, proxy p/ o PC das câmeras) — ADITIVA; se as
// envs CAM_* faltarem ou o PC das câmeras migrar/estiver off, responde 503 e o V4 segue intacto.
app.use('/', require('./routes/cameras'));

app.use('/', dashboardRouter);

// ===== STARTUP =====
async function start() {
  try {
    // 1. Run DB migrations
    console.log('[Boot] Running migrations...');
    await db.migrate();

    // 1a0. BLOCO B / C5: seed message_variations from code defaults
    //      (idempotent — only seeds a type that has no rows yet).
    await require('./message-variations').seedDefaults();

    // 1a. N3: close any breaks that were left open from previous days.
    await db.cleanupStaleBreaks();

    // 1a2. L2: admin_audit_log TTL (15 days, except permanent actions).
    await db.cleanupAuditLog();

    // 1b. Load custom supplements from DB into parser
    await loadCustomSupplements();

    // 1c. Entrega 3: seed workflow_templates / phase_templates / ad_hoc_tasks
    //     Idempotent — admin can edit/add/delete via dashboard afterwards.
    try {
      const { seedTemplates } = require('./workflow/seed');
      await seedTemplates();
    } catch (err) {
      console.error('[Boot] Workflow seed error:', err.message);
    }

    // 1d. Entrega 3: migrate legacy tasks/orders/formulation/pauses into the
    //     new ISA-88 model. Idempotent via legacy_table/legacy_id checks.
    //     Source tables remain unchanged (read-only history).
    if (process.env.SKIP_LEGACY_MIGRATION !== '1') {
      try {
        const { migrateAll } = require('./workflow/migrate-legacy');
        const summary = await migrateAll({ limit: 10000 });
        console.log('[Boot] Legacy migration summary:', JSON.stringify(summary));
      } catch (err) {
        console.error('[Boot] Legacy migration error:', err.message);
      }
    }

    // 2. Check Slack connection
    console.log('[Boot] Checking Slack connection...');
    try {
      const slackClient = require('./slack/client');
      await slackClient.getChannelInfo();
      console.log('[Boot] Slack connected OK');
    } catch (err) {
      console.error('[Boot] Slack connection failed:', err.message);
      console.error('[Boot] Check SLACK_BOT_TOKEN env var');
    }

    // 3. Backfill if not done
    const backfillDone = await poller.isBackfillDone();
    if (!backfillDone) {
      console.log('[Boot] Running historical backfill...');
      // Feb 12, 2026 = first message we found
      const BACKFILL_START_TS = '1739318400';
      // Run async - don't block startup
      poller.backfill(BACKFILL_START_TS).catch((err) => {
        console.error('[Boot] Backfill failed:', err.message);
      });
    }

    // ── FAXINA V2 — feature flag pra silenciar os crons legados ───────
    // Setar V2_DISABLED=1 no Railway (ProductionLineService) desliga os
    // 5 crons do V2 que postam no Slack (polling, EOD, greeting, detect,
    // activity-check). O V3 Observer (startWorker, mais abaixo) NÃO é
    // afetado — fica FORA deste bloco e sempre liga. Reversível:
    // V2_DISABLED=0 (ou unset) → redeploy → V2 volta. Código intacto.
    if (process.env.V2_DISABLED === '1') {
      console.log('[Boot] V2_DISABLED=1 — pulando crons V2 (polling, EOD, '
        + 'greeting, detect, activity-check). V3 Observer segue normalmente.');
    } else {
      // 4. Start Slack polling
      startPolling();

      // 5. Start EOD cron (C6: time read from app_state)
      await startEodJob();

      // 5a. Start the morning greeting cron (C6: time from app_state).
      await startGreetingJob();

      // 5a2. BLOCO C / P3 — autonomous detection cron (every 30min).
      startDetectJob();

      // 5a3. PARTE 4 — activity-freshness auto-check cron (hourly).
      startActivityCheckJob();
    }

    // 5b. Warm the app_name + persona caches (App Home header + Carolina
    //     persona are built synchronously on hot paths).
    require('./app-state').getAppName().catch(() => {});
    require('./app-state').getPersonaOverrides().catch(() => {});

    // 5c. V3 (shadow) — starta o Observer worker. try/catch pra um
    //     erro no V3 nunca derrubar o boot do legado.
    try {
      await require('./v3/wire').startWorker();
    } catch (err) {
      console.error('[Boot] V3 worker start error:', err.message);
    }

    // 6. Start HTTP server
    const port = config.app.port;
    app.listen(port, () => {
      console.log(`[Boot] Server running on port ${port}`);
      console.log(`[Boot] Dashboard: http://localhost:${port}`);
      console.log(`[Boot] API health: http://localhost:${port}/api/health`);
    });

  } catch (err) {
    console.error('[Boot] Fatal startup error:', err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Shutdown] SIGTERM received');
  await db.pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Shutdown] SIGINT received');
  await db.pool.end();
  process.exit(0);
});

start();
