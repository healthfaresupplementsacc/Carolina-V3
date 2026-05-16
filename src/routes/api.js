'use strict';
/**
 * JSON API endpoints for the dashboard.
 *
 * Every /admin/* write funnels through src/admin/audit.js (checkPin +
 * auditAction). See that module for the audit contract.
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const tasks = require('../tasks');
const orders = require('../orders');
const formulation = require('../formulation');
const parser = require('../parser');
const { auditAction, snapshotRow, checkPin, getAdminPin } = require('../admin/audit');
const { mergeTasks } = require('../admin/merge');
const appState = require('../app-state');
const msgVar = require('../message-variations');

/**
 * Load custom supplements from DB into the parser at startup.
 * Called once after DB migration completes.
 */
async function loadCustomSupplements() {
  try {
    const res = await db.query('SELECT canonical_name, aliases FROM supplement_catalog ORDER BY canonical_name');
    res.rows.forEach(row => parser.addCustomSupplement(row.canonical_name, row.aliases || ''));
    console.log(`[Parser] Loaded ${res.rows.length} custom supplement(s) from DB`);
  } catch (err) {
    console.error('[Parser] Failed to load custom supplements:', err.message);
  }
}

// loadCustomSupplements exported at bottom alongside router

// Main dashboard data endpoint
// ?date=YYYY-MM-DD for historical view (ET timezone)
router.get('/dashboard', async (req, res) => {
  try {
    // Validate date param (YYYY-MM-DD only)
    const rawDate = req.query.date;
    const date = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
    const dateExpr = date ? `'${date}'::date` : `(NOW() AT TIME ZONE 'America/New_York')::date`;

    // Date expressions for yesterday and current week
    const yesterdayExpr = date
      ? `'${date}'::date - INTERVAL '1 day'`
      : `(NOW() AT TIME ZONE 'America/New_York')::date - INTERVAL '1 day'`;
    // Week = Mon 00:00 ET through end of viewing day
    const weekStartExpr = date
      ? `date_trunc('week', '${date}'::date)`
      : `date_trunc('week', (NOW() AT TIME ZONE 'America/New_York')::date)`;

    const [openTasks, todayTasks, timeline, operators, archive, pauseResult, todayOrders, dayOrdersTotal, todayFormulations, todayMessages, todayNotes, activeBreaksResult, yesterdayResult, weekResult, prodSummaryRow] = await Promise.all([
      tasks.getOpenTasks(date),
      tasks.getTodayTasks(date),
      getTimeline(date),
      getOperatorStats(date),
      getArchive(),
      db.query(`SELECT COUNT(*) as cnt FROM pauses WHERE (started_at AT TIME ZONE 'America/New_York')::date = ${dateExpr}`),
      orders.getTodayOrders(date),
      orders.getDayOrdersTotal(date),
      formulation.getTodayFormulations(date),
      getTodayMessages(date),
      getTodayNotes(date),
      date ? Promise.resolve({ rows: [] }) : db.query(`
        SELECT DISTINCT ON (COALESCE(p.operator, t.operator))
               p.id, p.task_id, p.started_at,
               COALESCE(p.operator, t.operator) AS operator,
               t.supplement_name
        FROM pauses p
        LEFT JOIN tasks t ON t.id = p.task_id
        WHERE p.ended_at IS NULL
        ORDER BY COALESCE(p.operator, t.operator), p.started_at ASC
      `),
      // Yesterday's total bottles
      db.query(`
        SELECT COALESCE(SUM(pc.count), 0) AS total
        FROM tasks t
        LEFT JOIN production_counts pc ON pc.task_id = t.id
        WHERE t.status = 'closed'
          AND t.task_type NOT IN ('limpeza', 'revisao')
          AND (t.started_at AT TIME ZONE 'America/New_York')::date = ${yesterdayExpr}
      `),
      // This week's total bottles (Mon → viewing date)
      db.query(`
        SELECT COALESCE(SUM(pc.count), 0) AS total
        FROM tasks t
        LEFT JOIN production_counts pc ON pc.task_id = t.id
        WHERE t.status = 'closed'
          AND t.task_type NOT IN ('limpeza', 'revisao')
          AND (t.started_at AT TIME ZONE 'America/New_York')::date >= ${weekStartExpr}
          AND (t.started_at AT TIME ZONE 'America/New_York')::date <= ${dateExpr}
      `),
      // Production summary sent by team (e.g. "Producao de hoje: ...")
      db.query(`SELECT value FROM app_state WHERE key = $1`, [
        `prod_summary_${date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })}`
      ]),
    ]);

    // Add historical comparison + est. completion to today's tasks
    const todayWithComparison = await Promise.all(
      todayTasks.map(async (t) => {
        const history = await tasks.getSupplementHistory(t.supplement_name, 5);
        const comparison = buildComparison(t, history);
        return { ...t, comparison };
      })
    );

    // Est. completion time per OPEN task (based on historical avg duration)
    const openTasksEst = await Promise.all(
      openTasks.map(async (t) => {
        if (!t.supplement_name) return { ...t, avgDurationSeconds: null, estRemainingSeconds: null };
        const history = await tasks.getSupplementHistory(t.supplement_name, 8);
        const closed = history.filter(h => h.active_duration_seconds > 0);
        if (!closed.length) return { ...t, avgDurationSeconds: null, estRemainingSeconds: null };
        const avg = Math.round(closed.reduce((s, h) => s + h.active_duration_seconds, 0) / closed.length);
        const elapsedSecs = Math.round((Date.now() - new Date(t.started_at).getTime()) / 1000);
        const remaining = avg - elapsedSecs;
        return { ...t, avgDurationSeconds: avg, estRemainingSeconds: remaining };
      })
    );

    // Bug 4 — UNION with the new ISA-88 model so activities created via
    // App Home (which only write phase_instances / ad_hoc_task_instances,
    // never the legacy tasks table) show up in "Em andamento".
    // Dedup: skip rows already represented by a legacy task (the parser
    // dual-write path creates BOTH a task and a phase_instance for typed
    // messages) and skip migration rows (legacy_id IS NOT NULL).
    let workflowOpenItems = [];
    try {
      const wf = await db.query(`
        SELECT pi.id, pi.phase_name, pi.batch_number, pi.started_at,
               wi.product_name, wi.batch_number AS wf_batch,
               wt.name AS workflow_name, o.name AS operator_name,
               (SELECT string_agg(DISTINCT op2.name, ' + ' ORDER BY op2.name)
                  FROM operator_activity_log oal2
                  JOIN operators op2 ON op2.id = oal2.operator_id
                  WHERE oal2.phase_instance_id = pi.id
                    AND oal2.ended_at IS NULL) AS participants
        FROM phase_instances pi
        JOIN workflow_instances wi ON wi.id = pi.workflow_instance_id
        JOIN workflow_templates wt ON wt.id = wi.workflow_template_id
        LEFT JOIN operators o ON o.id = pi.started_by_operator_id
        WHERE pi.status = 'open' AND pi.ended_at IS NULL
          AND pi.legacy_id IS NULL
          AND (pi.started_at AT TIME ZONE 'America/New_York')::date = ${date ? `'${date}'::date` : `(NOW() AT TIME ZONE 'America/New_York')::date`}
          AND NOT EXISTS (
            SELECT 1 FROM tasks t
            WHERE t.status = 'open'
              AND COALESCE(t.operator,'') = COALESCE(o.name,'')
              AND COALESCE(t.supplement_name,'') = COALESCE(wi.product_name,'')
              AND ABS(EXTRACT(EPOCH FROM (t.started_at - pi.started_at))) < 180
          )
        ORDER BY pi.started_at DESC`);
      const ah = await db.query(`
        SELECT ati.id, ati.task_name, ati.started_at, o.name AS operator_name,
               (SELECT string_agg(DISTINCT op2.name, ' + ' ORDER BY op2.name)
                  FROM operator_activity_log oal2
                  JOIN operators op2 ON op2.id = oal2.operator_id
                  WHERE oal2.ad_hoc_task_instance_id = ati.id
                    AND oal2.ended_at IS NULL) AS participants
        FROM ad_hoc_task_instances ati
        LEFT JOIN operators o ON o.id = ati.started_by_operator_id
        WHERE ati.status = 'open' AND ati.ended_at IS NULL
          AND ati.legacy_id IS NULL
          AND (ati.started_at AT TIME ZONE 'America/New_York')::date = ${date ? `'${date}'::date` : `(NOW() AT TIME ZONE 'America/New_York')::date`}
        ORDER BY ati.started_at DESC`);
      workflowOpenItems = [
        ...wf.rows.map((r) => ({
          id: `ph-${r.id}`, phase_instance_id: r.id,
          supplement_name: r.product_name || null,
          batch_number: r.batch_number || null,
          // F1+U2: show every active participant (starter + joiners),
          // falling back to the phase starter name.
          operator: r.participants || r.operator_name || null,
          task_type: r.phase_name || null,
          // B6 — parent workflow so the card shows hierarchy:
          // "Produção de Suplemento · Berberine #0119" / phase indented.
          parent_label: (r.product_name
            ? `${r.workflow_name} · ${r.product_name}`
            : r.workflow_name) + (r.wf_batch ? ` #${r.wf_batch}` : ''),
          started_at: r.started_at,
          _source: 'workflow_phase',
          avgDurationSeconds: null, estRemainingSeconds: null,
        })),
        ...ah.rows.map((r) => ({
          id: `ah-${r.id}`, ad_hoc_task_instance_id: r.id,
          supplement_name: null, batch_number: null,
          operator: r.participants || r.operator_name || null,
          task_type: r.task_name || null,
          started_at: r.started_at,
          _source: 'workflow_adhoc',
          avgDurationSeconds: null, estRemainingSeconds: null,
        })),
      ];
    } catch (err) {
      console.error('[Dashboard] workflow union error:', err.message);
      workflowOpenItems = []; // fail closed — legacy openTasks still works
    }
    openTasksEst.push(...workflowOpenItems);

    // Production totals
    const todayBottles = todayWithComparison.reduce((s, t) => s + (parseInt(t.bottles) || 0), 0);
    const yesterdayBottles = parseInt(yesterdayResult.rows[0]?.total || 0);
    const weekBottles = parseInt(weekResult.rows[0]?.total || 0);

    // Production summary sent by team — preferred source for today's total
    let prodSummaryBottles = null;
    let prodSummaryItems = null;
    if (prodSummaryRow.rows.length > 0) {
      try {
        const parsed = JSON.parse(prodSummaryRow.rows[0].value);
        prodSummaryBottles = parsed.totalBottles || null;
        prodSummaryItems = parsed.items || null;
      } catch (_) { /* ignore */ }
    }

    // Use prod summary total for trend calc if available, otherwise fall back to task sum
    const displayBottles = prodSummaryBottles != null ? prodSummaryBottles : todayBottles;
    const trendPct = yesterdayBottles > 0
      ? Math.round(((displayBottles - yesterdayBottles) / yesterdayBottles) * 100)
      : null;

    // Silent mode flags (master + sub-flags). silentModeActive kept for
    // backward compat: true if EITHER text OR reactions is muted.
    let silentMaster = false, silentText = false, silentReactions = false;
    try {
      const s = await db.query(
        "SELECT key, value FROM app_state WHERE key IN ('silent_mode','silent_text','silent_reactions')"
      );
      const m = Object.fromEntries(s.rows.map((r) => [r.key, r.value]));
      silentMaster    = m.silent_mode      === 'true';
      silentText      = m.silent_text      === 'true' || silentMaster;
      silentReactions = m.silent_reactions === 'true' || silentMaster;
    } catch (_) {}
    const silentModeActive = silentText || silentReactions;

    res.json({
      openTasks: openTasksEst,
      todayTasks: todayWithComparison,
      todayOrders,
      dayOrdersTotal, // B14: { total, sessionCount } across all orders_sessions of the day
      silentModeActive,
      silentText,
      silentReactions,
      silentMaster,
      todayFormulations,
      todayMessages,
      todayNotes,
      timeline,
      operators,
      archive,
      pauseCount: parseInt(pauseResult.rows[0]?.cnt || 0),
      activeBreaks: activeBreaksResult.rows,
      todayBreaks: await getTodayBreaks(date),
      completedToday: await getCompletedToday(date),
      timeFormat: await appState.getTimeFormat(), // BUG AMPM — client mirrors this
      viewingDate: date || null,
      todayBottles,
      yesterdayBottles,
      weekBottles,
      trendPct,
      prodSummaryBottles,
      prodSummaryItems,
    });
  } catch (err) {
    console.error('[API] /dashboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Per-supplement history
router.get('/supplement/:name/history', async (req, res) => {
  try {
    const history = await tasks.getSupplementHistory(decodeURIComponent(req.params.name), 10);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Open tasks only (for urgency monitoring)
router.get('/tasks/open', async (req, res) => {
  try {
    res.json(await tasks.getOpenTasks());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
router.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    const lastPoll = await db.query("SELECT value FROM app_state WHERE key = 'last_processed_ts'");
    res.json({
      status: 'ok',
      db: 'connected',
      version: '2025-05-14-v2',
      lastPollTs: lastPoll.rows[0]?.value || null,
      time: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Trigger EOD manually (admin)
router.post('/eod/run', async (req, res) => {
  try {
    const { runEod } = require('../scheduler');
    await runEod();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-scan recent Slack messages looking for a production summary (admin)
router.post('/admin/rescan-summary', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const slackClient = require('../slack/client');
    const parserMod   = require('../parser');
    const eodEngine   = require('../eod');
    const date = req.body.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Fetch last 200 messages and look for production summary
    const messages = await slackClient.fetchMessages(null, 200);
    let found = null;
    for (const msg of messages.reverse()) {
      if (!msg.text) continue;
      const parsed = parserMod.parseMessage(msg);
      if (parsed?.type === 'production_summary' && parsed.totalBottles > 0) {
        found = parsed;
        break;
      }
    }

    if (!found) {
      await auditAction({ req, action: 'rescan_summary.no_match', entityType: 'app_state',
                          entityId: `prod_summary_${date}`, after: { date } });
      return res.json({ ok: false, message: 'Nenhum resumo de produção encontrado nas últimas mensagens' });
    }

    // Save and reply
    await eodEngine.handleProductionSummary(found);
    await auditAction({ req, action: 'rescan_summary.applied', entityType: 'app_state',
                        entityId: `prod_summary_${date}`,
                        after: { totalBottles: found.totalBottles, items: found.items } });
    res.json({ ok: true, totalBottles: found.totalBottles, items: found.items });
  } catch (err) {
    console.error('[Admin] Rescan summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Manually set today's production total (admin override)
router.post('/admin/set-total', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const { total, date } = req.body;
    const bottles = parseInt(total);
    if (isNaN(bottles) || bottles < 0) return res.status(400).json({ error: 'Total inválido' });
    const day = date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const key = `prod_summary_${day}`;
    const beforeRow = await db.query('SELECT value FROM app_state WHERE key = $1', [key]);
    const before = beforeRow.rows[0] ? safeJson(beforeRow.rows[0].value) : null;
    const after = { totalBottles: bottles, items: [], manualOverride: true, operator: 'admin' };
    await db.query(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, JSON.stringify(after)]
    );
    await auditAction({ req, action: 'set_total', entityType: 'app_state',
                        entityId: key, before, after });
    console.log(`[Admin] Manual total set: ${bottles} bottles for ${day}`);
    res.json({ ok: true, totalBottles: bottles, date: day });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Close all stale open tasks from backfill (tasks started before today)
router.post('/cleanup-stale-tasks', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const result = await db.query(`
      UPDATE tasks
      SET status = 'closed',
          ended_at = started_at + INTERVAL '8 hours',
          active_duration_seconds = EXTRACT(EPOCH FROM (started_at + INTERVAL '8 hours' - started_at))::int
      WHERE status = 'open'
        AND started_at::date < CURRENT_DATE
      RETURNING id
    `);
    await auditAction({ req, action: 'cleanup_stale_tasks', entityType: 'cleanup',
                        entityId: null, after: { closed: result.rows.length, ids: result.rows.map(r => r.id) } });
    console.log(`[Admin] Closed ${result.rows.length} stale historical tasks`);
    res.json({ ok: true, closed: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger backfill manually (admin)
router.post('/backfill', async (req, res) => {
  try {
    const poller = require('../slack/poller');
    const startTs = req.body.since || '1707696000'; // Feb 2026
    res.json({ ok: true, message: 'Backfill iniciado em background' });
    poller.backfill(startTs).catch(console.error);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Admin Edit Endpoints (PIN protected — see src/admin/audit.js) =====

// Helper: safe JSON.parse that returns the raw string when not JSON.
function safeJson(v) {
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return v; }
}

// Close an open task manually (admin)
router.post('/admin/task/:id/close', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const before = await snapshotRow('tasks', 'id', req.params.id);
    await db.query(
      `UPDATE tasks SET
         status = 'closed',
         ended_at = NOW(),
         duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::int,
         active_duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::int,
         updated_at = NOW()
       WHERE id = $1 AND status = 'open'`,
      [req.params.id]
    );
    const after = await snapshotRow('tasks', 'id', req.params.id);
    await auditAction({ req, action: 'task.close', entityType: 'task',
                        entityId: req.params.id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/admin/task/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const before = await snapshotRow('tasks', 'id', req.params.id);
    if (!before) return res.status(404).json({ error: 'Task not found' });
    const {
      supplement_name, batch_number, operator, started_at, ended_at, bottles,
      // Entrega 2 expansions:
      helpers, task_type, status, description, closed_by,
    } = req.body;

    // Build dynamic SET clause for task fields
    const sets = ['updated_at = NOW()'];
    const params = [];
    if (supplement_name !== undefined) { sets.push(`supplement_name = NULLIF($${params.length+1},'')`); params.push(supplement_name || ''); }
    if (batch_number    !== undefined) { sets.push(`batch_number    = NULLIF($${params.length+1},'')`); params.push(batch_number || ''); }
    if (operator        !== undefined) { sets.push(`operator        = NULLIF($${params.length+1},'')`); params.push(operator || ''); }
    if (helpers         !== undefined) { sets.push(`helpers         = NULLIF($${params.length+1},'')`); params.push(helpers || ''); }
    if (task_type       !== undefined) { sets.push(`task_type       = NULLIF($${params.length+1},'')`); params.push(task_type || ''); }
    if (description     !== undefined) { sets.push(`description     = $${params.length+1}`); params.push(description); }
    if (closed_by       !== undefined) { sets.push(`closed_by       = NULLIF($${params.length+1},'')`); params.push(closed_by || ''); }
    if (status          !== undefined) { sets.push(`status          = $${params.length+1}`); params.push(status); }
    if (started_at) {
      sets.push(`started_at = ($${params.length+1}::timestamp AT TIME ZONE 'America/New_York')`);
      params.push(started_at);
    }
    if (ended_at) {
      sets.push(`ended_at = ($${params.length+1}::timestamp AT TIME ZONE 'America/New_York')`);
      params.push(ended_at);
      // Recompute duration if both timestamps available
      sets.push(`duration_seconds = EXTRACT(EPOCH FROM (($${params.length}::timestamp AT TIME ZONE 'America/New_York') - started_at))::int`);
    }
    params.push(req.params.id);
    await db.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

    // Update bottles count (upsert into production_counts)
    if (bottles !== undefined && bottles !== null && bottles !== '') {
      const bottleCount = parseInt(bottles);
      if (!isNaN(bottleCount)) {
        const existing = await db.query('SELECT id FROM production_counts WHERE task_id = $1 LIMIT 1', [req.params.id]);
        if (existing.rows.length > 0) {
          await db.query('UPDATE production_counts SET count = $1 WHERE task_id = $2', [bottleCount, req.params.id]);
        } else {
          const taskRes = await db.query('SELECT supplement_name, batch_number, operator FROM tasks WHERE id = $1', [req.params.id]);
          const task = taskRes.rows[0];
          if (task) {
            await db.query(
              `INSERT INTO production_counts (supplement_name, batch_number, count, operator, reported_at, task_id)
               VALUES ($1, $2, $3, $4, NOW(), $5)`,
              [task.supplement_name, task.batch_number, bottleCount, task.operator, req.params.id]
            );
          }
        }
      }
    }

    const after = await snapshotRow('tasks', 'id', req.params.id);
    await auditAction({ req, action: 'task.edit', entityType: 'task',
                        entityId: req.params.id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/admin/order/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const before = await snapshotRow('orders_sessions', 'id', req.params.id);
    const { order_count, operator, batch_label, started_at, ended_at, status, helpers } = req.body;
    const sets = ['updated_at = NOW()'];
    const params = [];
    if (order_count !== undefined) { sets.push(`order_count = $${params.length+1}`); params.push(parseInt(order_count) || null); }
    if (operator    !== undefined) { sets.push(`operator    = NULLIF($${params.length+1},'')`); params.push(operator || ''); }
    if (helpers     !== undefined) { sets.push(`helpers     = NULLIF($${params.length+1},'')`); params.push(helpers || ''); }
    if (batch_label !== undefined) { sets.push(`batch_label = NULLIF($${params.length+1},'')`); params.push(batch_label || ''); }
    if (status      !== undefined) { sets.push(`status      = $${params.length+1}`); params.push(status); }
    if (started_at) {
      sets.push(`started_at = ($${params.length+1}::timestamp AT TIME ZONE 'America/New_York')`);
      params.push(started_at);
    }
    if (ended_at) {
      sets.push(`ended_at = ($${params.length+1}::timestamp AT TIME ZONE 'America/New_York')`);
      params.push(ended_at);
      sets.push(`duration_seconds = EXTRACT(EPOCH FROM (($${params.length}::timestamp AT TIME ZONE 'America/New_York') - started_at))::int`);
      sets.push(`status = 'closed'`);
    }
    params.push(req.params.id);
    await db.query(`UPDATE orders_sessions SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    const after = await snapshotRow('orders_sessions', 'id', req.params.id);
    await auditAction({ req, action: 'orders_session.edit', entityType: 'orders_session',
                        entityId: req.params.id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Admin Create Orders Session =====
router.post('/admin/order/create', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const { operator, order_count, batch_label, started_at, ended_at } = req.body;
    if (!started_at) return res.status(400).json({ error: 'started_at é obrigatório' });
    const status = ended_at ? 'closed' : 'open';
    const result = await db.query(
      `INSERT INTO orders_sessions (operator, order_count, batch_label, started_at, status, slack_start_ts)
       VALUES ($1, $2, $3, ($4::timestamp AT TIME ZONE 'America/New_York'), $5, 'manual')
       RETURNING id`,
      [operator || null, parseInt(order_count) || null, batch_label || 'afternoon', started_at, status]
    );
    if (ended_at) {
      await db.query(
        `UPDATE orders_sessions SET
           ended_at = ($1::timestamp AT TIME ZONE 'America/New_York'),
           duration_seconds = EXTRACT(EPOCH FROM (($1::timestamp AT TIME ZONE 'America/New_York') - started_at))::int
         WHERE id = $2`,
        [ended_at, result.rows[0].id]
      );
    }
    const after = await snapshotRow('orders_sessions', 'id', result.rows[0].id);
    await auditAction({ req, action: 'orders_session.create', entityType: 'orders_session',
                        entityId: result.rows[0].id, before: null, after });
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/admin/formulation/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const before = await snapshotRow('formulation_sessions', 'id', req.params.id);
    const { supplement_name, batch_number, operator, started_at, ended_at } = req.body;
    const sets = ['updated_at = NOW()'];
    const params = [];
    if (supplement_name !== undefined) { sets.push(`supplement_name = NULLIF($${params.length+1},'')`); params.push(supplement_name || ''); }
    if (batch_number    !== undefined) { sets.push(`batch_number    = NULLIF($${params.length+1},'')`); params.push(batch_number || ''); }
    if (operator        !== undefined) { sets.push(`operator        = NULLIF($${params.length+1},'')`); params.push(operator || ''); }
    if (started_at) {
      sets.push(`started_at = ($${params.length+1}::timestamp AT TIME ZONE 'America/New_York')`);
      params.push(started_at);
    }
    if (ended_at) {
      sets.push(`ended_at = ($${params.length+1}::timestamp AT TIME ZONE 'America/New_York')`);
      params.push(ended_at);
      sets.push(`duration_seconds = EXTRACT(EPOCH FROM (($${params.length}::timestamp AT TIME ZONE 'America/New_York') - started_at))::int`);
    }
    params.push(req.params.id);
    await db.query(`UPDATE formulation_sessions SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    const after = await snapshotRow('formulation_sessions', 'id', req.params.id);
    await auditAction({ req, action: 'formulation.edit', entityType: 'formulation_session',
                        entityId: req.params.id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Admin: Pauses / Breaks CRUD (B17 — admin tira pessoa de break) =====

// GET /api/admin/pauses?date=YYYY-MM-DD&pin=XXX — list pauses for a date (defaults today, ET)
router.get('/admin/pauses', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const date = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
    const dateExpr = date ? `'${date}'::date` : `(NOW() AT TIME ZONE 'America/New_York')::date`;
    const result = await db.query(
      `SELECT p.id, p.task_id, p.operator, p.reason,
              p.started_at, p.ended_at, p.ended_reason,
              p.slack_ts, p.created_at, p.deleted_at,
              t.supplement_name AS task_supplement
       FROM pauses p
       LEFT JOIN tasks t ON t.id = p.task_id
       WHERE (p.started_at AT TIME ZONE 'America/New_York')::date = ${dateExpr}
         AND p.deleted_at IS NULL
       ORDER BY p.started_at ASC`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/pause/create — retroactive break
router.post('/admin/pause/create', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const { operator, reason, started_at, ended_at, task_id } = req.body;
    if (!operator) return res.status(400).json({ error: 'operator é obrigatório' });
    if (!started_at) return res.status(400).json({ error: 'started_at é obrigatório' });

    // Insert with NULL ended_at first, then UPDATE if ended_at was provided.
    // Avoids string-interpolating a SQL fragment based on user-controlled data.
    const insert = await db.query(
      `INSERT INTO pauses (operator, reason, started_at, task_id, slack_ts)
       VALUES ($1, $2, ($3::timestamp AT TIME ZONE 'America/New_York'), $4, 'manual')
       RETURNING id`,
      [operator, reason || null, started_at, task_id || null]
    );
    const newId = insert.rows[0].id;
    if (ended_at) {
      await db.query(
        `UPDATE pauses SET ended_at = ($1::timestamp AT TIME ZONE 'America/New_York') WHERE id = $2`,
        [ended_at, newId]
      );
    }
    const after = await snapshotRow('pauses', 'id', newId);
    await auditAction({ req, action: 'pause.create', entityType: 'pause',
                        entityId: newId, before: null, after });
    res.json({ ok: true, id: newId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/admin/pause/:id — edit any field
router.put('/admin/pause/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const before = await snapshotRow('pauses', 'id', req.params.id);
    if (!before) return res.status(404).json({ error: 'Pause not found' });

    const { operator, reason, started_at, ended_at, ended_reason, task_id } = req.body;
    const sets = [];
    const params = [];
    if (operator      !== undefined) { sets.push(`operator      = NULLIF($${params.length+1},'')`); params.push(operator || ''); }
    if (reason        !== undefined) { sets.push(`reason        = NULLIF($${params.length+1},'')`); params.push(reason || ''); }
    if (ended_reason  !== undefined) { sets.push(`ended_reason  = NULLIF($${params.length+1},'')`); params.push(ended_reason || ''); }
    if (task_id       !== undefined) { sets.push(`task_id       = $${params.length+1}`); params.push(task_id || null); }
    if (started_at) {
      sets.push(`started_at = ($${params.length+1}::timestamp AT TIME ZONE 'America/New_York')`);
      params.push(started_at);
    }
    if (ended_at) {
      sets.push(`ended_at = ($${params.length+1}::timestamp AT TIME ZONE 'America/New_York')`);
      params.push(ended_at);
    } else if (ended_at === null) {
      // Explicit null → reopen the pause
      sets.push(`ended_at = NULL`);
      sets.push(`ended_reason = NULL`);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });

    params.push(req.params.id);
    await db.query(`UPDATE pauses SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    const after = await snapshotRow('pauses', 'id', req.params.id);
    await auditAction({ req, action: 'pause.edit', entityType: 'pause',
                        entityId: req.params.id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/pause/:id/close — admin force-closes an open break (B17)
router.post('/admin/pause/:id/close', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const before = await snapshotRow('pauses', 'id', req.params.id);
    if (!before) return res.status(404).json({ error: 'Pause not found' });
    if (before.ended_at) return res.status(400).json({ error: 'Pause já encerrada' });

    const endedAt = req.body.ended_at || new Date().toISOString();
    await db.query(
      `UPDATE pauses
       SET ended_at = ($1::timestamp AT TIME ZONE 'America/New_York'),
           ended_reason = 'admin_force_close'
       WHERE id = $2`,
      [endedAt, req.params.id]
    );
    const after = await snapshotRow('pauses', 'id', req.params.id);
    await auditAction({ req, action: 'pause.close', entityType: 'pause',
                        entityId: req.params.id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/admin/pause/:id — soft delete (sets deleted_at)
router.delete('/admin/pause/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const before = await snapshotRow('pauses', 'id', req.params.id);
    if (!before) return res.status(404).json({ error: 'Pause not found' });
    if (before.deleted_at) return res.status(400).json({ error: 'Pause já deletada' });

    await db.query('UPDATE pauses SET deleted_at = NOW() WHERE id = $1', [req.params.id]);
    const after = await snapshotRow('pauses', 'id', req.params.id);
    await auditAction({ req, action: 'pause.delete', entityType: 'pause',
                        entityId: req.params.id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Admin: Production Counts CRUD =====

// GET /api/admin/counts?date=YYYY-MM-DD&pin=XXX — list production_counts for a day
router.get('/admin/counts', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const date = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
    const dateExpr = date ? `'${date}'::date` : `(NOW() AT TIME ZONE 'America/New_York')::date`;
    const result = await db.query(
      `SELECT id, supplement_name, batch_number, count, operator,
              reported_at, slack_ts, task_id, deleted_at
       FROM production_counts
       WHERE (reported_at AT TIME ZONE 'America/New_York')::date = ${dateExpr}
         AND deleted_at IS NULL
       ORDER BY reported_at ASC`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/count/create — add a manual production count
router.post('/admin/count/create', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const { supplement_name, batch_number, count, operator, reported_at, task_id } = req.body;
    if (!supplement_name) return res.status(400).json({ error: 'supplement_name é obrigatório' });
    const n = parseInt(count);
    if (isNaN(n) || n < 0) return res.status(400).json({ error: 'count inválido' });

    const result = await db.query(
      `INSERT INTO production_counts
         (supplement_name, batch_number, count, operator, reported_at, task_id)
       VALUES ($1, $2, $3, $4,
               COALESCE(($5::timestamp AT TIME ZONE 'America/New_York'), NOW()),
               $6)
       RETURNING id`,
      [supplement_name, batch_number || null, n, operator || null, reported_at || null, task_id || null]
    );
    const newId = result.rows[0].id;
    const after = await snapshotRow('production_counts', 'id', newId);
    await auditAction({ req, action: 'production_count.create', entityType: 'production_count',
                        entityId: newId, before: null, after });
    res.json({ ok: true, id: newId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/admin/count/:id — edit any field
router.put('/admin/count/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const before = await snapshotRow('production_counts', 'id', req.params.id);
    if (!before) return res.status(404).json({ error: 'Count not found' });

    const { supplement_name, batch_number, count, operator, reported_at, task_id } = req.body;
    const sets = [];
    const params = [];
    if (supplement_name !== undefined) { sets.push(`supplement_name = NULLIF($${params.length+1},'')`); params.push(supplement_name || ''); }
    if (batch_number    !== undefined) { sets.push(`batch_number    = NULLIF($${params.length+1},'')`); params.push(batch_number || ''); }
    if (count           !== undefined) {
      const n = parseInt(count);
      if (isNaN(n) || n < 0) return res.status(400).json({ error: 'count inválido' });
      sets.push(`count = $${params.length+1}`); params.push(n);
    }
    if (operator !== undefined) { sets.push(`operator = NULLIF($${params.length+1},'')`); params.push(operator || ''); }
    if (task_id  !== undefined) { sets.push(`task_id  = $${params.length+1}`); params.push(task_id || null); }
    if (reported_at) {
      sets.push(`reported_at = ($${params.length+1}::timestamp AT TIME ZONE 'America/New_York')`);
      params.push(reported_at);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });

    params.push(req.params.id);
    await db.query(`UPDATE production_counts SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    const after = await snapshotRow('production_counts', 'id', req.params.id);
    await auditAction({ req, action: 'production_count.edit', entityType: 'production_count',
                        entityId: req.params.id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/admin/count/:id — soft delete
router.delete('/admin/count/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const before = await snapshotRow('production_counts', 'id', req.params.id);
    if (!before) return res.status(404).json({ error: 'Count not found' });
    if (before.deleted_at) return res.status(400).json({ error: 'Count já deletado' });

    await db.query('UPDATE production_counts SET deleted_at = NOW() WHERE id = $1', [req.params.id]);
    const after = await snapshotRow('production_counts', 'id', req.params.id);
    await auditAction({ req, action: 'production_count.delete', entityType: 'production_count',
                        entityId: req.params.id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Kill switch: silent mode (master + sub-flags) =====
// POST /api/admin/silent-toggle
//   body: { pin, kind?: 'text'|'reactions'|'all'|'master', value?: 'on'|'off' }
//   - kind='text'      → flips silent_text
//   - kind='reactions' → flips silent_reactions
//   - kind='all'       → sets BOTH sub-flags to value (and master to off)
//   - kind='master' OR undefined (backward compat) → flips silent_mode
//   value omitted → toggles current state
const SILENT_KEYS = {
  text:      'silent_text',
  reactions: 'silent_reactions',
  master:    'silent_mode',
};
router.post('/admin/silent-toggle', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const kind = req.body?.kind || 'master';
    let value;
    if (req.body?.value === 'on'  || req.body?.value === true)  value = 'true';
    else if (req.body?.value === 'off' || req.body?.value === false) value = 'false';
    else value = null; // toggle

    const cur = await db.query(
      "SELECT key, value FROM app_state WHERE key IN ('silent_mode','silent_text','silent_reactions')"
    );
    const before = Object.fromEntries(cur.rows.map((r) => [r.key, r.value]));

    async function setKey(key, next) {
      await db.query(
        `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, next]
      );
    }

    let after;
    if (kind === 'all') {
      const next = value || (before.silent_text === 'true' || before.silent_reactions === 'true' ? 'false' : 'true');
      await setKey('silent_text', next);
      await setKey('silent_reactions', next);
      await setKey('silent_mode', 'false'); // turn master off when using sub-flags
      after = { silent_text: next, silent_reactions: next, silent_mode: 'false' };
    } else {
      const dbKey = SILENT_KEYS[kind];
      if (!dbKey) return res.status(400).json({ error: 'kind inválido (use text|reactions|all|master)' });
      const next = value || (before[dbKey] === 'true' ? 'false' : 'true');
      await setKey(dbKey, next);
      after = { ...before, [dbKey]: next };
    }

    try { require('../slack/client').invalidateSilentCache(); } catch (_) {}

    await auditAction({
      req, action: 'silent_mode.toggle', entityType: 'app_state',
      entityId: kind, before, after,
    });
    res.json({
      ok: true,
      kind,
      silent_text:      after.silent_text      === 'true',
      silent_reactions: after.silent_reactions === 'true',
      silent_master:    after.silent_mode      === 'true',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== BLOCO B — Painel Config Carolina =====
// GET /api/admin/carolina-config?pin=XXX — current config snapshot.
// Extended by later BLOCO B commits (toggles, schedules, persona).
router.get('/admin/carolina-config', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const appName = await appState.getAppName();
    const toggles = await appState.getMsgToggles();
    const schedule = await appState.getSchedule();
    const pov = await appState.getPersonaOverrides();
    const pparts = require('../ai/persona').getPersonaParts(appName);
    res.json({
      app_name: appName, toggles, schedule,
      time_format: await appState.getTimeFormat(), // BUG AMPM (12h default)
      variation_types: msgVar.listTypes(),
      persona: {
        identity: pov.identity, personality: pov.personality,
        identity_default: pparts.identity_default,
        personality_default: pparts.personality_default,
        prod_rules: pparts.prod_rules, admin_rules: pparts.admin_rules,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/carolina-config/schedule
//   body: { pin, greeting_time?, eod_time?, pending_window_minutes?, active_weekdays? }
// C6 — times/window/weekdays. Time changes re-create the crons live.
router.post('/admin/carolina-config/schedule', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const b = req.body || {};
    const timeRe = /^([01]?\d|2[0-3]):[0-5]\d$/;
    const before = await appState.getSchedule();

    if (b.greeting_time !== undefined) {
      if (!timeRe.test(String(b.greeting_time))) return res.status(400).json({ error: 'greeting_time inválido (HH:MM)' });
      await appState.set('greeting_time', String(b.greeting_time));
    }
    if (b.eod_time !== undefined) {
      if (!timeRe.test(String(b.eod_time))) return res.status(400).json({ error: 'eod_time inválido (HH:MM)' });
      await appState.set('eod_time', String(b.eod_time));
    }
    if (b.pending_window_minutes !== undefined) {
      const n = parseInt(b.pending_window_minutes, 10);
      if (!Number.isFinite(n) || n < 1 || n > 240) return res.status(400).json({ error: 'pending_window_minutes 1–240' });
      await appState.set('pending_window_minutes', String(n));
    }
    if (b.active_weekdays !== undefined) {
      const arr = (Array.isArray(b.active_weekdays) ? b.active_weekdays : String(b.active_weekdays).split(','))
        .map((x) => parseInt(x, 10))
        .filter((x) => Number.isInteger(x) && x >= 0 && x <= 6);
      if (arr.length === 0) return res.status(400).json({ error: 'active_weekdays vazio' });
      await appState.set('active_weekdays', arr.join(','));
    }

    const after = await appState.getSchedule();
    // Re-create the greeting/EOD crons so a new time takes effect now.
    try { await require('../scheduler').rescheduleJobs(); } catch (e) { console.error('[Sched] reschedule:', e.message); }

    await auditAction({
      req, action: 'carolina_config.schedule', entityType: 'app_state',
      entityId: 'schedule', before, after,
    });
    res.json({ ok: true, schedule: after });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/carolina-config/persona  body: { pin, identity?, personality? }
// C7 — edit the IDENTITY / PERSONALITY blocks. Empty value reverts that
// block to the code default. The PROD_RULES guardrail is NOT editable
// here and is always re-appended by persona.buildPersona.
router.post('/admin/carolina-config/persona', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const b = req.body || {};
    if (b.identity === undefined && b.personality === undefined) {
      return res.status(400).json({ error: 'nada para alterar' });
    }
    const before = await appState.getPersonaOverrides();
    if (b.identity !== undefined) {
      if (String(b.identity).length > 4000) return res.status(400).json({ error: 'identity muito longo (máx 4000)' });
      await appState.setPersonaField('identity', b.identity);
    }
    if (b.personality !== undefined) {
      if (String(b.personality).length > 4000) return res.status(400).json({ error: 'personality muito longo (máx 4000)' });
      await appState.setPersonaField('personality', b.personality);
    }
    const after = await appState.getPersonaOverrides();
    await auditAction({
      req, action: 'carolina_config.persona', entityType: 'app_state',
      entityId: 'persona',
      before: { identity: before.identity, personality: before.personality },
      after: { identity: after.identity, personality: after.personality },
    });
    res.json({ ok: true, persona: after });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/carolina-config/persona/preview?pin
// The fully assembled persona for each scope, reflecting current
// overrides — so the admin can SEE the locked guardrails are still in.
router.get('/admin/carolina-config/persona/preview', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    await appState.getPersonaOverrides();          // refresh sync cache
    const appName = appState.getAppNameSync();
    const persona = require('../ai/persona');
    res.json({
      prod: persona.buildPersona('prod', appName),
      admin: persona.buildPersona('admin', appName),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/carolina-config/toggle  body: { pin, type, enabled }
// C4 — enable/disable a message type (greeting, eod, urgency, conflict,
// task, bottles, break). Honored centrally by the slack client gate.
router.post('/admin/carolina-config/toggle', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const type = String(req.body?.type ?? '');
    if (!appState.MSG_TYPE_KEYS[type]) {
      return res.status(400).json({ error: 'tipo inválido' });
    }
    const enabled = req.body?.enabled === true || req.body?.enabled === 'true';

    const before = await appState.isMsgEnabled(type);
    await appState.setMsgToggle(type, enabled);

    await auditAction({
      req, action: 'carolina_config.toggle', entityType: 'app_state',
      entityId: appState.MSG_TYPE_KEYS[type],
      before: { type, enabled: before }, after: { type, enabled },
    });
    res.json({ ok: true, type, enabled });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/carolina-config/time-format  body: { pin, format }
// BUG AMPM — flip how clock times are DISPLAYED everywhere (Carolina
// context, dashboard, admin pages). '12h' (AM/PM, default) | '24h'.
router.post('/admin/carolina-config/time-format', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const fmt = String(req.body?.format ?? '');
    if (fmt !== '12h' && fmt !== '24h') {
      return res.status(400).json({ error: "format inválido (use '12h' ou '24h')" });
    }
    const before = await appState.getTimeFormat();
    const after = await appState.setTimeFormat(fmt);
    await auditAction({
      req, action: 'carolina_config.time_format', entityType: 'app_state',
      entityId: 'time_format', before: { format: before }, after: { format: after },
    });
    res.json({ ok: true, time_format: after });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== C5 — message variations CRUD =====
// GET /api/admin/carolina-config/variations?pin&type=
//   no type → { types:[...] };  type → { type,label,placeholders,
//   example, variations:[...] }
router.get('/admin/carolina-config/variations', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const type = req.query.type ? String(req.query.type) : null;
    if (!type) return res.json({ types: msgVar.listTypes() });
    const reg = msgVar.VARIATION_SETS[type];
    if (!reg) return res.status(400).json({ error: 'tipo inválido' });
    res.json({
      type, label: reg.label, placeholders: reg.placeholders,
      example: reg.example, variations: await msgVar.list(type),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/carolina-config/variations  body: { pin, type, template }
router.post('/admin/carolina-config/variations', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const type = String(req.body?.type ?? '');
    if (!msgVar.VARIATION_SETS[type]) return res.status(400).json({ error: 'tipo inválido' });
    const template = String(req.body?.template ?? '').trim();
    if (!template) return res.status(400).json({ error: 'Texto não pode ser vazio' });
    if (template.length > 500) return res.status(400).json({ error: 'Texto muito longo (máx 500)' });

    const row = await msgVar.create(type, template);
    await auditAction({
      req, action: 'carolina_config.variation_create', entityType: 'message_variations',
      entityId: row.id, before: null, after: { type, template },
    });
    res.json({ ok: true, variation: row });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/admin/carolina-config/variations/:id  body: { pin, template?, active?, position? }
router.put('/admin/carolina-config/variations/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const id = parseInt(req.params.id);
    const before = await msgVar.getById(id);
    if (!before) return res.status(404).json({ error: 'variação não encontrada' });

    const fields = {};
    if (req.body?.template !== undefined) {
      const t = String(req.body.template).trim();
      if (!t) return res.status(400).json({ error: 'Texto não pode ser vazio' });
      if (t.length > 500) return res.status(400).json({ error: 'Texto muito longo (máx 500)' });
      fields.template = t;
    }
    if (req.body?.active !== undefined) fields.active = req.body.active === true || req.body.active === 'true';
    if (req.body?.position !== undefined) fields.position = req.body.position;

    const row = await msgVar.update(id, fields);
    await auditAction({
      req, action: 'carolina_config.variation_edit', entityType: 'message_variations',
      entityId: id,
      before: { template: before.template, active: before.active, position: before.position },
      after: { template: row.template, active: row.active, position: row.position },
    });
    res.json({ ok: true, variation: row });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/admin/carolina-config/variations/:id?pin
router.delete('/admin/carolina-config/variations/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const id = parseInt(req.params.id);
    const before = await msgVar.getById(id);
    if (!before) return res.status(404).json({ error: 'variação não encontrada' });
    await msgVar.remove(id);
    await auditAction({
      req, action: 'carolina_config.variation_delete', entityType: 'message_variations',
      entityId: id, before: { type: before.type, template: before.template }, after: null,
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/carolina-config/app-name  body: { pin, app_name }
// B1 item 1 — rename the app. Persisted in app_state, refreshes the
// in-process cache (App Home header + Carolina persona), audited.
router.post('/admin/carolina-config/app-name', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const raw = String(req.body?.app_name ?? '').trim();
    if (!raw) return res.status(400).json({ error: 'Nome não pode ser vazio' });
    if (raw.length > 80) return res.status(400).json({ error: 'Nome muito longo (máx 80)' });

    const before = await appState.get('app_name', appState.DEFAULT_APP_NAME);
    const after = await appState.setAppName(raw);

    await auditAction({
      req, action: 'carolina_config.app_name', entityType: 'app_state',
      entityId: 'app_name',
      before: { app_name: before }, after: { app_name: after },
    });
    res.json({ ok: true, app_name: after });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/silent-log?pin=XXX&hours=24&action=postMessage&limit=200
router.get('/admin/silent-log', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours) || 24, 1), 720);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 1000);
    const where = [`created_at >= NOW() - INTERVAL '${hours} hours'`];
    const params = [];
    if (req.query.action) {
      where.push(`intended_action = $${params.length + 1}`);
      params.push(req.query.action);
    }
    const result = await db.query(
      `SELECT id, intended_channel, intended_action, intended_text,
              would_have_replied_to_ts, created_at
       FROM silent_log
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit}`,
      params
    );
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM silent_log
       WHERE ${where.join(' AND ')}`,
      params
    );
    res.json({ rows: result.rows, total: countRes.rows[0]?.total || 0, hours, limit });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Admin: Audit log viewer =====
// GET /api/admin/audit?pin=XXX&entity_type=task&action=task.edit&entity_id=5&since=YYYY-MM-DD&limit=100&offset=0
router.get('/admin/audit', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const where = [];
    const params = [];
    if (req.query.entity_type) { where.push(`entity_type = $${params.length+1}`); params.push(req.query.entity_type); }
    if (req.query.entity_id)   { where.push(`entity_id   = $${params.length+1}`); params.push(String(req.query.entity_id)); }
    if (req.query.action)      { where.push(`action      = $${params.length+1}`); params.push(req.query.action); }
    if (req.query.since && /^\d{4}-\d{2}-\d{2}$/.test(req.query.since)) {
      where.push(`created_at >= $${params.length+1}::date`);
      params.push(req.query.since);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const limit  = Math.min(Math.max(parseInt(req.query.limit)  || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const result = await db.query(
      `SELECT id, admin_user, action, entity_type, entity_id,
              before_data, after_data, source, request_meta, created_at
       FROM admin_audit_log
       ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM admin_audit_log ${whereSql}`,
      params
    );
    res.json({
      rows: result.rows,
      total: countRes.rows[0]?.total || 0,
      limit, offset,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Admin: Task merge =====
// POST /api/admin/task/merge — body: { pin, taskIds: [int...] }
router.post('/admin/task/merge', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const result = await mergeTasks(req.body?.taskIds, req);
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

// ===== Admin: Task lifecycle (delete + reopen) =====

// POST /api/admin/task/:id/reopen — closed task → open, clears ended_at and duration
router.post('/admin/task/:id/reopen', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const before = await snapshotRow('tasks', 'id', req.params.id);
    if (!before) return res.status(404).json({ error: 'Task not found' });
    if (before.status === 'open')    return res.status(400).json({ error: 'Task já está aberta' });
    if (before.status === 'deleted') return res.status(400).json({ error: 'Task está deletada — restaure via PUT primeiro' });

    await db.query(
      `UPDATE tasks SET
         status = 'open',
         ended_at = NULL,
         duration_seconds = NULL,
         active_duration_seconds = NULL,
         closed_by = NULL,
         slack_end_ts = NULL,
         updated_at = NOW()
       WHERE id = $1`,
      [req.params.id]
    );
    const after = await snapshotRow('tasks', 'id', req.params.id);
    await auditAction({ req, action: 'task.reopen', entityType: 'task',
                        entityId: req.params.id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/admin/task/:id — soft delete (status='deleted')
router.delete('/admin/task/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const before = await snapshotRow('tasks', 'id', req.params.id);
    if (!before) return res.status(404).json({ error: 'Task not found' });
    if (before.status === 'deleted') return res.status(400).json({ error: 'Task já está deletada' });

    await db.query(
      `UPDATE tasks SET status = 'deleted', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    const after = await snapshotRow('tasks', 'id', req.params.id);
    await auditAction({ req, action: 'task.delete', entityType: 'task',
                        entityId: req.params.id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Admin: Notes editing =====

// GET /api/admin/notes?date=YYYY-MM-DD&pin=XXX — list notes for a day
router.get('/admin/notes', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const date = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
    const dateExpr = date ? `'${date}'::date` : `(NOW() AT TIME ZONE 'America/New_York')::date`;
    const result = await db.query(
      `SELECT slack_ts, user_name, text, linked_task_id, deleted_at, created_at
       FROM messages
       WHERE parsed_type = 'note'
         AND (created_at AT TIME ZONE 'America/New_York')::date = ${dateExpr}
         AND deleted_at IS NULL
       ORDER BY slack_ts ASC`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/admin/note/:ts — edit a note's text and/or link it to a task
router.put('/admin/note/:ts', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const ts = req.params.ts;
    const before = await snapshotRow('messages', 'slack_ts', ts);
    if (!before) return res.status(404).json({ error: 'Note not found' });

    const { text, linked_task_id } = req.body;
    const sets = [];
    const params = [];
    if (text !== undefined) { sets.push(`text = $${params.length+1}`); params.push(text); }
    if (linked_task_id !== undefined) {
      sets.push(`linked_task_id = $${params.length+1}`);
      params.push(linked_task_id === null ? null : parseInt(linked_task_id));
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });

    params.push(ts);
    await db.query(`UPDATE messages SET ${sets.join(', ')} WHERE slack_ts = $${params.length}`, params);
    const after = await snapshotRow('messages', 'slack_ts', ts);
    await auditAction({ req, action: 'note.edit', entityType: 'note',
                        entityId: ts, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/admin/note/:ts — soft delete
router.delete('/admin/note/:ts', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const ts = req.params.ts;
    const before = await snapshotRow('messages', 'slack_ts', ts);
    if (!before) return res.status(404).json({ error: 'Note not found' });
    if (before.deleted_at) return res.status(400).json({ error: 'Note já deletada' });

    await db.query('UPDATE messages SET deleted_at = NOW() WHERE slack_ts = $1', [ts]);
    const after = await snapshotRow('messages', 'slack_ts', ts);
    await auditAction({ req, action: 'note.delete', entityType: 'note',
                        entityId: ts, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Admin: Operators CRUD =====

// GET /api/admin/operators?pin=XXX — list all operators (active + inactive)
router.get('/admin/operators', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const result = await db.query(
      `SELECT id, name, slack_user_id, is_shared_account, active, aliases, role,
              created_at, updated_at
       FROM operators
       ORDER BY active DESC, name ASC`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/operator/create
router.post('/admin/operator/create', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const { name, slack_user_id, is_shared_account, aliases, role } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name é obrigatório' });

    const result = await db.query(
      `INSERT INTO operators (name, slack_user_id, is_shared_account, aliases, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [name.trim(), slack_user_id || null, !!is_shared_account, (aliases || '').trim(), role || null]
    );
    const newId = result.rows[0].id;
    const after = await snapshotRow('operators', 'id', newId);
    await auditAction({ req, action: 'operator.create', entityType: 'operator',
                        entityId: newId, before: null, after });
    res.json({ ok: true, id: newId });
  } catch (err) {
    if (/duplicate key/.test(err.message)) {
      return res.status(409).json({ error: 'Operador com esse nome já existe' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/operator/:id
router.put('/admin/operator/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const before = await snapshotRow('operators', 'id', req.params.id);
    if (!before) return res.status(404).json({ error: 'Operator not found' });

    const { name, slack_user_id, is_shared_account, active, aliases, role } = req.body;
    const sets = ['updated_at = NOW()'];
    const params = [];
    if (name              !== undefined) { sets.push(`name              = $${params.length+1}`); params.push(name.trim()); }
    if (slack_user_id     !== undefined) { sets.push(`slack_user_id     = NULLIF($${params.length+1},'')`); params.push(slack_user_id || ''); }
    if (is_shared_account !== undefined) { sets.push(`is_shared_account = $${params.length+1}`); params.push(!!is_shared_account); }
    if (active            !== undefined) { sets.push(`active            = $${params.length+1}`); params.push(!!active); }
    if (aliases           !== undefined) { sets.push(`aliases           = $${params.length+1}`); params.push(aliases || ''); }
    if (role              !== undefined) { sets.push(`role              = NULLIF($${params.length+1},'')`); params.push(role || ''); }
    if (sets.length === 1) return res.status(400).json({ error: 'Nada para atualizar' });

    params.push(req.params.id);
    await db.query(`UPDATE operators SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    const after = await snapshotRow('operators', 'id', req.params.id);
    await auditAction({ req, action: 'operator.edit', entityType: 'operator',
                        entityId: req.params.id, before, after });
    res.json({ ok: true });
  } catch (err) {
    if (/duplicate key/.test(err.message)) {
      return res.status(409).json({ error: 'Nome já usado por outro operador' });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/operator/:id — sets active=false (operators don't have deleted_at)
router.delete('/admin/operator/:id', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const before = await snapshotRow('operators', 'id', req.params.id);
    if (!before) return res.status(404).json({ error: 'Operator not found' });
    if (!before.active) return res.status(400).json({ error: 'Operator já está inativo' });

    await db.query('UPDATE operators SET active = FALSE, updated_at = NOW() WHERE id = $1', [req.params.id]);
    const after = await snapshotRow('operators', 'id', req.params.id);
    await auditAction({ req, action: 'operator.deactivate', entityType: 'operator',
                        entityId: req.params.id, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Admin Create Task =====
router.post('/admin/task/create', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const { supplement_name, batch_number, operator, started_at } = req.body;
    if (!supplement_name) return res.status(400).json({ error: 'Suplemento é obrigatório' });
    const result = await db.query(
      `INSERT INTO tasks (operator, supplement_name, batch_number, started_at, status)
       VALUES ($1, $2, $3, ($4::timestamp AT TIME ZONE 'America/New_York'), 'open')
       RETURNING id`,
      [operator || null, supplement_name, batch_number || null, started_at || new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' })]
    );
    const after = await snapshotRow('tasks', 'id', result.rows[0].id);
    await auditAction({ req, action: 'task.create', entityType: 'task',
                        entityId: result.rows[0].id, before: null, after });
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Admin Export (full data download) =====
// GET /api/admin/export?pin=XXX — returns JSON bundle of all production data
router.get('/admin/export', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const [tasksRes, ordersRes, formRes, countsRes, pausesRes] = await Promise.all([
      db.query(`SELECT * FROM tasks ORDER BY started_at ASC`),
      db.query(`SELECT * FROM orders_sessions ORDER BY started_at ASC`),
      db.query(`SELECT * FROM formulation_sessions ORDER BY started_at ASC`),
      db.query(`SELECT * FROM production_counts ORDER BY reported_at ASC`),
      db.query(`SELECT * FROM pauses ORDER BY started_at ASC`),
    ]);

    // Track backup timestamp
    await db.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ('last_backup_at', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [new Date().toISOString()]
    );

    await auditAction({ req, action: 'export', entityType: 'app_state',
                        entityId: 'last_backup_at',
                        after: { tasks: tasksRes.rows.length, orders: ordersRes.rows.length,
                                 formulations: formRes.rows.length, counts: countsRes.rows.length,
                                 pauses: pausesRes.rows.length } });

    const filename = `healthfare-backup-${new Date().toISOString().slice(0,10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json({
      exportedAt: new Date().toISOString(),
      tasks: tasksRes.rows,
      orders_sessions: ordersRes.rows,
      formulation_sessions: formRes.rows,
      production_counts: countsRes.rows,
      pauses: pausesRes.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/backup-status?pin=XXX — days since last backup + oldest record date
router.get('/admin/backup-status', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const [lastBackup, oldest] = await Promise.all([
      db.query(`SELECT value FROM app_state WHERE key = 'last_backup_at'`),
      db.query(`SELECT MIN(started_at) as oldest FROM tasks`),
    ]);
    const lastBackupAt = lastBackup.rows[0]?.value || null;
    const oldestRecord = oldest.rows[0]?.oldest || null;
    const daysSinceBackup = lastBackupAt
      ? Math.floor((Date.now() - new Date(lastBackupAt)) / 86400000)
      : null;
    const daysSinceOldest = oldestRecord
      ? Math.floor((Date.now() - new Date(oldestRecord)) / 86400000)
      : 0;
    res.json({ lastBackupAt, daysSinceBackup, daysSinceOldest, needsBackup: daysSinceOldest >= 15 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Admin Broadcast (send message to main channel) =====
router.post('/admin/broadcast', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Mensagem vazia' });
  try {
    const slackClient = require('../slack/client');
    const ts = await slackClient.postMessage(message.trim());
    await auditAction({ req, action: 'broadcast', entityType: 'broadcast',
                        entityId: ts || null, after: { message: message.trim(), ts } });
    res.json({ ok: true, ts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Supplement Catalog =====

// List all known supplements (hardcoded + custom)
router.get('/supplements', (req, res) => {
  res.json(parser.listSupplements());
});

// Add a new custom supplement (admin)
router.post('/admin/supplement', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  const { canonical_name, aliases } = req.body;
  if (!canonical_name || !canonical_name.trim()) return res.status(400).json({ error: 'Nome é obrigatório' });
  const canonical = canonical_name.trim();
  const aliasStr = (aliases || '').trim();
  try {
    const before = await snapshotRow('supplement_catalog', 'canonical_name', canonical);
    await db.query(
      `INSERT INTO supplement_catalog (canonical_name, aliases) VALUES ($1, $2)
       ON CONFLICT (canonical_name) DO UPDATE SET aliases = $2`,
      [canonical, aliasStr]
    );
    parser.addCustomSupplement(canonical, aliasStr);
    const after = await snapshotRow('supplement_catalog', 'canonical_name', canonical);
    await auditAction({ req, action: before ? 'supplement.edit' : 'supplement.create',
                        entityType: 'supplement', entityId: canonical, before, after });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete a custom supplement (admin)
router.delete('/admin/supplement/:name', async (req, res) => {
  if (!checkPin(req)) return res.status(403).json({ error: 'PIN incorreto' });
  try {
    const canonical = decodeURIComponent(req.params.name);
    const before = await snapshotRow('supplement_catalog', 'canonical_name', canonical);
    await db.query('DELETE FROM supplement_catalog WHERE canonical_name = $1', [canonical]);
    await auditAction({ req, action: 'supplement.delete', entityType: 'supplement',
                        entityId: canonical, before, after: null });
    res.json({ ok: true, note: 'Removed from DB. Restart to remove from parser memory.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Helpers =====

// Map Slack user IDs to human-readable names for display
const USER_NAME_MAP = {
  'U08JC85HMNE': 'Vitor',
  'U07FG34TMPF': 'Simone',
  'U03URLL1D4L': 'Bruno Camp',
  'U03S46L2EUA': 'Thassio',
  'U085SDY3F4Z': 'Henrique',
  'U0AU8N8FA00': 'Linha de Produção',
};

function resolveDisplayName(userId, userName) {
  if (userId && USER_NAME_MAP[userId]) return USER_NAME_MAP[userId];
  // user_name might itself be a raw user ID (U + alphanumeric)
  if (userName && /^U[A-Z0-9]{5,}$/.test(userName)) return USER_NAME_MAP[userName] || userName;
  return userName || userId || '?';
}

async function getTimeline(date) {
  const dateExpr = date ? `'${date}'::date` : 'CURRENT_DATE';
  const res = await db.query(`
    SELECT
      m.slack_ts as ts,
      m.parsed_type as type,
      m.text,
      m.user_name as operator,
      t.supplement_name,
      t.operator as task_operator
    FROM messages m
    LEFT JOIN tasks t ON t.slack_start_ts = m.slack_ts OR t.slack_end_ts = m.slack_ts
    WHERE m.created_at::date = ${dateExpr}
      AND m.parsed_type NOT IN ('ignore', 'unknown')
    ORDER BY m.slack_ts ASC
    LIMIT 100
  `);

  return res.rows.map(r => ({
    ts: new Date(parseFloat(r.ts) * 1000).toISOString(),
    type: r.type,
    text: buildTimelineText(r),
    operator: r.task_operator || r.operator,
  }));
}

function buildTimelineText(r) {
  const supp = r.supplement_name || '';
  switch (r.type) {
    case 'start': return `Iniciado: ${supp}`;
    case 'finish': return `Finalizado: ${supp}`;
    case 'count': return `Contagem: ${supp}`;
    case 'note': return r.text?.substring(0, 100) || 'Nota';
    default: return r.text?.substring(0, 80) || 'Evento';
  }
}

async function getOperatorStats(date) {
  const dateExpr = date ? `'${date}'::date` : 'CURRENT_DATE';
  const ops = await db.query('SELECT name FROM operators WHERE active = true ORDER BY name');

  return Promise.all(ops.rows.map(async (op) => {
    const [taskRes, bottleRes, timeRes] = await Promise.all([
      db.query(
        `SELECT COUNT(*) as cnt FROM tasks WHERE operator = $1 AND started_at::date = ${dateExpr} AND status = 'closed'`,
        [op.name]
      ),
      db.query(
        `SELECT COALESCE(SUM(pc.count), 0) as total FROM production_counts pc
         JOIN tasks t ON t.id = pc.task_id
         WHERE t.operator = $1 AND pc.reported_at::date = ${dateExpr}`,
        [op.name]
      ),
      db.query(
        `SELECT COALESCE(SUM(active_duration_seconds), 0) as secs FROM tasks
         WHERE operator = $1 AND started_at::date = ${dateExpr} AND status = 'closed'`,
        [op.name]
      ),
    ]);

    return {
      name: op.name,
      tasks_today: parseInt(taskRes.rows[0]?.cnt || 0),
      bottles_today: parseInt(bottleRes.rows[0]?.total || 0),
      active_seconds_today: parseInt(timeRes.rows[0]?.secs || 0),
    };
  }));
}

async function getArchive() {
  const res = await db.query(
    `SELECT snapshot_date, screenshot_path, total_bottles, task_count
     FROM eod_snapshots
     ORDER BY snapshot_date DESC
     LIMIT 30`
  );
  return res.rows;
}

// B5 — all of today's breaks (open AND closed) from operator_activity_log,
// the source of truth. The legacy activeBreaks only lists open ones, so
// a returned break (e.g. Simone's) vanished from the dashboard entirely.
// BUG DASHBOARD — when an operator closes a phase/ad-hoc/workflow the
// card vanished. This lists everything CLOSED TODAY (ET) so the day's
// output stays visible. Filters on ended_at::date in ET, so it resets
// at ET midnight automatically.
async function getCompletedToday(date) {
  const dExpr = date
    ? `'${date}'::date`
    : `(NOW() AT TIME ZONE 'America/New_York')::date`;
  const parts = (table, fk) => `(SELECT string_agg(DISTINCT op.name, ' + ' ORDER BY op.name)
       FROM operator_activity_log oal JOIN operators op ON op.id = oal.operator_id
       WHERE oal.${fk} = ${table}.id)`;
  try {
    const ph = await db.query(`
      SELECT 'phase' AS kind, pi.id, pi.phase_name AS name,
             wi.product_name, wi.batch_number,
             pi.started_at, pi.ended_at, pi.final_bottle_count AS bottles,
             GREATEST(0, EXTRACT(EPOCH FROM (pi.ended_at - pi.started_at))::int) AS duration_seconds,
             ${parts('pi', 'phase_instance_id')} AS participants
      FROM phase_instances pi
      JOIN workflow_instances wi ON wi.id = pi.workflow_instance_id
      WHERE pi.ended_at IS NOT NULL AND pi.status <> 'open'
        AND (pi.ended_at AT TIME ZONE 'America/New_York')::date = ${dExpr}
      ORDER BY pi.ended_at DESC LIMIT 100`);
    const ah = await db.query(`
      SELECT 'adhoc' AS kind, ati.id, ati.task_name AS name,
             NULL AS product_name, NULL AS batch_number,
             ati.started_at, ati.ended_at, NULL::int AS bottles,
             GREATEST(0, EXTRACT(EPOCH FROM (ati.ended_at - ati.started_at))::int) AS duration_seconds,
             ${parts('ati', 'ad_hoc_task_instance_id')} AS participants
      FROM ad_hoc_task_instances ati
      WHERE ati.ended_at IS NOT NULL AND ati.status <> 'open'
        AND (ati.ended_at AT TIME ZONE 'America/New_York')::date = ${dExpr}
      ORDER BY ati.ended_at DESC LIMIT 100`);
    const wf = await db.query(`
      SELECT 'workflow' AS kind, wi.id,
             COALESCE(wi.product_name, wt.name) AS name,
             wi.product_name, wi.batch_number,
             wi.started_at, wi.ended_at, NULL::int AS bottles,
             GREATEST(0, EXTRACT(EPOCH FROM (wi.ended_at - wi.started_at))::int) AS duration_seconds,
             (SELECT string_agg(DISTINCT op.name, ' + ' ORDER BY op.name)
                FROM operator_activity_log oal
                JOIN phase_instances p2 ON p2.id = oal.phase_instance_id
                JOIN operators op ON op.id = oal.operator_id
                WHERE p2.workflow_instance_id = wi.id) AS participants
      FROM workflow_instances wi
      JOIN workflow_templates wt ON wt.id = wi.workflow_template_id
      WHERE wi.ended_at IS NOT NULL AND wi.status <> 'active'
        AND COALESCE(wi.notes,'') NOT LIKE '%[auto_cleanup_ghost]%'
        AND (wi.ended_at AT TIME ZONE 'America/New_York')::date = ${dExpr}
      ORDER BY wi.ended_at DESC LIMIT 100`);
    return [...ph.rows, ...ah.rows, ...wf.rows]
      .sort((a, b) => new Date(b.ended_at) - new Date(a.ended_at));
  } catch (e) {
    console.error('[Dashboard] completedToday error:', e.message);
    return [];
  }
}

async function getTodayBreaks(date) {
  try {
    const dExpr = date
      ? `'${date}'::date`
      : `(NOW() AT TIME ZONE 'America/New_York')::date`;
    const r = await db.query(`
      SELECT oal.id, o.name AS operator, oal.started_at, oal.ended_at,
             oal.duration_seconds,
             p.reason, p.ended_reason
      FROM operator_activity_log oal
      JOIN operators o ON o.id = oal.operator_id
      LEFT JOIN pauses p ON p.id = oal.pause_id
      WHERE oal.activity_type = 'break'
        AND (oal.started_at AT TIME ZONE 'America/New_York')::date = ${dExpr}
      ORDER BY oal.started_at DESC`);
    return r.rows.map((x) => ({
      id: x.id,
      operator: x.operator,
      started_at: x.started_at,
      ended_at: x.ended_at,
      open: x.ended_at == null,
      duration_seconds: x.duration_seconds,
      untracked: x.ended_reason === 'untracked_return'
        || /não-rastreado|nao-rastreado/i.test(x.reason || ''),
    }));
  } catch (_) { return []; }
}

async function getTodayNotes(date) {
  const dateExpr = date ? `'${date}'::date` : 'CURRENT_DATE';
  const res = await db.query(`
    SELECT slack_ts as ts, user_id, user_name, text
    FROM messages
    WHERE created_at::date = ${dateExpr}
      AND parsed_type = 'note'
      AND deleted_at IS NULL
    ORDER BY slack_ts ASC
  `);
  const channelNotes = res.rows.map(r => {
    let noteText = (r.text || '').trim();
    noteText = noteText.replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/g, '').replace(/<[^>]+>/g, '').trim();
    noteText = noteText.replace(/^(Ana|Bruno|Vitor|Simone)\s*[-:]\s*\n?/i, '').trim();
    noteText = noteText.replace(/^(?:N:|NOTA\s*:|OBS\s*:)\s*/i, '').trim();
    return {
      ts: new Date(parseFloat(r.ts) * 1000).toISOString(),
      operator: resolveDisplayName(r.user_id, r.user_name),
      text: noteText,
      source: 'channel',
    };
  });

  // F2 — App Home / admin notes from operator_notes
  let homeNotes = [];
  try {
    const r2 = await db.query(`
      SELECT n.created_at AS ts, o.name AS operator, n.text,
             n.source, n.linked_phase_instance_id
      FROM operator_notes n
      LEFT JOIN operators o ON o.id = n.operator_id
      WHERE (n.created_at AT TIME ZONE 'America/New_York')::date =
            ${date ? `'${date}'::date` : `(NOW() AT TIME ZONE 'America/New_York')::date`}
        AND n.deleted_at IS NULL
      ORDER BY n.created_at ASC`);
    homeNotes = r2.rows.map((r) => ({
      ts: new Date(r.ts).toISOString(),
      operator: r.operator || '?',
      text: (r.text || '').trim(),
      source: r.source || 'app_home',
      linked_phase_instance_id: r.linked_phase_instance_id || null,
    }));
  } catch (_) { homeNotes = []; }

  return [...channelNotes, ...homeNotes].sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

async function getTodayMessages(date) {
  const dateExpr = date ? `'${date}'::date` : 'CURRENT_DATE';
  const res = await db.query(`
    SELECT slack_ts as ts, user_id, user_name, text, parsed_type
    FROM messages
    WHERE created_at::date = ${dateExpr}
    ORDER BY slack_ts ASC
    LIMIT 300
  `);
  return res.rows.map(r => ({
    ts: new Date(parseFloat(r.ts) * 1000).toISOString(),
    operator: resolveDisplayName(r.user_id, r.user_name),
    text: r.text,
    type: r.parsed_type || 'unknown',
  }));
}

function buildComparison(currentTask, history) {
  const avgDur = parseInt(currentTask.avg_duration_seconds) || null;
  const totalRuns = parseInt(currentTask.total_run_count) || 0;
  const curDur = currentTask.active_duration_seconds;

  if (totalRuns === 0 || !history || history.length === 0) {
    return { isFirst: true, avgDuration: null, totalRuns: 0 };
  }

  const lastRun = history[0];
  const pctVsLast = (curDur && lastRun.active_duration_seconds)
    ? Math.round(((curDur - lastRun.active_duration_seconds) / lastRun.active_duration_seconds) * 1000) / 10
    : null;

  const pctVsAvg = (curDur && avgDur)
    ? Math.round(((curDur - avgDur) / avgDur) * 1000) / 10
    : null;

  return {
    isFirst: false,
    pctVsLast,
    pctVsAvg,
    lastDuration: lastRun.active_duration_seconds,
    avgDuration: avgDur,
    totalRuns,
  };
}

router.loadCustomSupplements = loadCustomSupplements;
module.exports = router;
