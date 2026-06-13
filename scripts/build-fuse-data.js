'use strict';
/* Gera src/op/fuse-data.js a partir do banco (products + activity_types +
   batches recentes 30d). Rodar:
   railway run --service ProductionLineService node scripts/build-fuse-data.js
   Commitar o arquivo gerado (a página é estática).

   NOTA: usa os slugs REAIS de v3.activity_types (não cria slugs novos) —
   manter página e Slack/LLM no MESMO catálogo é o que permite o dedupe da
   Fase 4 casar por slug. Labels PT-BR amigáveis são só de exibição. */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// grupos de UI: slug real → (grupo, label de exibição)
const GROUPS = [
  { key: 'linha', icon: '🏭', label: 'Linha de Produção', items: [
    ['production_line', 'Linha de produção'], ['review', 'Revisão'],
    ['counting', 'Contagem'], ['line_changeover', 'Troca de linha'],
  ] },
  { key: 'formulacao', icon: '🧪', label: 'Formulação', items: [
    ['formulation', 'Formulação'], ['mixing', 'Mistura'],
    ['encapsulation', 'Cápsulas / Tablets'], ['material_handling', 'Preparo de material (peneira…)'],
  ] },
  { key: 'limpeza', icon: '🧹', label: 'Limpeza / Suporte', items: [
    ['cleaning', 'Limpeza'], ['repair', 'Conserto de máquina'],
    ['facility_maintenance', 'Manutenção'], ['organization', 'Organização'],
    ['machine_downtime', 'Máquina parada'],
  ] },
  { key: 'embalagem', icon: '📦', label: 'Embalagem / Ordens', items: [
    ['orders', 'Ordens'], ['order_printing', 'Impressão de ordens'],
    ['order_printing_2', '2ª impressão'], ['labeling', 'Colar labels'],
    ['packaging', 'Embalagem'], ['clinic_shipment', 'Envio Clínica'],
    ['marketplace_prep', 'Trocar label / marketplace'],
  ] },
  { key: 'envio', icon: '🚚', label: 'Envio', items: [
    ['shipping', 'Envio'], ['dc_shipment', 'Envio DC'], ['box_closing', 'Fechar caixas'],
  ] },
  { key: 'outros', icon: '⋯', label: 'Outros', items: [
    ['break', 'Pausa'], ['meeting', 'Reunião'], ['training', 'Treinamento'],
  ] },
];

// Botões DIRETOS na tela "O que vai fazer?" (sem entrar em grupo)
const QUICK = [['lunch', 'Almoço', '🍽️']];
// Slugs cuja nota é OBRIGATÓRIA (validado também no servidor)
const NOTE_REQUIRED = new Set(['break']);

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const acts = await c.query('SELECT slug, requires_product FROM v3.activity_types WHERE active = true');
  const bySlug = new Map(acts.rows.map((r) => [r.slug, r]));

  const groups = GROUPS.map((g) => ({
    key: g.key, icon: g.icon, label: g.label,
    types: g.items
      .filter(([slug]) => bySlug.has(slug))
      .map(([slug, label]) => ({
        slug, label,
        requires_product: !!bySlug.get(slug).requires_product,
        note_required: NOTE_REQUIRED.has(slug),
      })),
  })).filter((g) => g.types.length);

  const quick = QUICK
    .filter(([slug]) => bySlug.has(slug))
    .map(([slug, label, icon]) => ({
      slug, label, icon,
      requires_product: !!bySlug.get(slug).requires_product,
      note_required: NOTE_REQUIRED.has(slug),
    }));

  const sup = await c.query(`
    SELECT p.id, p.canonical_name, p.aliases, MAX(e.created_at) AS last_used_at
    FROM v3.products p
    LEFT JOIN v3.product_batches pb ON pb.product_id = p.id
    LEFT JOIN v3.events e ON e.product_batch_id = pb.id AND e.created_at > NOW() - INTERVAL '30 days'
    WHERE p.active = true
    GROUP BY p.id ORDER BY p.canonical_name`);

  const rb = await c.query(`
    SELECT pb.batch_number, pb.product_id, MAX(e.created_at) AS last_used
    FROM v3.product_batches pb
    JOIN v3.events e ON e.product_batch_id = pb.id
    WHERE e.created_at > NOW() - INTERVAL '30 days' AND e.deleted_at IS NULL
    GROUP BY pb.id ORDER BY MAX(e.created_at) DESC LIMIT 40`);

  const data = {
    generated_at: new Date().toISOString(),
    groups, quick,
    supplements: sup.rows.map((r) => ({ id: r.id, canonical_name: r.canonical_name, aliases: r.aliases || [], last_used_at: r.last_used_at })),
    recent_batches: rb.rows,
  };
  const out = path.join(__dirname, '..', 'src', 'op', 'fuse-data.js');
  fs.writeFileSync(out, 'window.HF_DATA = ' + JSON.stringify(data, null, 1) + ';\n');
  console.log('fuse-data.js gerado: ' + data.supplements.length + ' supplements, ' +
    groups.reduce((a, g) => a + g.types.length, 0) + ' task types em ' + groups.length + ' grupos, ' +
    data.recent_batches.length + ' batches recentes');
  await c.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
