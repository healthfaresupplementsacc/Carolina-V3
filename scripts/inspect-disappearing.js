'use strict';
/* URGENTE: o sandbox-cleanup está deletando events REAIS? + tasks somindo. read-only. */
const { Pool } = require('pg');
const EDT = 'America/New_York';
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s, p) => pool.query(s, p).then((r) => r.rows);

  console.log('=== HIPÓTESE: events is_test=true de NÃO-sandbox (vazamento) ===');
  const leak = await q(`
    SELECT e.id, e.person_id, p.display_name, p.is_sandbox, e.is_test,
           to_char(e.started_at AT TIME ZONE '${EDT}','MM-DD HH24:MI') AS started, e.ended_at IS NULL AS open
    FROM v3.events e JOIN v3.persons p ON p.id = e.person_id
    WHERE e.is_test = true AND e.deleted_at IS NULL
    ORDER BY e.started_at DESC LIMIT 20`);
  if (!leak.length) console.log('  (nenhum event is_test=true ativo agora)');
  leak.forEach((e) => console.log(`  ev#${e.id} ${e.display_name}(is_sandbox=${e.is_sandbox}) is_test=${e.is_test} ${e.started} open=${e.open}  ${e.is_sandbox ? '' : '⚠️ VAZAMENTO!'}`));

  console.log('\n=== persons is_sandbox=true (só deveria ser o 🧪 Sandbox) ===');
  const sb = await q('SELECT id, display_name, is_sandbox FROM v3.persons WHERE is_sandbox = true');
  sb.forEach((p) => console.log(`  #${p.id} ${p.display_name}`));

  console.log('\n=== events de hoje dos operadores que reclamaram (Ana=6,Simone=5,BrunoS=7) ===');
  const rep = await q(`
    SELECT e.id, e.person_id, p.display_name, at.slug,
           to_char(e.started_at AT TIME ZONE '${EDT}','HH24:MI') AS started,
           to_char(e.ended_at   AT TIME ZONE '${EDT}','HH24:MI') AS ended,
           e.ended_at IS NULL AS open, e.is_test, e.closed_reason, e.deleted_at IS NOT NULL AS deleted
    FROM v3.events e JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE e.person_id IN (5,6,7)
      AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
    ORDER BY e.person_id, e.started_at`);
  rep.forEach((e) => console.log(`  ev#${e.id} ${e.display_name} ${e.slug} ${e.started}–${e.ended || 'ABERTO'} open=${e.open} test=${e.is_test} reason=${e.closed_reason || '-'} deleted=${e.deleted}`));

  console.log('\n=== audit: deleções/limpezas suspeitas hoje ===');
  const aud = await q(`
    SELECT action, COUNT(*)::int n FROM v3.audit_log
    WHERE created_at > NOW() - INTERVAL '14 hours'
      AND action IN ('event.deleted','sandbox.cleanup','session_cleanup','event.auto_closed','forgotten_checkout.cascade','clock_out')
    GROUP BY action ORDER BY n DESC`);
  aud.forEach((a) => console.log(`  ${a.action}: ${a.n}`));

  console.log('\n=== events fechados por worker/cascade hoje (não operator_page) ===');
  const closed = await q(`
    SELECT closed_reason, COUNT(*)::int n FROM v3.events
    WHERE (started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date
      AND ended_at IS NOT NULL
    GROUP BY closed_reason ORDER BY n DESC`);
  closed.forEach((c) => console.log(`  ${c.closed_reason || '(null)'}: ${c.n}`));

  await pool.end();
})().then(() => process.exit(0), (e) => { console.error('ERR', e.message); process.exit(1); });
