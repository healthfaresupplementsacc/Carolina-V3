'use strict';
/* DIAG — tempos inflados V4 /dashboard-v4#hoje 28/mai/2026.
   Read-only. Reproduz o cálculo que o client faz pra mostrar:
     (a) "17h trabalhadas" do Bruno Sarmento
     (b) "28h+" no filtro Produção
   Hipótese: events is_long_running com started_at antigo (Potassium ev195+,
   Chromium ev231, Lithium ev252) estão sendo somados como se fossem de hoje.

   Estratégia:
   1. Replica a query do timeline-repo (WHERE date = 28/mai) e mostra TODOS os
      events que retornam, com started_at REAL (não só HH:MM).
   2. Replica o cálculo client-side do ScrollStrip "Pessoas · tempo ativo":
      sum((ended_at ?? now) - started_at) por pessoa, usando started_min/ended_min
      do adapter (HH:MM-do-dia → minutos). Esse é o BUG: se started_at é de
      ontem mas HH:MM virou 8:30 AM, o sistema acha que começou hoje 8:30 e
      conta até now (mas o ended_at, se null, usa now real).
   3. Replica o cálculo do filtro Produção: soma de duração de TODOS os events
      de fluxo production, com is_background incluído. Mostra se há paralelismo
      (multiple events overlapping the same wall-clock interval).
   4. Lista events is_long_running ativos hoje (started_at < hoje, ended_at null).
*/
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const TODAY = '2026-05-28';

  // ═══════════════════ 1. QUERY DO TIMELINE-REPO (= eventsByDay) ═══════════════════
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(` 1. Events que o /api/v3/data/timeline?date=${TODAY} retorna`);
  console.log('══════════════════════════════════════════════════════════════════');
  const rows = (await pool.query(`
    SELECT
      e.id, e.person_id, p.display_name AS person,
      at.slug AS activity, at.flow AS flow,
      at.is_background, e.is_long_running,
      e.started_at, e.ended_at,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS ny_start,
      TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS ny_end,
      EXTRACT(EPOCH FROM (e.started_at AT TIME ZONE 'America/New_York'))::bigint AS s_epoch_ny,
      EXTRACT(EPOCH FROM (COALESCE(e.ended_at, NOW()) AT TIME ZONE 'America/New_York'))::bigint AS e_epoch_ny,
      EXTRACT(HOUR   FROM (e.started_at AT TIME ZONE 'America/New_York'))::int * 60
        + EXTRACT(MINUTE FROM (e.started_at AT TIME ZONE 'America/New_York'))::int AS started_min_hhmm,
      CASE WHEN e.ended_at IS NULL THEN NULL
           ELSE EXTRACT(HOUR FROM (e.ended_at AT TIME ZONE 'America/New_York'))::int * 60
              + EXTRACT(MINUTE FROM (e.ended_at AT TIME ZONE 'America/New_York'))::int
      END AS ended_min_hhmm,
      e.cowork_with
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1
    ORDER BY p.display_name, e.started_at`, [TODAY])).rows;
  console.log(`  → ${rows.length} events retornados pelo endpoint (WHERE date=${TODAY})`);
  console.log();

  // ═══════════════════ 2. CÁLCULO TEMPO POR PESSOA (= ScrollStrip do V4) ═══════════════════
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(` 2. CÁLCULO V4 "Pessoas · tempo ativo" (sum de durações)`);
  console.log('══════════════════════════════════════════════════════════════════');
  // Reproduz a fórmula EXATA do client:
  //   const end = e.ended_min == null ? now : e.ended_min;
  //   byOp[op] += Math.max(0, end - e.started_min);
  // started_min/ended_min vêm do adapter que faz isoToNyMin: ONLY pega HH:MM.
  // Pra eventos LIVE com ended_at=null, end = now (minuto-do-dia atual NY).
  const nowMinNy = (await pool.query(`
    SELECT EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'America/New_York'))::int * 60
         + EXTRACT(MINUTE FROM (NOW() AT TIME ZONE 'America/New_York'))::int AS m`)).rows[0].m;
  console.log(`  agora (NY) = ${Math.floor(nowMinNy / 60)}:${String(nowMinNy % 60).padStart(2, '0')} (${nowMinNy} min do dia)`);
  console.log();

  const byOp = {};
  for (const r of rows) {
    const start = r.started_min_hhmm;
    const end   = r.ended_min_hhmm == null ? nowMinNy : r.ended_min_hhmm;
    const dur   = Math.max(0, end - start);
    byOp[r.person] = byOp[r.person] || { events: [], total: 0 };
    byOp[r.person].events.push({ id: r.id, activity: r.activity, flow: r.flow,
      bg: r.is_background, lr: r.is_long_running,
      start_hhmm: start, end_hhmm: end, dur, live: r.ended_at == null,
      ny_start: r.ny_start, ny_end: r.ny_end });
    byOp[r.person].total += dur;
  }

  for (const [name, info] of Object.entries(byOp).sort((a, b) => b[1].total - a[1].total)) {
    const h = Math.floor(info.total / 60);
    const m = info.total % 60;
    console.log(`\n  ★ ${name}: TOTAL ${h}h${String(m).padStart(2, '0')} (${info.total} min) — ${info.events.length} event(s)`);
    for (const ev of info.events) {
      const flag = (ev.lr ? '[LONG_RUN]' : '') + (ev.bg ? '[bg]' : '[fg]') + (ev.live ? '[LIVE]' : '');
      const sH = Math.floor(ev.start_hhmm / 60), sM = ev.start_hhmm % 60;
      const eH = Math.floor(ev.end_hhmm / 60),   eM = ev.end_hhmm   % 60;
      const durH = Math.floor(ev.dur / 60),      durM = ev.dur % 60;
      console.log(`     ev${ev.id} ${flag} ${ev.flow || 'NULL'}/${ev.activity || 'NULL'}`);
      console.log(`        started_at REAL: ${ev.ny_start}`);
      console.log(`        ended_at REAL:   ${ev.ny_end || 'NULL (LIVE)'}`);
      console.log(`        CALC client: ${sH}:${String(sM).padStart(2, '0')} → ${eH}:${String(eM).padStart(2, '0')} = ${durH}h${String(durM).padStart(2, '0')}`);
    }
  }

  // ═══════════════════ 3. CÁLCULO FILTRO "PRODUÇÃO" ═══════════════════
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log(` 3. CÁLCULO V4 filtro "Produção" (soma simples, sem união)`);
  console.log('══════════════════════════════════════════════════════════════════');
  const prodEvents = rows.filter((r) => r.flow === 'production');
  let prodTotal = 0;
  for (const r of prodEvents) {
    const end = r.ended_min_hhmm == null ? nowMinNy : r.ended_min_hhmm;
    prodTotal += Math.max(0, end - r.started_min_hhmm);
  }
  console.log(`  Eventos production no dia: ${prodEvents.length}`);
  console.log(`  Soma simples (= o que V4 mostra): ${Math.floor(prodTotal / 60)}h${String(prodTotal % 60).padStart(2, '0')} (${prodTotal} min)`);

  // União (intervalos wall-clock, sem dupla contagem) — o que SERIA correto
  const ivs = prodEvents.map((r) => [r.started_min_hhmm, r.ended_min_hhmm == null ? nowMinNy : r.ended_min_hhmm])
                        .filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const merged = ivs.length ? [ivs[0].slice()] : [];
  for (let i = 1; i < ivs.length; i++) {
    const last = merged[merged.length - 1];
    if (ivs[i][0] <= last[1]) last[1] = Math.max(last[1], ivs[i][1]);
    else merged.push(ivs[i].slice());
  }
  const unionTotal = merged.reduce((s, [a, b]) => s + (b - a), 0);
  console.log(`  União wall-clock (= correto): ${Math.floor(unionTotal / 60)}h${String(unionTotal % 60).padStart(2, '0')} (${unionTotal} min)`);
  console.log(`  → INFLAÇÃO: +${prodTotal - unionTotal} min (${Math.round((prodTotal / unionTotal - 1) * 100)}%)`);

  // ═══════════════════ 4. LONG_RUNNING ATIVOS ═══════════════════
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log(` 4. Events is_long_running ABERTOS (started_at < hoje, ended_at NULL)`);
  console.log('══════════════════════════════════════════════════════════════════');
  const lr = (await pool.query(`
    SELECT e.id, e.person_id, p.display_name AS person,
      at.slug AS activity, at.is_background,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS ny_start,
      EXTRACT(EPOCH FROM (NOW() - e.started_at))::bigint / 3600 AS hours_open,
      pb.batch_number, pr.canonical_name AS product
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.deleted_at IS NULL
      AND e.is_long_running = true
      AND e.ended_at IS NULL
    ORDER BY e.started_at`)).rows;
  for (const r of lr) {
    const inToday = r.ny_start.startsWith(TODAY);
    console.log(`  ev${r.id} ${r.person} ${r.activity} (bg=${r.is_background}) — started ${r.ny_start} — ${r.hours_open}h aberto — ${inToday ? '✓ DE HOJE' : '✗ DE OUTRO DIA'}`);
    console.log(`    ${r.product || '—'} / ${r.batch_number || '—'}`);
  }

  // ═══════════════════ 5. SANITY: Bruno Sarmento detalhado ═══════════════════
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log(` 5. Bruno Sarmento — detalhe SQL`);
  console.log('══════════════════════════════════════════════════════════════════');
  const bs = (await pool.query(`
    SELECT id, display_name FROM v3.persons WHERE display_name ILIKE 'Bruno Sarmento%'`)).rows[0];
  if (!bs) { console.log('  Bruno Sarmento não achado'); }
  else {
    console.log(`  person_id=${bs.id}`);
    const bsEvs = (await pool.query(`
      SELECT e.id, at.slug AS activity, at.is_background, e.is_long_running,
        TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS s,
        TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS e
      FROM v3.events e
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      WHERE e.person_id = $1 AND e.deleted_at IS NULL
        AND (e.started_at AT TIME ZONE 'America/New_York')::date = $2
      ORDER BY e.started_at`, [bs.id, TODAY])).rows;
    console.log(`  ${bsEvs.length} event(s) hoje:`);
    for (const r of bsEvs) {
      console.log(`    ev${r.id} ${r.s} → ${r.e || 'LIVE'} ${r.activity} bg=${r.is_background} lr=${r.is_long_running}`);
    }
  }

  await pool.end();
}
main().then(() => process.exit(0), (err) => { console.error('ERR:', err.message, '\n', err.stack); process.exit(1); });
