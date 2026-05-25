'use strict';
/**
 * Confirma após V2_DISABLED=1:
 *   - V3 Observer alive (heartbeat fresco)
 *   - fila V3 zerada (sem erros)
 *   - últimas mensagens processadas pelo V3 (não pelo V2)
 *   - msgs do canal admin do bot recentes (deve estar parando)
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

(async () => {
  const p = makeV3Pool();
  try {
    const hb = await p.query("SELECT value FROM v3.settings WHERE key = 'observer_last_tick_at'");
    const tickIso = hb.rows[0] && hb.rows[0].value;
    const tickMs = tickIso ? new Date(typeof tickIso === 'string' ? tickIso.replace(/"/g, '') : tickIso).getTime() : null;
    const ageSec = tickMs ? Math.round((Date.now() - tickMs) / 1000) : null;
    console.log('=== V3 Observer (heartbeat) ===');
    console.log(`  last_tick: ${tickIso}`);
    console.log(`  idade: ${ageSec}s  ${ageSec != null && ageSec < 60 ? '✓ vivo' : '⚠ velho'}`);

    const fila = await p.query('SELECT COUNT(*)::int c FROM v3.messages WHERE llm_processed_at IS NULL');
    const err = await p.query("SELECT COUNT(*)::int c FROM v3.messages WHERE processing_error IS NOT NULL AND llm_processed_at IS NULL");
    console.log(`\nfila V3 (não-processadas): ${fila.rows[0].c}`);
    console.log(`erros pendentes:           ${err.rows[0].c}`);

    console.log('\n=== últimas 5 mensagens V3 processadas (id desc) ===');
    const recent = await p.query(
      `SELECT id, slack_ts, llm_processed_at, llm_provider_used, events_created,
              LEFT(raw_text, 70) txt
       FROM v3.messages WHERE llm_processed_at IS NOT NULL
       ORDER BY id DESC LIMIT 5`);
    const fmt = (ts) => ts ? new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(ts)) : '—';
    for (const r of recent.rows) {
      console.log(`  id=${r.id} ${fmt(r.llm_processed_at)} provider=${r.llm_provider_used} created=${(r.events_created || []).length}`);
      console.log(`     "${(r.txt || '').replace(/\n/g, ' ')}"`);
    }

    // last admin-bot messages from public.* (legacy admin_audit_log) — proxy de "spam parou"
    try {
      const admin = await p.query(
        "SELECT id, created_at, action, LEFT(payload::text, 60) p FROM public.admin_audit_log WHERE created_at > NOW() - INTERVAL '30 minutes' ORDER BY id DESC LIMIT 5");
      console.log(`\n=== public.admin_audit_log nos últimos 30min (proxy de atividade legada): ${admin.rows.length} ===`);
      for (const r of admin.rows) {
        console.log(`  ${r.created_at.toISOString()} ${r.action} ${r.p || ''}`);
      }
    } catch (e) { console.log('admin_audit_log: ' + e.message); }
  } catch (e) { console.error('ERRO:', e.message); process.exitCode = 1; }
  finally { await p.end(); }
})();
