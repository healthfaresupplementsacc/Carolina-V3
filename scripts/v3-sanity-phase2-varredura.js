'use strict';
/* Sanity check: re-roda a varredura 27-29/mai com o parser PHASE 2 atual.
   Conta quantos falsos positivos sumiram (eram menos detectados com PHASE 1
   mas agora PHASE 2 reconhece como assinatura legítima). Read-only. */
const { Pool } = require('pg');
const { PersonResolver } = require('../src/v3/services/PersonResolver');

const VITOR_SLACK = 'U08JC85HMNE';
const ADMIN_IDS = [1, 2, 3];
const BRUNO_SARMENTO_ID = 7;

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const resolver = new PersonResolver({ db: pool });

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' SANITY PHASE 2 — varredura 27-29/mai');
  console.log('═══════════════════════════════════════════════════════════\n');

  // (A) events de produção em admins ativos
  const adminEvs = (await pool.query(`
    SELECT e.id, e.deleted_at IS NOT NULL AS deleted, p.display_name AS person, at.flow
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE e.person_id = ANY($1::int[])
      AND (e.started_at AT TIME ZONE 'America/New_York')::date BETWEEN '2026-05-27' AND '2026-05-29'`,
    [ADMIN_IDS])).rows;
  const aActive = adminEvs.filter((r) => !r.deleted).length;
  console.log(`(A) Events em admins ATIVOS: ${aActive}`);

  // (B) events Bruno-via-Vitor 27-29/mai
  const brunoEvs = (await pool.query(`
    SELECT e.id, e.deleted_at IS NOT NULL AS deleted, m.raw_text
    FROM v3.events e
    LEFT JOIN v3.messages m ON m.slack_ts = e.source_message_ts
    WHERE e.person_id = $1
      AND (e.started_at AT TIME ZONE 'America/New_York')::date BETWEEN '2026-05-27' AND '2026-05-29'
      AND m.slack_user_id = $2`,
    [BRUNO_SARMENTO_ID, VITOR_SLACK])).rows;

  let phase2_signature = 0, phase2_ambiguous = 0, phase2_unknown = 0, phase2_owner = 0, phase2_mention = 0;
  const phase1Misses = [];     // que o parser PHASE 1 dash não pegou (falso positivo do scanner)
  const phase2Hits = [];       // PHASE 2 agora reconhece

  for (const r of brunoEvs) {
    if (r.deleted) continue;
    const res = await resolver.resolve(VITOR_SLACK, r.raw_text || '', `sanity.${r.id}`, { message_id: null });
    if (res.resolution_method === 'signature_match' || res.resolution_method === 'admin_signature') {
      phase2_signature++;
      // Era falso positivo da varredura PHASE 1 (parser PHASE 1 não cobria)?
      // Heurística: msg NÃO tem padrão dash claro `-Nome$` ou `^Nome-`
      const hasDashPhase1 = /-\s*[A-Za-zÀ-ÿ]{2,}\s*$/u.test(r.raw_text || '')
        || /^\s*[A-Za-zÀ-ÿ]{2,}\s*-/u.test(r.raw_text || '');
      if (!hasDashPhase1) phase2Hits.push({ ev: r.id, text: (r.raw_text || '').slice(0, 80), kind: res.detected_identification });
    } else if (res.resolution_method === 'ambiguous_signature') phase2_ambiguous++;
    else if (res.resolution_method === 'unknown_signature_name') phase2_unknown++;
    else if (res.resolution_method === 'owner_default') phase2_owner++;
    else if (res.resolution_method === 'mention_uncertain') phase2_mention++;
    else phase2_owner++; // fallback bucket
  }

  console.log(`(B) Events Bruno-via-Vitor (não-deletados): ${brunoEvs.filter((r) => !r.deleted).length}`);
  console.log(`    PHASE 2 resolve:`);
  console.log(`      signature_match:        ${phase2_signature}`);
  console.log(`      ambiguous_signature:    ${phase2_ambiguous}`);
  console.log(`      unknown_signature_name: ${phase2_unknown}`);
  console.log(`      mention_uncertain:      ${phase2_mention}`);
  console.log(`      owner_default:          ${phase2_owner}`);
  console.log();
  console.log(`  Casos onde PHASE 2 reconhece assinatura QUE PHASE 1 NÃO COBRIA (= falsos positivos da varredura sumiram):`);
  for (const h of phase2Hits) {
    console.log(`    ev${h.ev}: "${h.text}"`);
    console.log(`        → assinatura detectada: "${h.kind}"`);
  }
  console.log(`\n  Total falsos positivos resolvidos: ${phase2Hits.length}`);

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
