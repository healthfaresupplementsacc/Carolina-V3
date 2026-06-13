'use strict';
/* FIX 3 — varredura Vitor + Bruno Sarmento 28/mai. Read-only. */
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const TODAY = '2026-05-28';

  for (const [pid, pname] of [[4, 'Vitor'], [7, 'Bruno Sarmento']]) {
    console.log(`\n══════════════════════════════════════════════════`);
    console.log(` ${pname} (id=${pid}) — ANÁLISE 28/mai`);
    console.log(`══════════════════════════════════════════════════`);

    // EVENTS atribuídos hoje
    console.log(`\n  EVENTS atribuídos a ${pname}:`);
    const evs = await pool.query(`
      SELECT e.id, at.slug AS activity, at.is_background, at.category,
        TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_start,
        TO_CHAR(e.ended_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_end,
        pr.canonical_name AS product, pb.batch_number AS batch,
        e.cowork_with, e.source_message_ts,
        LEFT(COALESCE(e.description,''), 100) AS desc
      FROM v3.events e
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
      LEFT JOIN v3.products pr ON pr.id = pb.product_id
      WHERE e.person_id = $1 AND e.deleted_at IS NULL
        AND (e.started_at AT TIME ZONE 'America/New_York')::date = $2::date
      ORDER BY e.started_at`, [pid, TODAY]);
    for (const e of evs.rows) {
      const flag = e.category === 'meta' ? '[META]' : e.is_background ? '[bg]' : '[fg]';
      console.log(`    ev${e.id} ${e.ny_start}→${e.ny_end || 'LIVE'} ${flag} ${e.activity || 'NULL'} ${e.product || '—'}/${e.batch || '—'} cw=[${e.cowork_with}]`);
      console.log(`      desc: "${e.desc}"`);
    }

    // MSGS de hoje com PROBABILIDADE de ser dessa pessoa
    console.log(`\n  MSGS hoje que mencionam/podem ser ${pname}:`);
    // estratégia: slack do user OR signature com nome OR aparece em events do user
    const slackId = (await pool.query(`SELECT slack_user_id FROM v3.persons WHERE id = $1`, [pid])).rows[0].slack_user_id;
    const firstName = pname.split(' ')[0];
    const msgs = await pool.query(`
      SELECT m.id, m.slack_user_id, m.slack_ts,
        TO_CHAR(to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_ts,
        m.events_created, m.events_updated,
        LEFT(m.raw_text, 140) AS txt
      FROM v3.messages m
      WHERE (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = $1::date
        AND (
          m.slack_user_id = $2
          OR m.raw_text ~* CONCAT('\\\\m', $3::text, '\\\\M')
          OR ARRAY[$4::int] && (
            SELECT array_agg(e2.id) FROM v3.events e2
            WHERE e2.person_id = $4::int
              AND (e2.started_at AT TIME ZONE 'America/New_York')::date = $1::date
          )::int[]
        )
      ORDER BY m.slack_ts::numeric`, [TODAY, slackId, firstName, pid]);

    for (const m of msgs.rows) {
      const evIds = [...(m.events_created || []), ...(m.events_updated || [])];
      let attr = '';
      if (evIds.length > 0) {
        const eRes = await pool.query(`
          SELECT e.id, p.display_name AS pname
          FROM v3.events e LEFT JOIN v3.persons p ON p.id = e.person_id
          WHERE e.id = ANY($1::int[])`, [evIds]);
        attr = ' → ' + eRes.rows.map((r) => `ev${r.id}=${r.pname || '?'}`).join(', ');
      }
      const mine = m.slack_user_id === slackId ? '(do account)' : '(não-do-account)';
      console.log(`    msg${m.id} ${m.ny_ts} slack=${m.slack_user_id} ${mine}${attr}`);
      console.log(`      "${m.txt}"`);
    }
  }

  // Casos específicos suspeitos
  console.log(`\n══════════════════════════════════════════════════`);
  console.log(` CASOS SUSPEITOS — ev268 e ev280`);
  console.log(`══════════════════════════════════════════════════`);
  const susp = await pool.query(`
    SELECT e.id, p.display_name AS person, at.slug AS activity, at.is_background,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_start,
      pr.canonical_name AS product,
      e.source_message_ts,
      m.id AS msg_id, m.slack_user_id, mp.display_name AS msg_owner,
      LEFT(m.raw_text, 160) AS msg_txt,
      e.description
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    LEFT JOIN v3.messages m ON m.slack_ts = e.source_message_ts
    LEFT JOIN v3.persons mp ON mp.slack_user_id = m.slack_user_id
    WHERE e.id IN (268, 280)`);
  for (const r of susp.rows) {
    console.log(`\n  ev${r.id} ${r.ny_start} ${r.person} ${r.activity}${r.is_background ? '[bg]' : '[fg]'} ${r.product || '—'}`);
    console.log(`    desc: "${r.description}"`);
    console.log(`    msg${r.msg_id} de slack=${r.slack_user_id} (${r.msg_owner || 'não-cadastrado'})`);
    console.log(`    msg txt: "${r.msg_txt}"`);
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
