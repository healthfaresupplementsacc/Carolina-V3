'use strict';
// FIX 4 — verificação do timeline de hoje. Read-only.
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

(async () => {
  const p = makeV3Pool();
  try {
    const date = process.argv[2] || '2026-05-21';
    const fila = (await p.query('SELECT COUNT(*) c FROM v3.messages WHERE llm_processed_at IS NULL')).rows[0].c;
    const err = (await p.query('SELECT COUNT(*) c FROM v3.messages WHERE processing_error IS NOT NULL')).rows[0].c;
    console.log(`global: fila=${fila} | erro=${err}`);

    const ev = (await p.query(
      `SELECT pe.display_name pn, at.display_name act, e.started_at, e.ended_at, e.confidence, e.cowork_with
       FROM v3.events e
       LEFT JOIN v3.persons pe ON pe.id = e.person_id
       LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
       WHERE e.deleted_at IS NULL AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1
       ORDER BY pe.display_name, e.started_at`, [date])).rows;
    console.log(`\ntimeline ${date} (${ev.length} events):`);
    for (const r of ev) {
      const hh = String(r.started_at.toISOString()).slice(11, 16);
      const cw = (r.cowork_with || []).length ? ' 🔗' : '';
      console.log(`  ${(r.pn || '?').padEnd(16)} ${(r.act || '(s/ tipo)').padEnd(24)} ${hh} ${r.confidence}${cw}`);
    }
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    await p.end().catch(() => {});
  }
})();
