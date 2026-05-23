'use strict';
/**
 * HEALTHFARE V3 — Aplica as correções de dado do dia 22/mai/2026.
 *
 * Correção 1: ev 129 (Vitor review→production_line, Tribulus 0145).
 * Correção 2a: ev 138 lunch encurta p/ 15:53→16:38 (volta real 16:38).
 * Correção 2b: cria repair 16:38→17:00 Bruno Sarmento, Rutin 0160.
 *
 * Tudo via EventService (porta-única, audit_log, reversível). Não
 * toca llm_corrections — é correção de DADO, não de aprendizado.
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');
const { EventService } = require('../src/v3/services/EventService');

(async () => {
  const p = makeV3Pool();
  try {
    const svc = new EventService({ db: p });

    // ── lookups ──
    const ats = await p.query(
      "SELECT id, slug FROM v3.activity_types WHERE slug IN ('production_line','repair','review','lunch')");
    const A = Object.fromEntries(ats.rows.map((r) => [r.slug, r.id]));
    const ID_LINHA = A.production_line;
    const ID_REPAIR = A.repair;

    const b145 = await p.query("SELECT id FROM v3.product_batches WHERE batch_number='BR-2026-0145' AND deleted_at IS NULL");
    const BATCH_TRIB = b145.rows[0].id;
    const b160 = await p.query("SELECT id FROM v3.product_batches WHERE batch_number='BR-2026-0160' AND deleted_at IS NULL");
    const BATCH_RUTIN = b160.rows[0].id;

    console.log('IDs resolvidos:');
    console.log(`  production_line = ${ID_LINHA}`);
    console.log(`  repair          = ${ID_REPAIR}`);
    console.log(`  Tribulus 0145   = batch_id ${BATCH_TRIB}`);
    console.log(`  Rutin 0160      = batch_id ${BATCH_RUTIN}`);

    // ── snapshot helper ──
    const snap = async (id) => {
      const r = await p.query(
        `SELECT e.id, e.person_id, pn.display_name AS person, at.slug AS activity,
                pb.batch_number, pr.canonical_name AS product,
                e.started_at, e.ended_at, e.phase_label, e.description,
                e.confidence, e.cowork_with, e.closed_reason
         FROM v3.events e
         LEFT JOIN v3.persons pn ON pn.id = e.person_id
         LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
         LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
         LEFT JOIN v3.products pr ON pr.id = pb.product_id
         WHERE e.id = $1`, [id]);
      return r.rows[0];
    };
    const show = (label, r) => {
      const fmt = (ts) => ts ? new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
      }).format(new Date(ts)) : '—';
      console.log(`  ${label}: ev ${r.id} — ${r.person} (${r.person_id}) / ${r.activity} / ${r.product || '—'}${r.batch_number ? '/' + r.batch_number : ''}`);
      console.log(`         ${fmt(r.started_at)} → ${fmt(r.ended_at)}  conf=${r.confidence} cowork=[${(r.cowork_with || []).join(',')}]`);
      console.log(`         phase="${r.phase_label || ''}"  desc="${(r.description || '').slice(0, 100)}"`);
    };

    // ══════ CORREÇÃO 1 — ev 129 ══════
    console.log('\n══════ CORREÇÃO 1 — ev 129 (Vitor: review → production_line Tribulus 0145) ══════');
    show('ANTES ', await snap(129));
    await svc.correct(129, {
      activity_type_id: ID_LINHA,
      product_batch_id: BATCH_TRIB,
      phase_label: 'Linha de Produção',
      description: 'Vitor assume a linha de produção do Tribulus 0145 (correção manual auditoria 22/mai: msg 1779471929 descrevia 2 pessoas — "Vitor assumindo a LINHA e a Ana indo para a REVISÃO"; o LLM atribuiu review ao Vitor por engano).',
      confidence: 'high',
    }, null, 'auditoria 22/mai correção 1: review→production_line', 'admin');
    show('DEPOIS', await snap(129));

    // ══════ CORREÇÃO 2a — ev 138 lunch encurta ══════
    console.log('\n══════ CORREÇÃO 2a — ev 138 (lunch Bruno Sarmento: 17:00 → 16:38) ══════');
    show('ANTES ', await snap(138));
    await svc.correct(138, {
      ended_at: '2026-05-22T16:38:00-04:00',
    }, null, 'auditoria 22/mai correção 2a: Bruno admin informou volta real do almoço 16:38; msg "voltei do almoço" das 17:00 foi lançada depois. Lunch real ≈ 45min.', 'admin');
    show('DEPOIS', await snap(138));

    // ══════ CORREÇÃO 2b — cria repair 16:38→17:00 ══════
    console.log('\n══════ CORREÇÃO 2b — cria repair 16:38→17:00 (Bruno Sarmento, Rutin 0160) ══════');
    const created = await svc.upsert({
      person_id: 7,
      activity_type_id: ID_REPAIR,
      product_batch_id: BATCH_RUTIN,
      started_at: '2026-05-22T16:38:00-04:00',
      ended_at: '2026-05-22T17:00:00-04:00',
      phase_label: 'Manutenção',
      description: 'Manutenção Rutin e Potassium (correção manual auditoria 22/mai: Bruno admin reconstruiu — volta do almoço foi 16:38; gap 16:38→17:00 foi manutenção, não almoço).',
      confidence: 'high',
      source_message_ts: null,
      actor_type: 'admin',
    });
    show('CRIADO', await snap(created.id));
    console.log(`  → novo event_id: ${created.id}`);

    // ══════ audit_log das mudanças ══════
    console.log('\n══════ audit_log das mudanças (últimos 5 min) ══════');
    const audit = await p.query(
      `SELECT id, created_at, actor_type, actor_person_id, action, target_id, metadata
       FROM v3.audit_log
       WHERE target_type='event' AND target_id IN (129, 138, $1)
         AND created_at > NOW() - INTERVAL '5 minutes'
       ORDER BY created_at`, [created.id]);
    for (const a of audit.rows) {
      console.log(`  audit ${a.id}: ${a.created_at.toISOString()} ${a.actor_type} ${a.action} ev=${a.target_id} meta=${JSON.stringify(a.metadata).slice(0, 120)}`);
    }

    // ══════ resumo ══════
    console.log('\n══════ resumo ══════');
    console.log(`  ev 129 corrigido (1 audit entry: event.corrected)`);
    console.log(`  ev 138 corrigido (1 audit entry: event.corrected)`);
    console.log(`  ev ${created.id} criado (1 audit entry: event.created)`);
    console.log('  Reversível: cada correct() tem before/after no audit_log; o create reverte via softDelete.');
  } catch (e) {
    console.error('ERRO:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await p.end();
  }
})();
