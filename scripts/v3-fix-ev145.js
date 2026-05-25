'use strict';
/**
 * 25/mai: cria activity_type 'marketplace_prep' (production, foreground)
 * e corrige ev 145 (Vitor) — encapsulação aberta → marketplace_prep fechado
 * 8:24→9:00 EDT. Via EventService.correct (auditado, reversível).
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');
const { EventService } = require('../src/v3/services/EventService');

(async () => {
  const p = makeV3Pool();
  try {
    const svc = new EventService({ db: p });

    // 1) INSERT activity_type marketplace_prep (idempotente — se já existir, pega)
    const existing = (await p.query("SELECT * FROM v3.activity_types WHERE slug = 'marketplace_prep'")).rows[0];
    let atRow;
    if (existing) {
      atRow = existing;
      console.log('marketplace_prep já existia (id=' + atRow.id + ') — pulando INSERT');
    } else {
      const ins = await p.query(
        `INSERT INTO v3.activity_types
           (slug, display_name, category, flow, phase_order, is_background, requires_product, active)
         VALUES ('marketplace_prep', 'Preparo p/ Marketplace (Contagem/FNSKU)',
                 'production_phase', 'production', NULL, false, true, true)
         RETURNING *`);
      atRow = ins.rows[0];
      await p.query(
        `INSERT INTO v3.audit_log (actor_type, action, target_type, target_id, after_data, metadata)
         VALUES ('admin', 'activity_type.created', 'activity_type', $1, $2::jsonb, $3::jsonb)`,
        [atRow.id, JSON.stringify(atRow),
          JSON.stringify({ note: 'criação manual 25/mai — FNSKU/contagem; preparo pra Amazon/Walmart' })]);
      console.log('✓ activity_type marketplace_prep criado: id=' + atRow.id);
    }
    console.log('  ' + JSON.stringify({
      id: atRow.id, slug: atRow.slug, display_name: atRow.display_name,
      flow: atRow.flow, category: atRow.category, is_background: atRow.is_background,
    }));

    // 2) BEFORE snapshot do ev 145
    const snap = async (id) => {
      const r = await p.query(
        `SELECT e.id, e.person_id, pn.display_name AS person, e.activity_type_id,
                at.slug, at.display_name AS activity, at.flow, at.is_background,
                e.started_at, e.ended_at, e.phase_label, e.description, e.confidence, e.closed_reason
         FROM v3.events e
         LEFT JOIN v3.persons pn ON pn.id = e.person_id
         LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
         WHERE e.id = $1`, [id]);
      return r.rows[0];
    };
    const fmt = (ts) => ts ? new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
    }).format(new Date(ts)) : '—';

    console.log('\n══ ev 145 ANTES ══');
    const before = await snap(145);
    console.log(JSON.stringify({
      id: before.id, person: before.person, slug: before.slug,
      flow: before.flow, is_background: before.is_background,
      started_at: fmt(before.started_at), ended_at: fmt(before.ended_at),
      phase_label: before.phase_label, confidence: before.confidence, closed_reason: before.closed_reason,
      description: (before.description || '').slice(0, 100),
    }, null, 2));

    // 3) correct() — muda activity_type, fecha, ajusta description/phase/conf/closed_reason
    await svc.correct(145, {
      activity_type_id: atRow.id,
      ended_at: '2026-05-25T13:00:53.886Z',  // = 9:00:53 EDT, ts da msg "F: Finalizado Contagem/FNSKU"
      phase_label: 'Contagem + FNSKU',
      description: 'Contagem + colocação de FNSKU no Vitamin B1 lote 0148 (preparo pra marketplace). Correção manual 25/mai: bug LLM emitiu 2 open_events sob o mesmo source_message_ts; o segundo sobrescreveu o primeiro. Sem sinal no Slack de formulação rodando paralelo após 9:00.',
      confidence: 'high',
      closed_reason: 'manual',
    }, null, '25/mai: corrige tipo (encaps bg → marketplace_prep fg) + fecha em 9:00 — bug-raiz da idempotência multi-action', 'admin');

    console.log('\n══ ev 145 DEPOIS ══');
    const after = await snap(145);
    console.log(JSON.stringify({
      id: after.id, person: after.person, slug: after.slug,
      flow: after.flow, is_background: after.is_background,
      started_at: fmt(after.started_at), ended_at: fmt(after.ended_at),
      phase_label: after.phase_label, confidence: after.confidence, closed_reason: after.closed_reason,
      description: (after.description || '').slice(0, 100),
    }, null, 2));

    // 4) audit ids
    console.log('\n══ audit_log (últimos 5 min, alvos relevantes) ══');
    const aud = await p.query(
      `SELECT id, created_at, actor_type, action, target_type, target_id
       FROM v3.audit_log
       WHERE created_at > NOW() - INTERVAL '5 minutes'
         AND ((target_type='activity_type' AND target_id=$1) OR (target_type='event' AND target_id=145))
       ORDER BY created_at`, [atRow.id]);
    for (const a of aud.rows) {
      console.log(`  audit ${a.id} ${a.created_at.toISOString()} ${a.actor_type} ${a.action} ${a.target_type}/${a.target_id}`);
    }
  } catch (e) {
    console.error('ERRO:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await p.end();
  }
})();
