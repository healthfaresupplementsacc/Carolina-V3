'use strict';
/**
 * Fix retroativo da sobreposição org×lunch do Vitor no 22/mai.
 * Opção B: encurta ev 123 pra 12:13→12:31 + cria parte 2 13:11→13:45.
 * Auditado via EventService (porta-única). Reversível.
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');
const { EventService } = require('../src/v3/services/EventService');

(async () => {
  const p = makeV3Pool();
  try {
    const svc = new EventService({ db: p });

    const snap = async (id) => {
      const r = await p.query(
        `SELECT e.id, e.person_id, pn.display_name AS person, at.slug AS activity,
                e.started_at, e.ended_at, e.phase_label, e.description, e.closed_reason
         FROM v3.events e
         LEFT JOIN v3.persons pn ON pn.id = e.person_id
         LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
         WHERE e.id = $1`, [id]);
      return r.rows[0];
    };
    const fmt = (ts) => ts ? new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
    }).format(new Date(ts)) : '—';
    const dur = (s, e) => {
      const ms = new Date(e).getTime() - new Date(s).getTime();
      const sec = Math.round(ms / 1000);
      return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
    };
    const show = (label, r) => {
      console.log(`  ${label}: ev ${r.id} ${r.person} (${r.person_id}) ${r.activity}`);
      console.log(`         ${fmt(r.started_at)} → ${fmt(r.ended_at)} (${dur(r.started_at, r.ended_at)})  reason=${r.closed_reason || '—'}`);
      console.log(`         phase="${r.phase_label || ''}"  desc="${(r.description || '').slice(0, 90)}"`);
    };

    // ── CORREÇÃO 1: encurta ev 123 ─────────────────────────────
    console.log('══════ encurta ev 123 (organização parte 1) ══════');
    show('ANTES ', await snap(123));
    await svc.correct(123, {
      ended_at: '2026-05-22T16:31:26.304Z',          // = ev 125 started_at
      closed_reason: 'paused_by_meta',
      description: 'Organização parte 1 — cortando sílica (correção manual auditoria 22/mai: almoço pausa foreground; ev original era 12:13→13:45 e engolia o lunch ev 125; agora dividido em duas partes).',
    }, null, 'auditoria 22/mai — split org×lunch (parte 1/2)', 'admin');
    show('DEPOIS', await snap(123));

    // ── CRIAÇÃO: parte 2 ──────────────────────────────────────
    console.log('\n══════ cria parte 2 (organização 13:11→13:45) ══════');
    const created = await svc.upsert({
      person_id: 4,                                  // Vitor
      activity_type_id: 12,                          // organization
      product_batch_id: null,
      started_at: '2026-05-22T17:11:56.365Z',        // = ev 125 ended_at
      ended_at:   '2026-05-22T17:45:29.543Z',        // = ev 123 ended_at ORIGINAL
      phase_label: 'Cortando sílica (continuação)',
      description: 'Organização parte 2 — continuação após almoço (correção manual auditoria 22/mai).',
      confidence: 'high',
      source_message_ts: null,
      actor_type: 'admin',
    });
    show('CRIADO', await snap(created.id));
    console.log(`  → novo event_id: ${created.id}`);

    // ── audit das mudanças ────────────────────────────────────
    console.log('\n══════ audit_log das mudanças (últimos 5min) ══════');
    const aud = await p.query(
      `SELECT id, created_at, actor_type, action, target_id, metadata
       FROM v3.audit_log
       WHERE target_type='event' AND target_id IN (123, $1)
         AND created_at > NOW() - INTERVAL '5 minutes'
       ORDER BY created_at`, [created.id]);
    for (const a of aud.rows) {
      console.log(`  audit ${a.id} ${a.created_at.toISOString()} ${a.actor_type} ${a.action} ev=${a.target_id}`);
    }

    console.log('\n══════ resumo final do bloco Vitor 12:13-13:45 ══════');
    for (const id of [123, 125, created.id]) show('  ', await snap(id));
    console.log(`\n  organização real total: 18m + 34m = 52min (não 1h31m que engolia o almoço)`);
  } catch (e) {
    console.error('ERRO:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await p.end();
  }
})();
