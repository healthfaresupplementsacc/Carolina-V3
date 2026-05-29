'use strict';
/* DIAG read-only — varredura 27-29/mai procurando vítimas do bug
   PersonResolver (corrigido em d7c351a).

   Duas categorias:
   (A) Events de produção atribuídos a admins (Bruno Camp id=1, Thassio
       id=2, Henrique id=3) — admins NÃO devem ser autores de production.
   (B) Events da conta U08JC85HMNE (Vitor's slack) atribuídos ao Bruno
       Sarmento (id=7) onde a msg NÃO tem assinatura "-Bruno". Indica
       herança de contexto que o LLM fez antes do fix.

   Lista sem corrigir. Bruno autoriza caso a caso. */
const { Pool } = require('pg');

const VITOR_SLACK = 'U08JC85HMNE';
const ADMIN_IDS = [1, 2, 3];
const BRUNO_SARMENTO_ID = 7;
const TODAY_RANGE = "(e.started_at AT TIME ZONE 'America/New_York')::date BETWEEN '2026-05-27' AND '2026-05-29'";

// Padrões de assinatura "-Nome" / "Nome-" — pra excluir do scan de Bruno-falsos-positivos.
// Se a msg TEM uma dessas assinaturas, NÃO é vítima (atribuição foi legítima).
function hasSignature(text) {
  if (!text) return false;
  const t = String(text).trim();
  // sufixo dash + primeiro nome (2+ letras)
  if (/-\s*[A-Za-zÀ-ÿ]{2,}\s*$/u.test(t)) return true;
  // prefixo nome- (2+ letras)
  if (/^\s*[A-Za-zÀ-ÿ]{2,}\s*-/u.test(t)) return true;
  // (nome) no fim
  if (/\(\s*[A-Za-zÀ-ÿ]{2,}\s*\)\s*$/u.test(t)) return true;
  // por Nome no fim
  if (/\bpor\s+[A-Za-zÀ-ÿ]{2,}\s*$/iu.test(t)) return true;
  return false;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' (A) Events PRODUÇÃO atribuídos a ADMIN (ids 1/2/3) — 27-29/mai');
  console.log('═══════════════════════════════════════════════════════════');
  const adminEvs = (await pool.query(`
    SELECT e.id, e.person_id, p.display_name AS person, p.role,
      at.slug, at.flow,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS s,
      TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS e_t,
      e.deleted_at, e.source_message_ts,
      m.id AS msg_id, m.slack_user_id, LEFT(m.raw_text, 140) AS raw_text
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.messages m ON m.slack_ts = e.source_message_ts
    WHERE e.person_id = ANY($1::int[])
      AND ${TODAY_RANGE}
    ORDER BY e.started_at`, [ADMIN_IDS])).rows;
  if (adminEvs.length === 0) console.log('  ✓ Nenhum event atribuído a admin nos últimos 3 dias.');
  for (const r of adminEvs) {
    const status = r.deleted_at ? '✓ DELETADO' : (r.flow === 'production' ? '⚠ ⚠ ⚠ PRODUCTION em admin LIVE' : `[${r.flow}]`);
    console.log(`\n  ev${r.id} ${status}`);
    console.log(`    ${r.person} (id=${r.person_id} ${r.role}) ${r.slug}/${r.flow}`);
    console.log(`    ${r.s}→${r.e_t || 'LIVE'}`);
    console.log(`    src=msg${r.msg_id || '?'} slack=${r.slack_user_id || '?'}`);
    console.log(`    text: "${(r.raw_text || '').slice(0, 120)}"`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' (B) Events Vitor-slack → Bruno (id=7) SEM assinatura — 27-29/mai');
  console.log('═══════════════════════════════════════════════════════════');
  const brunoEvs = (await pool.query(`
    SELECT e.id, e.person_id, at.slug, at.flow,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS s,
      TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH12:MI AM') AS e_t,
      e.deleted_at IS NOT NULL AS deleted, e.source_message_ts, e.confidence,
      m.id AS msg_id, m.raw_text, e.cowork_with,
      pb.batch_number, pr.canonical_name AS product
    FROM v3.events e
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    LEFT JOIN v3.messages m ON m.slack_ts = e.source_message_ts
    WHERE e.person_id = $1
      AND ${TODAY_RANGE}
      AND m.slack_user_id = $2
    ORDER BY e.started_at`, [BRUNO_SARMENTO_ID, VITOR_SLACK])).rows;
  console.log(`  ${brunoEvs.length} events Bruno-do-slack-do-Vitor no período.`);

  const suspects = [];
  for (const r of brunoEvs) {
    const signed = hasSignature(r.raw_text);
    if (signed) continue;        // assinatura legítima — não é vítima
    suspects.push(r);
  }
  console.log(`  ${suspects.length} sem assinatura "-Bruno" / "Bruno-" / "(Bruno)" / "por Bruno":\n`);
  for (const r of suspects) {
    console.log(`  ev${r.id}${r.deleted ? ' (DEL)' : ''} ${r.s}→${r.e_t || 'LIVE'} ${r.slug}/${r.flow}`);
    console.log(`    product=${r.product || '—'}/${r.batch_number || '—'} cw=${JSON.stringify(r.cowork_with)} conf=${r.confidence}`);
    console.log(`    src=msg${r.msg_id} text: "${(r.raw_text || '').slice(0, 120)}"`);
    console.log();
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' RESUMO');
  console.log('═══════════════════════════════════════════════════════════');
  const liveAdmin = adminEvs.filter((r) => !r.deleted_at);
  console.log(`  (A) Admin events ativos (não-deletados): ${liveAdmin.length}`);
  console.log(`      └─ production: ${liveAdmin.filter((r) => r.flow === 'production').length}`);
  console.log(`      └─ outros:     ${liveAdmin.filter((r) => r.flow !== 'production').length}`);
  console.log(`  (B) Bruno-via-Vitor-sem-assinatura: ${suspects.length}`);
  console.log(`      └─ não-deletados: ${suspects.filter((r) => !r.deleted).length}`);

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
