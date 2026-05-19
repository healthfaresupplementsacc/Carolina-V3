'use strict';
/**
 * FASE 1 P8 — legacy-vs-ISA-88 divergence telemetry.
 *
 * During Fase 1 the legacy tables (tasks/pauses/production_counts) keep
 * being written IN PARALLEL with the canonical ISA-88 model (doc 8.1,
 * safety). This job runs daily at 04:00 ET, compares today's counts in
 * both models, and alerts the admin chat when any metric diverges by
 * more than 5% — that's the early-warning that the canonical path is
 * dropping or duplicating something before Fase 2 makes ISA-88 the
 * single source of reads.
 *
 * Every run is audited (divergence.telemetry) so the Fase 1 final report
 * can quote "N runs, M divergences detected".
 */

const THRESHOLD = 0.05; // 5%

function pctDiff(legacy, isa) {
  const a = Number(legacy) || 0;
  const b = Number(isa) || 0;
  const denom = Math.max(a, b, 1);
  return Math.abs(a - b) / denom;
}

/**
 * Pure: turn the collected {legacy,isa} pairs into a divergence report.
 * Exported so the threshold logic is unit-tested without a DB.
 */
function computeDivergence(metrics) {
  const rows = Object.entries(metrics).map(([metric, v]) => {
    const diff = pctDiff(v.legacy, v.isa);
    return {
      metric,
      legacy: Number(v.legacy) || 0,
      isa: Number(v.isa) || 0,
      diff_pct: Math.round(diff * 1000) / 10,
      over: diff > THRESHOLD,
    };
  });
  return {
    rows,
    has_divergence: rows.some((r) => r.over),
    threshold_pct: THRESHOLD * 100,
  };
}

/** Collect today's counts from both models. */
async function collect(date, deps = {}) {
  const db = deps.db || require('../db');
  const d = date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const q = async (sql) => {
    try { return Number((await db.query(sql, [d])).rows[0]?.n || 0); }
    catch { return 0; }
  };

  // tasks (legacy) vs phase_instances (ISA-88) opened today
  const legacyTasks = await q(
    `SELECT COUNT(*)::int n FROM tasks
      WHERE (started_at AT TIME ZONE 'America/New_York')::date = $1::date
        AND status <> 'deleted'`);
  const isaPhases = await q(
    `SELECT COUNT(*)::int n FROM phase_instances
      WHERE (started_at AT TIME ZONE 'America/New_York')::date = $1::date
        AND status <> 'deleted'`);

  // pauses (legacy) vs break oal (ISA-88) started today
  const legacyPauses = await q(
    `SELECT COUNT(*)::int n FROM pauses
      WHERE (started_at AT TIME ZONE 'America/New_York')::date = $1::date
        AND deleted_at IS NULL`);
  const isaBreaks = await q(
    `SELECT COUNT(*)::int n FROM operator_activity_log
      WHERE activity_type = 'break'
        AND (started_at AT TIME ZONE 'America/New_York')::date = $1::date`);

  // production_counts rows (legacy) vs Reporte ad-hoc instances (ISA-88)
  const legacyCounts = await q(
    `SELECT COUNT(*)::int n FROM production_counts
      WHERE (reported_at AT TIME ZONE 'America/New_York')::date = $1::date
        AND deleted_at IS NULL`);
  const isaReportes = await q(
    `SELECT COUNT(*)::int n FROM ad_hoc_task_instances
      WHERE LOWER(task_name) LIKE 'reporte%'
        AND (started_at AT TIME ZONE 'America/New_York')::date = $1::date
        AND status <> 'deleted'`);

  return {
    date: d,
    metrics: {
      tasks_vs_phases: { legacy: legacyTasks, isa: isaPhases },
      pauses_vs_breaks: { legacy: legacyPauses, isa: isaBreaks },
      counts_vs_reportes: { legacy: legacyCounts, isa: isaReportes },
    },
  };
}

function formatAlert(date, report) {
  const lines = [
    `📊 Telemetria legacy×ISA-88 — ${date} (limite ${report.threshold_pct}%)`,
  ];
  for (const r of report.rows) {
    const flag = r.over ? ' ⚠️ DIVERGENTE' : '';
    lines.push(`• ${r.metric}: legacy=${r.legacy} · isa=${r.isa} · Δ${r.diff_pct}%${flag}`);
  }
  if (report.has_divergence) {
    lines.push('');
    lines.push('Há divergência > limite — vale investigar antes da Fase 2 (leituras só ISA-88).');
  }
  return lines.join('\n');
}

/**
 * Daily job. Always audits the result; posts to the admin chat ONLY when
 * something diverged over the threshold (no daily noise when healthy).
 */
async function runDivergenceTelemetry(deps = {}) {
  const { date, metrics } = await collect(deps.date, deps);
  const report = computeDivergence(metrics);

  const auditAction = deps.auditAction || require('../admin/audit').auditAction;
  try {
    await auditAction({
      action: 'divergence.telemetry', entityType: 'telemetry', entityId: date,
      before: null, after: { ...report, metrics },
      source: 'cron',
    });
  } catch (_) { /* best-effort */ }

  if (report.has_divergence) {
    try {
      const adminChat = deps.adminChat || require('../slack/admin-chat');
      await adminChat.sendToAdminChat(formatAlert(date, report), 'telemetry', deps);
    } catch (e) {
      console.error('[Divergence] alert post failed:', e.message);
    }
  }
  console.log(
    `[Divergence] ${date}: ` +
    report.rows.map((r) => `${r.metric} Δ${r.diff_pct}%`).join(', ') +
    (report.has_divergence ? ' — ALERT sent' : ' — ok')
  );
  return { date, ...report };
}

module.exports = {
  THRESHOLD, pctDiff, computeDivergence, collect,
  formatAlert, runDivergenceTelemetry,
};
