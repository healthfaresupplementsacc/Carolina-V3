'use strict';
/**
 * HEALTHFARE V3 — Architect API: queries SQL reusáveis (read-only).
 *
 * Princípios: SEMPRE parametrized ($1...), LIMIT obrigatório (max 500),
 * zero concatenação de input em SQL. Datas exibidas em America/New_York
 * (12h AM/PM no display é responsabilidade do cliente; aqui vai ISO UTC +
 * *_edt pré-formatado).
 */

const EDT = 'America/New_York';
const MAX_LIMIT = 500;

/** Valida 'YYYY-MM-DD'. null/undefined → null (caller usa hoje EDT). */
function validDateOrNull(s) {
  if (s == null || s === '') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? String(s) : undefined; // undefined = inválida
}

function clampLimit(n, dflt) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v) || v <= 0) return dflt;
  return Math.min(v, MAX_LIMIT);
}

// expressão SQL: data EDT de uma coluna timestamptz
const edtDate = (col) => `(${col} AT TIME ZONE '${EDT}')::date`;
const edtTs = (col) => `to_char(${col} AT TIME ZONE '${EDT}', 'YYYY-MM-DD HH12:MI:SS AM')`;

// dia alvo: $N (date) ou hoje EDT
const dayExpr = (col, param) => `${edtDate(col)} = COALESCE($${param}::date, (NOW() AT TIME ZONE '${EDT}')::date)`;

const EVENT_SELECT = `
  SELECT e.id, e.person_id, p.display_name, at.slug, at.flow,
         pb.batch_number, pr.canonical_name AS product,
         e.started_at, e.ended_at,
         ${edtTs('e.started_at')} AS started_at_edt,
         CASE WHEN e.ended_at IS NULL THEN NULL ELSE ${edtTs('e.ended_at')} END AS ended_at_edt,
         e.cowork_with, e.confidence, e.is_long_running, e.closed_reason,
         e.quantity, e.quantity_unit, e.source_message_ts, e.description
  FROM v3.events e
  JOIN v3.persons p ON p.id = e.person_id
  LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
  LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
  LEFT JOIN v3.products pr ON pr.id = pb.product_id`;

// ── [A1] snapshot do dia ──────────────────────────────────────
async function snapshotDay(db, date) {
  const [events, counts, messages] = await Promise.all([
    db.query(`${EVENT_SELECT}
      WHERE ${dayExpr('e.started_at', 1)} AND e.deleted_at IS NULL
      ORDER BY e.started_at LIMIT ${MAX_LIMIT}`, [date]),
    db.query(`
      SELECT pc.id, pc.bottles, pc.unit, pb.batch_number, pr.canonical_name AS product,
             pc.source_event_id, pc.source_message_ts, pc.confidence,
             ${edtTs('pc.created_at')} AS created_at_edt
      FROM v3.production_counts pc
      LEFT JOIN v3.product_batches pb ON pb.id = pc.product_batch_id
      LEFT JOIN v3.products pr ON pr.id = pb.product_id
      WHERE ${dayExpr('pc.created_at', 1)} AND pc.deleted_at IS NULL
      ORDER BY pc.created_at LIMIT ${MAX_LIMIT}`, [date]),
    db.query(`
      SELECT m.id, m.slack_ts, m.slack_channel_id, m.slack_user_id,
             LEFT(m.raw_text, 160) AS text_preview,
             (m.llm_processed_at IS NOT NULL) AS processed,
             m.processing_error, m.events_created, m.events_updated,
             ${edtTs('m.created_at')} AS created_at_edt
      FROM v3.messages m
      WHERE ${dayExpr('m.created_at', 1)}
      ORDER BY m.created_at LIMIT ${MAX_LIMIT}`, [date]),
  ]);
  return {
    date: date || 'today_edt',
    totals: { events: events.rowCount, counts: counts.rowCount, messages: messages.rowCount },
    events: events.rows, counts: counts.rows, messages: messages.rows,
  };
}

// ── [A2] audit_log do dia ─────────────────────────────────────
async function auditByDate(db, date, limit) {
  const r = await db.query(`
    SELECT id, actor_type, actor_person_id, action, target_type, target_id,
           metadata, ${edtTs('created_at')} AS created_at_edt, created_at
    FROM v3.audit_log
    WHERE ${dayExpr('created_at', 1)}
    ORDER BY id DESC LIMIT $2`, [date, clampLimit(limit, 100)]);
  return { date: date || 'today_edt', total: r.rowCount, entries: r.rows };
}

// ── [A3] drill-down de um event ──────────────────────────────
async function eventDetail(db, id) {
  const ev = await db.query(`${EVENT_SELECT} WHERE e.id = $1 LIMIT 1`, [id]);
  if (ev.rows.length === 0) return null;
  const event = ev.rows[0];
  const [msg, audit] = await Promise.all([
    event.source_message_ts
      ? db.query(`
          SELECT id, slack_ts, slack_user_id, raw_text, llm_result, processing_error,
                 ${edtTs('created_at')} AS created_at_edt
          FROM v3.messages WHERE slack_ts = split_part($1, '#', 1) LIMIT 1`,
        [event.source_message_ts])
      : Promise.resolve({ rows: [] }),
    db.query(`
      SELECT id, actor_type, action, before_data, after_data, metadata,
             ${edtTs('created_at')} AS created_at_edt
      FROM v3.audit_log
      WHERE target_type = 'event' AND target_id = $1
      ORDER BY id DESC LIMIT 100`, [id]),
  ]);
  return { event, source_message: msg.rows[0] || null, audit_trail: audit.rows };
}

// ── [A4] health ──────────────────────────────────────────────
async function health(db) {
  const [dbCheck, lastMsg, lastEvent, queue, latency] = await Promise.all([
    db.query('SELECT 1 AS ok'),
    db.query('SELECT MAX(created_at) AS ts, MAX(llm_processed_at) AS processed_ts FROM v3.messages'),
    db.query('SELECT MAX(created_at) AS ts FROM v3.events'),
    db.query('SELECT COUNT(*)::int AS pending FROM v3.messages WHERE llm_processed_at IS NULL'),
    db.query(`SELECT ROUND(AVG(processing_ms))::int AS avg_ms, COUNT(*)::int AS n
              FROM v3.llm_metrics WHERE created_at > NOW() - INTERVAL '1 hour'`),
  ]);
  return {
    db: dbCheck.rows.length === 1 ? 'connected' : 'error',
    uptime_s: Math.round(process.uptime()),
    last_message_at: lastMsg.rows[0].ts,
    last_processed_at: lastMsg.rows[0].processed_ts,
    last_event_at: lastEvent.rows[0].ts,
    queue_pending: queue.rows[0].pending,
    observer_avg_latency_ms_1h: latency.rows[0].avg_ms,
    observer_calls_1h: latency.rows[0].n,
  };
}

// ── [A5] diagnostics/orphans ─────────────────────────────────
async function orphans(db) {
  const [evNoMsg, msgNoEvent] = await Promise.all([
    db.query(`
      SELECT e.id, e.person_id, e.source_message_ts, ${edtTs('e.created_at')} AS created_at_edt
      FROM v3.events e
      LEFT JOIN v3.messages m ON m.slack_ts = split_part(e.source_message_ts, '#', 1)
      WHERE e.created_at > NOW() - INTERVAL '24 hours'
        AND e.deleted_at IS NULL
        AND (e.source_message_ts IS NULL OR m.id IS NULL)
      ORDER BY e.id DESC LIMIT ${MAX_LIMIT}`),
    db.query(`
      SELECT m.id, m.slack_ts, LEFT(m.raw_text, 120) AS text_preview,
             ${edtTs('m.created_at')} AS created_at_edt
      FROM v3.messages m
      WHERE m.created_at > NOW() - INTERVAL '24 hours'
        AND m.llm_processed_at IS NOT NULL
        AND m.processing_error IS NULL
        AND m.raw_text ~* '^\\s*\\w{0,14}\\s*-?\\s*[SF]\\s*[:;-]'
        AND COALESCE(array_length(m.events_created, 1), 0) = 0
        AND COALESCE(array_length(m.events_updated, 1), 0) = 0
      ORDER BY m.id DESC LIMIT ${MAX_LIMIT}`),
  ]);
  return {
    events_without_source_message: evNoMsg.rows,
    sf_messages_without_event: msgNoEvent.rows,
    totals: { events_without_source_message: evNoMsg.rowCount, sf_messages_without_event: msgNoEvent.rowCount },
  };
}

// ── [A6] diagnostics/queue ───────────────────────────────────
async function queueDiag(db) {
  const [pending, errored, cmds, last] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS n, MIN(created_at) AS oldest FROM v3.messages WHERE llm_processed_at IS NULL`),
    db.query(`SELECT COUNT(*)::int AS n FROM v3.messages
              WHERE processing_error IS NOT NULL AND processing_error <> 'deleted'
                AND created_at > NOW() - INTERVAL '24 hours'`),
    db.query(`SELECT COUNT(*)::int AS n FROM v3.pending_commands WHERE status = 'pending'`),
    db.query('SELECT MAX(llm_processed_at) AS ts FROM v3.messages'),
  ]);
  const oldest = pending.rows[0].oldest;
  return {
    pending_messages: pending.rows[0].n,
    oldest_pending_age_s: oldest ? Math.round((Date.now() - new Date(oldest).getTime()) / 1000) : null,
    errored_messages_24h: errored.rows[0].n,
    pending_commands: cmds.rows[0].n,
    last_processed_ts: last.rows[0].ts,
  };
}

// ── [A7] diagnostics/llm_metrics ─────────────────────────────
async function llmMetrics24h(db) {
  const [agg, byCaller, errors] = await Promise.all([
    db.query(`
      SELECT COUNT(*)::int AS calls,
             COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
             COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
             COALESCE(SUM(cache_creation_input_tokens), 0)::bigint AS cache_creation_tokens,
             COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS cache_read_tokens,
             ROUND(COALESCE(SUM(cost_estimate_usd), 0)::numeric, 4) AS cost_usd,
             ROUND(100.0 * COUNT(*) FILTER (WHERE cache_read_input_tokens > 0) / NULLIF(COUNT(*), 0), 1) AS cache_hit_pct,
             ROUND(AVG(processing_ms))::int AS avg_processing_ms
      FROM v3.llm_metrics WHERE created_at > NOW() - INTERVAL '24 hours'`),
    db.query(`
      SELECT COALESCE(caller, 'unknown') AS caller, COUNT(*)::int AS calls,
             ROUND(COALESCE(SUM(cost_estimate_usd), 0)::numeric, 4) AS cost_usd
      FROM v3.llm_metrics WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY caller ORDER BY calls DESC LIMIT 20`),
    db.query(`
      SELECT COUNT(*)::int AS n FROM v3.messages
      WHERE processing_error IS NOT NULL AND processing_error <> 'deleted'
        AND created_at > NOW() - INTERVAL '24 hours'`),
  ]);
  return { window: '24h', ...agg.rows[0], by_caller: byCaller.rows, message_errors_24h: errors.rows[0].n };
}

// ── [OP1/A8] persons ─────────────────────────────────────────
// NUNCA retorna pin_hash/pin_salt (select explícito de colunas).
async function personsList(db, { scope }) {
  if (scope === 'operator_page') {
    const r = await db.query(`
      SELECT id, display_name, role
      FROM v3.persons
      WHERE role = 'operator' AND active = true AND deleted_at IS NULL
      ORDER BY display_name LIMIT ${MAX_LIMIT}`);
    return r.rows;
  }
  const r = await db.query(`
    SELECT id, display_name, role, slack_user_id, slack_dm_id, active, hired_at, deleted_at
    FROM v3.persons ORDER BY id LIMIT ${MAX_LIMIT}`);
  return r.rows;
}

// ── [OP2/A9] timeline da pessoa hoje ─────────────────────────
// Inclui: events do dia EDT + qualquer event ainda aberto (mesmo de ontem).
async function personToday(db, personId) {
  const r = await db.query(`${EVENT_SELECT}
    WHERE e.person_id = $1 AND e.deleted_at IS NULL
      AND (${edtDate('e.started_at')} = (NOW() AT TIME ZONE '${EDT}')::date OR e.ended_at IS NULL)
    ORDER BY e.started_at LIMIT ${MAX_LIMIT}`, [personId]);
  return r.rows;
}

// ── [OP3/A10] open events ────────────────────────────────────
async function openEvents(db, { scope }) {
  const r = await db.query(`${EVENT_SELECT}
    WHERE e.ended_at IS NULL AND e.deleted_at IS NULL
    ORDER BY e.started_at LIMIT ${MAX_LIMIT}`);
  const strip = (row) => ({
    id: row.id,
    display_name: row.display_name,
    slug: row.slug,
    batch_number: row.batch_number,
    started_at_edt: row.started_at_edt,
    cowork_with: row.cowork_with,
  });
  const fg = r.rows.filter((x) => !x.is_long_running);
  const bg = r.rows.filter((x) => x.is_long_running);
  if (scope === 'operator_page') {
    return { open_events: fg.map(strip), background_events: bg.map(strip) };
  }
  return { open_events: fg, background_events: bg };
}

// ── [OP4/A11] supplements autocomplete ───────────────────────
async function supplementsSearch(db, q) {
  if (q != null && String(q).trim() !== '') {
    const r = await db.query(`
      SELECT p.id, p.canonical_name, p.aliases, MAX(e.created_at) AS last_used_at
      FROM v3.products p
      LEFT JOIN v3.product_batches pb ON pb.product_id = p.id
      LEFT JOIN v3.events e ON e.product_batch_id = pb.id
        AND e.created_at > NOW() - INTERVAL '30 days' AND e.deleted_at IS NULL
      WHERE p.active = true
        AND (p.canonical_name ILIKE '%' || $1 || '%'
             OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE a ILIKE '%' || $1 || '%'))
      GROUP BY p.id
      ORDER BY MAX(e.created_at) DESC NULLS LAST, p.canonical_name
      LIMIT 20`, [String(q).trim()]);
    return r.rows;
  }
  // sem q → top 20 por uso nos últimos 30 dias
  const r = await db.query(`
    SELECT p.id, p.canonical_name, p.aliases, MAX(e.created_at) AS last_used_at,
           COUNT(e.id)::int AS uses_30d
    FROM v3.products p
    LEFT JOIN v3.product_batches pb ON pb.product_id = p.id
    LEFT JOIN v3.events e ON e.product_batch_id = pb.id
      AND e.created_at > NOW() - INTERVAL '30 days' AND e.deleted_at IS NULL
    WHERE p.active = true
    GROUP BY p.id
    ORDER BY COUNT(e.id) DESC, p.canonical_name
    LIMIT 20`);
  return r.rows;
}

module.exports = {
  validDateOrNull, clampLimit,
  snapshotDay, auditByDate, eventDetail, health, orphans, queueDiag, llmMetrics24h,
  personsList, personToday, openEvents, supplementsSearch,
  MAX_LIMIT,
};
