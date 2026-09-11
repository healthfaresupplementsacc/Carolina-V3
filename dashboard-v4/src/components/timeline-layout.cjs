'use strict';
/**
 * TIMELINE — LAYOUT PURO (Bruno 09-10, estudo S03-TIMELINE-REDESIGN-STUDY).
 *
 * Tudo que decide "onde e como desenhar" sem tocar no DOM, pra ser testado
 * (src/__tests__/timeline-layout.test.js) e reusado pelo Timeline.jsx.
 *
 * Regras que vieram do feedback do Bruno sobre o protótipo:
 *  - NOME e TEMPO em todo registro, de relance. A letra encolhe (11.5 → 10.5 →
 *    9.5 px) e quebra em duas linhas; se ainda não cabe, o rótulo SAI do bloco
 *    (calha acima) com a duração ao lado. Nunca "…" no meio da palavra.
 *  - Máquina/lote acompanhado (encapsulação, pesagem, mix, separação, formulação,
 *    impressão de labels) = ABA fina com nome · lote · duração, não bloco cheio.
 *  - Registros de < 2 min (reinício do kiosk) = tique, não bloco.
 *  - Registros iguais no mesmo horário (mesma atividade, ≥ 90% sobrepostos)
 *    = um bloco com "×N" pra quem edita decidir.
 *  - Sobreposição REAL de duas tarefas de mão = dividem a faixa (empacota
 *    dentro do cluster, como o Google Agenda), nunca cresce a linha inteira.
 */

/* Nomes curtos por atividade. Quando o Bruno aprovar `short_name` no cadastro,
   este mapa vira fallback. */
const SHORT = {
  production_line: 'Linha', encapsulation: 'Encaps.', label_printing: 'Labels', order_printing: 'Ordens',
  order_printing_2: '2ª Ordens', packaging: 'Empacot.', stock_organization: 'Estoque', line_changeover: 'Setup',
  formulation_other: 'Outro (form.)', production_line_other: 'Outro (linha)', cleaning_other: 'Outro (limp.)',
  packaging_other: 'Outro (emb.)', shipping_other: 'Outro (envio)', cleaning: 'Limpeza', review: 'Revisão',
  weighing: 'Pesagem', separating: 'Separando', mixing: 'Mix', lunch: 'Almoço', break: 'Pausa', counting: 'Contagem',
  shipping: 'Envio', clinic_shipment: 'Envio clínica', box_closing: 'Caixas', fnsku_labeling: 'FNSKU',
  special_task: 'Especial', formulation: 'Formulação', labeling: 'Etiquet.', repair: 'Conserto',
  organization: 'Organiz.', training: 'Treino', meeting: 'Reunião', marketplace_prep: 'Prep. mkt',
  dc_shipment: 'Envio DC', shipping_walmart: 'Envio Walmart', shipping_amazon: 'Envio Amazon',
  label_change: 'Troca label', label_repair: 'Cons. label', facility_maintenance: 'Manutenção',
  machine_downtime: 'Downtime', material_handling: 'Carga/desc.', end_of_day: 'Fim',
};
/* Processos que a pessoa ACOMPANHA (rodam sozinhos): viram aba, não bloco.
   `is_background` do cadastro também conta. label_printing entra por decisão
   do estudo (9 de 11 "SIMULTÂNEO" do dia 09-09 eram Linha + Labels). */
const RAIL_SLUGS = new Set(['encapsulation', 'weighing', 'mixing', 'separating', 'formulation', 'label_printing']);
/* Não é trabalho: neutro hachurado, nunca conta como "simultâneo". */
const NEUTRAL = new Set(['lunch', 'break', 'pausa', 'end_of_day']);

const shortName = (slug, fullName) => SHORT[slug] || fullName || slug;
const isRail = (ev) => !!(ev && (ev._is_background || RAIL_SLUGS.has(ev.activity)));
const isNeutral = (ev) => !!(ev && NEUTRAL.has(ev.activity));

/** Duração amigável: 1h05 · 45m. */
function fmtDurShort(min) {
  const m = Math.max(0, Math.round(min));
  if (m >= 60) { const h = Math.floor(m / 60), r = m % 60; return h + 'h' + (r ? String(r).padStart(2, '0') : ''); }
  return m + 'm';
}

/** Registros iguais (mesma atividade, ≥ 90% sobrepostos) viram um com `dupes`. */
function collapseDupes(list, effEnd) {
  const out = [];
  for (const e of list.slice().sort((a, b) => a.started_min - b.started_min)) {
    const len = effEnd(e) - e.started_min;
    const prev = len > 0 ? out.find((o) => o.activity === e.activity &&
      Math.min(effEnd(o), effEnd(e)) - Math.max(o.started_min, e.started_min) >= 0.9 * Math.min(effEnd(o) - o.started_min, len)) : null;
    if (prev) {
      prev.dupes = (prev.dupes || 1) + 1;
      prev.dupe_ids = [...(prev.dupe_ids || [prev.id]), e.id];
      prev.started_min = Math.min(prev.started_min, e.started_min);
      prev.ended_min = (prev.ended_min != null && e.ended_min != null) ? Math.max(prev.ended_min, e.ended_min) : null;
      continue;
    }
    out.push({ ...e });
  }
  return out;
}

/** First-fit de lanes (partição de intervalos). */
function assignLanes(list, effEnd) {
  const sorted = list.slice().sort((a, b) => a.started_min - b.started_min || effEnd(a) - effEnd(b));
  const laneEnds = []; const laneOf = {};
  for (const e of sorted) {
    let lane = laneEnds.findIndex((le) => le <= e.started_min);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(effEnd(e)); } else laneEnds[lane] = effEnd(e);
    laneOf[e.id] = lane;
  }
  return { laneOf, count: Math.max(1, laneEnds.length) };
}

/** Clusters de sobreposição transitiva; lanes só DENTRO do cluster. */
function clusters(list, effEnd) {
  const sorted = list.slice().sort((a, b) => a.started_min - b.started_min);
  const out = []; let cur = null;
  for (const e of sorted) {
    if (cur && e.started_min < cur.end) { cur.items.push(e); cur.end = Math.max(cur.end, effEnd(e)); }
    else { cur = { items: [e], end: effEnd(e) }; out.push(cur); }
  }
  for (const c of out) { const l = assignLanes(c.items, effEnd); c.laneOf = l.laneOf; c.count = l.count; }
  return out;
}

/**
 * Escada de legibilidade do bloco de tarefa.
 *  measure(text, px, kind) → largura em px ('sans' negrito 600 | 'mono' 500).
 *  w = largura útil (sem padding); h = altura do bloco.
 * Devolve { inside, name, px, wrap, line2, prod } ou { inside:false, name }.
 */
function fitLabel({ name, short, w, h, durTxt, prodName, measure }) {
  const twoLines = h >= 34;
  const line2 = h >= 26 && w >= measure(durTxt, 10.5, 'mono') + 2;
  const prod = !!(prodName && line2 && w >= measure(prodName + ' · ' + durTxt, 10.5, 'mono') + 2);
  if (!line2) {
    // bloco baixo (faixa dividida): nome · tempo numa linha só
    for (const px of [11.5, 10.5, 9.5]) { const t = name + ' · ' + durTxt; if (measure(t, px, 'sans') <= w) return { inside: true, name: t, px, line2: false, prod: false }; }
    for (const px of [10.5, 9.5]) { const t = short + ' · ' + durTxt; if (measure(t, px, 'sans') <= w) return { inside: true, name: t, px, line2: false, prod: false }; }
  }
  for (const px of [11.5, 10.5, 9.5]) { if (measure(name, px, 'sans') <= w) return { inside: true, name, px, line2, prod }; }
  if (twoLines && !line2) {
    for (const px of [10.5, 9.5]) {
      const words = name.split(' '); const half = Math.ceil(words.length / 2);
      if (words.length > 1 && Math.max(measure(words.slice(0, half).join(' '), px, 'sans'), measure(words.slice(half).join(' '), px, 'sans')) <= w) return { inside: true, name, px, wrap: true, line2: false, prod: false };
    }
  }
  for (const px of [10.5, 9.5]) { if (measure(short, px, 'sans') <= w) return { inside: true, name: short, px, line2, prod }; }
  // VERTICAL (Bruno 09-11): não coube na horizontal mas o bloco é alto o bastante → texto em pé
  if (w >= 13 && h >= 30) {
    for (const px of [10, 9.5]) {
      const withDur = short + ' ' + durTxt;
      if (measure(withDur, px, 'sans') <= h - 6) return { inside: true, vertical: true, name: withDur, px, line2: false, prod: false };
      if (measure(short, px, 'sans') <= h - 6) return { inside: true, vertical: true, name: short, px, line2: false, prod: false };
    }
  }
  return { inside: false, name: short };
}

/**
 * Rótulo da ABA (máquina/lote). `room` = espaço livre à direita até a próxima
 * aba da mesma lane. Devolve { mode: 'full'|'short_dur'|'short'|'outside'|'none', name, extra }.
 */
function railLabel({ name, short, w, durTxt, prodName, room, measure }) {
  const full = (prodName ? prodName + ' · ' : '') + durTxt;
  const fits = (n, x) => w >= measure(n, 10.5, 'sans') + measure(x, 10.5, 'mono') + 20;
  // escada: nome + lote + tempo → curto + lote + tempo → nome + tempo → curto + tempo
  if (fits(name, full)) return { mode: 'full', name, extra: full };
  if (prodName && fits(short, full)) return { mode: 'full', name: short, extra: full };
  if (fits(name, durTxt)) return { mode: 'short_dur', name, extra: durTxt };
  if (fits(short, durTxt)) return { mode: 'short_dur', name: short, extra: durTxt };
  // fora, à direita: com o lote se houver espaço, senão só curto + tempo
  const outFull = short + (prodName ? ' · ' + prodName : '') + ' ' + durTxt;
  if (prodName && room >= measure(outFull, 10.5, 'mono') + 10) return { mode: 'outside', name: outFull, extra: '' };
  const out = short + ' ' + durTxt;
  if (room >= measure(out, 10.5, 'mono') + 10) return { mode: 'outside', name: out, extra: '' };
  if (w >= 30) return { mode: 'short', name: short, extra: '' };
  return { mode: 'none', name: '', extra: '' };
}

/** Buracos ≥ minGap entre tarefas de mão consecutivas (já sem pausas). */
function gapsBetween(sortedReal, effEnd, minGap) {
  const zones = [];
  for (let i = 0; i < sortedReal.length - 1; i++) {
    const end = effEnd(sortedReal[i]); const g = sortedReal[i + 1].started_min - end;
    if (g >= minGap) zones.push({ start: end, end: sortedReal[i + 1].started_min, dur: g, after_id: sortedReal[i].id, before_id: sortedReal[i + 1].id });
  }
  return zones;
}

/** Métricas verticais da linha da pessoa. */
function rowMetrics({ railLanes, hourPx }) {
  const RAIL_H = 18, RAIL_GAP = 3, GUTTER = 15;
  const LANE_H = hourPx >= 150 ? 46 : 42;
  const railsTop = 6;
  const gutterTop = railsTop + railLanes * (RAIL_H + RAIL_GAP) + (railLanes ? 2 : 0);
  const laneTop = gutterTop + GUTTER;
  return { RAIL_H, RAIL_GAP, GUTTER, LANE_H, railsTop, gutterTop, laneTop, rowH: laneTop + LANE_H + 8 };
}

/**
 * Parte "o que desenhar" de uma pessoa: abas (com lane), tarefas de mão
 * (com cluster/lane), tiques, buracos. `events` já no shape do adapter.
 */
function layoutPerson(events, { now, dayEnd }) {
  const effEnd = (e) => (e.ended_min == null ? Math.min(now, dayEnd) : e.ended_min);
  const valid = events.filter((e) => e.started_min != null);
  const rails = collapseDupes(valid.filter(isRail), effEnd).filter((e) => effEnd(e) - e.started_min >= 2);
  const rl = assignLanes(rails, effEnd);
  for (const r of rails) r._lane = Math.min(rl.laneOf[r.id] || 0, 3);
  const hands = collapseDupes(valid.filter((e) => !isRail(e)), effEnd);
  const ticks = hands.filter((e) => e.ended_min != null && effEnd(e) - e.started_min < 2);
  const real = hands.filter((e) => !(e.ended_min != null && effEnd(e) - e.started_min < 2)).sort((a, b) => a.started_min - b.started_min);
  // 09-11: almoço/pausa ENTRAM nos clusters (antes ficavam por cima de tarefa que os atravessava)
  const cls = clusters(real, effEnd);
  const neutral = real.filter(isNeutral);
  return { rails, railLanes: rails.length ? Math.min(4, rl.count) : 0, real, ticks, clusters: cls, neutral, gaps: gapsBetween(real, effEnd, 15), effEnd };
}

/**
 * CALOR (Bruno 09-11): quanto uma tarefa AO VIVO já passou do esperado.
 *  expected = ajuste da pessoa (pref) → cadastro (act.expected) → média das
 *  concluídas da mesma atividade no dia (≥ 3) → null (sem sinal).
 *  Devolve 0..4: 0 azul (<50 %), 1 verde (<85 %), 2 amarelo (<100 %),
 *  3 laranja (<130 %), 4 vermelho + fogo (≥ 130 %).
 */
function expectedFor(slug, { prefMin, actMin, events, effEnd }) {
  if (prefMin > 0) return prefMin;
  if (actMin > 0) return actMin;
  const done = (events || []).filter((e) => e.activity === slug && e.ended_min != null && effEnd(e) - e.started_min >= 2);
  if (done.length >= 3) return done.reduce((a, e) => a + (effEnd(e) - e.started_min), 0) / done.length;
  return null;
}
function heatLevel(elapsedMin, expectedMin) {
  if (!expectedMin || expectedMin <= 0) return null;
  const r = elapsedMin / expectedMin;
  return r < 0.5 ? 0 : r < 0.85 ? 1 : r < 1 ? 2 : r < 1.3 ? 3 : 4;
}
/** Marca ao terminar: 'fast' (≤ 90 % do esperado) · 'ok' · 'slow' (≥ 120 %). */
function doneMark(durMin, expectedMin) {
  if (!expectedMin || expectedMin <= 0) return null;
  const r = durMin / expectedMin;
  return r <= 0.9 ? 'fast' : r >= 1.2 ? 'slow' : 'ok';
}

module.exports = { expectedFor, heatLevel, doneMark, SHORT, RAIL_SLUGS, NEUTRAL, shortName, isRail, isNeutral, fmtDurShort, collapseDupes, assignLanes, clusters, fitLabel, railLabel, gapsBetween, rowMetrics, layoutPerson };
