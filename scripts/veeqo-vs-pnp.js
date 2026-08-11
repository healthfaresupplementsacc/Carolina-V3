'use strict';
/**
 * Cross-check Veeqo × P&P do tracker (Bruno 07-09).
 * Pergunta: as ORDENS que a Veeqo etiquetou por dia batem com o que os operadores
 * contaram no P&P? Rodar via:  railway run --service ProductionLineService node scripts/veeqo-vs-pnp.js
 *
 * Lados:
 *  - VEEQO: pedidos com etiqueta impressa (status shipped) por dia NY. Cobre
 *    Amazon/eBay/Walmart/site HealthFare. NÃO cobre TikTok (ainda não integrado).
 *  - TRACKER (canônico): production_counts kind='orders' de tasks counts_as_pp
 *    (clínica fora), por production_date — a MESMA query do /admin e do pnpByDay.
 *    Vem quebrado por `marketplace` (tag OPCIONAL do operador) pra eu separar TikTok.
 *
 * A comparação honesta é: Veeqo  vs  (tracker MENOS TikTok).  Se sobrar muita
 * diferença → operador esqueceu/contou errado, ou tem canal fora do Veeqo.
 */
const { Pool } = require('pg');
const { createVeeqoClient } = require('../src/v3/services/veeqo-api');
const veeqo = createVeeqoClient({ timeoutMs: 60000 }); // janela larga = Veeqo lento/página
const EDT = 'America/New_York';
async function getPageRetry(page, since) {
  for (let a = 1; a <= 3; a++) {
    try { return await veeqo.getOrdersPage({ status: 'shipped', updatedSince: since, page, pageSize: 100 }); }
    catch (e) { if (a === 3) throw e; await new Promise((r) => setTimeout(r, 1500 * a)); }
  }
}
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const DAYS = parseInt(process.env.DAYS, 10) || 8;

const nyDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: EDT }) : null);
const today = new Date().toLocaleDateString('en-CA', { timeZone: EDT });
// lista de dias YYYY-MM-DD do mais antigo pro mais novo (inclui hoje)
const days = [];
for (let i = DAYS - 1; i >= 0; i--) {
  days.push(new Date(Date.parse(today + 'T12:00:00Z') - i * 86400000).toLocaleDateString('en-CA', { timeZone: EDT }));
}
const isTikTok = (m) => /tik\s*tok/i.test(String(m || ''));

(async () => {
  if (!veeqo.configured()) { console.error('sem VEEQO_API_KEY'); process.exit(1); }

  // ── VEEQO: uma varredura só, balde por dia de shipped_at ────────────────────
  const since = new Date(Date.parse(days[0] + 'T00:00:00Z') - 30 * 3600 * 1000).toISOString();
  const vqByDay = new Map(); // day -> { orders, byChannel:Map }
  days.forEach((d) => vqByDay.set(d, { orders: 0, byChannel: new Map() }));
  let scanned = 0, pagesUsed = 0, capped = false;
  const CAP = 120; // 12k pedidos — folga enorme pra ~8 dias
  for (let page = 1; page <= CAP; page++) {
    const rows = await getPageRetry(page, since);
    pagesUsed = page;
    if (!rows.length) break;
    scanned += rows.length;
    for (const o of rows) {
      const d = nyDate(o.shipped_at);
      const b = vqByDay.get(d);
      if (!b) continue; // fora da janela de dias
      b.orders += 1;
      const ch = (o.channel && (o.channel.name || o.channel.type_code)) || '—';
      b.byChannel.set(ch, (b.byChannel.get(ch) || 0) + 1);
    }
    if (rows.length < 100) break;
    if (page === CAP) capped = true;
  }

  // ── TRACKER: P&P canônico por dia + quebra por marketplace ───────────────────
  const tr = (await p.query(
    `SELECT pc.production_date::text AS d,
            COALESCE(NULLIF(TRIM(pc.marketplace),''),'(sem tag)') AS marketplace,
            SUM(pc.bottles)::int AS orders,
            COUNT(*)::int AS submissions,
            array_agg(DISTINCT COALESCE(rp.display_name,'?')) AS who
       FROM v3.production_counts pc
       JOIN v3.events e ON e.id = pc.source_event_id
       JOIN v3.activity_types at ON at.id = e.activity_type_id AND at.counts_as_pp = true
       LEFT JOIN v3.persons rp ON rp.id = pc.reported_by_person_id
      WHERE pc.kind = 'orders' AND pc.deleted_at IS NULL AND pc.superseded_by IS NULL
        AND e.deleted_at IS NULL
        AND pc.production_date = ANY($1::date[])
      GROUP BY pc.production_date, COALESCE(NULLIF(TRIM(pc.marketplace),''),'(sem tag)')
      ORDER BY pc.production_date, orders DESC`,
    [days])).rows;

  // clínica (contexto — fica FORA do P&P)
  const clin = (await p.query(
    `SELECT pc.production_date::text AS d, SUM(pc.bottles)::int AS orders
       FROM v3.production_counts pc
      WHERE pc.kind = 'clinic' AND pc.deleted_at IS NULL AND pc.superseded_by IS NULL
        AND pc.production_date = ANY($1::date[])
      GROUP BY pc.production_date`, [days])).rows;
  const clinByDay = new Map(clin.map((r) => [r.d, r.orders]));

  const trByDay = new Map(); // d -> { total, tiktok, byMkt:[{marketplace,orders,submissions}] , who:Set }
  days.forEach((d) => trByDay.set(d, { total: 0, tiktok: 0, byMkt: [], who: new Set() }));
  for (const row of tr) {
    const b = trByDay.get(row.d); if (!b) continue;
    b.total += row.orders;
    if (isTikTok(row.marketplace)) b.tiktok += row.orders;
    b.byMkt.push({ marketplace: row.marketplace, orders: row.orders, submissions: row.submissions });
    (row.who || []).forEach((w) => b.who.add(w));
  }

  // ── RELATÓRIO ────────────────────────────────────────────────────────────────
  const dow = (d) => ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][new Date(d + 'T12:00:00Z').getUTCDay()];
  console.log(`\n════ VEEQO × P&P (tracker) — últimos ${DAYS} dias (NY) ════`);
  console.log(`Veeqo: ${scanned} pedidos shipped varridos em ${pagesUsed} págs desde ${since.slice(0, 10)}${capped ? '  ⚠️ CAP ATINGIDO (dado pode faltar)' : ''}\n`);
  const pad = (s, n) => String(s).padEnd(n);
  const pnum = (s, n) => String(s).padStart(n);
  console.log(pad('dia', 12) + pnum('VEEQO', 7) + pnum('P&P', 7) + pnum('P&P-TT', 8) + pnum('TikTok', 8) + pnum('Δ', 7) + '   (Δ = Veeqo − P&P·sem·TikTok)');
  console.log('─'.repeat(72));
  let sumV = 0, sumP = 0, sumPnoTT = 0, sumTT = 0;
  for (const d of days) {
    const v = vqByDay.get(d);
    const t = trByDay.get(d);
    const pNoTT = t.total - t.tiktok;
    const delta = v.orders - pNoTT;
    sumV += v.orders; sumP += t.total; sumPnoTT += pNoTT; sumTT += t.tiktok;
    const flag = t.total === 0 && v.orders > 0 ? '  ← tracker ZERO' : (Math.abs(delta) >= 15 ? `  ← Δ${delta > 0 ? '+' : ''}${delta}` : '');
    console.log(pad(`${d} ${dow(d)}`, 12) + pnum(v.orders, 7) + pnum(t.total, 7) + pnum(pNoTT, 8) + pnum(t.tiktok, 8) + pnum((delta > 0 ? '+' : '') + delta, 7) + flag);
  }
  console.log('─'.repeat(72));
  console.log(pad('TOTAL', 12) + pnum(sumV, 7) + pnum(sumP, 7) + pnum(sumPnoTT, 8) + pnum(sumTT, 8) + pnum((sumV - sumPnoTT > 0 ? '+' : '') + (sumV - sumPnoTT), 7));

  console.log('\n──── detalhe por dia ────');
  for (const d of days) {
    const v = vqByDay.get(d); const t = trByDay.get(d);
    const vch = [...v.byChannel.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(' · ') || '—';
    const tmk = t.byMkt.length ? t.byMkt.map((m) => `${m.marketplace} ${m.orders}${m.submissions > 1 ? `(${m.submissions}x)` : ''}`).join(' · ') : '— nada contado —';
    const cl = clinByDay.get(d);
    console.log(`\n${d} ${dow(d)}`);
    console.log(`  VEEQO ${v.orders}:  ${vch}`);
    console.log(`  P&P   ${t.total}:  ${tmk}${cl ? `   [clínica ${cl}, fora do P&P]` : ''}`);
    if (t.who.size) console.log(`  quem contou: ${[...t.who].join(', ')}`);
  }
  console.log('');
  await p.end();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
