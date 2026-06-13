'use strict';
/**
 * HEALTHFARE V3 — Fase 2: análise de tempos por task (últimos 30 dias).
 *
 * READ-ONLY. Standalone (não muda o app). Rodar:
 *   railway run node src/analysis/compute-task-targets.js
 *
 * Saídas:
 *   - analysis_output.json (raiz; gitignored) — consumido pela Fase 5 (task_targets)
 *   - docs/analysis/task-targets-<date>.md — relatório (committed)
 *
 * Ajustes de schema vs prompt (validados no banco real):
 *   - activity_types.display_name (NÃO display_name_pt)
 *   - events NÃO tem bottles_count → bottles vêm de production_counts
 *     (SUM por source_event_id)
 *   - events tem orders_printed, is_long_running, cowork_with[]
 *
 * 3 métodos de target por slug (sobre durations "limpas", sem outliers):
 *   M1 = média dos P25 individuais (operadores com >=3 events) — justo
 *   M2 = P25 do operador mais rápido — puxa todos pra cima
 *   M3 = M2 × 1.15 — ambicioso mas realista (híbrido)
 *   fallback = P25 agregado se ninguém tem dados suficientes
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const EDT = 'America/New_York';

// percentil linear (type-7, igual numpy/excel) sobre array ordenado asc
function pct(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx); const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function std(a) { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); }

function statsOf(durations) {
  const s = durations.slice().sort((a, b) => a - b);
  return {
    count: s.length,
    p25: round1(pct(s, 0.25)), p50: round1(pct(s, 0.5)), p75: round1(pct(s, 0.75)), p95: round1(pct(s, 0.95)),
    mean: round1(mean(s)), std: round1(std(s)),
    min: s.length ? round1(s[0]) : null, max: s.length ? round1(s[s.length - 1]) : null,
    duration_total: round1(s.reduce((a, x) => a + x, 0)),
  };
}

function flagsFor(ev) {
  const f = [];
  const dur = ev.duration_min;
  const endHour = ev.ended_hour;
  if (dur > 300 && endHour === 19) f.push('forgotten_eod');          // >5h e fechou 19:00-19:59
  if (ev.started_min_of_day < 12 * 60 + 30 && ev.ended_min_of_day > 14 * 60 + 30) f.push('cross_lunch_no_pause');
  if (dur > 360) f.push('extreme_outlier');                          // >6h
  if (dur < 1) f.push('spurious');
  return f;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = await pool.query(`
    SELECT e.id, e.person_id, p.display_name AS person_name,
           at.slug, at.display_name AS task_name, at.category,
           pb.batch_number, pr.canonical_name AS product_name,
           to_char(e.started_at AT TIME ZONE '${EDT}','YYYY-MM-DD HH24:MI') AS started_edt,
           to_char(e.ended_at   AT TIME ZONE '${EDT}','YYYY-MM-DD HH24:MI') AS ended_edt,
           EXTRACT(EPOCH FROM (e.ended_at - e.started_at)) / 60.0 AS duration_min,
           EXTRACT(DOW  FROM e.started_at AT TIME ZONE '${EDT}')::int AS day_of_week,
           EXTRACT(HOUR FROM e.started_at AT TIME ZONE '${EDT}')::int AS hour_of_day,
           EXTRACT(HOUR FROM e.ended_at   AT TIME ZONE '${EDT}')::int AS ended_hour,
           (EXTRACT(HOUR FROM e.started_at AT TIME ZONE '${EDT}') * 60 + EXTRACT(MINUTE FROM e.started_at AT TIME ZONE '${EDT}'))::int AS started_min_of_day,
           (EXTRACT(HOUR FROM e.ended_at   AT TIME ZONE '${EDT}') * 60 + EXTRACT(MINUTE FROM e.ended_at   AT TIME ZONE '${EDT}'))::int AS ended_min_of_day,
           e.orders_printed,
           (SELECT COALESCE(SUM(pc.bottles), 0) FROM v3.production_counts pc
             WHERE pc.source_event_id = e.id AND pc.deleted_at IS NULL) AS bottles
    FROM v3.events e
    JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.deleted_at IS NULL AND e.ended_at IS NOT NULL
      AND e.started_at > NOW() - INTERVAL '30 days'
      AND e.is_long_running = false
    ORDER BY at.slug, p.display_name, e.started_at`);

  const rows = q.rows.map((r) => ({
    ...r,
    duration_min: Number(r.duration_min),
    bottles: Number(r.bottles) || 0,
    orders_printed: r.orders_printed == null ? null : Number(r.orders_printed),
  }));
  rows.forEach((r) => { r.flags = flagsFor(r); r.is_clean = r.flags.length === 0; });

  const outliers = rows.filter((r) => !r.is_clean).map((r) => ({
    event_id: r.id, person: r.person_name, slug: r.slug,
    duration_min: round1(r.duration_min), flags: r.flags,
    started_edt: r.started_edt, ended_edt: r.ended_edt,
  }));

  // ── por slug ──────────────────────────────────────────────────────────
  const slugs = {};
  for (const r of rows) {
    const k = r.slug || 'unknown';
    (slugs[k] = slugs[k] || { all: [], clean: [], byOp: {}, task_name: r.task_name, category: r.category, bottles: 0, orders: 0 });
    slugs[k].all.push(r);
    slugs[k].bottles += r.bottles;
    slugs[k].orders += r.orders_printed || 0;
    if (r.is_clean) {
      slugs[k].clean.push(r.duration_min);
      (slugs[k].byOp[r.person_name] = slugs[k].byOp[r.person_name] || []).push(r.duration_min);
    }
  }

  const by_slug = {};
  for (const [slug, d] of Object.entries(slugs)) {
    const agg = statsOf(d.clean);
    const byOp = {};
    const opP25s = [];
    let best = null;
    for (const [op, durs] of Object.entries(d.byOp)) {
      const s = statsOf(durs);
      byOp[op] = s;
      if (s.count >= 3) {
        opP25s.push(s.p25);
        if (best == null || s.p25 < best.p25) best = { op, p25: s.p25 };
      }
    }
    const m1 = opP25s.length ? round1(mean(opP25s)) : null;
    const m2 = best ? best.p25 : null;
    const m3 = m2 != null ? round1(m2 * 1.15) : null;
    by_slug[slug] = {
      task_name: d.task_name, category: d.category,
      total_events: d.all.length, clean_events: d.clean.length, filtered_events: d.all.length - d.clean.length,
      ...agg,
      bottles_total: d.bottles, orders_printed_total: d.orders,
      method_1_target_minutes: m1,
      method_2_target_minutes: m2,
      method_3_target_minutes: m3,
      fallback_target_minutes: agg.p25,
      best_operator: best ? best.op : null,
      best_p25: best ? best.p25 : null,
      by_operator: byOp,
    };
  }

  // ── por operador ──────────────────────────────────────────────────────
  const ops = {};
  for (const r of rows) {
    const k = r.person_name;
    (ops[k] = ops[k] || { total: 0, clean_min: 0, slugs: new Set(), days: new Set(), forgotten: 0, cross_lunch: 0 });
    ops[k].total += 1;
    if (r.is_clean) ops[k].clean_min += r.duration_min;
    ops[k].slugs.add(r.slug);
    ops[k].days.add(r.started_edt.slice(0, 10));
    if (r.flags.includes('forgotten_eod')) ops[k].forgotten += 1;
    if (r.flags.includes('cross_lunch_no_pause')) ops[k].cross_lunch += 1;
  }
  const by_operator = {};
  for (const [op, d] of Object.entries(ops)) {
    by_operator[op] = {
      total_events: d.total,
      total_hours_clean: round1(d.clean_min / 60),
      slugs_executed: [...d.slugs].sort(),
      active_days: d.days.size,
      avg_events_per_day: round1(d.total / Math.max(1, d.days.size)),
      forgotten_checkouts: d.forgotten,
      cross_lunch_events: d.cross_lunch,
    };
  }

  // ── por dia da semana ───────────────────────────────────────────────────
  const DOW = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
  const by_day_of_week = {};
  for (let i = 0; i < 7; i++) by_day_of_week[`${i}_${DOW[i]}`] = { events: 0, clean_minutes: 0 };
  for (const r of rows) {
    const key = `${r.day_of_week}_${DOW[r.day_of_week]}`;
    by_day_of_week[key].events += 1;
    if (r.is_clean) by_day_of_week[key].clean_minutes += r.duration_min;
  }
  for (const k of Object.keys(by_day_of_week)) by_day_of_week[k].clean_minutes = round1(by_day_of_week[k].clean_minutes);

  const out = {
    analysis_date: new Date().toISOString(),
    period_days: 30,
    total_events: rows.length,
    events_clean: rows.filter((r) => r.is_clean).length,
    events_filtered: outliers.length,
    by_slug, by_operator, by_day_of_week,
    outliers_flagged: outliers,
  };

  // JSON (raiz, gitignored) — Fase 5 consome
  const jsonPath = path.join(__dirname, '..', '..', 'analysis_output.json');
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  console.log('JSON: ' + jsonPath);

  // Markdown report (committed)
  const dateStr = (new Date().toISOString()).slice(0, 10);
  const md = renderMarkdown(out, dateStr);
  const mdDir = path.join(__dirname, '..', '..', 'docs', 'analysis');
  fs.mkdirSync(mdDir, { recursive: true });
  const mdPath = path.join(mdDir, `task-targets-${dateStr}.md`);
  fs.writeFileSync(mdPath, md);
  console.log('Markdown: ' + mdPath);
  console.log(`\nResumo: ${out.total_events} events, ${out.events_clean} limpos, ${out.events_filtered} outliers, ${Object.keys(by_slug).length} slugs.`);
  await pool.end();
}

function renderMarkdown(out, dateStr) {
  const L = [];
  L.push(`# Análise de Tempos por Task — Últimos 30 dias`);
  L.push('');
  L.push(`Gerado: ${out.analysis_date} · Período: ${out.period_days}d`);
  L.push('');
  L.push(`## Resumo executivo`);
  L.push(`- Events processados: **${out.total_events}**`);
  L.push(`- Events válidos (sem outliers): **${out.events_clean}**`);
  L.push(`- Outliers detectados: **${out.events_filtered}**`);
  L.push(`- Task types analisados: **${Object.keys(out.by_slug).length}**`);
  L.push('');
  L.push(`## Targets por método (minutos)`);
  L.push('');
  L.push('| Slug | Tarefa | Events | Limpos | P25 | P50 | P75 | M1 (P25 ind) | M2 (best) | M3 (híbrido) | Melhor operador |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  const slugRows = Object.entries(out.by_slug).sort((a, b) => (b[1].p50 || 0) - (a[1].p50 || 0));
  for (const [slug, d] of slugRows) {
    L.push(`| \`${slug}\` | ${d.task_name || '—'} | ${d.total_events} | ${d.clean_events} | ${d.p25 ?? '—'} | ${d.p50 ?? '—'} | ${d.p75 ?? '—'} | ${d.method_1_target_minutes ?? '—'} | ${d.method_2_target_minutes ?? '—'} | ${d.method_3_target_minutes ?? '—'} | ${d.best_operator || '—'} |`);
  }
  L.push('');
  L.push(`## Top 10 tasks mais lentas (por P50)`);
  L.push('');
  slugRows.slice(0, 10).forEach(([slug, d], i) => {
    L.push(`${i + 1}. \`${slug}\` (${d.task_name || '—'}) — P50 ${d.p50 ?? '—'}min, P25 ${d.p25 ?? '—'}min, ${d.clean_events} events limpos`);
  });
  L.push('');
  L.push(`## Por operador`);
  L.push('');
  L.push('| Operador | Events | Horas (limpas) | Dias ativos | Events/dia | Forgotten | Cross-lunch |');
  L.push('|---|---|---|---|---|---|---|');
  for (const [op, d] of Object.entries(out.by_operator).sort((a, b) => b[1].total_events - a[1].total_events)) {
    L.push(`| ${op} | ${d.total_events} | ${d.total_hours_clean} | ${d.active_days} | ${d.avg_events_per_day} | ${d.forgotten_checkouts} | ${d.cross_lunch_events} |`);
  }
  L.push('');
  L.push(`## Por dia da semana`);
  L.push('');
  L.push('| Dia | Events | Minutos (limpos) |');
  L.push('|---|---|---|');
  for (const [k, d] of Object.entries(out.by_day_of_week)) L.push(`| ${k.split('_')[1]} | ${d.events} | ${d.clean_minutes} |`);
  L.push('');
  L.push(`## Outliers detectados (${out.outliers_flagged.length})`);
  L.push('');
  if (!out.outliers_flagged.length) { L.push('_Nenhum._'); } else {
    L.push('| ev | Operador | Slug | Duração (min) | Flags | Início | Fim |');
    L.push('|---|---|---|---|---|---|---|');
    out.outliers_flagged.slice(0, 100).forEach((o) => {
      L.push(`| ${o.event_id} | ${o.person} | \`${o.slug || '—'}\` | ${o.duration_min} | ${o.flags.join(', ')} | ${o.started_edt} | ${o.ended_edt} |`);
    });
  }
  L.push('');
  L.push(`## Recomendação de método`);
  L.push('');
  L.push('- **M3 (híbrido, best×1.15)** é o default sugerido pra seed de `task_targets`: ambicioso mas alcançável (o operador mais rápido já bate, com folga de 15%).');
  L.push('- Slugs com poucos dados por operador (sem M1/M2) usam o **fallback P25 agregado**.');
  L.push('- Bruno pode sobrescrever por slug na aba 📊 Targets (Fase 5).');
  L.push('');
  L.push(`_Estimativas Claude.ai vs SQL: coluna a preencher quando o handoff tiver a seção de estimativas (TODO)._`);
  return L.join('\n');
}

main().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
