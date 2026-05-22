'use strict';
/**
 * HEALTHFARE V3 — Bloco 3 — DeadlinesRepo (leitura).
 *
 * Lista as deadlines + calcula, pras recorrentes, quantos minutos
 * faltam pro corte de HOJE (>0 = faltam; <0 = passou; null = não é
 * dia/recorrente). A UI de alerta consome isso. Read-only.
 */

const { TZ } = require('./ny-date');

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

class DeadlinesRepo {
  constructor(deps = {}) {
    this.db = deps.db;
    this._now = deps.now || Date.now;
  }

  /** Minutos até o corte de hoje (recorrente). null se não aplicável. */
  _minutesUntilToday(d, nowMs) {
    if (!d.active || d.kind !== 'recurring' || !d.time_of_day) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    }).formatToParts(new Date(nowMs)).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
    const weekday = WD[parts.weekday];
    if (!(d.weekdays || []).includes(weekday)) return null;
    const nowMin = (parseInt(parts.hour, 10) % 24) * 60 + parseInt(parts.minute, 10);
    const [h, m] = String(d.time_of_day).split(':').map(Number);
    return (h * 60 + m) - nowMin;
  }

  async list() {
    const r = await this.db.query(
      'SELECT * FROM v3.deadlines ORDER BY flow NULLS FIRST, time_of_day NULLS LAST, id');
    const nowMs = this._now();
    return {
      deadlines: (r.rows || []).map((d) => ({
        id: d.id,
        flow: d.flow || null,
        label: d.label,
        kind: d.kind,
        time_of_day: d.time_of_day || null,
        weekdays: d.weekdays || [],
        due_date: d.due_date || null,
        active: d.active !== false,
        notes: d.notes || null,
        minutes_until_today: this._minutesUntilToday(d, nowMs),
      })),
    };
  }
}

module.exports = { DeadlinesRepo };
