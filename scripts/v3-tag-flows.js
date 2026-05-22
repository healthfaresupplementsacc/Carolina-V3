'use strict';
/**
 * HEALTHFARE V3 — Bloco 1 — classifica os activity_types nos 3 fluxos.
 *
 * Atribui flow + phase_order a cada activity_type e cria as fases de
 * Picking & Packing que ainda não existem. O fluxo de cada event é
 * DERIVADO do activity_type (via join) — então "re-tag retroativo" é
 * só taguear o catálogo aqui; nenhum UPDATE em v3.events.
 *
 * MODOS:
 *   (default / --dry-run)  imprime o plano. ZERO escrita.
 *   --apply                executa em transação única, auditado.
 *
 * Pré-req: migration 004 já rodou (v3.flows + colunas).
 *
 *   railway run ... node scripts/v3-tag-flows.js              # dry-run
 *   railway run ... node scripts/v3-tag-flows.js --apply
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

// ── plano: slug → fluxo/ordem (+ category nova quando deve mudar) ──
// production: sequência provável do handoff §5 (ajustável — é o que
// o dry-run serve pra revisar). support: sem ordem. pnp: ver abaixo.
const FLOW_MAP = {
  // FLUXO PRODUÇÃO (ordenado) — category fica 'production_phase'
  formulation:     { flow: 'production', phase_order: 1 },
  mixing:          { flow: 'production', phase_order: 2 },
  encapsulation:   { flow: 'production', phase_order: 3 },
  review:          { flow: 'production', phase_order: 4 },
  production_line: { flow: 'production', phase_order: 5 },
  counting:        { flow: 'production', phase_order: 6 },
  // FLUXO P&P (ordenado) — category vira 'pnp_phase'
  labeling:        { flow: 'pnp', phase_order: 3, category: 'pnp_phase' },
  packaging:       { flow: 'pnp', phase_order: 4, category: 'pnp_phase' },
  shipping:        { flow: 'pnp', phase_order: 6, category: 'pnp_phase' },
  orders:          { flow: 'pnp', phase_order: null, category: 'pnp_phase' }, // genérico P&P
  // FLUXO SUPORTE (não-ordenado) — category preservada (support / meta)
  cleaning:        { flow: 'support', phase_order: null },
  repair:          { flow: 'support', phase_order: null },
  organization:    { flow: 'support', phase_order: null },
  training:        { flow: 'support', phase_order: null },
  meeting:         { flow: 'support', phase_order: null },
  break:           { flow: 'support', phase_order: null }, // category 'meta' — NÃO mexer
  lunch:           { flow: 'support', phase_order: null }, // category 'meta' — NÃO mexer
  end_of_day:      { flow: 'support', phase_order: null }, // category 'meta' — NÃO mexer
};

// ── fases de P&P que faltam (handoff §6) — criar ──
const NEW_PNP = [
  { slug: 'order_printing',   display_name: 'Impressão de Ordens',     phase_order: 1, emoji: '🖨' },
  { slug: 'order_printing_2', display_name: '2ª Impressão de Ordens',  phase_order: 2, emoji: '🖨' },
  { slug: 'box_closing',      display_name: 'Fechar Caixas',           phase_order: 5, emoji: '📦' },
];

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = makeV3Pool();
  const client = await pool.connect();
  try {
    console.log(`==== V3 BLOCO 1 — taguear fluxos/fases (${apply ? 'APPLY' : 'DRY-RUN'}) ====\n`);

    const existing = (await client.query(
      'SELECT id, slug, display_name, category, flow, phase_order FROM v3.activity_types ORDER BY id')).rows;
    const evCounts = {};
    for (const r of (await client.query(
      `SELECT activity_type_id, COUNT(*) n FROM v3.events
       WHERE deleted_at IS NULL GROUP BY activity_type_id`)).rows) {
      evCounts[r.activity_type_id] = parseInt(r.n, 10);
    }

    // classifica os existentes
    const mapped = [];
    const unmapped = [];
    for (const a of existing) {
      const plan = FLOW_MAP[a.slug];
      if (plan) mapped.push({ a, plan });
      else unmapped.push(a);
    }
    const existingSlugs = new Set(existing.map((a) => a.slug));
    const toCreate = NEW_PNP.filter((p) => !existingSlugs.has(p.slug));

    // ── relatório ──
    const FLOWS = ['production', 'pnp', 'support'];
    for (const flow of FLOWS) {
      const inFlow = mapped.filter((m) => m.plan.flow === flow)
        .sort((x, y) => (x.plan.phase_order || 99) - (y.plan.phase_order || 99));
      console.log(`── FLUXO ${flow.toUpperCase()} ──`);
      for (const { a, plan } of inFlow) {
        const ord = plan.phase_order == null ? ' · ' : ` ${plan.phase_order} `;
        const catChange = plan.category && plan.category !== a.category
          ? ` [category ${a.category}→${plan.category}]` : '';
        const ev = evCounts[a.id] || 0;
        console.log(`  ${ord} ${a.slug.padEnd(18)} "${a.display_name}"  · ${ev} event(s)${catChange}`);
      }
      if (flow === 'pnp' && toCreate.length) {
        for (const p of toCreate) {
          console.log(`  ${p.phase_order}  ${p.slug.padEnd(18)} "${p.display_name}"  · NOVO (category pnp_phase)`);
        }
      }
      console.log('');
    }
    if (unmapped.length) {
      console.log('── ⚠️ NÃO MAPEADOS (decidir) ──');
      for (const a of unmapped) console.log(`  ${a.slug} "${a.display_name}" (category ${a.category})`);
      console.log('');
    }

    console.log('==== RESUMO ====');
    console.log(`activity_types existentes:   ${existing.length}`);
    console.log(`  → mapeados a um fluxo:      ${mapped.length}`);
    console.log(`  → não mapeados:            ${unmapped.length}`);
    console.log(`fases de P&P a criar:        ${toCreate.length} (${toCreate.map((p) => p.slug).join(', ')})`);
    console.log(`total events no shadow:      ${Object.values(evCounts).reduce((s, n) => s + n, 0)}`);

    if (!apply) {
      console.log('\nDRY-RUN — nada escrito. Revise o mapa fluxo/fase e rode com --apply.');
      return;
    }

    // ── APPLY ──
    console.log('\n==== APPLY ====');
    await client.query('BEGIN');
    let updated = 0;
    for (const { a, plan } of mapped) {
      const sets = ['flow = $2', 'phase_order = $3'];
      const params = [a.id, plan.flow, plan.phase_order];
      if (plan.category && plan.category !== a.category) {
        params.push(plan.category);
        sets.push(`category = $${params.length}`);
      }
      await client.query(`UPDATE v3.activity_types SET ${sets.join(', ')} WHERE id = $1`, params);
      updated++;
    }
    let created = 0;
    for (const p of toCreate) {
      const r = await client.query(
        `INSERT INTO v3.activity_types (slug, display_name, category, requires_product, emoji, flow, phase_order)
         VALUES ($1, $2, 'pnp_phase', false, $3, 'pnp', $4) RETURNING id`,
        [p.slug, p.display_name, p.emoji, p.phase_order]);
      created++;
      void r;
    }
    await client.query(
      `INSERT INTO v3.audit_log (actor_type, action, target_type, after_data)
       VALUES ('system', 'bloco1.tag_flows', 'activity_type', $1::jsonb)`,
      [JSON.stringify({ updated, created, new_slugs: toCreate.map((p) => p.slug) })]);
    await client.query('COMMIT');
    console.log(`OK — ${updated} activity_types tagueados, ${created} fases de P&P criadas.`);
  } catch (e) {
    if (apply) { try { await client.query('ROLLBACK'); } catch (_) { /* */ } }
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

main();
