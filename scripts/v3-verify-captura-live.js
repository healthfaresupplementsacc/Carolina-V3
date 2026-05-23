'use strict';
/**
 * Verifica que o cérebro novo está rodando em prod:
 *  - worker heartbeat fresco (< 60s)
 *  - fila / erros
 *  - últimas mensagens processadas (provam que o Observer está vivo
 *    sem erro de "column does not exist")
 *  - últimos events gravados pelo Observer (mostrando os campos novos
 *    quando aplicáveis)
 *  - smoke do kind via _kindOf: lê 1 activity_type background + 1 fg.
 * READ-ONLY.
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

(async () => {
  const p = makeV3Pool();
  try {
    const fmt = (ts) => ts ? new Date(ts).toISOString() : '—';
    const fmtNy = (ts) => ts ? new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(ts)) : '—';

    const hb = await p.query("SELECT value FROM v3.settings WHERE key = 'observer_last_tick_at'");
    const tickIso = hb.rows[0] && hb.rows[0].value;
    const tickMs = tickIso ? new Date(typeof tickIso === 'string' ? tickIso : tickIso).getTime() : null;
    const ageSec = tickMs ? Math.round((Date.now() - tickMs) / 1000) : null;
    console.log('=== Worker heartbeat ===');
    console.log(`  observer_last_tick_at: ${tickIso}`);
    console.log(`  idade: ${ageSec}s  ${ageSec != null && ageSec < 60 ? '✓ vivo' : '⚠ velho'}`);

    const fila = await p.query('SELECT COUNT(*)::int c FROM v3.messages WHERE llm_processed_at IS NULL');
    const erros = await p.query("SELECT COUNT(*)::int c FROM v3.messages WHERE processing_error IS NOT NULL AND llm_processed_at IS NULL");
    console.log(`\nfila (não processadas): ${fila.rows[0].c}`);
    console.log(`erros pendentes:       ${erros.rows[0].c}`);
    if (erros.rows[0].c > 0) {
      const errSample = await p.query(
        "SELECT id, slack_ts, LEFT(processing_error, 200) e FROM v3.messages WHERE processing_error IS NOT NULL AND llm_processed_at IS NULL ORDER BY id DESC LIMIT 5");
      console.log('  ⚠ amostra de erros:');
      for (const r of errSample.rows) console.log(`    id=${r.id} ts=${r.slack_ts}: ${r.e}`);
    }

    console.log('\n=== últimas 10 mensagens processadas (id desc) ===');
    const recent = await p.query(
      `SELECT id, slack_ts, llm_processed_at, llm_provider_used, processing_error,
              events_created, events_updated, LEFT(raw_text, 80) txt
       FROM v3.messages WHERE llm_processed_at IS NOT NULL
       ORDER BY id DESC LIMIT 10`);
    for (const r of recent.rows) {
      console.log(`  id=${r.id} ts=${r.slack_ts} ${fmtNy(r.llm_processed_at)} provider=${r.llm_provider_used} created=${(r.events_created || []).length} updated=${(r.events_updated || []).length} err=${r.processing_error || '—'}`);
      console.log(`     "${(r.txt || '').replace(/\n/g, ' ')}"`);
    }

    console.log('\n=== últimos 10 events gravados (com kind derivado) ===');
    const evs = await p.query(
      `SELECT e.id, e.person_id, pn.display_name AS person,
              at.slug, at.display_name AS activity, at.category, at.is_background,
              e.started_at, e.ended_at, e.quantity, e.quantity_unit, e.closed_reason
       FROM v3.events e
       LEFT JOIN v3.persons pn ON pn.id = e.person_id
       LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
       WHERE e.deleted_at IS NULL
       ORDER BY e.id DESC LIMIT 10`);
    for (const e of evs.rows) {
      const kind = e.category === 'meta' ? 'meta'
        : (e.is_background ? 'background' : 'foreground');
      const qty = e.quantity != null ? `${e.quantity} ${e.quantity_unit || ''}` : '';
      console.log(`  ev ${e.id} ${e.person || '?'} (${e.person_id}) — ${e.slug || '?'} [${kind}] ${fmtNy(e.started_at)}→${e.ended_at ? fmtNy(e.ended_at) : 'aberto'}  ${qty}  ${e.closed_reason ? '['+e.closed_reason+']' : ''}`);
    }

    console.log('\n=== smoke do kind (confere que SELECT category, is_background funciona) ===');
    const k1 = await p.query(
      "SELECT id, slug, category, is_background FROM v3.activity_types WHERE slug='formulation'");
    const k2 = await p.query(
      "SELECT id, slug, category, is_background FROM v3.activity_types WHERE slug='production_line'");
    const k3 = await p.query(
      "SELECT id, slug, category, is_background FROM v3.activity_types WHERE slug='lunch'");
    console.log('  formulation:', k1.rows[0]);
    console.log('  production_line:', k2.rows[0]);
    console.log('  lunch:', k3.rows[0]);
  } catch (e) {
    console.error('ERRO:', e.message);
    process.exitCode = 1;
  } finally {
    await p.end();
  }
})();
