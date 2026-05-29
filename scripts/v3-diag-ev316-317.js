'use strict';
/* DIAG read-only — caso ev316/ev317 Bruno Sarmento 29/mai 11:29 AM
   "Fechamento das caixas para envio e troca FNSKU do Black Garlic".
   Procura: o estado dos events afetados, as msgs origem (S e F), e o
   gap resultante do F que ninguém fechou. */
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' 1. ev316 / ev317 / ev318 — estado completo');
  console.log('═══════════════════════════════════════════════════════════');
  const r = (await pool.query(`
    SELECT e.id, e.person_id, p.display_name AS person,
      at.id AS activity_type_id, at.slug, at.flow, at.is_background,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS s,
      TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS e_t,
      e.started_at, e.ended_at, e.deleted_at, e.closed_reason,
      e.product_batch_id, pb.batch_number, pr.canonical_name AS product,
      e.cowork_with, e.confidence, e.source_message_ts,
      LEFT(COALESCE(e.description,''), 150) AS desc
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.id IN (316, 317, 318)
    ORDER BY e.id`)).rows;
  for (const x of r) {
    console.log(`\n  ev${x.id} ${x.person} (person_id=${x.person_id})`);
    console.log(`    activity_type_id=${x.activity_type_id} slug=${x.slug} flow=${x.flow} bg=${x.is_background}`);
    console.log(`    ${x.s}→${x.e_t || 'LIVE'}   started=${x.started_at}  ended=${x.ended_at}`);
    console.log(`    deleted=${x.deleted_at ? 'YES' : 'NO'} closed_reason=${x.closed_reason || 'NULL'}`);
    console.log(`    product=${x.product || '—'}/${x.batch_number || '—'} cw=${JSON.stringify(x.cowork_with)}`);
    console.log(`    source_ts=${x.source_message_ts} desc="${x.desc}"`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 2. Msgs origem (S 11:29 e F ~12:16)');
  console.log('═══════════════════════════════════════════════════════════');
  const msgs = (await pool.query(`
    SELECT m.id, m.slack_user_id, m.slack_ts,
      TO_CHAR(to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny,
      m.events_created, m.events_updated,
      m.llm_result->>'categorization' AS cat,
      m.llm_result->>'uncertain' AS uncertain,
      m.llm_result->>'uncertainty_reason' AS reason,
      m.raw_text,
      m.llm_result->'actions' AS actions
    FROM v3.messages m
    WHERE (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = '2026-05-29'
      AND m.raw_text ILIKE '%caixa%'
    ORDER BY m.slack_ts::numeric`)).rows;
  for (const m of msgs) {
    console.log(`\n  msg${m.id} ${m.ny} from=${m.slack_user_id}`);
    console.log(`    raw: "${m.raw_text}"`);
    console.log(`    events_created=${JSON.stringify(m.events_created || [])} events_updated=${JSON.stringify(m.events_updated || [])}`);
    console.log(`    cat=${m.cat} uncertain=${m.uncertain} reason="${m.reason || ''}"`);
    if (m.actions) {
      const actions = m.actions;
      for (const a of actions) {
        console.log(`    action: type=${a.type} person=${a.person_id} activity_type_id=${a.activity_type_id} product=${a.product_id} batch=${a.batch_number || '—'} desc="${(a.description || '').slice(0, 80)}"`);
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 3. Activity types relevantes (box_closing / dc_shipment / outros)');
  console.log('═══════════════════════════════════════════════════════════');
  const ats = (await pool.query(`
    SELECT id, slug, display_name, flow, category, is_background
    FROM v3.activity_types
    WHERE slug IN ('box_closing', 'dc_shipment', 'shipping', 'packaging', 'marketplace_prep', 'review')
    ORDER BY id`)).rows;
  for (const a of ats) {
    console.log(`  id=${a.id} slug=${a.slug} → "${a.display_name}" flow=${a.flow} cat=${a.category} bg=${a.is_background}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 4. Outras criações Bruno Sarmento entre 11:29 e 12:30 PM');
  console.log('═══════════════════════════════════════════════════════════');
  const others = (await pool.query(`
    SELECT e.id, at.slug, at.flow,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS s,
      TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS e_t,
      e.deleted_at, e.closed_reason,
      LEFT(COALESCE(e.description,''), 100) AS desc
    FROM v3.events e
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE e.person_id = 7 AND e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = '2026-05-29'
      AND e.started_at >= '2026-05-29 11:00:00-04'
      AND e.started_at <= '2026-05-29 12:30:00-04'
    ORDER BY e.started_at`)).rows;
  for (const r of others) {
    console.log(`  ev${r.id} ${r.s}→${r.e_t || 'LIVE'} ${r.slug}/${r.flow} closed=${r.closed_reason || '—'} desc="${r.desc}"`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 5. AUDIT timeline pros 3 events (criação, close, delete)');
  console.log('═══════════════════════════════════════════════════════════');
  const audit = (await pool.query(`
    SELECT al.id, al.target_id, al.action, al.actor_type, al.actor_person_id,
      al.created_at, al.metadata->>'reason' AS reason
    FROM v3.audit_log al
    WHERE al.target_id IN (316, 317, 318) AND al.action LIKE 'event%'
    ORDER BY al.target_id, al.created_at`)).rows;
  for (const a of audit) {
    console.log(`  audit#${a.id} ev${a.target_id} ${a.action} actor=${a.actor_type}/${a.actor_person_id || 'NULL'} ${a.created_at}`);
    if (a.reason) console.log(`     reason: "${(a.reason || '').slice(0, 120)}"`);
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
