'use strict';
/** Diagnóstico: msg da Simone hoje + event order_printing + card P&P. Read-only. */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

(async () => {
  const p = makeV3Pool();
  try {
    console.log('=== msg da Simone hoje com "ordens" ===');
    const msgs = (await p.query(
      `SELECT id, slack_ts, slack_user_id, raw_text, llm_processed_at,
              llm_provider_used, llm_result, events_created, events_updated, processing_error
       FROM v3.messages
       WHERE created_at > NOW() - INTERVAL '36 hours'
         AND raw_text ILIKE '%ordens%'
       ORDER BY created_at DESC LIMIT 5`)).rows;
    if (!msgs.length) {
      // tenta últimas 24h
      const m2 = (await p.query(
        `SELECT id, slack_ts, raw_text, llm_result, events_created
         FROM v3.messages WHERE raw_text ILIKE '%468%' OR raw_text ILIKE '%impressao das ordens%'
         ORDER BY created_at DESC LIMIT 5`)).rows;
      console.log('(busca alt) results:', m2.length);
      for (const m of m2) {
        console.log(`  msg ${m.id} ts=${m.slack_ts}`);
        console.log(`    raw: "${(m.raw_text || '').slice(0, 140)}"`);
        console.log(`    events_created: ${JSON.stringify(m.events_created)}`);
        console.log(`    llm_result:`, JSON.stringify(m.llm_result, null, 2));
      }
    }
    for (const m of msgs) {
      console.log(`\nmsg ${m.id} ts=${m.slack_ts} user=${m.slack_user_id}`);
      console.log(`  raw: "${(m.raw_text || '').replace(/\n/g, ' ')}"`);
      console.log(`  processed_at: ${m.llm_processed_at}`);
      console.log(`  provider: ${m.llm_provider_used}`);
      console.log(`  events_created: ${JSON.stringify(m.events_created)} updated=${JSON.stringify(m.events_updated)}`);
      console.log(`  error: ${m.processing_error || '—'}`);
      console.log(`  llm_result:\n${JSON.stringify(m.llm_result, null, 2)}`);
      if (m.events_created && m.events_created.length) {
        const evs = (await p.query(
          `SELECT e.id, e.activity_type_id, at.slug, e.started_at, e.ended_at,
                  e.quantity, e.quantity_unit, e.description, e.phase_label
           FROM v3.events e LEFT JOIN v3.activity_types at ON at.id=e.activity_type_id
           WHERE e.id = ANY($1)`, [m.events_created])).rows;
        console.log('  event(s) criado(s):');
        for (const e of evs) console.log('   ', JSON.stringify(e));
      }
    }

    console.log('\n=== flow-views pnpByDay (hoje) ===');
    const { FlowViewsRepo } = require('../src/v3/data/flow-views-repo');
    const fv = new FlowViewsRepo({ db: p });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    const pp = await fv.pnpByDay(today);
    console.log(JSON.stringify(pp, null, 2));
  } catch (e) { console.error('ERRO:', e.message); console.error(e.stack); process.exitCode = 1; }
  finally { await p.end(); }
})();
