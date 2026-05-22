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
  };
}

const EVENT_COLUMNS = `e.id, e.person_id, e.activity_type_id, e.product_batch_id,
            e.started_at, e.ended_at, e.confidence, e.cowork_with,
            e.phase_label, e.description, e.source_message_ts, e.flow_override,
            p.display_name AS person_name, p.role AS person_role,
            at.slug AS activity_slug, at.display_name AS activity_name,
            at.category AS activity_category, at.flow AS activity_flow,
            at.phase_order AS activity_phase_order`;

class TimelineRepo {
  constructor(deps = {}) {
    this.db = deps.db;
  }

  /** Eventos do dia, agrupados por pessoa. */
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
        });
      }
      byPerson.get(e.person_id).events.push(shapeEvent(e));
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

module.exports = { TimelineRepo };
