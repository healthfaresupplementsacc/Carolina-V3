'use strict';
/**
 * HEALTHFARE V3 — Investigação pré-correção dos events do 22/mai. READ-ONLY.
 * Sai com os dados necessários pra montar os UPDATEs sem chutar.
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

const DAY = '2026-05-22';
const TZ = 'America/New_York';

function fmt(ts) {
  if (!ts) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  }).format(new Date(ts));
}

(async () => {
  const p = makeV3Pool();
  try {
    // 1. activity_type_id do production_line e de review (pra ter os dois)
    const ats = await p.query(
      "SELECT id, slug, display_name, category, flow FROM v3.activity_types "
      + "WHERE slug IN ('production_line','review','encapsulation','lunch')");
    console.log('=== activity_types relevantes ===');
    for (const r of ats.rows) console.log(`  id=${r.id} slug=${r.slug} (${r.display_name}) cat=${r.category} flow=${r.flow}`);

    // 2. batch Tribulus BR-2026-0145
    const bat = await p.query(
      `SELECT pb.id, pb.batch_number, pb.product_id, pr.canonical_name, pb.status, pb.started_at
       FROM v3.product_batches pb
       LEFT JOIN v3.products pr ON pr.id = pb.product_id
       WHERE pb.batch_number = 'BR-2026-0145' AND pb.deleted_at IS NULL`);
    console.log('\n=== batches BR-2026-0145 ===');
    for (const r of bat.rows) console.log(`  id=${r.id} ${r.canonical_name} status=${r.status}`);

    // 3. ev 129 atual + check de overlap pro Vitor no novo intervalo
    const ev129 = await p.query('SELECT * FROM v3.events WHERE id = 129');
    console.log('\n=== ev 129 atual ===');
    console.log(JSON.stringify(ev129.rows[0], null, 2));

    const overlap129 = await p.query(`
      SELECT e.id, e.person_id, at.slug, at.category,
             e.started_at, e.ended_at, e.product_batch_id
      FROM v3.events e
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      WHERE e.person_id = 4 AND e.id <> 129 AND e.deleted_at IS NULL
        AND tstzrange(e.started_at, COALESCE(e.ended_at, NOW())) &&
            tstzrange('2026-05-22 17:45:00+00'::timestamptz, '2026-05-22 19:23:00+00'::timestamptz)
      ORDER BY e.started_at`);
    console.log(`\n=== Events do Vitor que sobrepoem o intervalo 13:45-15:23 (UTC 17:45-19:23) — ${overlap129.rows.length} ===`);
    for (const r of overlap129.rows) {
      console.log(`  ev ${r.id} ${r.slug} (${r.category}) ${fmt(r.started_at)} → ${r.ended_at ? fmt(r.ended_at) : 'aberto'}`);
    }

    // 4. mensagens posteriores da CONTA do ev 136 (Vitor shipping)
    const ev136 = await p.query('SELECT * FROM v3.events WHERE id = 136');
    const srcEv136 = await p.query('SELECT slack_user_id, raw_text FROM v3.messages WHERE slack_ts = $1',
      [ev136.rows[0].source_message_ts]);
    console.log('\n=== ev 136 (Vitor shipping aberto) ===');
    console.log(JSON.stringify(ev136.rows[0], null, 2));
    console.log('msg de origem:', srcEv136.rows[0]);
    if (srcEv136.rows[0]) {
      const later = await p.query(
        `SELECT m.slack_ts, m.created_at, m.raw_text, m.person_id
         FROM v3.messages m
         WHERE m.slack_user_id = $1
           AND m.created_at > $2
           AND (m.created_at AT TIME ZONE 'America/New_York')::date = $3
         ORDER BY m.created_at`,
        [srcEv136.rows[0].slack_user_id, ev136.rows[0].started_at, DAY]);
      console.log(`mensagens dessa conta APÓS ${fmt(ev136.rows[0].started_at)}: ${later.rows.length}`);
      for (const m of later.rows) {
        console.log(`  ${fmt(m.created_at)} ts=${m.slack_ts} person=${m.person_id}: "${(m.raw_text || '').slice(0, 140).replace(/\n/g, ' ')}"`);
      }
    }

    // 5. ev 141 (Bruno Sarmento review aberto)
    const ev141 = await p.query('SELECT * FROM v3.events WHERE id = 141');
    const srcEv141 = await p.query('SELECT slack_user_id, raw_text FROM v3.messages WHERE slack_ts = $1',
      [ev141.rows[0].source_message_ts]);
    console.log('\n=== ev 141 (Bruno Sarmento review aberto) ===');
    console.log(JSON.stringify(ev141.rows[0], null, 2));
    console.log('msg de origem:', srcEv141.rows[0]);
    if (srcEv141.rows[0]) {
      const later = await p.query(
        `SELECT m.slack_ts, m.created_at, m.raw_text, m.person_id
         FROM v3.messages m
         WHERE m.slack_user_id = $1
           AND m.created_at > $2
           AND (m.created_at AT TIME ZONE 'America/New_York')::date = $3
         ORDER BY m.created_at`,
        [srcEv141.rows[0].slack_user_id, ev141.rows[0].started_at, DAY]);
      console.log(`mensagens dessa conta APÓS ${fmt(ev141.rows[0].started_at)}: ${later.rows.length}`);
      for (const m of later.rows) {
        console.log(`  ${fmt(m.created_at)} ts=${m.slack_ts} person=${m.person_id}: "${(m.raw_text || '').slice(0, 140).replace(/\n/g, ' ')}"`);
      }
    }

    // 6. ev 138 (Bruno Sarmento lunch retroativo)
    const ev138 = await p.query('SELECT * FROM v3.events WHERE id = 138');
    const srcEv138 = await p.query('SELECT slack_user_id, raw_text, created_at FROM v3.messages WHERE slack_ts = $1',
      [ev138.rows[0].source_message_ts]);
    console.log('\n=== ev 138 (Bruno Sarmento lunch 3:53PM-5:00PM, retroativo) ===');
    console.log(JSON.stringify(ev138.rows[0], null, 2));
    console.log('msg de origem:', srcEv138.rows[0]);
    // mensagens do Bruno Sarmento ANTES e DURANTE o intervalo 12:31-13:10 (gap candidato)
    const brunoMsgs = await p.query(
      `SELECT m.slack_ts, m.created_at, m.raw_text, m.person_id
       FROM v3.messages m
       WHERE m.person_id = 7
         AND (m.created_at AT TIME ZONE 'America/New_York')::date = $1
       ORDER BY m.created_at`, [DAY]);
    console.log(`\nTodas as msgs de Bruno Sarmento (person_id=7) no dia: ${brunoMsgs.rows.length}`);
    for (const m of brunoMsgs.rows) {
      console.log(`  ${fmt(m.created_at)} ts=${m.slack_ts}: "${(m.raw_text || '').slice(0, 140).replace(/\n/g, ' ')}"`);
    }
  } catch (e) {
    console.error('ERRO:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await p.end();
  }
})();
