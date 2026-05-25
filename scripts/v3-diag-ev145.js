'use strict';
/** Diagnóstico ev 145 + msgs do Vitor 25/mai 8:24-9:13. Read-only. */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

(async () => {
  const p = makeV3Pool();
  try {
    console.log('=== ev 145 atual ===');
    const ev = (await p.query(
      `SELECT e.id, e.person_id, pn.display_name AS person, e.activity_type_id,
              at.slug, at.display_name AS activity, at.flow, at.category, at.is_background,
              e.product_batch_id, pb.batch_number, pr.canonical_name AS product,
              e.started_at, e.ended_at, e.quantity, e.quantity_unit,
              e.phase_label, e.description, e.confidence, e.closed_reason,
              e.source_message_ts
       FROM v3.events e
       LEFT JOIN v3.persons pn ON pn.id=e.person_id
       LEFT JOIN v3.activity_types at ON at.id=e.activity_type_id
       LEFT JOIN v3.product_batches pb ON pb.id=e.product_batch_id
       LEFT JOIN v3.products pr ON pr.id=pb.product_id
       WHERE e.id=145`)).rows[0];
    console.log(JSON.stringify(ev, null, 2));

    console.log('\n=== msgs do Vitor hoje (last 24h) ===');
    const msgs = (await p.query(
      `SELECT m.id, m.slack_ts, m.raw_text, m.llm_processed_at, m.events_created, m.events_updated,
              m.llm_result, pn.display_name AS person
       FROM v3.messages m LEFT JOIN v3.persons pn ON pn.id = m.person_id
       WHERE m.created_at > NOW() - INTERVAL '36 hours'
         AND (m.person_id = 4 OR m.raw_text ILIKE '%fnsku%' OR m.raw_text ILIKE '%vita b1%' OR m.raw_text ILIKE '%rutin%')
       ORDER BY m.created_at`)).rows;
    for (const m of msgs) {
      console.log(`\n  msg ${m.id} ts=${m.slack_ts} ${new Date(m.llm_processed_at).toISOString()}`);
      console.log(`  person=${m.person}  raw: "${(m.raw_text || '').replace(/\n/g, ' ').slice(0, 160)}"`);
      console.log(`  events_created=${JSON.stringify(m.events_created)} updated=${JSON.stringify(m.events_updated)}`);
      const r = m.llm_result;
      if (r) {
        console.log(`  llm.interpretation: ${r.interpretation}`);
        console.log(`  llm.categorization: ${r.categorization}  conf=${r.confidence_overall}`);
        if (r.actions && r.actions.length) {
          for (const a of r.actions) {
            console.log(`    action: ${a.type} person_id=${a.person_id} at_id=${a.activity_type_id} quantity=${a.quantity || ''} ${a.description ? '— ' + a.description.slice(0, 80) : ''}`);
          }
        }
      }
    }

    console.log('\n=== activity_types relevantes (count/fnsku/marketplace/encaps/formul) ===');
    const ats = (await p.query(
      `SELECT id, slug, display_name, category, flow, is_background, expected_seconds, requires_product
       FROM v3.activity_types
       WHERE slug ILIKE '%count%' OR slug ILIKE '%fnsku%' OR slug ILIKE '%market%'
          OR slug ILIKE '%encaps%' OR slug ILIKE '%formul%' OR slug ILIKE '%label%'
       ORDER BY flow, slug`)).rows;
    for (const a of ats) console.log(' ', JSON.stringify(a));

    console.log('\n=== ev 145 → audit history ===');
    const aud = (await p.query(
      `SELECT id, created_at, actor_type, action, before_data, after_data, metadata
       FROM v3.audit_log WHERE target_type='event' AND target_id=145
       ORDER BY created_at`)).rows;
    for (const a of aud) {
      console.log(`  audit ${a.id} ${a.created_at.toISOString()} ${a.actor_type} ${a.action}`);
      if (a.before_data) console.log(`    before: ${JSON.stringify(a.before_data).slice(0, 200)}`);
      if (a.after_data) console.log(`    after:  ${JSON.stringify(a.after_data).slice(0, 200)}`);
    }
  } catch (e) { console.error('ERRO:', e.message); console.error(e.stack); process.exitCode = 1; }
  finally { await p.end(); }
})();
