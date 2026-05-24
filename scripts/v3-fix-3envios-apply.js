'use strict';
/**
 * HEALTHFARE V3 — separação dos TRÊS envios (P&P cliente / DC produção / clínica suporte).
 *
 * 1) Cria activity_type dc_shipment    (production, foreground, fim-de-linha)
 * 2) Cria activity_type clinic_shipment (support, foreground, clínica)
 * 3) Renomeia shipping (id=9) display_name → "Envio Pedidos (cliente)"
 * 4) Reclassifica 6 events históricos via EventService.correct (auditado):
 *    ev 35,53,89  → clinic_shipment (Simone, "injeções")
 *    ev 99,103,136 → dc_shipment (Bruno×2 "fechando caixa" + Vitor "FBA")
 *
 * Auditado, reversível. Cada criação registra audit_log activity_type.created;
 * cada correct() registra event.corrected com before/after.
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');
const { EventService } = require('../src/v3/services/EventService');

const SIMONE_EVENTS = [35, 53, 89];
const DC_EVENTS = [99, 103, 136];

async function insertActivityType(client, row, actorType = 'admin') {
  const r = await client.query(
    `INSERT INTO v3.activity_types
       (slug, display_name, category, flow, phase_order, is_background, requires_product, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [row.slug, row.display_name, row.category, row.flow,
      row.phase_order || null, row.is_background, row.requires_product, row.active]);
  await client.query(
    `INSERT INTO v3.audit_log
       (actor_type, action, target_type, target_id, after_data, metadata)
     VALUES ($1, 'activity_type.created', 'activity_type', $2, $3::jsonb, $4::jsonb)`,
    [actorType, r.rows[0].id, JSON.stringify(r.rows[0]),
      JSON.stringify({ note: 'separação 3-envios: P&P/DC/clínica' })]);
  return r.rows[0];
}

async function renameShipping(client, newName, actorType = 'admin') {
  const before = (await client.query("SELECT * FROM v3.activity_types WHERE slug='shipping'")).rows[0];
  const after = (await client.query(
    "UPDATE v3.activity_types SET display_name = $1 WHERE id = $2 RETURNING *",
    [newName, before.id])).rows[0];
  await client.query(
    `INSERT INTO v3.audit_log
       (actor_type, action, target_type, target_id, before_data, after_data, metadata)
     VALUES ($1, 'activity_type.updated', 'activity_type', $2, $3::jsonb, $4::jsonb, $5::jsonb)`,
    [actorType, before.id, JSON.stringify(before), JSON.stringify(after),
      JSON.stringify({ note: 'rename pra desambiguar — fica em pnp pra pedidos de cliente' })]);
  return { before, after };
}

function fmtNy(ts) {
  if (!ts) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(ts));
}

async function snapEvent(p, id) {
  const r = await p.query(
    `SELECT e.id, e.person_id, pn.display_name AS person,
            e.activity_type_id, at.slug, at.display_name AS activity, at.flow,
            e.started_at, e.ended_at, e.description
     FROM v3.events e
     LEFT JOIN v3.persons pn ON pn.id = e.person_id
     LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
     WHERE e.id = $1`, [id]);
  return r.rows[0];
}

function showEv(label, r) {
  console.log(`  ${label}: ev ${r.id} ${r.person} (${r.person_id})`);
  console.log(`         activity_type_id=${r.activity_type_id} slug=${r.slug} (flow=${r.flow})`);
  console.log(`         ${fmtNy(r.started_at)} → ${fmtNy(r.ended_at)}`);
}

(async () => {
  const p = makeV3Pool();
  try {
    const svc = new EventService({ db: p });

    // ── 1+2+3 — criações e rename em uma transação ──
    const c = await p.connect();
    let dcAt; let clinicAt; let shipRename;
    try {
      await c.query('BEGIN');
      console.log('══════ 1) INSERT dc_shipment (production) ══════');
      dcAt = await insertActivityType(c, {
        slug: 'dc_shipment',
        display_name: 'Envio pro DC (FBA/WFS)',
        category: 'production_phase',
        flow: 'production',
        phase_order: null,
        is_background: false,
        requires_product: false,
        active: true,
      });
      console.log('  criado id=' + dcAt.id, JSON.stringify({
        slug: dcAt.slug, display_name: dcAt.display_name, category: dcAt.category,
        flow: dcAt.flow, is_background: dcAt.is_background,
      }));

      console.log('\n══════ 2) INSERT clinic_shipment (support) ══════');
      clinicAt = await insertActivityType(c, {
        slug: 'clinic_shipment',
        display_name: 'Envio Injeções (clínica)',
        category: 'support',
        flow: 'support',
        phase_order: null,
        is_background: false,
        requires_product: false,
        active: true,
      });
      console.log('  criado id=' + clinicAt.id, JSON.stringify({
        slug: clinicAt.slug, display_name: clinicAt.display_name, category: clinicAt.category,
        flow: clinicAt.flow,
      }));

      console.log('\n══════ 3) UPDATE shipping (id=9) display_name ══════');
      shipRename = await renameShipping(c, 'Envio Pedidos (cliente)');
      console.log(`  "${shipRename.before.display_name}" → "${shipRename.after.display_name}" (slug=${shipRename.after.slug}, flow=${shipRename.after.flow})`);

      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }

    // ── 4 — reclassificar os 6 events via EventService.correct ──
    console.log('\n══════ 4) reclassif dos 6 events (via EventService.correct) ══════');
    const tasks = [
      ...SIMONE_EVENTS.map((id) => ({ id, newAtId: clinicAt.id, dest: 'clinic_shipment' })),
      ...DC_EVENTS.map((id) => ({ id, newAtId: dcAt.id, dest: 'dc_shipment' })),
    ];
    for (const t of tasks) {
      const before = await snapEvent(p, t.id);
      showEv('ANTES ', before);
      await svc.correct(t.id, {
        activity_type_id: t.newAtId,
        description: (before.description || '') + ' · reclassificado modelo 3-envios',
      }, null, 'reclassif 3-envios: P&P (cliente) vs DC (produção) vs clínica (support)', 'admin');
      const after = await snapEvent(p, t.id);
      showEv('DEPOIS', after);
      console.log('');
    }

    // ── audit log do batch ──
    console.log('══════ audit_log das mudanças (últimos 5 min) ══════');
    const aud = await p.query(
      `SELECT id, created_at, actor_type, action, target_type, target_id
       FROM v3.audit_log
       WHERE created_at > NOW() - INTERVAL '5 minutes'
         AND (
           (target_type = 'activity_type' AND action IN ('activity_type.created','activity_type.updated'))
           OR (target_type = 'event' AND target_id = ANY($1))
         )
       ORDER BY created_at`, [tasks.map((t) => t.id)]);
    for (const a of aud.rows) {
      console.log(`  audit ${a.id} ${a.created_at.toISOString()} ${a.actor_type} ${a.action} ${a.target_type}/${a.target_id}`);
    }

    // ── estado final: contagem por slug + P&P do 22 ──
    console.log('\n══════ estado final ══════');
    const r1 = await p.query(
      "SELECT at.id, at.slug, at.display_name, at.flow, COUNT(e.id)::int AS evs FROM v3.activity_types at LEFT JOIN v3.events e ON e.activity_type_id = at.id AND e.deleted_at IS NULL WHERE at.slug IN ('shipping','dc_shipment','clinic_shipment') GROUP BY at.id ORDER BY at.id");
    for (const r of r1.rows) console.log(`  ${r.slug} (id=${r.id}) "${r.display_name}" flow=${r.flow} → ${r.evs} event(s) ativos`);

    // recalcula P&P do 22
    const { FlowViewsRepo } = require('../src/v3/data/flow-views-repo');
    const fv = new FlowViewsRepo({ db: p });
    const pp22 = await fv.pnpByDay('2026-05-22');
    console.log(`\n  P&P 22/mai: total = ${Math.round(pp22.total_seconds / 60)}min (~${(pp22.total_seconds / 3600).toFixed(2)}h)`);
    for (const s of pp22.sub_steps) console.log(`    - ${s.activity}: ${Math.round(s.seconds / 60)}min`);

    console.log('\n  IDs criados — guardar pra reverter se preciso:');
    console.log(`    dc_shipment    = ${dcAt.id}`);
    console.log(`    clinic_shipment = ${clinicAt.id}`);
  } catch (e) {
    console.error('ERRO:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await p.end();
  }
})();
