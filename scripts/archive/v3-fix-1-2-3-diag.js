'use strict';
/* FIX 1+2+3 — discovery + propostas. Read-only.
   1) slack_user_id da Simone hoje (msgs 587/602/603) vs catálogo
   2) plano dos 3 events retroativos da Simone (impressão / 2ª / finalizadas)
   3) varredura Vitor + Bruno Sarmento 28/mai */
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const TODAY = '2026-05-28';

  // ── FIX 1 — slack_user_ids da Simone hoje vs catálogo ──────
  console.log('══════════════════════════════════════════════════');
  console.log(' FIX 1 — slack_user_id da Simone hoje vs catálogo');
  console.log('══════════════════════════════════════════════════');

  const persons = await pool.query(`SELECT id, display_name, slack_user_id, active FROM v3.persons WHERE deleted_at IS NULL ORDER BY id`);
  console.log('\n  CATÁLOGO completo:');
  for (const p of persons.rows) {
    console.log(`    id=${p.id}  ${(p.display_name || '').padEnd(15)}  slack=${p.slack_user_id || '—'}  active=${p.active}`);
  }
  const simoneCatalog = persons.rows.find((p) => p.display_name === 'Simone');
  console.log(`\n  Simone cadastrada com slack_user_id = ${simoneCatalog ? simoneCatalog.slack_user_id : '(NÃO ACHADA)'}`);

  console.log('\n  Msgs HOJE 28/mai das 3 "supostamente da Simone" + outras dela:');
  const simoneMsgs = await pool.query(`
    SELECT m.id, m.slack_user_id, m.slack_channel_id, m.person_id,
      TO_CHAR(to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_ts,
      p.display_name AS resolved,
      m.events_created, m.events_updated,
      LEFT(m.raw_text, 130) AS txt
    FROM v3.messages m
    LEFT JOIN v3.persons p ON p.id = m.person_id
    WHERE m.id IN (587, 596, 601, 602, 605, 609, 612, 613)
    ORDER BY m.slack_ts::numeric`);
  for (const r of simoneMsgs.rows) {
    const matchCatalog = r.slack_user_id === (simoneCatalog && simoneCatalog.slack_user_id) ? ' ✓ catalog' : ' ⚠ DIFERENTE do catalog';
    console.log(`    msg${r.id} ${r.ny_ts} slack=${r.slack_user_id}${matchCatalog}  resolved=${r.resolved || 'NULL'}  ev:[${r.events_created || []}+${r.events_updated || []}]  "${r.txt}"`);
  }

  // Aggregate por slack_user_id usado HOJE
  console.log('\n  TODOS os slack_user_ids únicos do dia 28/mai (e contagem de msgs):');
  const slacksToday = await pool.query(`
    SELECT m.slack_user_id, COUNT(*)::int AS msgs,
      p.display_name AS catalog_person,
      ARRAY_AGG(DISTINCT (m.raw_text ~ '(?i)\\\\bSimone\\\\b' OR m.raw_text ILIKE '%Naturmineral%' OR m.raw_text ILIKE '%impressao ordens%' OR m.raw_text ILIKE '%Psyllium%')::text)
        AS could_be_simone
    FROM v3.messages m
    LEFT JOIN v3.persons p ON p.slack_user_id = m.slack_user_id
    WHERE (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = $1::date
    GROUP BY m.slack_user_id, p.display_name
    ORDER BY msgs DESC`, [TODAY]);
  for (const r of slacksToday.rows) {
    console.log(`    slack=${r.slack_user_id}  ${r.msgs} msgs  catálogo=${r.catalog_person || 'NÃO REGISTRADO'}  toca_simone=${r.could_be_simone}`);
  }

  // ── FIX 2 — proposta dos 3 events retroativos ──────────────
  console.log('\n══════════════════════════════════════════════════');
  console.log(' FIX 2 — proposta dos 3 events retroativos da Simone');
  console.log('══════════════════════════════════════════════════');

  // activity_type_ids relevantes
  const ats = await pool.query(`
    SELECT id, slug FROM v3.activity_types
    WHERE slug IN ('order_printing','order_printing_2','orders','labeling','packaging')`);
  const slugToId = Object.fromEntries(ats.rows.map((r) => [r.slug, r.id]));
  console.log('  Activity types disponíveis:', slugToId);

  // Pega ts/raw das 3 msgs alvo
  const targetMsgs = await pool.query(`
    SELECT m.id, m.slack_ts,
      TO_CHAR(to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_12h,
      to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York' AS ny_ts_full,
      m.raw_text
    FROM v3.messages m
    WHERE m.id IN (587, 596, 601)
    ORDER BY m.slack_ts::numeric`);
  for (const r of targetMsgs.rows) {
    console.log(`\n  msg${r.id} ${r.ny_12h}: "${r.raw_text}"`);
  }

  console.log(`\n  PLANO — 3 events sequenciais (1 abre, próxima fecha):`);
  console.log(`
    ev_A:  person_id=5 (Simone)
           activity_type_id=${slugToId.order_printing} (order_printing)
           started_at=msg587 (10:09 AM)
           ended_at  =msg596 (11:27 AM)         ← "F: segunda impresssao feita" fecha
           quantity=129, quantity_unit='order'
           description='Impressão de ordens — 129 ordens. Criado retroativo
             (msg587 não gerou event automático por slack_user_id não-resolvido).'

    ev_B:  person_id=5 (Simone)
           activity_type_id=${slugToId.order_printing_2} (order_printing_2)
           started_at=msg596 (11:27 AM)           ← "F: segunda impresssao" => 2ª impr START aqui? Hmm
           ended_at  =msg601 (12:01 PM)         ← "F: ordens finalizadas" fecha
           description='Segunda impressão de ordens. Criado retroativo.'

    ⚠ ATENÇÃO interpretação: msg596 'F: segunda impresssao feita' diz que a 2ª impressão
      JÁ FOI FEITA quando chegou. Então:
        (a) Se a 2ª impressão começou EM 10:09 (junto com a 1ª) e terminou em 11:27 → AMBAS overlap
        (b) Se a 1ª terminou e a 2ª começou em ALGUM ponto entre 10:09 e 11:27, mas o time
            não posto S: pra 2ª → assumir start = msg596 (~11:27 fechamento) é estranho
        (c) Mais provável: msg587 abriu 'impressão' como UM bloco e msg596 'F: segunda' fechou
            esse bloco (terminologia da Simone: ela diz "segunda impressão" pra dizer "fechei").
            Nesse caso é só 2 events, não 3.

    Preciso teu input — Bruno: msg587/596/601 são 3 fases SEPARADAS de P&P ou 2?
    Posso fazer 2 alternativas:

      OPÇÃO A — 3 events sequenciais:
        order_printing 10:09→11:27 (qty=129)
        order_printing_2 11:27→11:27 (zero duration — ou skip)
        orders 11:27→12:01 (finalização)

      OPÇÃO B — 2 events (assumindo "segunda impressão = fim da impressão"):
        order_printing 10:09→11:27 (qty=129)
        orders 11:27→12:01 (finalização das ordens)

    ev_C:  person_id=5 (Simone)
           activity_type_id=${slugToId.orders} (orders)
           started_at=msg596 ou ev_B end
           ended_at  =msg601 (12:01 PM)
           description='Finalização das ordens.'`);

  // ── FIX 3 — varredura Vitor + Bruno Sarmento ──────────────
  console.log('\n══════════════════════════════════════════════════');
  console.log(' FIX 3 — varredura Vitor + Bruno Sarmento 28/mai');
  console.log('══════════════════════════════════════════════════');

  for (const [pid, pname] of [[4, 'Vitor'], [7, 'Bruno Sarmento']]) {
    console.log(`\n  ${pname} (id=${pid}) — MSGS+EVENTS lado a lado:`);
    const msgs = await pool.query(`
      SELECT m.id, m.slack_user_id, m.slack_ts,
        TO_CHAR(to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_ts,
        m.person_id AS resolved_id, p.display_name AS resolved_name,
        m.events_created, m.events_updated,
        LEFT(m.raw_text, 130) AS txt
      FROM v3.messages m
      LEFT JOIN v3.persons p ON p.id = m.person_id
      WHERE (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = $1::date
        AND (
          m.slack_user_id = (SELECT slack_user_id FROM v3.persons WHERE id = $2)
          OR ARRAY[$2::int] && m.events_created
          OR ARRAY[$2::int] && m.events_updated
          OR m.raw_text ILIKE '%' || $3::text || '%'
        )
      ORDER BY m.slack_ts::numeric`, [TODAY, pid, pname.split(' ')[0]]);
    for (const m of msgs.rows) {
      const evs = [...(m.events_created || []), ...(m.events_updated || [])];
      let assignedTo = '';
      if (evs.length > 0) {
        const e = await pool.query(`SELECT id, person_id, p.display_name FROM v3.events e LEFT JOIN v3.persons p ON p.id = e.person_id WHERE e.id = ANY($1::int[])`, [evs]);
        assignedTo = e.rows.map((r) => `ev${r.id}→${r.display_name}`).join(', ');
      }
      console.log(`    msg${m.id} ${m.ny_ts} slack=${m.slack_user_id} resolved=${m.resolved_name || 'NULL'}  ev=[${evs}] ${assignedTo}`);
      console.log(`      "${m.txt}"`);
    }

    console.log(`\n  ${pname} — EVENTS atribuídos hoje:`);
    const evs = await pool.query(`
      SELECT e.id, at.slug AS activity,
        TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_start,
        TO_CHAR(e.ended_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS ny_end,
        pr.canonical_name AS product, pb.batch_number AS batch,
        e.cowork_with,
        LEFT(COALESCE(e.description,''), 90) AS desc
      FROM v3.events e
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
      LEFT JOIN v3.products pr ON pr.id = pb.product_id
      WHERE e.person_id = $1 AND e.deleted_at IS NULL
        AND (e.started_at AT TIME ZONE 'America/New_York')::date = $2::date
      ORDER BY e.started_at`, [pid, TODAY]);
    for (const e of evs.rows) {
      console.log(`    ev${e.id} ${e.ny_start}→${e.ny_end || 'LIVE'} ${e.activity} ${e.product || '—'}/${e.batch || '—'} cw=[${e.cowork_with}] "${e.desc}"`);
    }
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
