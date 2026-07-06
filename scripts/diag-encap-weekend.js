'use strict';
// Quando o encap-monitor REALMENTE disparou? (audit_log = à prova de deleção do Slack)
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const EDT = 'America/New_York';
(async () => {
  console.log('── encap_off_alert (últimos 5 dias, hora NY) ──');
  const a = await p.query(
    `SELECT to_char(created_at AT TIME ZONE '${EDT}', 'Dy DD/MM HH24:MI') AS t, metadata
       FROM v3.audit_log WHERE action='encap_off_alert' AND created_at > NOW() - INTERVAL '5 days'
       ORDER BY created_at`);
  if (!a.rows.length) console.log('  (nenhum disparo registrado)');
  for (const r of a.rows) console.log('  ' + r.t + '  ' + JSON.stringify(r.metadata));

  console.log('\n── dias com factory_active (eventos começados, últimos 5 dias) ──');
  const d = await p.query(
    `SELECT to_char((started_at AT TIME ZONE '${EDT}')::date, 'Dy DD/MM') AS dia, COUNT(*)::int n,
            to_char(MIN(started_at AT TIME ZONE '${EDT}'),'HH24:MI') AS primeiro,
            to_char(MAX(started_at AT TIME ZONE '${EDT}'),'HH24:MI') AS ultimo
       FROM v3.events WHERE deleted_at IS NULL AND COALESCE(is_test,false)=false
        AND started_at > NOW() - INTERVAL '5 days'
      GROUP BY 1 ORDER BY 1`);
  for (const r of d.rows) console.log('  ' + r.dia + ': ' + r.n + ' eventos (' + r.primeiro + '–' + r.ultimo + ')');

  console.log('\n── sessões abertas AGORA (logged_out_at IS NULL) ──');
  const s = await p.query(
    `SELECT pr.display_name, to_char(s.created_at AT TIME ZONE '${EDT}','Dy DD/MM HH24:MI') AS entrou,
            to_char(s.last_activity_at AT TIME ZONE '${EDT}','Dy DD/MM HH24:MI') AS ult_ativ,
            ROUND(EXTRACT(EPOCH FROM (NOW()-s.last_activity_at))/3600,1) AS h_parada
       FROM v3.operator_sessions s JOIN v3.persons pr ON pr.id=s.person_id
      WHERE s.logged_out_at IS NULL ORDER BY s.last_activity_at`);
  if (!s.rows.length) console.log('  (nenhuma)');
  for (const r of s.rows) console.log('  ' + r.display_name + ' — entrou ' + r.entrou + ', última atividade ' + r.ult_ativ + ' (' + r.h_parada + 'h atrás)');
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
