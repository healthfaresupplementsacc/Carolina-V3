'use strict';
/**
 * ANALISTA DE DADOS — coletor de CONTEXTO (Bruno 07-28).
 *
 * Quando o Henrique (ou qualquer admin) pergunta algo no Slack, EU (Claude Code)
 * preciso dos NÚMEROS REAIS pra responder com precisão. Este script puxa, pra uma
 * ou mais datas, tudo que costuma importar (produção, ordens/P&P, tempos, por
 * pessoa) usando os MESMOS repos do dashboard — então o número que eu respondo é
 * exatamente o que aparece no painel. Nada de SQL inventado.
 *
 * Uso:  railway run node scripts/analyst/context.js <data1> [data2] ...
 *   datas em YYYY-MM-DD (NY). Sem argumento = hoje. Imprime JSON no stdout.
 *
 * REGRA (Bruno): informação incorreta destrói credibilidade → eu leio ESTE JSON e
 * só afirmo o que está aqui; se faltar dado ou for ambíguo, pergunto de volta.
 */

const { Pool } = require('pg');
const path = require('path');

// carrega os repos do próprio código do backend (fonte única de verdade)
const { FlowViewsRepo } = require(path.join(__dirname, '../../src/v3/data/flow-views-repo'));
const { TimelineRepo } = require(path.join(__dirname, '../../src/v3/data/timeline-repo'));
const { CountsRepo } = require(path.join(__dirname, '../../src/v3/data/counts-repo'));
const { BatchesRepo } = require(path.join(__dirname, '../../src/v3/data/batches-repo'));

function nyToday() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }

async function collectForDate(repos, db, date) {
  const out = { date };
  // produção (linha) e P&P (ordens) do dia — os dois fluxos, separados
  try { out.production = await repos.flowViews.productionByDay(date); } catch (e) { out.production = { error: e.message }; }
  try { out.pnp = await repos.flowViews.pnpByDay(date); } catch (e) { out.pnp = { error: e.message }; }
  try { out.counts = await repos.counts.countsByDay(date); } catch (e) { out.counts = { error: e.message }; }
  // eventos por pessoa (tempos, idle) — resumido pra não estourar
  try {
    const tl = await repos.timeline.eventsByDay(date);
    const evSec = (e) => {
      if (!e.started_at) return 0;
      const end = e.ended_at ? new Date(e.ended_at).getTime() : Date.now();
      return Math.max(0, Math.round((end - new Date(e.started_at).getTime()) / 1000));
    };
    out.people = (tl.people || tl || []).map((p) => {
      const evs = p.events || [];
      // tempo por fase (slug) — útil pra "quanto tempo fulano gastou em X"
      const byPhase = {};
      for (const e of evs) { const k = (e.activity && e.activity.slug) || 'outro'; byPhase[k] = (byPhase[k] || 0) + evSec(e); }
      return {
        name: p.display_name || p.name,
        person_id: p.person_id || p.id,
        events: evs.length,
        worked_sec: evs.reduce((s, e) => s + evSec(e), 0),
        idle_sec: p.idle_seconds || 0,
        by_phase: byPhase,
      };
    });
  } catch (e) { out.people = { error: e.message }; }
  // presença do dia (chegada/saída) — pode importar pra "tempo trabalhado"
  try {
    const att = (await db.query(
      `SELECT p.display_name, s.checkin_at, s.checkout_at, s.state
         FROM v3.att_state s JOIN v3.persons p ON p.id=s.person_id
        WHERE s.att_date=$1::date ORDER BY s.checkin_at`, [date])).rows;
    out.attendance = att.map((r) => ({ name: r.display_name, checkin: r.checkin_at, checkout: r.checkout_at, state: r.state }));
  } catch (e) { out.attendance = { error: e.message }; }
  return out;
}

async function main() {
  const dates = process.argv.slice(2);
  if (!dates.length) dates.push(nyToday());
  const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const repos = {
    flowViews: new FlowViewsRepo({ db }),
    timeline: new TimelineRepo({ db }),
    counts: new CountsRepo({ db }),
    batches: new BatchesRepo({ db }),
  };
  const result = { generated_at: new Date().toISOString(), tz: 'America/New_York', days: [] };
  for (const d of dates) {
    result.days.push(await collectForDate(repos, db, d));
  }
  await db.end();
  process.stdout.write(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch((e) => { process.stderr.write('ERRO: ' + e.message + '\n'); process.exit(1); });
module.exports = { collectForDate, nyToday };
