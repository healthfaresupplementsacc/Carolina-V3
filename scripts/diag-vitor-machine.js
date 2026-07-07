'use strict';
// O que aconteceu com a responsabilidade da máquina do Vitor hoje (07-07)?
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const EDT = 'America/New_York';
(async () => {
  const ids = (await p.query(
    "SELECT id, display_name, is_machine_operator FROM v3.persons WHERE display_name ILIKE ANY(ARRAY['Vitor%','Bruno Sarmento%']) AND deleted_at IS NULL")).rows;
  console.log('pessoas:', ids.map((x) => x.display_name + '(#' + x.id + ',mach=' + x.is_machine_operator + ')').join(', '));
  const idList = ids.map((x) => x.id);

  console.log('\n── EVENTOS de hoje (Vitor + Bruno), em ordem ──');
  const ev = await p.query(
    `SELECT e.id, pr.display_name AS quem, at.slug,
            to_char(e.started_at AT TIME ZONE '${EDT}','HH24:MI:SS') AS ini,
            to_char(e.ended_at AT TIME ZONE '${EDT}','HH24:MI:SS') AS fim,
            e.closed_reason, e.source, e.bg_handoff_from_person_id AS hoff_from,
            e.is_long_running AS bg
       FROM v3.events e JOIN v3.persons pr ON pr.id=e.person_id
       JOIN v3.activity_types at ON at.id=e.activity_type_id
      WHERE e.person_id = ANY($1::int[]) AND e.deleted_at IS NULL
        AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
      ORDER BY e.started_at`, [idList]);
  for (const r of ev.rows) {
    console.log(`  #${r.id} ${r.quem.padEnd(15)} ${r.slug.padEnd(16)} ${r.ini}→${r.fim || '(aberto)'}  ${r.bg ? '[bg]' : '[fg]'}` +
      (r.hoff_from ? ` hoff_from=#${r.hoff_from}` : '') + (r.closed_reason ? ` close=${r.closed_reason}` : '') + ` src=${r.source}`);
  }

  console.log('\n── AUDIT machine.* de hoje ──');
  const au = await p.query(
    `SELECT to_char(created_at AT TIME ZONE '${EDT}','HH24:MI:SS') AS t, action, actor_person_id, metadata
       FROM v3.audit_log WHERE action LIKE 'machine.%'
        AND (created_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
      ORDER BY created_at`);
  if (!au.rows.length) console.log('  (nenhum)');
  for (const r of au.rows) console.log(`  ${r.t}  ${r.action}  actor=#${r.actor_person_id}  ${JSON.stringify(r.metadata)}`);

  console.log('\n── sessões de hoje (Vitor + Bruno) ──');
  const se = await p.query(
    `SELECT pr.display_name, to_char(s.created_at AT TIME ZONE '${EDT}','HH24:MI') AS entrou,
            to_char(s.logged_out_at AT TIME ZONE '${EDT}','HH24:MI') AS saiu, s.logoff_reason,
            to_char(s.last_activity_at AT TIME ZONE '${EDT}','HH24:MI') AS ult
       FROM v3.operator_sessions s JOIN v3.persons pr ON pr.id=s.person_id
      WHERE s.person_id = ANY($1::int[]) AND (s.created_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
      ORDER BY s.created_at`, [idList]);
  for (const r of se.rows) console.log(`  ${r.display_name.padEnd(15)} entrou ${r.entrou}, saiu ${r.saiu || '(aberta)'} ${r.logoff_reason || ''}, últ.ativ ${r.ult}`);
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
