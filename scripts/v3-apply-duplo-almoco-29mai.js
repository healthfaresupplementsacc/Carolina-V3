'use strict';
/* Bruno OK em texto cru — bloco 29/mai-noite duplo-almoço.
   Idempotente, audited.

   TZ: NY 29/mai está em EDT (UTC-4). Uso ISO UTC explícito ('...Z')
   pra evitar repetir o bug do ev318 (passar timestamp sem offset
   → pg interpreta wrong).
     3:22:33 PM NY = 19:22:33 UTC
     4:57:00 PM NY = 20:57:00 UTC

   WRITES:
   1) PATCH ev311 (Vitor prod_line): ended_at 4:12 PM→3:22:33 PM,
      closed_reason='manual'.
   2) PATCH ev326 (Bruno phantom lunch → Vitor real lunch):
      person_id 7→4, ended_at LIVE→4:57 PM, closed_reason='meta_closed_by_fg'.
   3) SOFT-DELETE ev327 (Bruno dup phantom lunch). */
const { Pool } = require('pg');
const { EventService } = require('../src/v3/services/EventService');

const F_LINHA_UTC      = '2026-05-29T19:22:33Z';   // 3:22:33 PM NY
const LUNCH_END_UTC    = '2026-05-29T20:57:00Z';   // 4:57:00 PM NY

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const ev = new EventService({ db: pool });

  async function snap(id) {
    const r = await pool.query(`
      SELECT e.id, e.person_id, p.display_name AS person,
        at.slug AS activity, at.flow,
        TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI:SS AM') AS s,
        TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH12:MI:SS AM') AS e_t,
        e.started_at, e.ended_at, e.deleted_at, e.closed_reason, e.confidence
      FROM v3.events e
      LEFT JOIN v3.persons p ON p.id = e.person_id
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      WHERE e.id = $1`, [id]);
    return r.rows[0] || null;
  }
  const fmt = (s) => s
    ? `ev${s.id} ${s.person}(id=${s.person_id}) [${s.activity}/${s.flow}] ${s.s}→${s.e_t || 'LIVE'} closed_reason=${s.closed_reason || '—'}${s.deleted_at ? ' (DEL)' : ''}`
    : 'NULL';

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' BEFORE');
  console.log('═══════════════════════════════════════════════════════════');
  for (const id of [311, 326, 327]) console.log('  ' + fmt(await snap(id)));

  // ═══════════════════ WRITE 1 — PATCH ev311 ═══════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' WRITE 1 — PATCH ev311 ended_at=3:22:33 PM NY closed_reason=manual');
  console.log('═══════════════════════════════════════════════════════════');
  const b311 = await snap(311);
  if (b311 && b311.ended_at && new Date(b311.ended_at).toISOString() === new Date(F_LINHA_UTC).toISOString() && b311.closed_reason === 'manual') {
    console.log('  ev311 já patcheado — skip');
  } else {
    await ev.correct(311, {
      ended_at: F_LINHA_UTC,
      closed_reason: 'manual',
    }, null,
    'Bloco 29/mai-noite duplo-almoço: restaura F do msg711 ("F: Finalizando ajuda na linha para almocar") que ficou no-op porque LLM atribuiu close ao Bruno (Vitor sem assinatura na conta dele). Sistema corrigido sistemicamente em d7c351a (PersonResolver hard-skip). PATCH ended_at de 4:12 PM (auto-close de algum next_phase) pra 3:22:33 PM (timing real do F). Autorizado Bruno texto cru.',
    'admin');
    console.log('  ev311 PATCHED');
  }

  // ═══════════════════ WRITE 2 — PATCH ev326 ═══════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' WRITE 2 — PATCH ev326 person_id 7→4 ended_at=4:57 PM closed_reason=meta_closed_by_fg');
  console.log('═══════════════════════════════════════════════════════════');
  const b326 = await snap(326);
  if (b326 && b326.person_id === 4 && b326.ended_at) {
    console.log('  ev326 já patcheado — skip');
  } else {
    await ev.correct(326, {
      person_id: 4,
      ended_at: LUNCH_END_UTC,
      closed_reason: 'meta_closed_by_fg',
    }, null,
    'Bloco 29/mai-noite duplo-almoço: ev326 era lunch fantasma do Bruno criado pelo break_start do msg711 ("F: Finalizando ajuda na linha para almocar"). Mensagem era do Vitor (conta U08JC85HMNE sem assinatura -Nome) — LLM herdou Bruno do contexto da msg710 anterior. Re-atribui ao Vitor (person 4) e fecha em 4:57 PM (start do ev331 = Vitor voltando do almoço). Preserva audit chain reusando o event em vez de criar novo. Autorizado Bruno texto cru.',
    'admin');
    console.log('  ev326 PATCHED');
  }

  // ═══════════════════ WRITE 3 — SOFT-DELETE ev327 ═══════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' WRITE 3 — SOFT-DELETE ev327 (dup phantom lunch)');
  console.log('═══════════════════════════════════════════════════════════');
  const b327 = await snap(327);
  if (b327 && b327.deleted_at) {
    console.log('  ev327 já deletado — skip');
  } else if (b327) {
    await ev.softDelete(327, null,
      'Bloco 29/mai-noite duplo-almoço: dup phantom lunch criado pela msg712 ("S: Inicio Almoco") 7 segundos após msg711. Mesma intenção, mesmo autor (Vitor sem assinatura), mesma janela. Já tratado por ev326 (após reassign ao Vitor). Soft-delete pra remover o ruído. Autorizado Bruno texto cru.',
      'admin');
    console.log('  ev327 SOFT-DELETED');
  }

  // ═══════════════════ AFTER ═══════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' AFTER');
  console.log('═══════════════════════════════════════════════════════════');
  for (const id of [311, 326, 327]) console.log('  ' + fmt(await snap(id)));

  // ═══════════════════ Visão lunches Bruno + lunch+prod_line Vitor ═══════════════════
  console.log('\n  --- Bruno Sarmento (id=7) lunches do dia ---');
  const bs = (await pool.query(`
    SELECT e.id, at.slug,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS s,
      TO_CHAR(e.ended_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS e_t,
      e.deleted_at IS NOT NULL AS deleted
    FROM v3.events e LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE e.person_id = 7 AND at.slug = 'lunch'
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = '2026-05-29'
    ORDER BY e.started_at`)).rows;
  for (const r of bs) console.log(`    ev${r.id} ${r.s}→${r.e_t || 'LIVE'} lunch${r.deleted ? ' (DEL)' : ''}`);

  console.log('\n  --- Vitor (id=4) lunches + prod_line do dia ---');
  const vt = (await pool.query(`
    SELECT e.id, at.slug,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS s,
      TO_CHAR(e.ended_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS e_t,
      e.deleted_at IS NOT NULL AS deleted, e.closed_reason
    FROM v3.events e LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    WHERE e.person_id = 4 AND at.slug IN ('lunch', 'production_line')
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = '2026-05-29'
    ORDER BY e.started_at`)).rows;
  for (const r of vt) console.log(`    ev${r.id} ${r.s}→${r.e_t || 'LIVE'} ${r.slug} closed=${r.closed_reason || '—'}${r.deleted ? ' (DEL)' : ''}`);

  // ═══════════════════ AUDIT counts ═══════════════════
  const audit = await pool.query(`
    SELECT action, COUNT(*)::int AS c
    FROM v3.audit_log WHERE created_at >= NOW() - interval '2 minutes'
    GROUP BY action ORDER BY action`);
  console.log('\n  --- AUDIT últimos 2min ---');
  for (const r of audit.rows) console.log(`    ${r.action}: ${r.c}`);

  await pool.end();
  console.log('\n✓ Duplo-almoço corrigido.');
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
