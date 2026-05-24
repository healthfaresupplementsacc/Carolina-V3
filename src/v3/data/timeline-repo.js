'use strict';
/**
 * HEALTHFARE V3 — Bloco 0 — TimelineRepo (leitura).
 *
 * Eventos por pessoa de um dia (NY). Esta é a query que hoje está
 * DUPLICADA 3× nos handlers HTML (overview/events-shadow/timeline)
 * — vira fonte única, consumida pelo /api/v3/data/timeline e pelos
 * 3 handlers. Read-only.
 */

const { resolveDate, toNyIso } = require('./ny-date');

/** Shape estável de um event. Timestamps em ISO com offset de NY. */
function shapeEvent(e) {
  return {
    event_id: e.id,
    activity: e.activity_type_id
      ? {
        id: e.activity_type_id,
        slug: e.activity_slug || null,
        display_name: e.activity_name || null,
        category: e.activity_category || null,
        phase_order: e.activity_phase_order != null ? e.activity_phase_order : null,
        is_background: e.activity_is_background === true,
        expected_seconds: e.activity_expected_seconds != null ? e.activity_expected_seconds : null,
      }
      : null,
    // fluxo efetivo: override do event vence o derivado do activity_type.
    flow: e.flow_override || e.activity_flow || null,
    started_at: toNyIso(e.started_at),
    ended_at: toNyIso(e.ended_at),
    confidence: e.confidence || null,
    cowork_with: e.cowork_with || [],
    product_batch_id: e.product_batch_id || null,
    phase_label: e.phase_label || null,
    description: e.description || null,
    source_message_ts: e.source_message_ts || null,
    quantity: e.quantity != null ? e.quantity : null,
    quantity_unit: e.quantity_unit || null,
  };
}

const EVENT_COLUMNS = `e.id, e.person_id, e.activity_type_id, e.product_batch_id,
            e.started_at, e.ended_at, e.confidence, e.cowork_with,
            e.phase_label, e.description, e.source_message_ts, e.flow_override,
            e.quantity, e.quantity_unit,
            p.display_name AS person_name, p.role AS person_role,
            at.slug AS activity_slug, at.display_name AS activity_name,
            at.category AS activity_category, at.flow AS activity_flow,
            at.phase_order AS activity_phase_order,
            at.is_background AS activity_is_background,
            at.expected_seconds AS activity_expected_seconds`;

/** Threshold default (s) pra distinguir IDLE (curto) de NÃO REPORTADO (longo).
 *  Configurável depois via v3.settings.idle_long_gap_threshold_seconds. */
const IDLE_LONG_GAP_THRESHOLD_SEC_DEFAULT = 3600; // 60min

/**
 * Calcula gaps de uma pessoa num dia, DISTINGUINDO:
 *  - idle_seconds        — soma dos gaps CURTOS (≤ threshold). "tempo parado real".
 *  - unreported_seconds  — soma dos gaps LONGOS (> threshold). "parou de postar".
 *  - unreported_since    — ISO do último ended_at SE houver gap trailing > threshold.
 *
 * Aberto = qualquer event (fg/bg/meta) cobrindo o instante. Background rodando
 * ≠ idle (double-task). Trailing gap = do último ended_at até dayEndMs (passou
 * de expedient_end_hour ou now do dia atual).
 */
function computeGaps(events, nowMs, dayEndMs, threshold = IDLE_LONG_GAP_THRESHOLD_SEC_DEFAULT) {
  if (!events.length) return { idle_seconds: 0, unreported_seconds: 0, unreported_since: null };
  const ivs = events
    .filter((e) => e.started_at)
    .map((e) => {
      const s = new Date(e.started_at).getTime();
      const en = e.ended_at ? new Date(e.ended_at).getTime() : nowMs;
      return [Math.min(s, en), Math.max(s, en)];
    })
    .filter(([s, e]) => e > s);
  if (!ivs.length) return { idle_seconds: 0, unreported_seconds: 0, unreported_since: null };
  ivs.sort((a, b) => a[0] - b[0]);
  const merged = [ivs[0].slice()];
  for (let i = 1; i < ivs.length; i++) {
    const last = merged[merged.length - 1];
    if (ivs[i][0] <= last[1]) last[1] = Math.max(last[1], ivs[i][1]);
    else merged.push(ivs[i].slice());
  }
  const thresholdMs = threshold * 1000;
  let idleSec = 0;
  let unreportedSec = 0;
  // gaps internos
  for (let i = 1; i < merged.length; i++) {
    const gapMs = merged[i][0] - merged[i - 1][1];
    if (gapMs <= 0) continue;
    if (gapMs > thresholdMs) unreportedSec += gapMs / 1000;
    else idleSec += gapMs / 1000;
  }
  // gap TRAILING: do último ended até dayEnd (ou now, o que for menor)
  const lastEnd = merged[merged.length - 1][1];
  const cap = Math.min(nowMs, dayEndMs || nowMs);
  let unreportedSince = null;
  if (cap > lastEnd) {
    const trailingMs = cap - lastEnd;
    if (trailingMs > thresholdMs) {
      unreportedSec += trailingMs / 1000;
      unreportedSince = new Date(lastEnd).toISOString();
    } else {
      idleSec += trailingMs / 1000;
    }
  }
  return {
    idle_seconds: Math.round(idleSec),
    unreported_seconds: Math.round(unreportedSec),
    unreported_since: unreportedSince,
  };
}

/** Compat: API antiga só com idle. Mantida pra retro-compat e teste. */
function computeIdleSeconds(events, nowMs) {
  return computeGaps(events, nowMs, nowMs).idle_seconds;
}

class TimelineRepo {
  constructor(deps = {}) {
    this.db = deps.db;
  }

  /** Eventos do dia, agrupados por pessoa. Com idle_seconds derivado. */
  async eventsByDay(date) {
    const d = resolveDate(date);
    const r = await this.db.query(
      `SELECT ${EVENT_COLUMNS}
       FROM v3.events e
       LEFT JOIN v3.persons p ON p.id = e.person_id
       LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
       WHERE e.deleted_at IS NULL
         AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1
       ORDER BY p.display_name, e.started_at`, [d]);

    const byPerson = new Map();
    for (const e of (r.rows || [])) {
      if (!byPerson.has(e.person_id)) {
        byPerson.set(e.person_id, {
          person_id: e.person_id,
          display_name: e.person_name || null,
          role: e.person_role || null,
          events: [],
          _raw: [],
        });
      }
      const bp = byPerson.get(e.person_id);
      bp.events.push(shapeEvent(e));
      bp._raw.push(e);
    }
    const nowMs = Date.now();
    // dayEnd = expedient_end_hour_ny (default 19h) no fuso NY do dia `d`.
    // Trailing gap até esse cap é considerado "não reportado" se exceder.
    // Pra hoje, cap = min(EOD, now).
    const [y, mo, dy] = d.split('-').map(Number);
    const noonUtc = Date.UTC(y, mo - 1, dy, 12);
    const tz = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', timeZoneName: 'short',
    }).formatToParts(noonUtc).find((p) => p.type === 'timeZoneName').value;
    const off = tz === 'EDT' ? -4 : -5;
    // pega o setting expedient_end_hour_ny (default 19)
    let endHour = 19;
    try {
      const s = await this.db.query("SELECT value FROM v3.settings WHERE key = 'expedient_end_hour_ny'");
      if (s.rows[0]) {
        const v = s.rows[0].value;
        const n = typeof v === 'number' ? v : parseInt(typeof v === 'string' ? v.replace(/"/g, '') : v, 10);
        if (Number.isFinite(n)) endHour = n;
      }
    } catch (_) { /* default */ }
    const dayEndMs = Date.UTC(y, mo - 1, dy, endHour - off);
    for (const bp of byPerson.values()) {
      const g = computeGaps(bp._raw, nowMs, dayEndMs);
      bp.idle_seconds = g.idle_seconds;
      bp.unreported_seconds = g.unreported_seconds;
      bp.unreported_since = g.unreported_since;
      delete bp._raw;
    }
    return { date: d, people: [...byPerson.values()] };
  }

  /** Eventos de UMA pessoa num dia. */
  async eventsByPersonDay(personId, date) {
    const d = resolveDate(date);
    const r = await this.db.query(
      `SELECT ${EVENT_COLUMNS}
       FROM v3.events e
       LEFT JOIN v3.persons p ON p.id = e.person_id
       LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
       WHERE e.deleted_at IS NULL AND e.person_id = $1
         AND (e.started_at AT TIME ZONE 'America/New_York')::date = $2
       ORDER BY e.started_at`, [personId, d]);
    const first = r.rows[0];
    return {
      date: d,
      person: {
        person_id: personId,
        display_name: first ? (first.person_name || null) : null,
        role: first ? (first.person_role || null) : null,
      },
      events: (r.rows || []).map(shapeEvent),
    };
  }
}

module.exports = { TimelineRepo, computeIdleSeconds, computeGaps };
