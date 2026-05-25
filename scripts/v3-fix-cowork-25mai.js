'use strict';
/**
 * 25/mai: marca cowork histórico nos events de P&P do Vitor + Simone.
 * - ev 149 (Vitor orders)        → cowork_with = [5] Simone
 * - ev 148 (Simone order_printing) → cowork_with = [4] Vitor
 * - ev 150 (Simone labeling)     → cowork_with = [4] Vitor
 * Via EventService.correct, auditado, reversível.
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');
const { EventService } = require('../src/v3/services/EventService');

const PLAN = [
  { id: 149, cowork_with: [5], who: 'Vitor → cowork=[Simone]' },
  { id: 148, cowork_with: [4], who: 'Simone → cowork=[Vitor]' },
  { id: 150, cowork_with: [4], who: 'Simone (labeling) → cowork=[Vitor]' },
];

(async () => {
  const p = makeV3Pool();
  try {
    const svc = new EventService({ db: p });
    const snap = async (id) => {
      const r = await p.query(
        `SELECT e.id, pn.display_name AS person, at.slug, e.started_at, e.ended_at, e.cowork_with
         FROM v3.events e
         LEFT JOIN v3.persons pn ON pn.id = e.person_id
         LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
         WHERE e.id = $1`, [id]);
      return r.rows[0];
    };
    const fmt = (ts) => ts ? new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(ts)) : '—';

    for (const t of PLAN) {
      console.log(`\n══ ${t.who} ══`);
      const before = await snap(t.id);
      console.log(`  ANTES : ev ${before.id} ${before.person} ${before.slug} ${fmt(before.started_at)}→${fmt(before.ended_at)} cowork=${JSON.stringify(before.cowork_with)}`);
      await svc.correct(t.id, { cowork_with: t.cowork_with }, null,
        '25/mai correção histórica de cowork — P&P Simone+Vitor (LLM não inferiu pelo EQUIPE state; regra atualizada daqui pra frente)',
        'admin');
      const after = await snap(t.id);
      console.log(`  DEPOIS: ev ${after.id} ${after.person} ${after.slug} ${fmt(after.started_at)}→${fmt(after.ended_at)} cowork=${JSON.stringify(after.cowork_with)}`);
    }

    console.log('\n══ audit_log (últimos 5min, alvos 148/149/150) ══');
    const aud = (await p.query(
      `SELECT id, created_at, actor_type, action, target_id
       FROM v3.audit_log
       WHERE created_at > NOW() - INTERVAL '5 minutes'
         AND target_type = 'event' AND target_id = ANY($1)
       ORDER BY created_at`,
      [PLAN.map((t) => t.id)])).rows;
    for (const a of aud) {
      console.log(`  audit ${a.id} ${a.created_at.toISOString()} ${a.actor_type} ${a.action} ev=${a.target_id}`);
    }

    console.log('\n══ pnpByDay(25/mai) após correção ══');
    const { FlowViewsRepo } = require('../src/v3/data/flow-views-repo');
    const pp = await new FlowViewsRepo({ db: p }).pnpByDay('2026-05-25');
    console.log(`  total_seconds(wall): ${pp.total_seconds}s = ${Math.round(pp.total_seconds / 60)}min (~${(pp.total_seconds / 3600).toFixed(2)}h)`);
    console.log(`  orders: ${pp.orders}, seconds_per_order: ${pp.seconds_per_order}`);
    console.log(`  person_seconds: ${JSON.stringify(pp.person_seconds)}`);
  } catch (e) {
    console.error('ERRO:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await p.end();
  }
})();
