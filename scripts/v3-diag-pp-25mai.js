'use strict';
/** Diagnóstico P&P 25/mai: ev 148/149/150 + msgs do Vitor "ajuda nas orders" + ev 150 aberto. */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

(async () => {
  const p = makeV3Pool();
  try {
    console.log('=== events P&P 25/mai (ordenados) ===');
    const evs = (await p.query(
      `SELECT e.id, e.person_id, pn.display_name AS person, e.activity_type_id,
              at.slug, at.flow, at.is_background,
              e.started_at, e.ended_at, e.cowork_with, e.source_message_ts,
              e.description, e.closed_reason, e.quantity, e.quantity_unit
       FROM v3.events e
       LEFT JOIN v3.persons pn ON pn.id=e.person_id
       LEFT JOIN v3.activity_types at ON at.id=e.activity_type_id
       WHERE e.deleted_at IS NULL
         AND (e.started_at AT TIME ZONE 'America/New_York')::date = '2026-05-25'
         AND (at.flow = 'pnp' OR e.id IN (148,149,150))
       ORDER BY e.started_at`)).rows;
    for (const e of evs) {
      const dur = e.ended_at ? Math.round((Date.parse(e.ended_at) - Date.parse(e.started_at)) / 60000) + 'min' : 'aberto';
      console.log(`  ev ${e.id} ${e.person} ${e.slug} ${e.flow} ${e.started_at}→${e.ended_at || '∞'} (${dur}) cowork=${JSON.stringify(e.cowork_with)} reason=${e.closed_reason} src=${e.source_message_ts}`);
    }

    console.log('\n=== msgs com "ajuda"/"ordens"/"orders" 25/mai ===');
    const msgs = (await p.query(
      `SELECT m.id, m.slack_ts, m.raw_text, m.events_created, m.events_updated, m.llm_result, pn.display_name AS person
       FROM v3.messages m LEFT JOIN v3.persons pn ON pn.id=m.person_id
       WHERE m.created_at > '2026-05-25T00:00:00-04:00' AND m.created_at < '2026-05-26T00:00:00-04:00'
         AND (m.raw_text ILIKE '%ajuda%' OR m.raw_text ILIKE '%ordens%' OR m.raw_text ILIKE '%orders%' OR m.raw_text ILIKE '%fnsku%' OR m.raw_text ILIKE '%label%')
       ORDER BY m.created_at`)).rows;
    for (const m of msgs) {
      console.log(`  msg ${m.id} ts=${m.slack_ts} person=${m.person}`);
      console.log(`    raw: "${(m.raw_text || '').slice(0, 180).replace(/\n/g, ' ')}"`);
      console.log(`    created=${JSON.stringify(m.events_created)} updated=${JSON.stringify(m.events_updated)}`);
      const r = m.llm_result;
      if (r && r.actions) {
        for (const a of r.actions) {
          console.log(`      action: ${a.type} person_id=${a.person_id} at_id=${a.activity_type_id} cowork_with=${JSON.stringify(a.cowork_with)} ${a.description ? '· ' + a.description.slice(0, 80) : ''}`);
        }
        if (r.uncertain) console.log(`      ⚠ uncertain: ${r.uncertainty_reason}`);
      }
    }

    console.log('\n=== msgs da Simone 25/mai pós-10:05 (depois que ev 150 abriu) ===');
    const simMsgs = (await p.query(
      `SELECT m.id, m.slack_ts, m.raw_text, m.events_created, m.events_updated
       FROM v3.messages m
       WHERE m.created_at > '2026-05-25T10:05:00-04:00' AND m.created_at < '2026-05-26T00:00:00-04:00'
         AND m.person_id = 5
       ORDER BY m.created_at`)).rows;
    for (const m of simMsgs) {
      console.log(`  msg ${m.id} ts=${m.slack_ts}: "${(m.raw_text || '').slice(0, 160).replace(/\n/g, ' ')}" → created=${JSON.stringify(m.events_created)} updated=${JSON.stringify(m.events_updated)}`);
    }

    console.log('\n=== flow-views.pnpByDay(25/mai) — estado atual do card ===');
    const { FlowViewsRepo } = require('../src/v3/data/flow-views-repo');
    const fv = new FlowViewsRepo({ db: p });
    const pp = await fv.pnpByDay('2026-05-25');
    console.log(JSON.stringify(pp, null, 2));
  } catch (e) { console.error('ERRO:', e.message); console.error(e.stack); process.exitCode = 1; }
  finally { await p.end(); }
})();
