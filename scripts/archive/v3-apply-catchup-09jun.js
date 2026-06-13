'use strict';
/* HEALTHFARE V3 — Catch-up manual 09/jun (architect review).
   GRUPO 1: 5 slug fix + 1 long_running + 2 batch fill + 2 count link + 1 INSERT downtime.
   Snapshot antes → transação idempotente → audit_log por op. Read+fix, sem LLM.
   Rodar: railway run --service ProductionLineService node scripts/v3-apply-catchup-09jun.js */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const EDT_DATE = "(started_at AT TIME ZONE 'America/New_York')::date = '2026-06-09'";

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // ── 1) SNAPSHOT ANTES ──
  const snapDir = path.join(__dirname, '..', 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });
  const snapPath = path.join(snapDir, '09jun-pre-catchup.json');
  const evSnap = await c.query(`SELECT * FROM v3.events WHERE ${EDT_DATE}`);
  const cntSnap = await c.query(`SELECT * FROM v3.production_counts WHERE (created_at AT TIME ZONE 'America/New_York')::date = '2026-06-09'`);
  fs.writeFileSync(snapPath, JSON.stringify({ note: 'pre-catchup 09jun (GRUPO 1)', events: evSnap.rows, counts: cntSnap.rows }, null, 2));
  console.log('SNAPSHOT: ' + snapPath + '  (events=' + evSnap.rowCount + ', counts=' + cntSnap.rowCount + ')');

  const META = (anomaly) => JSON.stringify({ architect_review: true, decision_source: 'slack_manual_audit', anomaly_type: anomaly });
  async function auditEvent(anomaly, id, before, after) {
    await c.query(`INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data, metadata)
      VALUES ('admin', NULL, 'manual_catchup_2026_06_09', 'event', $1, $2::jsonb, $3::jsonb, $4::jsonb)`,
      [id, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, META(anomaly)]);
  }

  await c.query('BEGIN');
  try {
    // ── slug fix (packaging=7, material_handling=28, encapsulation=3) ──
    for (const [id, act, label] of [[619, 7, 'packaging'], [622, 7, 'packaging'], [636, 7, 'packaging'], [629, 28, 'material_handling'], [633, 3, 'encapsulation']]) {
      const cur = (await c.query('SELECT activity_type_id FROM v3.events WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
      if (!cur) throw new Error('ev' + id + ' não encontrado');
      if (cur.activity_type_id === act) { console.log('  ev' + id + ' slug já=' + act + ' (skip)'); continue; }
      await c.query('UPDATE v3.events SET activity_type_id=$2, updated_at=NOW() WHERE id=$1', [id, act]);
      await auditEvent('slug_fix', id, { activity_type_id: cur.activity_type_id }, { activity_type_id: act });
      console.log('  ev' + id + ' slug ' + cur.activity_type_id + '→' + act + ' (' + label + ')');
    }
    // ── long_running ──
    {
      const cur = (await c.query('SELECT is_long_running FROM v3.events WHERE id=621 AND deleted_at IS NULL')).rows[0];
      if (!cur) throw new Error('ev621 não encontrado');
      if (cur.is_long_running === true) console.log('  ev621 lr já true (skip)');
      else {
        await c.query('UPDATE v3.events SET is_long_running=true, updated_at=NOW() WHERE id=621');
        await auditEvent('long_running_fix', 621, { is_long_running: cur.is_long_running }, { is_long_running: true });
        console.log('  ev621 is_long_running→true');
      }
    }
    // ── batch fill (BR-2026-0194=40, BR-2026-0190=39) ──
    for (const [id, batch] of [[608, 40], [612, 39]]) {
      const cur = (await c.query('SELECT product_batch_id FROM v3.events WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
      if (!cur) throw new Error('ev' + id + ' não encontrado');
      if (cur.product_batch_id === batch) { console.log('  ev' + id + ' batch já=' + batch + ' (skip)'); continue; }
      await c.query('UPDATE v3.events SET product_batch_id=$2, updated_at=NOW() WHERE id=$1', [id, batch]);
      await auditEvent('batch_fill', id, { product_batch_id: cur.product_batch_id }, { product_batch_id: batch });
      console.log('  ev' + id + ' batch ' + cur.product_batch_id + '→' + batch);
    }
    // ── count link ──
    for (const [id, evid] of [[46, 609], [47, 613]]) {
      const cur = (await c.query('SELECT source_event_id FROM v3.production_counts WHERE id=$1', [id])).rows[0];
      if (!cur) throw new Error('count#' + id + ' não encontrado');
      if (cur.source_event_id === evid) { console.log('  count#' + id + ' já linkado (skip)'); continue; }
      await c.query('UPDATE v3.production_counts SET source_event_id=$2, updated_at=NOW() WHERE id=$1', [id, evid]);
      await c.query(`INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data, metadata)
        VALUES ('admin', NULL, 'manual_catchup_2026_06_09', 'production_count', $1, $2::jsonb, $3::jsonb, $4::jsonb)`,
        [id, JSON.stringify({ source_event_id: cur.source_event_id }), JSON.stringify({ source_event_id: evid }), META('count_link')]);
      console.log('  count#' + id + ' source_event_id→' + evid);
    }
    // ── V06 machine_downtime INSERT (idempotente por source_message_ts) ──
    {
      const ts = '1781022212.313169';
      const exists = (await c.query("SELECT id FROM v3.events WHERE split_part(source_message_ts,'#',1)=split_part($1,'#',1) AND deleted_at IS NULL", [ts])).rows[0];
      if (exists) console.log('  V06 já existe ev' + exists.id + ' (skip insert)');
      else {
        const ins = await c.query(`INSERT INTO v3.events (person_id, activity_type_id, started_at, ended_at, description, source_message_ts, confidence, is_long_running)
          VALUES (4, 27, '2026-06-09 11:31:00 America/New_York', '2026-06-09 12:21:50 America/New_York', $1, $2, 'high', false) RETURNING id`,
          ['Pausa linha 50-55 min: manutencao maquina capsulas, rodando final formula Berberine manual, abastecimento linha, verificando erro formula berberine, recebimento sterate', ts]);
        const newid = ins.rows[0].id;
        await auditEvent('missing_event', newid, null, { person_id: 4, activity_type_id: 27, slug: 'machine_downtime', source_message_ts: ts });
        console.log('  V06 machine_downtime INSERIDO → ev' + newid);
      }
    }
    await c.query('COMMIT');
    console.log('COMMIT ok');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('ROLLBACK —', e.message);
    await c.end();
    process.exit(1);
  }

  // ── verificação pós-commit ──
  console.log('\n=== VERIFICAÇÃO pós-commit ===');
  const chk = await c.query(`
    SELECT e.id, p.display_name, at.slug, pb.batch_number, e.is_long_running,
      to_char(e.started_at AT TIME ZONE 'America/New_York','HH24:MI:SS') AS s,
      CASE WHEN e.ended_at IS NULL THEN 'OPEN' ELSE to_char(e.ended_at AT TIME ZONE 'America/New_York','HH24:MI:SS') END AS e_
    FROM v3.events e JOIN v3.persons p ON p.id=e.person_id
    LEFT JOIN v3.activity_types at ON at.id=e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id=e.product_batch_id
    WHERE e.id IN (619,622,636,629,633,621,608,612) OR (e.activity_type_id=27 AND e.person_id=4 AND (e.started_at AT TIME ZONE 'America/New_York')::date='2026-06-09')
    ORDER BY e.id`);
  chk.rows.forEach((r) => console.log('  ev' + r.id + ' ' + (r.display_name || '').padEnd(14) + (r.slug || '').padEnd(16) + ' b=' + (r.batch_number || '—').toString().padEnd(13) + ' lr=' + (r.is_long_running ? 'Y' : 'n') + ' ' + r.s + '→' + r.e_));
  const cnt = await c.query('SELECT id, bottles, source_event_id FROM v3.production_counts WHERE id IN (46,47) ORDER BY id');
  cnt.rows.forEach((r) => console.log('  count#' + r.id + ' bottles=' + r.bottles + ' source_event_id=' + r.source_event_id));
  const au = await c.query("SELECT COUNT(*)::int n FROM v3.audit_log WHERE action='manual_catchup_2026_06_09'");
  console.log('  audit_log manual_catchup_2026_06_09: ' + au.rows[0].n + ' linhas');

  await c.end();
}
main().then(() => process.exit(0), (e) => { console.error('FATAL', e.message); process.exit(1); });
