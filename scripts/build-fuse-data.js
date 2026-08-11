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
// Cada grupo termina com um "✏️ Outro (…)" — task type livre, nota
// obrigatória (migration 024). O grupo "outros" já tem o catch-all
// special_task, então não recebe outro.
const GROUPS = [
  { key: 'linha', icon: '🏭', label: 'Linha de Produção', items: [
    ['production_line', 'Linha de produção'], ['review', 'Revisão'],
    ['labeling', 'Colocar labels'],
    ['fnsku_labeling', 'Colocando FNSKU / Código de Barras'],
    ['counting', 'Contagem'], ['line_changeover', 'Troca de linha'],
    ['production_line_other', '✏️ Outro (Linha)'],
  ] },
  { key: 'formulacao', icon: '🧪', label: 'Formulação', items: [
    ['separating', 'Separando ingredientes'], ['weighing', 'Weighing (Pesagem)'],
    ['mixing', 'Mixing (Mistura)'], ['encapsulation', 'Encapsulation / Tablet'],
    ['material_handling', 'Material prep'],
    ['formulation_other', '✏️ Outro (Formulação)'],
  ] },
  { key: 'limpeza', icon: '🧹', label: 'Limpeza / Organização', items: [
    ['cleaning', 'Limpeza'], ['repair', 'Conserto de máquina'],
    ['facility_maintenance', 'Manutenção'],
    ['organization', 'Organização do Warehouse'],
    ['stock_organization', 'Organização de Stock (Inventário)'],
    ['machine_downtime', 'Máquina parada'],
    ['label_change', '🏷️ Troca/Ajuste de Label'],
    ['cleaning_other', '✏️ Outro (Limpeza/Suporte)'],
  ] },
  { key: 'embalagem', icon: '📦', label: 'Envio De Pacotes', items: [
    ['order_printing', 'Impressão de ordens'],
    ['order_printing_2', '2ª impressão'],
    // Bruno 08-06: acesso fácil ao workspace de estoque também daqui (mesmo slug
    // existe em 'limpeza' — padrão já usado pelo clinic_shipment em 2 grupos)
    ['stock_organization', 'Organização de Stock (Inventário)'],
    ['packaging', 'Empacotando Suplementos'],
    ['marketplace_prep', 'Trocar label'],
    ['clinic_shipment', 'Envio Clínica'],
    ['packaging_other', '✏️ Outro (Embalagem)'],
  ] },
  { key: 'envio', icon: '🚚', label: 'Envio De Caixas', items: [
    ['box_closing', 'Fechando caixas'],
    ['fnsku_labeling', 'Colocando FNSKU / Código de Barras'],
    ['shipping_walmart', 'Envio Walmart'], ['shipping_amazon', 'Envio Amazon'],
    ['dc_shipment', 'Envio Distribution Center'], ['clinic_shipment', 'Envio Clínica'],
    ['shipping_other', '✏️ Outro (Envio)'],
  ] },
  { key: 'outros', icon: '⋯', label: 'Outros', items: [
    ['special_task', '✨ Algo Especial'], ['break', 'Pausa'], ['meeting', 'Reunião'], ['training', 'Treinamento'],
  ] },
];

// Botões DIRETOS na tela "O que vai fazer?" (sem entrar em grupo)
const QUICK = [['lunch', 'Almoço', '🍽️']];
// Slugs cuja nota é OBRIGATÓRIA (validado também no servidor — op.js).
// Os 5 "*_other" entram aqui: tarefa livre só faz sentido com explicação.
const NOTE_REQUIRED = new Set([
  // Bruno 08-06: impressão de ordens (1ª E 2ª) NAO exige motivo — só a QUANTIDADE.
  'break', 'special_task', 'meeting', 'training',
  'production_line_other', 'formulation_other', 'cleaning_other', 'packaging_other', 'shipping_other',
  'label_change', 'label_repair',
  'machine_downtime', // mudança #5: motivo da parada é obrigatório
  'repair',           // Fase 3.3: conserto de máquina exige nota (motivo)
]);
// Slugs que exigem quantidade de ordens impressas
const ORDERS_REQUIRED = new Set(['order_printing', 'order_printing_2']);
// Mudança #3: Embalagem não pede lote no /op. requires_product no DB segue true
// (Slack/LLM dependem disso); aqui só a PÁGINA do operador pula produto+lote.
const NO_PRODUCT_OVERRIDE = new Set(['labeling', 'packaging', 'marketplace_prep']);
// Fase 3.2: Conserto de label exige produto + lote (além da nota já obrigatória),
// pra identificar QUAL label/lote tem o problema. Override só na página.
const YES_PRODUCT_OVERRIDE = new Set(['label_repair']);

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const acts = await c.query('SELECT slug, requires_product, requires_order_count, counts_as_pp FROM v3.activity_types WHERE active = true');
  const bySlug = new Map(acts.rows.map((r) => [r.slug, r]));

  const groups = GROUPS.map((g) => ({
    key: g.key, icon: g.icon, label: g.label,
    types: g.items
      .filter(([slug]) => bySlug.has(slug))
      .map(([slug, label]) => ({
        slug, label,
        requires_product: YES_PRODUCT_OVERRIDE.has(slug) ? true : (NO_PRODUCT_OVERRIDE.has(slug) ? false : !!bySlug.get(slug).requires_product),
        note_required: NOTE_REQUIRED.has(slug),
        orders_required: ORDERS_REQUIRED.has(slug),
        requires_order_count: !!bySlug.get(slug).requires_order_count, // FASE 5: pede contagem no FINISH
        counts_as_pp: !!bySlug.get(slug).counts_as_pp,
      })),
  })).filter((g) => g.types.length);

  const quick = QUICK
    .filter(([slug]) => bySlug.has(slug))
    .map(([slug, label, icon]) => ({
      slug, label, icon,
      requires_product: !!bySlug.get(slug).requires_product,
      note_required: NOTE_REQUIRED.has(slug),
      orders_required: ORDERS_REQUIRED.has(slug),
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
