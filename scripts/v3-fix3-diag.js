'use strict';
// HEALTHFARE V3 — FIX 3 — diagnóstico das mensagens de hoje (21/mai). Read-only.
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

function nyDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

(async () => {
  const p = makeV3Pool();
  try {
    const date = process.argv[2] || nyDate();
    console.log('AGORA UTC:', new Date().toISOString(), '| dia analisado (NY):', date);

    const day = (await p.query(
      `SELECT id, slack_ts, slack_user_id, created_at, llm_processed_at, claimed_at,
              processing_error, LEFT(raw_text,48) txt
       FROM v3.messages
       WHERE (created_at AT TIME ZONE 'America/New_York')::date = $1
       ORDER BY created_at`, [date])).rows;
    const proc = day.filter((m) => m.llm_processed_at);
    const fila = day.filter((m) => !m.llm_processed_at);
    const err = day.filter((m) => m.processing_error);
    console.log(`\nmensagens de ${date} em v3.messages: ${day.length}`);
    console.log(`  processadas: ${proc.length} | na fila: ${fila.length} | com processing_error: ${err.length}`);

    if (fila.length) {
      console.log('  PRESAS:');
      for (const m of fila) {
        console.log(`    id=${m.id} claimed_at=${m.claimed_at ? m.claimed_at.toISOString() : 'NULL'}`
          + ` err=${m.processing_error || '-'} "${(m.txt || '').replace(/\n/g, ' ')}"`);
      }
    }

    // fila/erro globais
    const filaTot = (await p.query('SELECT COUNT(*) c FROM v3.messages WHERE llm_processed_at IS NULL')).rows[0].c;
    const errTot = (await p.query('SELECT COUNT(*) c FROM v3.messages WHERE processing_error IS NOT NULL')).rows[0].c;
    console.log(`\nglobal: fila=${filaTot} | com erro=${errTot}`);

    // webhook ao vivo — última msg recebida + topo
    const last = (await p.query(
      'SELECT id, slack_ts, created_at, LEFT(raw_text,40) txt FROM v3.messages ORDER BY id DESC LIMIT 5')).rows;
    console.log('\núltimas 5 mensagens recebidas (id desc):');
    for (const m of last) {
      console.log(`  id=${m.id} ${m.created_at.toISOString()} "${(m.txt || '').replace(/\n/g, ' ')}"`);
    }

    // heartbeat
    const hb = (await p.query("SELECT value FROM v3.settings WHERE key = 'observer_last_tick_at'")).rows[0];
    const hbVal = hb && (typeof hb.value === 'string' ? hb.value.replace(/"/g, '') : hb.value);
    const ageS = hbVal ? Math.round((Date.now() - new Date(hbVal).getTime()) / 1000) : null;
    console.log(`\nheartbeat: ${hbVal} (${ageS != null ? ageS + 's atrás' : '?'}) — worker ${ageS != null && ageS < 120 ? 'VIVO' : 'verificar'}`);

    // distribuição de autoria do dia (events) — pra ver Vitor vs Simone
    const evByPerson = (await p.query(
      `SELECT pe.display_name, COUNT(*) n
       FROM v3.events e LEFT JOIN v3.persons pe ON pe.id = e.person_id
       WHERE e.deleted_at IS NULL AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1
       GROUP BY pe.display_name ORDER BY n DESC`, [date])).rows;
    console.log(`\nevents de ${date} por pessoa:`);
    for (const r of evByPerson) console.log(`  ${r.display_name || '?'}: ${r.n}`);
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    await p.end().catch(() => {});
  }
})();
