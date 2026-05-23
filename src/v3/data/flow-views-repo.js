'use strict';
/**
 * HEALTHFARE V3 — Bloco 3 — FlowViewsRepo (leitura).
 *
 * As 3 visões por fluxo, cada uma no seu modo (Bloco 1):
 *   productionByDay  mode=ordered — lotes do dia, fase a fase
 *   pnpByDay         mode=block   — o bloco do dia (tempo total somado)
 *   supportByDay     mode=loose   — ocorrências avulsas
 *
 * Fluxo efetivo = COALESCE(flow_override, activity_type.flow).
 * Duração via validSeconds (ended>started) — events ruins não poluem.
 * Read-only.
 */

const { resolveDate, toNyIso } = require('./ny-date');
const { validSeconds } = require('./goals-repo');

const DOWNTIME_SLUGS = new Set(['repair']); // conserto = parada (downtime)

/**
 * Bounds (UTC ms) do dia NY YYYY-MM-DD. Detecta EDT/EST via Intl.
 * Usado pra CLAMPAR a duração de events que cruzam meia-noite —
 * o ev 136 (shipping aberto 22→23/mai) inflava o P&P do dia 22 em
 * 22h44m porque a regra antiga somava a duração inteira no dia do
 * `started_at`. Bug #B.7 do dashboard B.
 */
function nyDayBounds(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  // meio-dia UTC SEMPRE cai dentro do dia NY do mesmo y-m-d.
  const noonUtcMs = Date.UTC(y, m - 1, d, 12);
  const tz = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'short',
  }).formatToParts(noonUtcMs).find((p) => p.type === 'timeZoneName').value;
  const offsetH = tz === 'EDT' ? -4 : -5;
  const startMs = Date.UTC(y, m - 1, d, -offsetH);
  return { startMs, endMs: startMs + 24 * 3600 * 1000 };
}

/**
 * Segundos válidos de um event DENTRO da janela [dayStart, dayEnd] NY.
 * Mesmo guard de validSeconds (ended>started); event aberto conta até
 * `now` (clampado ao endMs). Event que cruza meia-noite só contribui
 * com a parte do dia em questão.
 */
function clampedSeconds(started, ended, dayStartMs, dayEndMs, nowMs) {
  if (!started) return null;
  const sRaw = new Date(started).getTime();
  const eRaw = ended ? new Date(ended).getTime() : nowMs;
  if (Number.isNaN(sRaw) || Number.isNaN(eRaw)) return null;
  if (eRaw <= sRaw) return null; // guard duração negativa/zero
  const s = Math.max(sRaw, dayStartMs);
  const e = Math.min(eRaw, dayEndMs);
  const sec = (e - s) / 1000;
  return sec > 0 ? sec : null;
}

const EV_COLUMNS = `e.id, e.product_batch_id, e.person_id, e.started_at, e.ended_at,
  at.display_name AS activity_name, at.slug AS activity_slug, at.phase_order,
  pb.batch_number, pb.product_id, pr.canonical_name AS product,
  p.display_name AS person_name`;

class FlowViewsRepo {
  constructor(deps = {}) {
    this.db = deps.db;
    this._now = deps.now || Date.now;
  }

  /** Events do dia (NY) cujo fluxo EFETIVO = `flow`. */
  async _dayEvents(date, flow) {
    const r = await this.db.query(
      `SELECT ${EV_COLUMNS}
       FROM v3.events e
       LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
       LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
       LEFT JOIN v3.products pr ON pr.id = pb.product_id
       LEFT JOIN v3.persons p ON p.id = e.person_id
       WHERE e.deleted_at IS NULL
         AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1
         AND COALESCE(e.flow_override, at.flow) = $2
       ORDER BY e.started_at`, [date, flow]);
    return r.rows;
  }

  /** PRODUÇÃO — lotes trabalhados no dia, fase a fase. */
  async productionByDay(date) {
    const d = resolveDate(date);
    const evs = await this._dayEvents(d, 'production');
    const now = this._now();
    const bounds = nyDayBounds(d);
    const byBatch = new Map();
    for (const e of evs) {
      const key = e.product_batch_id || 0;
      if (!byBatch.has(key)) {
        byBatch.set(key, {
          batch_id: e.product_batch_id || null,
          batch_number: e.batch_number || null,
          product: e.product_id ? { id: e.product_id, canonical_name: e.product } : null,
          total_seconds: 0, invalid_event_count: 0,
          _phases: new Map(), _people: new Set(),
        });
      }
      const b = byBatch.get(key);
      if (e.person_name) b._people.add(e.person_name);
      // B.7 — clamp à janela NY do dia: event que cruzou meia-noite
      // só contribui com a parte que cai dentro de [00:00, 24:00] NY.
      const secs = clampedSeconds(e.started_at, e.ended_at, bounds.startMs, bounds.endMs, now);
      if (secs == null) { b.invalid_event_count += 1; continue; }
      b.total_seconds += secs;
      const ph = e.activity_name || '(não classificado)';
      b._phases.set(ph, (b._phases.get(ph) || 0) + secs);
    }
    return {
      date: d, flow: 'production', mode: 'ordered',
      lotes: [...byBatch.values()].map((b) => ({
        batch_id: b.batch_id, batch_number: b.batch_number, product: b.product,
        total_seconds: Math.round(b.total_seconds),
        invalid_event_count: b.invalid_event_count,
        people: [...b._people],
        phases: [...b._phases.entries()].map(([activity, s]) => ({ activity, seconds: Math.round(s) })),
      })),
    };
  }

  /** P&P — o bloco do dia: tempo total somado + sub-passos presentes. */
  async pnpByDay(date) {
    const d = resolveDate(date);
    const evs = await this._dayEvents(d, 'pnp');
    const now = this._now();
    const bounds = nyDayBounds(d);
    let total = 0;
    let invalid = 0;
    const subSteps = new Map();
    const people = new Set();
    for (const e of evs) {
      if (e.person_name) people.add(e.person_name);
      const secs = clampedSeconds(e.started_at, e.ended_at, bounds.startMs, bounds.endMs, now);
      if (secs == null) { invalid += 1; continue; }
      total += secs;
      const ss = e.activity_name || '(?)';
      subSteps.set(ss, (subSteps.get(ss) || 0) + secs);
    }
    return {
      date: d, flow: 'pnp', mode: 'block',
      total_seconds: Math.round(total),
      invalid_event_count: invalid,
      event_count: evs.length,
      people: [...people],
      sub_steps: [...subSteps.entries()].map(([activity, s]) => ({ activity, seconds: Math.round(s) })),
      // nº de pacotes: sem fonte de dado ainda (Veeqo / captura de qtd
      // pelo Observer é futuro). null = pendente. Sem isso, tempo/pacote
      // também fica null.
      packages: null,
      seconds_per_package: null,
    };
  }

  /** SUPORTE — ocorrências avulsas do dia (conserto destacado como downtime). */
  async supportByDay(date) {
    const d = resolveDate(date);
    const evs = await this._dayEvents(d, 'support');
    const now = this._now();
    const bounds = nyDayBounds(d);
    return {
      date: d, flow: 'support', mode: 'loose',
      occurrences: evs.map((e) => ({
        event_id: e.id,
        activity: e.activity_name || '(não classificado)',
        person: e.person_name || null,
        started_at: toNyIso(e.started_at),
        ended_at: toNyIso(e.ended_at),
        seconds: clampedSeconds(e.started_at, e.ended_at, bounds.startMs, bounds.endMs, now),
        is_downtime: DOWNTIME_SLUGS.has(e.activity_slug),
      })),
    };
  }
}

module.exports = { FlowViewsRepo, nyDayBounds, clampedSeconds };
