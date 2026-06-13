'use strict';
/* ITEM 1 — PersonResolver bug: Bruno Sarmento posta via conta Vitor.
   Toda msg de hoje (27/mai) da conta Vitor com assinatura -Bruno / Bruno-
   deveria virar event do Bruno Sarmento (person_id=7), não Vitor (4).
   Read-only. */
const { Pool } = require('pg');

// Format 12h AM/PM (Bruno's preference — Florida)
function fmt12h(date) {
  if (!date) return '—';
  const s = date.toISOString();   // wall NY como faux-UTC (system convention)
  const hh = Number(s.slice(11, 13));
  const mm = s.slice(14, 16);
  const ampm = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh === 0 ? 12 : (hh > 12 ? hh - 12 : hh);
  return `${h12}:${mm} ${ampm}`;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const D = '2026-05-27';

  // 0. catalog — slack_user_ids
  console.log('═══ Catálogo persons ═══');
  const persons = await pool.query(`SELECT id, display_name, role, slack_user_id, active FROM v3.persons WHERE deleted_at IS NULL ORDER BY id`);
  for (const p of persons.rows) console.log(`  id=${p.id} ${p.display_name.padEnd(15)} role=${p.role.padEnd(10)} slack=${p.slack_user_id || '—'}`);
  const vitor = persons.rows.find((p) => p.display_name === 'Vitor');
  const brunoS = persons.rows.find((p) => p.display_name === 'Bruno Sarmento');
  if (!vitor || !vitor.slack_user_id) { console.error('Vitor sem slack_user_id'); await pool.end(); process.exit(2); }
  console.log(`\n  Vitor = id ${vitor.id} (slack ${vitor.slack_user_id})`);
  console.log(`  Bruno Sarmento = id ${brunoS.id}`);

  // 1. Todas msgs hoje da conta Vitor
  console.log('\n═══ ITEM 1 — TODAS as msgs HOJE 27/mai da conta Vitor (slack=' + vitor.slack_user_id + ') ═══');
  const msgs = await pool.query(`
    SELECT m.id, m.slack_ts,
           to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York' AS ny_ts,
           m.person_id AS resolved_person_id,
           p.display_name AS resolved_name,
           m.events_created, m.events_updated,
           m.llm_result->>'confidence_overall' AS conf,
           (m.llm_result->>'uncertain')::boolean AS uncertain,
           LEFT(m.raw_text, 160) AS txt
    FROM v3.messages m
    LEFT JOIN v3.persons p ON p.id = m.person_id
    WHERE m.slack_user_id = $1
      AND (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = $2::date
    ORDER BY m.slack_ts::numeric`, [vitor.slack_user_id, D]);
  console.log(`  Total: ${msgs.rows.length} msgs\n`);

  // Detecta possíveis assinaturas Bruno
  const brunoRe = /(\bbruno\b|[\-–]\s*bruno|bruno\s*[\-–])/i;
  const suspects = [];
  for (const r of msgs.rows) {
    const hasBruno = brunoRe.test(r.txt);
    const tag = hasBruno ? '⚠ BRUNO?' : '       ';
    console.log(`  ${tag} msg${r.id} ${fmt12h(r.ny_ts)} resolved=${r.resolved_name || '?'} (id ${r.resolved_person_id || '?'}) ev:[${r.events_created || []}+${r.events_updated || []}] "${r.txt}"`);
    if (hasBruno) suspects.push(r);
  }

  // 2. Pra cada msg suspeita, listar events resultantes
  console.log(`\n═══ ${suspects.length} msgs com assinatura Bruno via conta Vitor — análise event a event ═══\n`);
  for (const m of suspects) {
    const evIds = [...(m.events_created || []), ...(m.events_updated || [])];
    if (evIds.length === 0) {
      console.log(`  msg${m.id} ${fmt12h(m.ny_ts)}: NENHUM event criado/atualizado`);
      console.log(`    txt: "${m.txt}"\n`);
      continue;
    }
    const events = await pool.query(`
      SELECT e.id, e.person_id, p.display_name AS person_name, at.slug AS activity,
             e.started_at AT TIME ZONE 'America/New_York' AS ny_start,
             e.ended_at AT TIME ZONE 'America/New_York' AS ny_end,
             e.cowork_with,
             LEFT(COALESCE(e.description, ''), 100) AS desc
      FROM v3.events e
      LEFT JOIN v3.persons p ON p.id = e.person_id
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      WHERE e.id = ANY($1::int[]) AND e.deleted_at IS NULL
      ORDER BY e.id`, [evIds]);
    console.log(`  msg${m.id} ${fmt12h(m.ny_ts)}: "${m.txt}"`);
    for (const e of events.rows) {
      const wrong = e.person_id === vitor.id ? '❌ ATRIBUÍDO A VITOR — DEVERIA SER BRUNO SARMENTO' : '';
      console.log(`    → ev${e.id} person=${e.person_name} (id ${e.person_id}) ${e.activity} ${fmt12h(e.ny_start)}→${e.ny_end ? fmt12h(e.ny_end) : 'LIVE'} cw=[${e.cowork_with}] ${wrong}`);
      if (e.desc) console.log(`        desc: "${e.desc}"`);
    }
    console.log('');
  }

  // 3. Reverse — events de hoje atribuídos ao Bruno Sarmento — confirma pra ver se PersonResolver acertou em alguns
  console.log(`\n═══ Events HOJE atribuídos ao Bruno Sarmento (person_id=7) — pra ver os que JÁ estão corretos ═══`);
  const brunoEvents = await pool.query(`
    SELECT e.id, at.slug AS activity,
           e.started_at AT TIME ZONE 'America/New_York' AS ny_start,
           m.id AS msg_id, m.slack_user_id AS msg_account,
           LEFT(COALESCE(e.description, ''), 80) AS desc
    FROM v3.events e
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.messages m ON m.slack_ts = e.source_message_ts
    WHERE e.person_id = 7 AND e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1::date
    ORDER BY e.started_at`, [D]);
  for (const r of brunoEvents.rows) {
    const acct = r.msg_account === vitor.slack_user_id ? '(via Vitor✓)' : r.msg_account ? `(via ${r.msg_account})` : '(admin)';
    console.log(`  ev${r.id} ${fmt12h(r.ny_start)} ${r.activity} ${acct} "${r.desc}"`);
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
