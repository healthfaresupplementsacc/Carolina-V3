'use strict';
/**
 * HEALTHFARE V4 — adapter puro: payloads de /api/v3/data/* → shape HFData
 * que o template do redesign espera. Sem React, sem fetch — só transformação.
 *
 * Dual-loadable: CommonJS aqui (.cjs), pra ser require()'d pelo teste do Jest;
 * o wrapper ESM `from-api.js` importa este módulo via Vite (interop default).
 *
 * Decisões de mapping (versão E2):
 *   - operators[].id      = "p<person_id>"  (string estável)
 *   - products[<key>]     = "b<batch_id>"   (chave do lote do dia)
 *   - activities[<slug>]  = slug do activity_type (fonte: catálogo + events)
 *   - events[].started_min/ended_min = minutos desde 00:00 NY (parsed do ISO)
 *   - events[].cowork     = ["p<id>", ...] (mapeia cowork_with)
 *   - operators.c1/c2     = paleta determinística por person_id
 *   - DEADLINE_MIN        = HH:MM mais cedo dos deadlines ativos (1º corte do dia)
 *   - alerts              = derivado de duplicatas + invalid + downtime + open
 *
 * Tudo o que é DERIVADO (overrun, ao-vivo) fica pro render-time com `now`.
 */

const FLOWS = {
  production: { color: 'var(--flow-prod)',    color2: 'var(--flow-prod-2)',    label: 'Produção', en: 'Production' },
  pnp:        { color: 'var(--flow-pnp)',     color2: 'var(--flow-pnp-2)',     label: 'P&P',      en: 'Pick & Pack' },
  support:    { color: 'var(--flow-support)', color2: 'var(--flow-support-2)', label: 'Suporte',  en: 'Support' },
  meta:       { color: 'var(--hf-leaf-500)',  color2: 'var(--hf-leaf-600)',    label: 'Meta',     en: 'Goal' },
};

// Paleta determinística por person_id — 8 pares fixos pra estabilidade visual.
const PALETTE = [
  ['#1e3f8c', '#3fc874'],
  ['#22b35d', '#18934c'],
  ['#7c5cd6', '#a98be8'],
  ['#2855ad', '#4a74c2'],
  ['#18934c', '#22b35d'],
  ['#d97706', '#7c5cd6'],
  ['#0ea5e9', '#22b35d'],
  ['#1e3f8c', '#22b35d'],
];

function colorPair(personId) {
  const n = Number(personId) || 0;
  const i = ((n % PALETTE.length) + PALETTE.length) % PALETTE.length;
  return PALETTE[i];
}

/** "Bruno Sarmento" → "BS". 1 letra se só 1 palavra. */
function initials(name) {
  const w = String(name || '?').trim().split(/\s+/);
  return ((w[0] || '?')[0] + (w[1] ? w[1][0] : '')).toUpperCase();
}

/** ISO com offset NY (ex.: "2026-05-25T08:35:00-04:00") → minuto-do-dia (0..1439). */
function isoToNyMin(iso) {
  if (!iso) return null;
  const s = String(iso);
  const h = Number(s.slice(11, 13));
  const m = Number(s.slice(14, 16));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/** "HH:MM" → minuto-do-dia. Aceita também "HH:MM:SS". null se inválido. */
function hhmmToMin(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/** "Mix & Formulação" → "mix_formulacao" (slug pra activities sem slug). */
function slugify(s) {
  return String(s || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unknown';
}

/**
 * Pure mapper. Recebe payloads brutos da API, devolve shape HFData do V4.
 *
 * @param {object} input — qualquer campo pode vir null/undefined (treated as empty).
 *   timeline:   /api/v3/data/timeline    → { date, people: [...] }
 *   production: /api/v3/data/production  → { date, lotes: [...] }
 *   pp:         /api/v3/data/pp          → { total_seconds, orders, ... }
 *   support:    /api/v3/data/support     → { occurrences: [...] }   (opcional)
 *   goals:      /api/v3/data/goals       → { goals: [...] }
 *   counts:     /api/v3/data/counts      → { counts: [...], totals_by_product }
 *   deadlines:  /api/v3/data/deadlines   → { deadlines: [...] }
 *   catalog:    { persons, activity_types, products } (opcional, mas recomendado)
 *   date:       'YYYY-MM-DD' do dia consultado
 *
 * @returns {object} HFData-shape (compatível com o template V4).
 */
function adaptToHFData(input) {
  const {
    timeline = null, production = null, pp = null, support = null,
    goals = null, /* counts = null, */ deadlines = null, review = null, catalog = {}, date = null,
  } = input || {};

  // ── 1. Operators ──────────────────────────────────────────
  // Regra E7: timeline.people é a fonte ÚNICA — quem postou evento HOJE.
  // Isso filtra admins automaticamente (admins nunca autoram event, então
  // nunca aparecem em v3.events → nunca em timeline.people). Bruno Camp e
  // Thassio são admins; Vitor, Simone, Ana, Bruno Sarmento são operadores.
  // catalog.persons foi removido daqui de propósito — antes adicionava TODO
  // mundo do catálogo, incluindo admins. (Continua disponível pra dropdowns
  // futuros via _meta.has_catalog se precisar.)
  const opMap = new Map();
  for (const p of ((timeline && timeline.people) || [])) {
    if (!opMap.has(p.person_id)) {
      opMap.set(p.person_id, { id: p.person_id, name: p.display_name || ('Pessoa ' + p.person_id), role: p.role || '—' });
    }
  }
  const operators = [...opMap.values()].map((o) => {
    const [c1, c2] = colorPair(o.id);
    return {
      id: 'p' + o.id,           // string id estável; template assume string
      _person_id: o.id,
      short: initials(o.name),
      name: o.name,
      role: o.role,
      en_role: o.role,          // tradução fica pra B5+
      c1, c2,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'pt'));

  // ── 2. Products (do dia, keyed por b<batch_id>) ──────────
  const products = {};
  const lotes = (production && production.lotes) || [];
  for (const l of lotes) {
    if (l.batch_id != null) {
      products['b' + l.batch_id] = {
        name: (l.product && l.product.canonical_name) || '(produto)',
        batch: l.batch_number || '(sem nº)',
        category: (l.product && l.product.category) || '',
        _batch_id: l.batch_id,
        _product_id: (l.product && l.product.id) || null,
      };
    }
  }

  // ── 3. Activities (catálogo + inferido dos events) ──────
  const activities = {};
  for (const a of ((catalog && catalog.activity_types) || [])) {
    const slug = a.slug || slugify(a.display_name);
    activities[slug] = {
      name: a.display_name || slug,
      en: a.display_name || slug,
      flow: a.flow || 'support',
      expected: null,           // catalog não traz expected_seconds; vem do event
      _id: a.id,
      _phase_order: a.phase_order,
      _category: a.category || null,
    };
  }

  // ── 4. Events (flat array, normalizado) ─────────────────
  const events = [];
  for (const p of ((timeline && timeline.people) || [])) {
    for (const ev of (p.events || [])) {
      const a = ev.activity || null;
      const slug = a ? (a.slug || slugify(a.display_name)) : 'unknown';
      // garante entrada em activities, mesmo sem catálogo
      if (!activities[slug]) {
        activities[slug] = {
          name: a ? (a.display_name || slug) : 'Desconhecido',
          en: a ? (a.display_name || slug) : 'Unknown',
          flow: ev.flow || (a && a.flow) || 'support',
          expected: a && a.expected_seconds != null ? Math.round(a.expected_seconds / 60) : null,
          _id: a ? a.id : null,
          _phase_order: a ? a.phase_order : null,
          _category: a ? (a.category || null) : null,
        };
      } else if (a && a.expected_seconds != null && activities[slug].expected == null) {
        // catálogo não tinha expected; preenche do event
        activities[slug].expected = Math.round(a.expected_seconds / 60);
      }
      events.push({
        id: ev.event_id,
        op: 'p' + p.person_id,
        started_min: isoToNyMin(ev.started_at),
        ended_min: ev.ended_at ? isoToNyMin(ev.ended_at) : null,
        activity: slug,
        product: ev.product_batch_id != null ? ('b' + ev.product_batch_id) : null,
        cowork: (ev.cowork_with || []).map((id) => 'p' + id),
        qty: ev.quantity != null ? Number(ev.quantity) : null,
        unit: ev.quantity_unit || null,
        description: ev.description || '',
        confidence: ev.confidence || 'high',
        overrun: false,          // calculado em render com `now`
        _flow: ev.flow || (a && a.flow) || 'support',
        _is_background: !!(a && a.is_background),
        _phase_label: ev.phase_label || null,
        _started_at: ev.started_at,
        _ended_at: ev.ended_at,
        _source_message_ts: ev.source_message_ts || null,
        _expected_seconds: a && a.expected_seconds != null ? a.expected_seconds : null,
      });
    }
  }

  // ── 5. Goals (V3 shape → V4 shape) ──────────────────────
  const goalsList = (goals && goals.goals) || [];
  const adaptedGoals = goalsList.map((g) => {
    // V4 espera 'product' como chave de products[]; usamos o batch quando
    // resolve, senão o product_id puro como fallback identificador.
    const productKey = g.batch_id != null
      ? ('b' + g.batch_id)
      : (g.product && g.product.id ? ('product_' + g.product.id) : null);
    const esperado = Number(g.esperado || g.expected_quantity || 0);
    const realizado = Number(g.realizado || g.actual_total || 0);
    return {
      id: g.goal_id || g.id,
      product: productKey,
      _product_name: g.product && g.product.canonical_name ? g.product.canonical_name : null,
      _batch_number: g.batch_number || null,
      target: esperado,
      done: realizado,
      started_min: null,       // V3 não persiste; fica pro client deduzir do timeline
      unit: g.unit || 'bottle',
      completed: g.bateu === true || (esperado > 0 && realizado >= esperado),
      pct: g.pct_atingido != null ? g.pct_atingido : (esperado > 0 ? Math.round((realizado / esperado) * 100) : 0),
      duplicatas_suspeitas: g.duplicatas_suspeitas || [],
    };
  });

  // ── 6. Alerts (Atenção) ─────────────────────────────────
  const dupCount = goalsList.reduce((s, g) => s + ((g.duplicatas_suspeitas || []).length), 0);
  const invalidCount = lotes.reduce((s, l) => s + (l.invalid_event_count || 0), 0)
    + ((pp && pp.invalid_event_count) || 0);
  // Bug #1 bloco 29/mai: agora coletamos o array detalhado (production +
  // pp), não só o count agregado. Permite listar por id/pessoa/hora/razão
  // na notif e destacar na timeline.
  const invalidEvents = [
    ...(((production && production.invalid_events) || [])),
    ...(((pp && pp.invalid_events) || [])),
  ];
  const supOccurrences = (support && support.occurrences) || [];
  const downtimeCount = supOccurrences.filter((o) => o.is_downtime).length;
  const openCount = events.filter((e) => e.ended_min == null).length;

  const alerts = [];
  if (dupCount)      alerts.push({ id: 'dup',  severity: 'warn', title: 'Duplicatas suspeitas', en: 'Suspected duplicates', detail: dupCount + ' contagem(ns) marcadas pelo LLM' });
  if (invalidCount)  alerts.push({
    id: 'inv',  severity: 'warn', title: 'Eventos inválidos', en: 'Invalid events',
    detail: invalidCount + ' event(s) com duração ruim',
    _invalid_events: invalidEvents,   // lista detalhada pra notif renderizar
  });
  if (downtimeCount) alerts.push({ id: 'down', severity: 'bad',  title: 'Downtime',              en: 'Downtime',             detail: downtimeCount + ' parada(s) registrada(s)' });
  if (openCount)     alerts.push({ id: 'open', severity: 'info', title: 'Eventos em andamento', en: 'Open events',          detail: openCount + ' em curso' });

  // ── 7. PP block ─────────────────────────────────────────
  const ppBlock = {
    total_minutes: pp && pp.total_seconds != null ? Math.round(pp.total_seconds / 60) : 0,
    orders: (pp && pp.orders) || 0,
    seconds_per_order: (pp && pp.seconds_per_order) || 0,
    deadline_min: null,
    _raw: pp,
  };

  // ── 8. Deadlines → primary DEADLINE_MIN ─────────────────
  // V4 só tem 1 deadline visual no Hoje. Pega o mais cedo do dia que
  // ainda tenha time_of_day setado. Se nada, fica null → CountdownCard
  // pode esconder ou cair pra placeholder. 3 envios completos ficam pro
  // adapter do P&P/Producao depois (E7).
  const dlList = (deadlines && deadlines.deadlines) || [];
  let primaryDeadlineMin = null;
  for (const d of dlList) {
    if (d.active === false) continue;
    const m = hhmmToMin(d.time_of_day);
    if (m == null) continue;
    if (primaryDeadlineMin == null || m < primaryDeadlineMin) primaryDeadlineMin = m;
  }
  ppBlock.deadline_min = primaryDeadlineMin;

  // ── 9. Janela do dia + NOW snapshot ─────────────────────
  // 08:00–18:00 default (template original). TODO E7+: ler
  // expedient_*_hour_ny do /api/v3/data/settings quando o endpoint existir.
  const DAY_START = 8 * 60;
  const DAY_END = 18 * 60;
  // E7 bugfix: NÃO fabrica deadline quando não há um real. Antes caía em
  // 16:00 (4 PM) hardcoded → combinado com a linha .tl-deadline no template
  // (label "📮 Correio · 4:00 PM" escrita à mão no CSS) renderizava uma faixa
  // laranja FALSA na primeira lane (Ana). Correio agora é só do P&P card.
  const DEADLINE_MIN = primaryDeadlineMin;  // pode ser null — Timeline ignora
  // NOW_MIN: snapshot inicial pra retro-compat. O componente tika via helpers.useNow().
  let NOW_MIN = 12 * 60;
  try {
    const s = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
    }).format(new Date());
    NOW_MIN = Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  } catch (_) { /* fica em 12*60 */ }

  // ── 10. Per-person gaps (idle vs unreported) ────────────
  const tlPeople = (timeline && timeline.people) || [];
  const gaps = {};
  for (const p of tlPeople) {
    gaps['p' + p.person_id] = {
      idle_seconds: p.idle_seconds || 0,
      unreported_seconds: p.unreported_seconds || 0,
      unreported_since: p.unreported_since || null,
    };
  }

  // ── Produção (canônico) — garrafas do dia vindas de production_counts via /production ──
  const prodLotes = (production && production.lotes) || [];
  const productionBlock = {
    total_bottles: (production && production.total_bottles != null)
      ? production.total_bottles
      : prodLotes.reduce((s, l) => s + (Number(l.bottles) || 0), 0),
    lotes: prodLotes.map((l) => {
      const sec = Number(l.total_seconds) || 0;
      const bottles = Number(l.bottles) || 0;
      return {
        batch_number: l.batch_number,
        product: (l.product && l.product.canonical_name) || l.product || '(produto)',
        bottles, total_seconds: l.total_seconds,
        bottles_per_min: l.bottles_per_min != null ? l.bottles_per_min : (sec > 0 ? +(bottles / (sec / 60)).toFixed(1) : null),
        bottles_per_sec: sec > 0 ? +(bottles / sec).toFixed(2) : null,
      };
    }),
    _raw: production,
  };

  // ── Revisão (histórico) — cápsulas/seg + frascos/min + média por produto ──
  const reviewBlock = review ? {
    range_days: review.range_days || null,
    n: review.n || 0,
    avg_capsules_per_sec: review.avg_capsules_per_sec != null ? review.avg_capsules_per_sec : null,
    avg_bottles_per_min: review.avg_bottles_per_min != null ? review.avg_bottles_per_min : null,
    avg_sec_per_bottle: review.avg_sec_per_bottle != null ? review.avg_sec_per_bottle : null,
    products: review.products || [],
    runs: review.runs || [],
  } : { range_days: null, n: 0, avg_capsules_per_sec: null, avg_bottles_per_min: null, avg_sec_per_bottle: null, products: [], runs: [] };

  return {
    DAY_START, DAY_END, NOW_MIN, DEADLINE_MIN,
    operators, products, activities, FLOWS,
    events, goals: adaptedGoals, alerts, pp: ppBlock, production: productionBlock, review: reviewBlock,
    _gaps: gaps,
    _meta: {
      date,
      source: 'api',
      has_timeline: !!timeline,
      has_production: !!production,
      has_pp: !!pp,
      has_goals: !!goals,
      has_deadlines: !!deadlines,
      has_catalog: !!(catalog && (catalog.persons || catalog.activity_types)),
    },
  };
}

module.exports = {
  adaptToHFData,
  FLOWS,
  PALETTE,
  colorPair,
  initials,
  isoToNyMin,
  hhmmToMin,
  slugify,
};
