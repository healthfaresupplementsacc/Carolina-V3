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

/**
 * Intervalo [s,e] clampado à janela do dia. Retorna null se inválido/fora.
 */
function clampedInterval(started, ended, dayStartMs, dayEndMs, nowMs) {
  if (!started) return null;
  const sRaw = new Date(started).getTime();
  const eRaw = ended ? new Date(ended).getTime() : nowMs;
  if (Number.isNaN(sRaw) || Number.isNaN(eRaw)) return null;
  if (eRaw <= sRaw) return null;
  const s = Math.max(sRaw, dayStartMs);
  const e = Math.min(eRaw, dayEndMs);
  return e > s ? [s, e] : null;
}

/**
 * União de intervalos (em ms) → soma de segundos cobertos.
 * Ex: [[10,20],[15,25],[30,40]] → 20s (10-25 = 15s + 30-40 = 10s).
 * Usado pra calcular tempo-de-parede do bloco P&P (sem somar paralelo).
 */
function unionSeconds(intervals) {
  if (!intervals || !intervals.length) return 0;
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let [s, e] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][0] <= e) {
      e = Math.max(e, sorted[i][1]); // sobrepõe
    } else {
      covered += e - s;
      [s, e] = sorted[i];
    }
  }
  covered += e - s;
  return Math.round(covered / 1000);
}

const EV_COLUMNS = `e.id, e.product_batch_id, e.person_id, e.started_at, e.ended_at,
  e.quantity, e.quantity_unit,
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

  /** P&P — o bloco do dia: TEMPO-DE-PAREDE (união de intervalos) + sub-passos + quantidades.
   *  Antes: somava o tempo de cada pessoa (inflava com cowork). Agora total =
   *  união dos intervalos cobertos por algum event de P&P, então 2 pessoas
   *  na MESMA atividade ao mesmo tempo conta como 1 vez (modelo "tempo de
   *  parede do bloco", combinado com Bruno). sub_steps mantém soma por
   *  atividade pra ver onde o tempo foi gasto. person_seconds mantém soma
   *  por pessoa pra ver carga individual. */
  async pnpByDay(date) {
    const d = resolveDate(date);
    const evs = await this._dayEvents(d, 'pnp');
    const now = this._now();
    const bounds = nyDayBounds(d);
    let invalid = 0;
    const subSteps = new Map();      // activity → soma de seconds (pessoa-hora; mantém)
    const people = new Set();
    const allIntervals = [];          // [[s,e],...] pra união do total
    const subIntervals = new Map();   // activity → [[s,e],...] pra união por sub-passo
    const personSeconds = new Map();  // person_name → soma de seconds (carga individual)
    const quantities = [];
    let ordersTotal = 0;
    for (const e of evs) {
      if (e.person_name) people.add(e.person_name);
      const iv = clampedInterval(e.started_at, e.ended_at, bounds.startMs, bounds.endMs, now);
      if (!iv) { invalid += 1; continue; }
      const secs = (iv[1] - iv[0]) / 1000;
      allIntervals.push(iv);
      const ss = e.activity_name || '(?)';
      if (!subIntervals.has(ss)) subIntervals.set(ss, []);
      subIntervals.get(ss).push(iv);
      subSteps.set(ss, (subSteps.get(ss) || 0) + secs);
      if (e.person_name) {
        personSeconds.set(e.person_name, (personSeconds.get(e.person_name) || 0) + secs);
      }
      if (e.quantity != null) {
        quantities.push({
          event_id: e.id, activity: ss, quantity: Number(e.quantity), unit: e.quantity_unit || null,
        });
        if (e.quantity_unit === 'order') ordersTotal += Number(e.quantity);
      }
    }
    const wallSeconds = unionSeconds(allIntervals);
    // sub_steps com tempo-de-parede por atividade (uniao) + carga total
    // (soma pessoa-hora). Frontend pode escolher qual mostrar.
    const subStepsOut = [...subIntervals.entries()].map(([activity, ivs]) => ({
      activity,
      seconds: Math.round(subSteps.get(activity) || 0),    // soma (pessoa-hora)
      wall_seconds: unionSeconds(ivs),                      // união (sem dupla contagem)
    }));
    return {
      date: d, flow: 'pnp', mode: 'block',
      total_seconds: wallSeconds,         // NOVO MODELO: união de intervalos
      person_seconds_total: Math.round([...personSeconds.values()].reduce((s, v) => s + v, 0)),
      person_seconds: [...personSeconds.entries()].map(([person, s]) => ({ person, seconds: Math.round(s) })),
      invalid_event_count: invalid,
      event_count: evs.length,
      people: [...people],
      sub_steps: subStepsOut,
      orders: ordersTotal,
      seconds_per_order: ordersTotal > 0 ? Math.round(wallSeconds / ordersTotal) : null,
      quantities,
      packages: ordersTotal > 0 ? ordersTotal : null,
      seconds_per_package: ordersTotal > 0 ? Math.round(wallSeconds / ordersTotal) : null,
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

module.exports = { FlowViewsRepo, nyDayBounds, clampedSeconds, clampedInterval, unionSeconds };
