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
const { startPolling, startEodJob } = require('./scheduler');

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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/archive', express.static(path.join(process.cwd(), 'public', 'archive')));

// ===== ROUTES =====
const slackEvents = require('./slack/events');
app.use('/', slackEvents.router); // Entrega 3 — /slack/events (Events API + Interactivity)
app.use('/api', apiRouter);
app.use('/api', workflowRouter); // Entrega 3 — workflow_templates et al
app.use('/', dashboardRouter);

// ===== STARTUP =====
async function start() {
  try {
    // 1. Run DB migrations
    console.log('[Boot] Running migrations...');
    await db.migrate();

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

    // 4. Start Slack polling
    startPolling();

    // 5. Start EOD cron
    startEodJob();

    // 5b. Warm the app_name cache (App Home header + Carolina persona).
    require('./app-state').getAppName().catch(() => {});

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
