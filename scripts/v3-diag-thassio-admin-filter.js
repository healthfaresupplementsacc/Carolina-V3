'use strict';
/* DIAG — Thassio (admin id=2) eventos de produção 28/mai + verificação do
   admin filter no Observer. Read-only. */
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' 1. CATÁLOGO de admins (v3.persons.role IN owner/manager)');
  console.log('═══════════════════════════════════════════════════════════');
  const admins = (await pool.query(`
    SELECT id, display_name, role, slack_user_id
    FROM v3.persons
    WHERE deleted_at IS NULL AND role IN ('owner', 'manager')
    ORDER BY id`)).rows;
  for (const a of admins) {
    console.log(`  id=${a.id} ${a.display_name} (role=${a.role}, slack=${a.slack_user_id || '—'})`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 2. EVENTOS atribuídos a admins na semana (qualquer fluxo)');
  console.log('═══════════════════════════════════════════════════════════');
  const adminIds = admins.map((a) => a.id);
  if (adminIds.length === 0) { console.log('  (nenhum admin no catálogo)'); }
  else {
    const evs = (await pool.query(`
      SELECT e.id, e.person_id, p.display_name AS person, p.role,
        at.slug AS activity, at.flow,
        TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS ny_start,
        TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS ny_end,
        e.deleted_at,
        e.source_message_ts
      FROM v3.events e
      LEFT JOIN v3.persons p ON p.id = e.person_id
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      WHERE e.person_id = ANY($1::int[])
        AND e.started_at >= NOW() - interval '7 days'
      ORDER BY e.started_at DESC`, [adminIds])).rows;
    if (evs.length === 0) {
      console.log('  ✓ Nenhum evento atribuído a admin nos últimos 7 dias.');
    } else {
      for (const r of evs) {
        const flag = (r.flow === 'production' ? '⚠ PRODUÇÃO' : `[${r.flow || '?'}]`)
          + (r.deleted_at ? ' (SOFT-DELETED)' : '');
        console.log(`  ev${r.id} ${flag} ${r.person} ${r.activity || 'NULL'} ${r.ny_start}→${r.ny_end || 'LIVE'}`);
        console.log(`     source_ts=${r.source_message_ts || 'NULL'}`);
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 3. AUDIT_LOG — eventos criados por LLM/observer pra admin');
  console.log('═══════════════════════════════════════════════════════════');
  // Procura criações onde target person é admin (proxy: actor_person_id ou
  // metadata→person_id no payload). Cruza com a tabela events.
  const adminEvts = (await pool.query(`
    SELECT al.id, al.action, al.actor_type, al.actor_person_id, al.target_id,
      al.metadata->>'person_id' AS meta_person,
      al.created_at
    FROM v3.audit_log al
    WHERE al.action IN ('event.created', 'event.upserted')
      AND al.actor_type = 'observer'
      AND (al.metadata->>'person_id')::int = ANY($1::int[])
      AND al.created_at >= NOW() - interval '7 days'
    ORDER BY al.created_at DESC
    LIMIT 20`, [adminIds])).rows;
  if (adminEvts.length === 0) {
    console.log('  ✓ Observer NÃO criou eventos pra admin nos últimos 7 dias.');
  } else {
    console.log(`  ⚠ ${adminEvts.length} eventos criados pelo Observer com person_id admin:`);
    for (const r of adminEvts) console.log(`    audit#${r.id} ev${r.target_id} action=${r.action} created=${r.created_at}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 4. SHARED ACCOUNTS que mapeiam admin → user');
  console.log('═══════════════════════════════════════════════════════════');
  const sa = (await pool.query(`
    SELECT sa.slack_user_id, sa.description,
      json_agg(json_build_object('person_id', sau.person_id, 'name', p.display_name, 'role', p.role)) AS users
    FROM v3.shared_accounts sa
    LEFT JOIN v3.shared_account_users sau ON sau.shared_account_id = sa.slack_user_id AND sau.active = true
    LEFT JOIN v3.persons p ON p.id = sau.person_id
    GROUP BY sa.slack_user_id, sa.description
    ORDER BY sa.slack_user_id`)).rows;
  for (const r of sa) {
    const adminUsers = (r.users || []).filter((u) => u && (u.role === 'owner' || u.role === 'manager'));
    if (adminUsers.length > 0) {
      console.log(`  ${r.slack_user_id} (${r.description || '—'}) tem usuário admin:`);
      for (const u of adminUsers) console.log(`    person_id=${u.person_id} ${u.name} (${u.role})`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 5. ÚLTIMOS 5 MSGS recentes que mencionam admin slack_user_id');
  console.log('═══════════════════════════════════════════════════════════');
  const slackIds = admins.map((a) => a.slack_user_id).filter(Boolean);
  if (slackIds.length === 0) { console.log('  (nenhum admin tem slack_user_id direto)'); }
  else {
    const msgs = (await pool.query(`
      SELECT m.id, m.slack_user_id, m.slack_ts, m.status, m.events_created, m.events_updated,
        TO_CHAR(to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS ny,
        LEFT(m.raw_text, 100) AS txt
      FROM v3.messages m
      WHERE m.slack_user_id = ANY($1::text[])
        AND to_timestamp(m.slack_ts::numeric) >= NOW() - interval '3 days'
      ORDER BY m.slack_ts::numeric DESC LIMIT 10`, [slackIds])).rows;
    for (const m of msgs) {
      console.log(`  msg${m.id} ${m.ny} from=${m.slack_user_id} status=${m.status}`);
      console.log(`    events_created=${JSON.stringify(m.events_created || [])} events_updated=${JSON.stringify(m.events_updated || [])}`);
      console.log(`    "${m.txt}"`);
    }
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
