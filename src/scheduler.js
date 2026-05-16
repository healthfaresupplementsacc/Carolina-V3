'use strict';
/**
 * Scheduled jobs:
 *  - Poll Slack every N seconds (configured via POLL_INTERVAL_MS)
 *  - Run urgency check after each poll
 *  - EOD summary at 19:00 EDT every day
 */

const cron = require('node-cron');
const config = require('./config');
const poller = require('./slack/poller');
const urgency = require('./urgency');
const dmHandler = require('./slack/dm-handler');
const slackClient = require('./slack/client');
const { takeScreenshot } = require('./screenshot');
const db = require('./db');
const tasks = require('./tasks');
const orders = require('./orders');
const appState = require('./app-state');
const fs = require('fs');

let pollTimer = null;
// C6 — cron handles so the greeting/EOD jobs can be re-created when the
// admin changes their time in the Config Carolina panel.
let _greetingTask = null;
let _eodTask = null;

async function runPollCycle() {
  try {
    await poller.poll();
    await urgency.checkUrgency();
    await dmHandler.pollBossDMs();
    await dmHandler.pollManagerChannel();
  } catch (err) {
    console.error('[Scheduler] Poll cycle error:', err.message);
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(runPollCycle, config.polling.intervalMs);
  console.log(`[Scheduler] Polling every ${config.polling.intervalMs / 1000}s`);
  // Run immediately on start
  runPollCycle();
}

/**
 * EOD summary job. Runs at 19:00 EDT = 23:00 UTC (or 00:00 UTC in summer).
 * We use both times to handle DST.
 * Cron: "0 23 * * *" UTC (Nov-Mar, EST = UTC-5)
 *       "0 0 * * *"  UTC (Mar-Nov, EDT = UTC-4)
 */
function _stop(task) {
  try { if (task && typeof task.stop === 'function') task.stop(); } catch (_) {}
}

// C6 — single ET-timezone cron from the configured eod_time. The old
// belt-and-suspenders UTC cron is gone: node-cron handles DST via the
// timezone option, and runEod() is idempotent (eod_snapshots per day),
// so a configurable time can't double-fire or fire at the wrong hour.
async function _scheduleEod() {
  _stop(_eodTask);
  const time = await appState.getEodTime();
  _eodTask = cron.schedule(appState.timeToCron(time, '19:00'), () => runEod(), {
    timezone: config.eod.timezone,
  });
  console.log(`[Scheduler] EOD job scheduled at ${time} ${config.eod.timezone}`);
}

async function startEodJob() {
  await _scheduleEod();

  // P4 — daily maintenance at 03:30 ET: stale-break cleanup (N3),
  // audit TTL (L2) and legacy orphan cleanup (>24h open phases/adhoc).
  cron.schedule('30 3 * * *', () => runDailyCleanup(), {
    timezone: config.eod.timezone,
  });
  console.log('[Scheduler] Daily cleanup scheduled at 03:30 ' + config.eod.timezone);
}

// ===== BLOCO B / C3 — morning greeting =====
// Posts a greeting to the production channel each morning. on/off flag,
// override text, schedule time (C6) and active weekdays (C6) all come
// from app_state via the Config Carolina panel; message picks from the
// C5 variations.
async function runGreeting() {
  try {
    const enabled = await appState.get('greeting_enabled', 'true');
    if (String(enabled) === 'false') {
      console.log('[Greeting] disabled — skipping');
      return;
    }

    if (!(await appState.isActiveToday(config.eod.timezone))) {
      console.log('[Greeting] inactive weekday — skipping');
      return;
    }

    const today = new Date().toLocaleDateString('en-CA', { timeZone: config.eod.timezone });
    const lastRun = await appState.get('greeting_last_run', null);
    if (lastRun === today) {
      console.log(`[Greeting] already sent for ${today} — skipping`);
      return;
    }

    const override = await appState.get('greeting_text', null);
    const text = (override && String(override).trim())
      ? String(override).trim()
      : await require('./message-variations').pick('greeting', {});

    // postMessage self-suppresses to silent_log when silent_text=ON or
    // when the 'greeting' toggle is off (C4).
    await slackClient.postMessage(text, null, 'greeting');
    await appState.set('greeting_last_run', today);
    console.log(`[Greeting] sent for ${today}`);
  } catch (err) {
    console.error('[Greeting] error:', err.message);
  }
}

async function _scheduleGreeting() {
  _stop(_greetingTask);
  const time = await appState.getGreetingTime();
  _greetingTask = cron.schedule(appState.timeToCron(time, '08:00'), () => runGreeting(), {
    timezone: config.eod.timezone,
  });
  console.log(`[Scheduler] Morning greeting scheduled at ${time} ${config.eod.timezone}`);
}

async function startGreetingJob() {
  await _scheduleGreeting();
}

// C6 — called by the Config Carolina panel after the admin changes a
// time. Re-creates the greeting + EOD crons from the new app_state.
async function rescheduleJobs() {
  await _scheduleGreeting();
  await _scheduleEod();
}

// BLOCO C / P3 — autonomous detection every 30 min. Detectors self-gate
// (business hours, dedupe); proposals go to the admin channel.
async function runDetect() {
  try {
    const made = await require('./ai/detect').detectAndPropose();
    if (made.length) console.log(`[Detect] proposed ${made.length}: ` +
      made.map((m) => m.type).join(', '));
  } catch (err) {
    console.error('[Detect] error:', err.message);
  }
}
let _detectTask = null;
function startDetectJob() {
  _stop(_detectTask);
  _detectTask = cron.schedule('*/30 * * * *', () => runDetect(), {
    timezone: config.eod.timezone,
  });
  console.log('[Scheduler] Autonomous detect scheduled every 30min ' + config.eod.timezone);
}

async function runDailyCleanup() {
  try {
    const closed = await db.cleanupStaleBreaks();
    const audited = await db.cleanupAuditLog();
    let orphans = { phases_closed: 0, adhoc_closed: 0, workflows_closed: 0 };
    try {
      orphans = await require('./workflow/legacy-cleanup')
        .cleanupLegacyOrphans({ dryRun: false, olderThanHours: 24 });
    } catch (e) { console.error('[Cleanup] legacy orphans error:', e.message); }
    // BUG GHOST — close ghost workflow_instances (>24h active, no
    // recently-active child phase). Audited action='ghost_cleanup'.
    let ghosts = { count: 0 };
    try {
      ghosts = await require('../scripts/cleanup-ghost-workflows')
        .cleanupGhostWorkflows({ apply: true, db, source: 'cron' });
    } catch (e) { console.error('[Cleanup] ghost workflows error:', e.message); }
    console.log(
      `[Cleanup] daily: stale-breaks=${Array.isArray(closed) ? closed.length : closed}, ` +
      `audit-ttl=${audited}, orphan-phases=${orphans.phases_closed}, ` +
      `orphan-adhoc=${orphans.adhoc_closed}, orphan-wf=${orphans.workflows_closed}, ` +
      `ghost-wf=${ghosts.count}`
    );
  } catch (err) {
    console.error('[Cleanup] daily run error:', err.message);
  }
}

async function runEod() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: config.eod.timezone }); // YYYY-MM-DD

  // Prevent duplicate runs
  const existing = await db.query(
    'SELECT id FROM eod_snapshots WHERE snapshot_date = $1',
    [today]
  );
  if (existing.rows.length > 0) {
    console.log(`[EOD] Already ran for ${today}, skipping`);
    return;
  }

  // BLOCO B / C4 — EOD reminder toggle.
  if (!(await appState.isMsgEnabled('eod'))) {
    console.log('[EOD] disabled via Config Carolina — skipping');
    return;
  }

  // BLOCO B / C6 — active-weekday gate.
  if (!(await appState.isActiveToday(config.eod.timezone))) {
    console.log('[EOD] inactive weekday — skipping');
    return;
  }

  console.log(`[EOD] Running summary for ${today}`);

  try {
    // Gather data
    const todayTasks = await tasks.getTodayTasks();
    const countResult = await db.query(
      `SELECT SUM(count) as total FROM production_counts
       WHERE reported_at::date = $1::date`,
      [today]
    );
    const totalBottles = parseInt(countResult.rows[0]?.total || 0);

    // Check for unclosed tasks
    const openTasks = await tasks.getOpenTasks();

    // Screenshot
    let screenshotPath = null;
    let screenshotUrl = null;
    try {
      const shot = await takeScreenshot(today);
      screenshotPath = shot.filepath;
      screenshotUrl = shot.url;
    } catch (err) {
      console.error('[EOD] Screenshot failed:', err.message);
    }

    // B14: include orders total in the summary
    let dayOrdersTotal = { total: 0, sessionCount: 0 };
    try { dayOrdersTotal = await orders.getDayOrdersTotal(today); }
    catch (err) { console.error('[EOD] getDayOrdersTotal error:', err.message); }

    // Build summary message
    const lines = [`Resumo do dia - ${formatDate(today)}`];
    lines.push('');
    lines.push(`Total produzido: *${totalBottles} bottles*`);
    lines.push(`Tarefas concluidas: ${todayTasks.length}`);
    if (dayOrdersTotal.total > 0) {
      const sess = dayOrdersTotal.sessionCount === 1 ? 'sessão' : 'sessões';
      lines.push(`Ordens do dia: ${dayOrdersTotal.total} em ${dayOrdersTotal.sessionCount} ${sess}`);
    }
    lines.push('');

    if (todayTasks.length > 0) {
      for (const t of todayTasks) {
        const bottles = t.bottles ? `${t.bottles} bottles` : 'sem contagem';
        const dur = formatDuration(t.active_duration_seconds);
        const rate = t.bottles_per_hour ? `${t.bottles_per_hour}/h` : '';
        lines.push(`• ${t.supplement_name}: ${bottles} em ${dur} ${rate}`);
      }
    }

    if (openTasks.length > 0) {
      lines.push('');
      lines.push(`*${openTasks.length} tarefa(s) em aberto:*`);
      for (const t of openTasks) {
        lines.push(`• ${t.supplement_name} (${t.operator || '?'}) - sem F:`);
      }
    }

    const summaryText = lines.join('\n');

    // Post to Slack
    let slackTs = null;
    try {
      if (screenshotPath && fs.existsSync(screenshotPath)) {
        const imgBuffer = fs.readFileSync(screenshotPath);
        await slackClient.postImage({
          title: `Resumo ${formatDate(today)}`,
          comment: summaryText,
          imageBuffer: imgBuffer,
          filename: `${today}.png`,
        });
      } else {
        slackTs = await slackClient.postMessage(summaryText);
      }
    } catch (err) {
      console.error('[EOD] Slack post failed:', err.message);
    }

    // Save snapshot
    await db.query(
      `INSERT INTO eod_snapshots (snapshot_date, screenshot_path, summary_text, total_bottles, task_count, slack_message_ts, data_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (snapshot_date) DO UPDATE SET
         screenshot_path = $2, summary_text = $3, total_bottles = $4,
         task_count = $5, slack_message_ts = $6, data_json = $7`,
      [today, screenshotUrl, summaryText, totalBottles, todayTasks.length, slackTs,
       JSON.stringify({ tasks: todayTasks, openTasks })]
    );

    console.log(`[EOD] Done for ${today}. Total: ${totalBottles} bottles.`);
  } catch (err) {
    console.error('[EOD] Error:', err.message);
  }
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDuration(seconds) {
  if (!seconds) return '?';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h${m.toString().padStart(2, '0')}m` : `${m}min`;
}

module.exports = {
  startPolling, startEodJob, runEod, runPollCycle, runDailyCleanup,
  startGreetingJob, runGreeting, rescheduleJobs,
  startDetectJob, runDetect,
};
