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

// Bloco 27/mai — machine_downtime explicitamente marca a linha parada.
// 'repair' legado mantido (cobre eventos antigos onde os 2 conceitos não
// estavam separados). facility_maintenance NÃO entra — não pára a linha.
const DOWNTIME_SLUGS = new Set(['repair', 'machine_downtime']);

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
    // E7-cérebro #6 — invalid_events detalhados (não esconde mais com count só).
    // Cada event que falha clampedSeconds vira { event_id, person, activity, started_at,
    // ended_at, reason } no card de Atenção pra Bruno conseguir corrigir.
    const invalidEvents = [];
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
      const secs = clampedSeconds(e.started_at, e.ended_at, bounds.startMs, bounds.endMs, now);
      if (secs == null) {
        b.invalid_event_count += 1;
        invalidEvents.push({
          event_id: e.id, person: e.person_name || null,
          activity: e.activity_name || null,
          started_at: toNyIso(e.started_at), ended_at: toNyIso(e.ended_at),
          batch_number: e.batch_number || null,
          reason: e.ended_at == null
            ? 'event aberto sem clamp possível (data inválida?)'
            : (new Date(e.ended_at) <= new Date(e.started_at)
              ? 'duração negativa ou zero (ended_at <= started_at)'
              : 'event totalmente fora da janela NY do dia'),
        });
        continue;
      }
      b.total_seconds += secs;
      const ph = e.activity_name || '(não classificado)';
      b._phases.set(ph, (b._phases.get(ph) || 0) + secs);
    }
    // SINCRONIA: garrafas vêm da FONTE CANÔNICA v3.production_counts (kind='bottles'),
    // por lote + total do dia. Antes a "Produção hoje" lia events.qty (que o /op não
    // grava) → "0 garrafas". LEFT-friendly: não derruba lote sem produto.
    const bottlesByBatch = new Map();
    let totalBottles = 0;
    try {
      const bc = await this.db.query(
        `SELECT pc.product_batch_id, COALESCE(SUM(pc.bottles),0)::int AS bottles
         FROM v3.production_counts pc
         WHERE pc.kind = 'bottles' AND pc.deleted_at IS NULL AND pc.superseded_by IS NULL
           AND pc.production_date = $1
         GROUP BY pc.product_batch_id`, [d]);
      for (const row of bc.rows) { bottlesByBatch.set(row.product_batch_id || 0, row.bottles); totalBottles += row.bottles; }
    } catch (e) { /* canônico falhou */ }
    // LINHA (Bruno 06-22): "Produção hoje" mostra o TEMPO REAL da linha — só
    // production_line (fora review/labeling/etc). 3 bases: pessoa-hora (SOMA dos
    // tempos), span (relógio do 1º início ao último fim) e união (relógio sem dupla
    // contagem quando 2+ produzem o mesmo lote junto). O ritmo certo é por relógio.
    const line = { bottles: totalBottles, person_seconds: 0, span_seconds: 0, union_seconds: 0, event_count: 0 };
    // TOTAL DO FLUXO (Bruno 06-22): mantém a métrica ANTIGA também — garrafas ÷ SOMA
    // de TODO o tempo de produção (linha + revisão + labeling + …), em pessoa-hora —
    // pra Bruno ver os 2 lado a lado, + o detalhe por fase (revisão, labeling…).
    const flowBySlug = new Map();
    let flowPersonSec = 0;
    {
      const ivs = [];
      for (const e of evs) {
        const secs = clampedSeconds(e.started_at, e.ended_at, bounds.startMs, bounds.endMs, now);
        if (secs == null) continue;
        flowPersonSec += secs;
        const slug = e.activity_slug || 'outro';
        const cur = flowBySlug.get(slug) || { slug, name: e.activity_name || slug, seconds: 0 };
        cur.seconds += secs; flowBySlug.set(slug, cur);
        if (e.activity_slug === 'production_line') {
          line.person_seconds += secs;
          line.event_count += 1;
          const s0 = new Date(e.started_at).getTime();
          const s1 = e.ended_at ? new Date(e.ended_at).getTime() : now;
          if (Number.isFinite(s0) && Number.isFinite(s1) && s1 > s0) ivs.push([s0, s1]);
        }
      }
      if (ivs.length) {
        const span = Math.max(...ivs.map((i) => i[1])) - Math.min(...ivs.map((i) => i[0]));
        ivs.sort((a, b) => a[0] - b[0]);
        let union = 0, cS = null, cE = null;
        for (const [s, en] of ivs) {
          if (cS === null) { cS = s; cE = en; }
          else if (s <= cE) { cE = Math.max(cE, en); }
          else { union += cE - cS; cS = s; cE = en; }
        }
        if (cS !== null) union += cE - cS;
        line.span_seconds = Math.round(span / 1000);
        line.union_seconds = Math.round(union / 1000);
      }
      line.person_seconds = Math.round(line.person_seconds);
      line.bottles_per_min = line.union_seconds > 0 ? +(totalBottles / (line.union_seconds / 60)).toFixed(1) : null;
      line.sec_per_bottle = (line.union_seconds > 0 && totalBottles > 0) ? +(line.union_seconds / totalBottles).toFixed(1) : null;
      // pessoa-hora da linha tb vira ritmo (referência, sem relógio)
      line.bottles_per_min_person = line.person_seconds > 0 ? +(totalBottles / (line.person_seconds / 60)).toFixed(1) : null;
    }
    const flowTotal = {
      person_seconds: Math.round(flowPersonSec),
      bottles_per_min: flowPersonSec > 0 ? +(totalBottles / (flowPersonSec / 60)).toFixed(1) : null,
      sec_per_bottle: (flowPersonSec > 0 && totalBottles > 0) ? +(flowPersonSec / totalBottles).toFixed(1) : null,
      by_phase: [...flowBySlug.values()]
        .map((p) => ({ slug: p.slug, name: p.name, seconds: Math.round(p.seconds) }))
        .sort((a, b) => b.seconds - a.seconds),
    };
    return {
      date: d, flow: 'production', mode: 'ordered',
      total_bottles: totalBottles, line, flow_total: flowTotal,
      lotes: [...byBatch.values()].map((b) => ({
        batch_id: b.batch_id, batch_number: b.batch_number, product: b.product,
        total_seconds: Math.round(b.total_seconds),
        bottles: bottlesByBatch.get(b.batch_id || 0) || 0,
        bottles_per_min: b.total_seconds > 0 ? +((bottlesByBatch.get(b.batch_id || 0) || 0) / (b.total_seconds / 60)).toFixed(1) : null,
        invalid_event_count: b.invalid_event_count,
        people: [...b._people],
        phases: [...b._phases.entries()].map(([activity, s]) => ({ activity, seconds: Math.round(s) })),
      })),
      invalid_events: invalidEvents,
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
    // Bug #1 bloco 29/mai: array detalhado de invalid events pra notif
    // V4 listar (não só count). Mesmo shape do productionByDay.
    const invalidEvents = [];
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
      if (!iv) {
        invalid += 1;
        invalidEvents.push({
          event_id: e.id, person: e.person_name || null,
          activity: e.activity_name || null,
          started_at: toNyIso(e.started_at), ended_at: toNyIso(e.ended_at),
          reason: e.ended_at == null
            ? 'event aberto sem clamp possível (data inválida?)'
            : (new Date(e.ended_at) <= new Date(e.started_at)
              ? 'duração negativa ou zero (ended_at <= started_at)'
              : 'event totalmente fora da janela NY do dia'),
        });
        continue;
      }
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
    // SINCRONIA: ordens vêm da FONTE CANÔNICA v3.production_counts (kind='orders'),
    // dos events counts_as_pp (clínica fora) — igual /admin. Antes só lia
    // events.quantity_unit='order' (o /op grava em production_counts) → "ordens 0".
    let pcOrders = 0;
    try {
      pcOrders = (await this.db.query(
        `SELECT COALESCE(SUM(pc.bottles),0)::int AS orders
         FROM v3.production_counts pc
         JOIN v3.events e ON e.id = pc.source_event_id
         JOIN v3.activity_types at ON at.id = e.activity_type_id AND at.counts_as_pp = true
         WHERE pc.kind = 'orders' AND pc.deleted_at IS NULL AND pc.superseded_by IS NULL AND e.deleted_at IS NULL AND pc.production_date = $1`,
        [d])).rows[0].orders;
    } catch (e) { /* canônico falhou → usa fallback abaixo */ }
    const orders = pcOrders > 0 ? pcOrders : ordersTotal; // canônico, com fallback events.quantity
    // P&P "do dia" = SPAN corrido (1º início P&P → último fim), incluindo gaps (decisão Bruno).
    let spanStart = null, spanEnd = null;
    for (const e of evs) {
      const s = new Date(e.started_at).getTime();
      const en = e.ended_at ? new Date(e.ended_at).getTime() : now;
      if (!Number.isNaN(s) && (spanStart == null || s < spanStart)) spanStart = s;
      if (!Number.isNaN(en) && (spanEnd == null || en > spanEnd)) spanEnd = en;
    }
    const spanSeconds = (spanStart != null && spanEnd != null && spanEnd > spanStart)
      ? Math.round((spanEnd - spanStart) / 1000) : wallSeconds;
    const subStepsOut = [...subIntervals.entries()].map(([activity, ivs]) => ({
      activity,
      seconds: Math.round(subSteps.get(activity) || 0),    // soma (pessoa-hora)
      wall_seconds: unionSeconds(ivs),                      // união (sem dupla contagem)
    }));
    // INPUTS BRUTOS das ordens (auditoria): cada contagem kind='orders' VIVA, com
    // a qtd que o operador digitou, em qual impressão (order_printing / _2) e quem.
    // Deixa o painel do evento mostrar exatamente o que a Simone entrou na 1ª/2ª
    // impressão — `orders` (acima) é a soma; aqui é o detalhe. Clínica fica fora.
    let ordersInputs = [];
    try {
      ordersInputs = (await this.db.query(
        `SELECT pc.bottles AS qty, at.slug, at.display_name AS activity_name, pc.adjustment_kind,
                p.display_name AS person, pc.source_event_id AS event_id,
                to_char(pc.reported_at AT TIME ZONE 'America/New_York', 'HH24:MI') AS at_ny
         FROM v3.production_counts pc
         JOIN v3.events e ON e.id = pc.source_event_id
         JOIN v3.activity_types at ON at.id = e.activity_type_id AND at.counts_as_pp = true
         LEFT JOIN v3.persons p ON p.id = pc.reported_by_person_id
         WHERE pc.kind = 'orders' AND pc.deleted_at IS NULL AND pc.superseded_by IS NULL
           AND e.deleted_at IS NULL AND pc.production_date = $1
         ORDER BY pc.reported_at`, [d])).rows.map((r) => ({
        qty: Number(r.qty), slug: r.slug, activity_name: r.activity_name, adjustment_kind: r.adjustment_kind || null,
        person: r.person || null, event_id: r.event_id, at: r.at_ny || null,
      }));
    } catch (e) { /* opcional — não derruba o card */ }
    // RESET de ordens: se um operador reajustou o TOTAL hoje, expõe antes→agora
    // pro dashboard mostrar o valor antigo riscado + o novo em vermelho. Pega o
    // reset VIVO mais recente; old_total = soma do que ele superseded.
    let ordersReset = null;
    try {
      const rr = (await this.db.query(
        `SELECT pc.bottles AS new_total, p.display_name AS by_name,
                to_char(pc.reported_at AT TIME ZONE 'America/New_York', 'HH24:MI') AS at_ny,
                (SELECT COALESCE(SUM(o.bottles),0)::int FROM v3.production_counts o WHERE o.superseded_by = pc.id) AS old_total
         FROM v3.production_counts pc LEFT JOIN v3.persons p ON p.id = pc.reported_by_person_id
         WHERE pc.adjustment_kind = 'reset' AND pc.kind = 'orders' AND pc.deleted_at IS NULL
           AND pc.superseded_by IS NULL AND pc.production_date = $1
         ORDER BY pc.reported_at DESC LIMIT 1`, [d])).rows[0];
      if (rr) ordersReset = { old_total: Number(rr.old_total), new_total: Number(rr.new_total), by: rr.by_name || null, at: rr.at_ny || null };
    } catch (e) { /* opcional */ }
    // PESSOA-HORA (Bruno 06-22): tempo total de CADA pessoa no P&P + a SOMA, e a
    // média por pacote dividindo a soma pelos envelopes ("quanto cada um levou,
    // somado, ÷ nº de pacotes"). by_person ordenado do maior pro menor.
    const personTotal = Math.round([...personSeconds.values()].reduce((s, v) => s + v, 0));
    const byPerson = [...personSeconds.entries()]
      .map(([person, s]) => ({ person, seconds: Math.round(s) }))
      .sort((a, b) => b.seconds - a.seconds);
    return {
      date: d, flow: 'pnp', mode: 'block',
      total_seconds: spanSeconds,         // P&P do dia = SPAN corrido (Bruno)
      wall_seconds: wallSeconds,          // união de intervalos (referência)
      span_seconds: spanSeconds,
      person_seconds_total: personTotal,  // SOMA do tempo de todas as pessoas no P&P
      person_seconds: byPerson,           // tempo de cada pessoa (Simone, Ana, …)
      person_seconds_per_order: orders > 0 ? Math.round(personTotal / orders) : null, // média pessoa-hora ÷ pacote
      invalid_event_count: invalid,
      invalid_events: invalidEvents,
      event_count: evs.length,
      people: [...people],
      sub_steps: subStepsOut,
      orders,
      orders_inputs: ordersInputs,        // detalhe por impressão (input bruto do operador)
      orders_reset: ordersReset,          // { old_total, new_total, by, at } se reajustaram hoje
      seconds_per_order: orders > 0 ? Math.round(spanSeconds / orders) : null,
      quantities,
      packages: orders > 0 ? orders : null,
      seconds_per_package: orders > 0 ? Math.round(spanSeconds / orders) : null,
    };
  }

  /** FNSKU — o bloco do dia (regra Bruno 06-23): labels colados + TEMPO por pessoa
   *  (estilo P&P: cada um soma o SEU tempo no fnsku_labeling), soma, e a MÉDIA por
   *  label. Mais o ritmo por relógio (labels/min) e o detalhe por lote. Cowork no
   *  MESMO lote soma por pessoa (cada um cola labels diferentes → contagens somam).
   *  Conta = production_counts kind='fnsku'. Tempo = eventos slug='fnsku_labeling'. */
  async fnskuByDay(date) {
    const d = resolveDate(date);
    const evs = await this._dayEvents(d, 'production'); // fnsku_labeling tem flow=production
    const now = this._now();
    const bounds = nyDayBounds(d);
    const personSeconds = new Map();
    const byBatch = new Map();
    const allIntervals = [];
    let eventCount = 0;
    for (const e of evs) {
      if (e.activity_slug !== 'fnsku_labeling') continue;
      const secs = clampedSeconds(e.started_at, e.ended_at, bounds.startMs, bounds.endMs, now);
      if (secs == null) continue;
      eventCount += 1;
      if (e.person_name) personSeconds.set(e.person_name, (personSeconds.get(e.person_name) || 0) + secs);
      const s0 = new Date(e.started_at).getTime();
      const s1 = e.ended_at ? new Date(e.ended_at).getTime() : now;
      const iv = (Number.isFinite(s0) && Number.isFinite(s1) && s1 > s0) ? [s0, s1] : null;
      if (iv) allIntervals.push(iv);
      const key = e.product_batch_id || 0;
      if (!byBatch.has(key)) byBatch.set(key, { batch_id: e.product_batch_id || null, batch_number: e.batch_number || null, product: e.product || null, seconds: 0, people: new Set(), intervals: [] });
      const b = byBatch.get(key);
      b.seconds += secs;
      if (e.person_name) b.people.add(e.person_name);
      if (iv) b.intervals.push(iv);
    }
    // labels (kind='fnsku') do dia, total + por lote
    let totalLabels = 0;
    const labelsByBatch = new Map();
    try {
      const lc = await this.db.query(
        `SELECT pc.product_batch_id, COALESCE(SUM(pc.bottles),0)::int AS labels
         FROM v3.production_counts pc
         WHERE pc.kind = 'fnsku' AND pc.deleted_at IS NULL AND pc.superseded_by IS NULL AND pc.production_date = $1
         GROUP BY pc.product_batch_id`, [d]);
      for (const r of lc.rows) { labelsByBatch.set(r.product_batch_id || 0, r.labels); totalLabels += r.labels; }
    } catch (e) { /* canônico falhou */ }
    const wallUnion = unionSeconds(allIntervals);
    let spanStart = null, spanEnd = null;
    for (const [s, en] of allIntervals) { if (spanStart == null || s < spanStart) spanStart = s; if (spanEnd == null || en > spanEnd) spanEnd = en; }
    const span = (spanStart != null && spanEnd != null && spanEnd > spanStart) ? Math.round((spanEnd - spanStart) / 1000) : wallUnion;
    const personTotal = Math.round([...personSeconds.values()].reduce((s, v) => s + v, 0));
    return {
      date: d, flow: 'fnsku',
      total_labels: totalLabels,
      person_seconds_total: personTotal,
      person_seconds: [...personSeconds.entries()].map(([person, s]) => ({ person, seconds: Math.round(s) })).sort((a, b) => b.seconds - a.seconds),
      person_seconds_per_label: totalLabels > 0 ? Math.round(personTotal / totalLabels) : null, // seg/label (pessoa-hora)
      wall_seconds: wallUnion,
      span_seconds: span,
      labels_per_min: wallUnion > 0 ? +(totalLabels / (wallUnion / 60)).toFixed(1) : null,          // relógio (união)
      labels_per_min_person: personTotal > 0 ? +(totalLabels / (personTotal / 60)).toFixed(1) : null, // pessoa-hora
      sec_per_label: (wallUnion > 0 && totalLabels > 0) ? +(wallUnion / totalLabels).toFixed(1) : null,
      event_count: eventCount,
      people: [...personSeconds.keys()],
      lotes: [...byBatch.values()].map((b) => {
        const w = unionSeconds(b.intervals);
        const labels = labelsByBatch.get(b.batch_id || 0) || 0;
        return {
          batch_id: b.batch_id, batch_number: b.batch_number, product: b.product,
          seconds: Math.round(b.seconds), wall_seconds: w, labels, people: [...b.people],
          labels_per_min: w > 0 ? +(labels / (w / 60)).toFixed(1) : null,
        };
      }).sort((a, b) => b.labels - a.labels),
    };
  }

  /** REVISÃO — taxa de revisão (cápsulas/seg + frascos/min) + MÉDIA DE TEMPO
   *  DE REVISÃO por produto e geral. Histórico (range em dias) pra Bruno saber
   *  a média por suplemento — "média de tempo de revisão por esse produto/geral".
   *  Mesma base do /admin review-rate (capsules = target_bottles × units_per_bottle;
   *  work_sec desconta pausa), mas AGREGADO POR PRODUTO. Read-only. */
  async reviewRate(opts = {}) {
    const days = ({ '7d': 7, '30d': 30, '90d': 90, '180d': 180 }[String(opts.range)] || 30);
    // WORK_SEC = duração de trabalho descontando pausas (igual /admin, fonte única).
    const WORK_SEC = `GREATEST(0, EXTRACT(EPOCH FROM (e.ended_at - e.started_at)) - COALESCE(e.total_paused_seconds, 0))`;
    const params = [];
    let prodFilter = '';
    const pid = Number(opts.product_id);
    if (Number.isFinite(pid)) { params.push(pid); prodFilter = ` AND pb.product_id = $${params.length}`; }
    let personFilter = '';
    const perid = Number(opts.person_id);
    if (Number.isFinite(perid)) { params.push(perid); personFilter = ` AND e.person_id = $${params.length}`; }
    // Janela: from/to (YYYY-MM-DD NY) tem prioridade; senão rolling de N dias.
    const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    const from = ymd(opts.from); const to = ymd(opts.to);
    let dateFilter;
    if (from || to) {
      const lo = from || to; const hi = to || from;
      params.push(lo); const pLo = params.length;
      params.push(hi); const pHi = params.length;
      dateFilter = ` AND (e.started_at AT TIME ZONE 'America/New_York')::date BETWEEN $${pLo} AND $${pHi}`;
    } else {
      dateFilter = ` AND e.started_at > NOW() - INTERVAL '${days} days'`;
    }
    let rows = [];
    try {
      const r = await this.db.query(
        `SELECT pb.product_id, pr.canonical_name AS product, pb.batch_number,
                p.id AS operator_id, p.display_name AS operator, pb.units_per_bottle, pb.target_bottles,
                ${WORK_SEC} AS work_sec, e.ended_at
         FROM v3.events e
         JOIN v3.activity_types at ON at.id = e.activity_type_id AND at.slug = 'review'
         JOIN v3.persons p ON p.id = e.person_id
         JOIN v3.product_batches pb ON pb.id = e.product_batch_id
         LEFT JOIN v3.products pr ON pr.id = pb.product_id
         WHERE e.ended_at IS NOT NULL AND e.deleted_at IS NULL
           AND pb.units_per_bottle IS NOT NULL AND pb.target_bottles IS NOT NULL AND pb.target_bottles > 0${prodFilter}${personFilter}${dateFilter}
         ORDER BY e.ended_at DESC LIMIT 300`, params);
      rows = r.rows;
    } catch (e) { /* sem dados de revisão / colunas ausentes → vazio */ }
    const runs = rows.map((x) => {
      const bottles = Number(x.target_bottles);
      const caps = bottles * Number(x.units_per_bottle);
      const sec = Number(x.work_sec) || 0;
      return {
        product_id: x.product_id || null, product: x.product || 'Sem produto vinculado',
        batch: x.batch_number || null, operator_id: x.operator_id || null, operator: x.operator || null,
        bottles, capsules: caps, work_sec: Math.round(sec),
        ended_at: toNyIso(x.ended_at),
        capsules_per_sec: sec > 0 ? +(caps / sec).toFixed(2) : null,
        bottles_per_min: sec > 0 ? +(bottles / (sec / 60)).toFixed(1) : null,
        sec_per_bottle: sec > 0 && bottles > 0 ? +(sec / bottles).toFixed(1) : null,
      };
    }).filter((x) => x.capsules_per_sec != null && x.work_sec >= 30); // ignora ruído < 30s
    const avg = (arr, k, dp) => (arr.length ? +(arr.reduce((a, x) => a + (x[k] || 0), 0) / arr.length).toFixed(dp) : null);
    const groupAvg = (keyId, keyName) => {
      const m = new Map();
      for (const run of runs) {
        const key = run[keyId] || 0;
        if (!m.has(key)) m.set(key, { [keyId]: run[keyId], [keyName]: run[keyName], _runs: [] });
        m.get(key)._runs.push(run);
      }
      return [...m.values()].map((g) => ({
        [keyId]: g[keyId], [keyName]: g[keyName], n: g._runs.length,
        avg_capsules_per_sec: avg(g._runs, 'capsules_per_sec', 2),
        avg_bottles_per_min: avg(g._runs, 'bottles_per_min', 1),
        avg_sec_per_bottle: avg(g._runs, 'sec_per_bottle', 1),
      })).sort((a, b) => b.n - a.n);
    };
    // Agrega POR PRODUTO e POR PESSOA (médias) — o que o Bruno pediu.
    const products = groupAvg('product_id', 'product');
    const operators = groupAvg('operator_id', 'operator');
    return {
      range_days: (from || to) ? null : days,
      scope: (from || to) ? `${from || to}..${to || from}` : `${days}d`,
      from: from || null, to: to || null,
      n: runs.length,
      avg_capsules_per_sec: avg(runs, 'capsules_per_sec', 2),
      avg_bottles_per_min: avg(runs, 'bottles_per_min', 1),
      avg_sec_per_bottle: avg(runs, 'sec_per_bottle', 1),
      products,
      operators,
      runs: runs.slice(0, 80),
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
