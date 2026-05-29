'use strict';
/**
 * V4 — day-stats: cálculos do "Resumo do dia" em conceitos do negócio.
 * Pure functions, sem React/DOM. CJS pra ser testável com Jest (igual adapter).
 *
 * Por que esses helpers existem (28/mai/2026):
 *  O código antigo do Resumo somava (ended - started) de cada evento, ignorando
 *  sobreposição (fg+bg em paralelo, lunch dentro de bg, múltiplas pessoas em
 *  cowork). Resultado: Bruno 17h52 quando real era 10h23; Produção 28h50 quando
 *  real era 10h58. Solução: trabalhar com UNIÃO de intervalos (wall-clock) e
 *  expressar métricas como conceitos do negócio (presença, ativo, parada,
 *  efetivo, etc), não como soma de eventos.
 *
 * Convenções:
 *  - eventos têm shape do adapter V4: { op, started_min, ended_min, activity,
 *    cowork, _is_background, _flow, ... }; started_min/ended_min são minutos
 *    desde 00:00 NY (0..1439). ended_min null = LIVE.
 *  - `now` = minuto-do-dia NY atual.
 *  - `activities` = map slug → { name, flow, category, ... } (do adapter).
 */

// Slugs canônicos (vêm de v3.activity_types).
const BREAK_SLUGS = new Set(['lunch', 'break']);
const STOPPAGE_SLUGS = new Set(['machine_downtime', 'line_changeover', 'facility_maintenance', 'repair']);
const EOD_SLUG = 'end_of_day';

/** Helper interno: clamps a duração de um evento na janela [0, 1440]. Eventos
 *  com end <= start retornam null. */
function evIv(e, now) {
  if (e.started_min == null) return null;
  const end = e.ended_min == null ? now : e.ended_min;
  if (!Number.isFinite(end) || end <= e.started_min) return null;
  return [e.started_min, end];
}

/**
 * mergeIntervals(intervals) — União de intervalos numéricos.
 * Devolve { merged: [[a,b], ...], total: Number } onde merged é a forma
 * normalizada (não-sobreposta, ordenada) e total = sum(b - a).
 */
function mergeIntervals(intervals) {
  const valid = (intervals || [])
    .filter((iv) => iv && Number.isFinite(iv[0]) && Number.isFinite(iv[1]) && iv[1] > iv[0])
    .map(([a, b]) => [a, b])
    .sort((a, b) => a[0] - b[0]);
  if (valid.length === 0) return { merged: [], total: 0 };
  const merged = [valid[0].slice()];
  for (let i = 1; i < valid.length; i++) {
    const last = merged[merged.length - 1];
    if (valid[i][0] <= last[1]) last[1] = Math.max(last[1], valid[i][1]);
    else merged.push(valid[i].slice());
  }
  const total = merged.reduce((s, [a, b]) => s + (b - a), 0);
  return { merged, total };
}

/**
 * subtractIntervals(base, sub) — Subtrai `sub` de `base`. Os dois são listas
 * de intervalos numéricos (não precisam estar merged). Retorna { merged, total }
 * com a diferença normalizada.
 */
function subtractIntervals(base, sub) {
  const merged = mergeIntervals(base).merged;
  const subMerged = mergeIntervals(sub).merged;
  if (subMerged.length === 0) {
    const total = merged.reduce((s, [a, b]) => s + (b - a), 0);
    return { merged, total };
  }
  const result = [];
  for (const [a, b] of merged) {
    let cuts = [[a, b]];
    for (const [sa, sb] of subMerged) {
      const next = [];
      for (const [ca, cb] of cuts) {
        if (sb <= ca || sa >= cb) { next.push([ca, cb]); continue; }
        if (sa > ca) next.push([ca, sa]);
        if (sb < cb) next.push([sb, cb]);
      }
      cuts = next;
    }
    for (const c of cuts) result.push(c);
  }
  const total = result.reduce((s, [a, b]) => s + (b - a), 0);
  return { merged: result, total };
}

/**
 * personPresence(opId, events, now) — Janela de presença e tempo ativo.
 * Presença = última atividade − primeira atividade (wall-clock).
 * Break = união de eventos com slug lunch/break (não soma dobrada).
 * Ativo = presença − break.
 */
function personPresence(opId, events, now) {
  const evs = (events || []).filter((e) => e.op === opId && e.started_min != null);
  if (evs.length === 0) {
    return { firstMin: null, lastMin: null, presenceMin: 0, breakMin: 0, activeMin: 0, breakEvents: [] };
  }
  let firstMin = Infinity;
  let lastMin = -Infinity;
  for (const e of evs) {
    if (e.started_min < firstMin) firstMin = e.started_min;
    const end = e.ended_min == null ? now : e.ended_min;
    if (end > lastMin) lastMin = end;
  }
  const presenceMin = Math.max(0, lastMin - firstMin);
  const breakEvents = evs.filter((e) => BREAK_SLUGS.has(e.activity));
  const { total: breakMin } = mergeIntervals(breakEvents.map((e) => evIv(e, now)).filter(Boolean));
  return { firstMin, lastMin, presenceMin, breakMin, activeMin: Math.max(0, presenceMin - breakMin), breakEvents };
}

/**
 * productionTime(events, now, activities) — Tempo de produção real.
 * wallClock = união dos events com flow=production.
 * stoppage = intersecção das paradas (downtime/changeover/maintenance/repair)
 *            com o wall-clock de produção.
 * effective = wallClock − stoppage.
 */
function productionTime(events, now, activities) {
  const prodEvents = (events || []).filter((e) => {
    const a = activities && activities[e.activity];
    return a && a.flow === 'production';
  });
  const stopEvents = (events || []).filter((e) => STOPPAGE_SLUGS.has(e.activity));
  const prodIvs = prodEvents.map((e) => evIv(e, now)).filter(Boolean);
  const stopIvs = stopEvents.map((e) => evIv(e, now)).filter(Boolean);

  const wallClock = mergeIntervals(prodIvs);
  // Stoppage só conta o pedaço que sobrepõe com produção.
  const stoppageInProd = subtractIntervals(prodIvs, subtractIntervals(prodIvs, stopIvs).merged);
  const effective = subtractIntervals(prodIvs, stopIvs);

  // Breakdown por slug — duração própria do evento (sem clamp à produção).
  const stoppageBySlug = {};
  for (const e of stopEvents) {
    const iv = evIv(e, now);
    if (!iv) continue;
    const dur = iv[1] - iv[0];
    stoppageBySlug[e.activity] = (stoppageBySlug[e.activity] || 0) + dur;
  }
  return {
    wallClockMin: wallClock.total,
    effectiveMin: effective.total,
    stoppageMin: stoppageInProd.total,
    stoppageBySlug,
  };
}

/**
 * supportBreakdown(events, now, activities) — Categoriza suporte por motivo.
 * Cleaning é dividido em "day" (entre fases) vs "eod" (última atividade do op).
 */
function supportBreakdown(events, now /* , activities */) {
  const sumBySlug = (slugSet) => {
    let total = 0;
    for (const e of (events || [])) {
      if (!slugSet.has(e.activity)) continue;
      const iv = evIv(e, now);
      if (iv) total += iv[1] - iv[0];
    }
    return total;
  };
  // cleaning split: eod = cleaning AFTER op's last production event
  let cleaningDay = 0, cleaningEod = 0;
  const byOp = {};
  for (const e of (events || [])) {
    if (e._is_background) continue;
    (byOp[e.op] = byOp[e.op] || []).push(e);
  }
  for (const opEvents of Object.values(byOp)) {
    const sorted = opEvents.slice().sort((a, b) => a.started_min - b.started_min);
    let lastProdEnd = -Infinity;
    for (const e of sorted) {
      if (e._flow === 'production') {
        const end = e.ended_min == null ? now : e.ended_min;
        if (end > lastProdEnd) lastProdEnd = end;
      }
    }
    for (const e of sorted) {
      if (e.activity !== 'cleaning') continue;
      const iv = evIv(e, now);
      if (!iv) continue;
      const dur = iv[1] - iv[0];
      if (e.started_min >= lastProdEnd) cleaningEod += dur;
      else cleaningDay += dur;
    }
  }
  return {
    cleaningDay,
    cleaningEod,
    cleaningTotal: cleaningDay + cleaningEod,
    organization: sumBySlug(new Set(['organization'])),
    maintenance:  sumBySlug(new Set(['facility_maintenance', 'repair'])),
    materialHandling: sumBySlug(new Set(['material_handling'])),
    clinic:       sumBySlug(new Set(['clinic_shipment'])),
    meeting:      sumBySlug(new Set(['meeting'])),
    training:     sumBySlug(new Set(['training'])),
    downtime:     sumBySlug(new Set(['machine_downtime'])),
  };
}

/**
 * idleRanking(events, now, operators, threshold=25) — quem ficou mais
 * tempo sem reportar durante a janela de presença. Gap = intervalo sem
 * nenhum evento (fg/bg) entre eventos consecutivos do op.
 */
function idleRanking(events, now, operators, threshold = 25) {
  const out = [];
  for (const op of (operators || [])) {
    const evs = (events || []).filter((e) => e.op === op.id && e.started_min != null);
    if (evs.length === 0) continue;
    const ivs = evs.map((e) => evIv(e, now)).filter(Boolean);
    const { merged } = mergeIntervals(ivs);
    let idleMin = 0;
    let gapsCount = 0;
    for (let i = 1; i < merged.length; i++) {
      const gap = merged[i][0] - merged[i - 1][1];
      if (gap >= threshold) { idleMin += gap; gapsCount++; }
    }
    out.push({
      opId: op.id, opShort: op.short, opName: op.name, opC1: op.c1,
      idleMin, gapsCount,
    });
  }
  return out.sort((a, b) => b.idleMin - a.idleMin);
}

/**
 * openTasksByOp(events, operators) — quantas tarefas LIVE (sem F) cada
 * pessoa tem. Exclui end_of_day (não precisa "fechar").
 */
function openTasksByOp(events, operators) {
  const byOp = {};
  for (const e of (events || [])) {
    if (e.ended_min != null) continue;
    if (e.activity === EOD_SLUG) continue;
    byOp[e.op] = (byOp[e.op] || 0) + 1;
  }
  return Object.entries(byOp).map(([opId, count]) => {
    const op = (operators || []).find((o) => o.id === opId);
    return {
      opId, count,
      opShort: op ? op.short : '?',
      opName: op ? op.name : '?',
      opC1: op ? op.c1 : 'var(--text-3)',
    };
  }).sort((a, b) => b.count - a.count);
}

/**
 * coworkStats(events) — quantos events colaborativos (cowork não-vazio).
 */
function coworkStats(events) {
  let total = 0;
  const byOp = {};
  for (const e of (events || [])) {
    if (e.cowork && e.cowork.length > 0) {
      total++;
      byOp[e.op] = (byOp[e.op] || 0) + 1;
    }
  }
  return { total, byOp };
}

/**
 * lotesEnriched(rawLotes, events, products) — enriquece os lotes do
 * /production com a fase ATUAL (último event production no lote) e cowork
 * (todos os ops que tocaram o lote no dia).
 */
function lotesEnriched(rawLotes, events) {
  const lotes = (rawLotes || []).map((l) => {
    if (l.batch_id == null) return null;
    const pKey = 'b' + l.batch_id;
    const lotEvents = (events || []).filter((e) => e.product === pKey && e._flow === 'production');
    // fase atual = slug do último event production cronologicamente
    let lastEv = null;
    for (const e of lotEvents) {
      if (!lastEv || e.started_min > lastEv.started_min) lastEv = e;
    }
    const peopleOps = new Set();
    let qty = 0;
    for (const e of lotEvents) {
      peopleOps.add(e.op);
      for (const cw of (e.cowork || [])) peopleOps.add(cw);
      if (e.qty) qty += Number(e.qty) || 0;
    }
    return {
      batch_id: l.batch_id,
      batch_number: l.batch_number,
      product_name: (l.product && l.product.canonical_name) || '(produto)',
      current_phase_slug: lastEv ? lastEv.activity : null,
      total_seconds: l.total_seconds || 0,
      qty,
      people_ops: [...peopleOps],
      is_live: lotEvents.some((e) => e.ended_min == null),
      phases_count: (l.phases || []).length,
    };
  }).filter(Boolean);
  return lotes;
}

module.exports = {
  BREAK_SLUGS, STOPPAGE_SLUGS, EOD_SLUG,
  mergeIntervals, subtractIntervals,
  personPresence, productionTime, supportBreakdown,
  idleRanking, openTasksByOp, coworkStats, lotesEnriched,
};
