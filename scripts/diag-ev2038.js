'use strict';
/* Bruno 07-10: EV 2038 - Vitor entrou numa LIMPEZA como cowork do Bruno Sarmento,
   mas o sistema marcou como se ele limpasse desde 9am. E a Carolina criou evento
   NOVO quando o admin avisou. railway run ... node scripts/diag-ev2038.js */
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const EDT = 'America/New_York';
const t = (x) => (x ? new Date(x).toLocaleString('en-US', { timeZone: EDT, hour12: false }) : '-');
const row = (o) => JSON.stringify(o);

(async () => {
  const ev = (await p.query(
    `SELECT e.*, at.slug, at.flow, at.slug AS act_name, pe.display_name AS person
       FROM v3.events e
       LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
       LEFT JOIN v3.persons pe ON pe.id = e.person_id
      WHERE e.id = 2038`)).rows[0];
  if (!ev) { console.log('EV 2038 nao existe'); await p.end(); return; }
  console.log('\n==== EV 2038 ====');
  console.log(row({ person: ev.person, person_id: ev.person_id, slug: ev.slug, flow: ev.flow, act: ev.act_name }));
  console.log(row({ started_at: t(ev.started_at), ended_at: t(ev.ended_at) }));
  console.log(row({ cowork_group_id: ev.cowork_group_id, bg_handoff_from: ev.bg_handoff_from_person_id }));
  console.log(row({ source: ev.source, source_message_ts: ev.source_message_ts }));
  console.log(row({ created_at: t(ev.created_at), production_date: ev.production_date, deleted_at: t(ev.deleted_at) }));

  if (ev.cowork_group_id) {
    const grp = (await p.query(
      `SELECT e.id, e.person_id, pe.display_name, e.started_at, e.ended_at, e.source, e.source_message_ts, e.created_at, e.deleted_at
         FROM v3.events e LEFT JOIN v3.persons pe ON pe.id = e.person_id
        WHERE e.cowork_group_id = $1 ORDER BY e.started_at, e.id`, [ev.cowork_group_id])).rows;
    console.log(`\n---- grupo cowork ${ev.cowork_group_id} (${grp.length}) ----`);
    grp.forEach((g) => console.log('  ' + row({ ev: g.id, who: g.display_name, start: t(g.started_at), end: t(g.ended_at), src: g.source, ts: g.source_message_ts, created: t(g.created_at), del: !!g.deleted_at })));
  }

  const people = (await p.query(
    `SELECT id, display_name FROM v3.persons WHERE display_name ILIKE '%vitor%' OR display_name ILIKE '%sarmento%'`)).rows;
  const ids = people.map((r) => r.id);
  console.log(`\n---- pessoas: ${people.map((r) => '#' + r.id + ' ' + r.display_name).join(' , ')} ----`);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: EDT });
  const evs = (await p.query(
    `SELECT e.id, pe.display_name, at.slug, e.started_at, e.ended_at, e.cowork_group_id, e.source, e.source_message_ts, e.created_at, e.deleted_at
       FROM v3.events e LEFT JOIN v3.persons pe ON pe.id = e.person_id
       LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      WHERE e.person_id = ANY($1::int[]) AND (e.started_at AT TIME ZONE 'America/New_York')::date = $2
      ORDER BY e.started_at, e.id`, [ids, today])).rows;
  console.log(`\n---- eventos de hoje (${today}) Vitor + Bruno Sarmento (${evs.length}) ----`);
  evs.forEach((e) => console.log('  ' + row({ ev: e.id, who: e.display_name, slug: e.slug, start: t(e.started_at), end: t(e.ended_at), cw: e.cowork_group_id, src: e.source, ts: e.source_message_ts, del: !!e.deleted_at })));

  try {
    const a2 = (await p.query(
      `SELECT created_at, action, actor_person_id, payload FROM v3.audit_log
        WHERE entity_type='event' AND entity_id = 2038 ORDER BY created_at LIMIT 40`)).rows;
    console.log(`\n---- audit_log ev2038 (${a2.length}) ----`);
    a2.forEach((a) => console.log('  ' + t(a.created_at) + ' ' + a.action + ' actor#' + a.actor_person_id + ' ' + JSON.stringify(a.payload).slice(0, 170)));
  } catch (e) { console.log('audit_log:', e.message); }
  console.log('');
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
