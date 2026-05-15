'use strict';
/**
 * Entrega 3 — seeds the initial workflow_templates, phase_templates and
 * ad_hoc_tasks approved by Bruno. Idempotent: re-running upserts on name.
 *
 * Run once at boot AFTER db.migrate().
 *
 * Bruno can edit / add / delete anything from the dashboard afterwards
 * (Princípio D — customizable at any time). These rows are seed only.
 */

const db = require('../db');

const WORKFLOWS = [
  {
    name: 'Produção de Suplemento',
    description: 'Batch de produção de um suplemento, da Formulação à Contagem.',
    allows_product: true,
    phases: [
      { name: 'Formulação',         seq: 1, required: true,  parallel_group: null,        prereq: [],                         mode: 'all', soft: true },
      { name: 'Mix',                seq: 2, required: true,  parallel_group: null,        prereq: ['Formulação'],             mode: 'all', soft: true },
      { name: 'Encapsulação',       seq: 3, required: false, parallel_group: 'cap_or_tab', prereq: ['Mix'],                   mode: 'all', soft: true },
      { name: 'Tablet',             seq: 3, required: false, parallel_group: 'cap_or_tab', prereq: ['Mix'],                   mode: 'all', soft: true },
      { name: 'Revisão',            seq: 4, required: true,  parallel_group: null,        prereq: ['Encapsulação','Tablet'],  mode: 'any', soft: true },
      { name: 'Linha de Produção',  seq: 5, required: true,  parallel_group: null,        prereq: ['Revisão'],                mode: 'all', soft: true },
      { name: 'Contagem',           seq: 6, required: true,  parallel_group: null,        prereq: ['Linha de Produção'],      mode: 'all', soft: true },
    ],
  },
  {
    name: 'Picking & Packing',
    description: 'Sessão de impressão e empacotamento de ordens (1ª, 2ª ou 3ª impressão do dia).',
    allows_product: false,
    phases: [
      { name: 'Imprimir ordens',         seq: 1, required: true,  parallel_group: null, prereq: [],                       mode: 'all', soft: true },
      { name: 'Colar label no envelope', seq: 2, required: false, parallel_group: null, prereq: ['Imprimir ordens'],      mode: 'all', soft: true },
      { name: 'Separar bottles',         seq: 2, required: false, parallel_group: null, prereq: [],                       mode: 'all', soft: true },
      { name: 'Empacotar',               seq: 3, required: true,  parallel_group: null, prereq: ['Colar label no envelope'], mode: 'all', soft: true },
    ],
  },
  {
    name: 'Envio FBA/Walmart/Tiktok/Ebay',
    description: 'Preparação de remessa para marketplace. destination column escolhe FBA / Walmart / Tiktok / Ebay.',
    allows_product: false,
    phases: [
      { name: 'Imprimir label/FNSKU', seq: 1, required: true, parallel_group: null, prereq: [],                       mode: 'all', soft: true },
      { name: 'Encaixotar',           seq: 2, required: true, parallel_group: null, prereq: ['Imprimir label/FNSKU'], mode: 'all', soft: true },
    ],
  },
];

const AD_HOC_TASKS = [
  { name: 'Limpeza',            description: 'Limpeza do maquinário e área de produção.' },
  { name: 'Manutenção',         description: 'Conserto ou ajuste de máquina.' },
  { name: 'Treinamento',        description: 'Treinamento de operador novo ou capacitação.' },
  { name: 'Reunião',            description: 'Alinhamento ou reunião interna.' },
  { name: 'Estoque',            description: 'Inventário ou contagem de matéria-prima.' },
  { name: 'Reporte no sistema', description: '"Bia - Quantidade de X adicionado no sistema FO-NNNNN" — quando vincula a um batch, anexa ao phase Contagem. Senão fica avulso.' },
  { name: 'Transformação',      description: 'Re-empacotar de uma marca/dose para outra (ex: "Usei 01 Chlorophyll para transformar em 02 Naturmineral").' },
  { name: 'Outro',              description: 'Catch-all para qualquer atividade não classificada.' },
];

async function seedTemplates() {
  let workflowsInserted = 0, phasesInserted = 0, adHocInserted = 0;

  for (const wf of WORKFLOWS) {
    const wfRes = await db.query(
      `INSERT INTO workflow_templates (name, description, allows_product, is_active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (name) DO UPDATE SET
         description = EXCLUDED.description,
         allows_product = EXCLUDED.allows_product,
         updated_at = NOW()
       RETURNING id, (xmax = 0) AS inserted`,
      [wf.name, wf.description, wf.allows_product]
    );
    const wfId = wfRes.rows[0].id;
    if (wfRes.rows[0].inserted) workflowsInserted++;

    // First pass: upsert phases by (workflow_id, name) — name unique within workflow.
    // We need a temporary unique index for ON CONFLICT, so use SELECT-then-INSERT/UPDATE.
    const phaseIdByName = {};
    for (const ph of wf.phases) {
      const existing = await db.query(
        `SELECT id FROM phase_templates WHERE workflow_template_id = $1 AND name = $2`,
        [wfId, ph.name]
      );
      if (existing.rows.length > 0) {
        const id = existing.rows[0].id;
        phaseIdByName[ph.name] = id;
        await db.query(
          `UPDATE phase_templates SET
             sequence_order = $1, is_required = $2, can_run_parallel = $3,
             parallel_group = $4, prerequisite_mode = $5, soft_prereq = $6,
             updated_at = NOW()
           WHERE id = $7`,
          [ph.seq, ph.required, !!ph.parallel_group, ph.parallel_group,
           ph.mode, ph.soft, id]
        );
      } else {
        const ins = await db.query(
          `INSERT INTO phase_templates
             (workflow_template_id, name, sequence_order, is_required,
              can_run_parallel, parallel_group, prerequisite_mode, soft_prereq)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [wfId, ph.name, ph.seq, ph.required, !!ph.parallel_group,
           ph.parallel_group, ph.mode, ph.soft]
        );
        phaseIdByName[ph.name] = ins.rows[0].id;
        phasesInserted++;
      }
    }

    // Second pass: now that every phase has an id, wire up prerequisite_phase_ids.
    for (const ph of wf.phases) {
      const prereqIds = (ph.prereq || [])
        .map((pname) => phaseIdByName[pname])
        .filter((x) => x != null);
      await db.query(
        `UPDATE phase_templates
         SET prerequisite_phase_ids = $1::jsonb, updated_at = NOW()
         WHERE workflow_template_id = $2 AND name = $3`,
        [JSON.stringify(prereqIds), wfId, ph.name]
      );
    }
  }

  for (const t of AD_HOC_TASKS) {
    const res = await db.query(
      `INSERT INTO ad_hoc_tasks (name, description, is_active, admin_approved)
       VALUES ($1, $2, TRUE, TRUE)
       ON CONFLICT (name) DO UPDATE SET
         description = EXCLUDED.description,
         is_active = TRUE, admin_approved = TRUE, updated_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [t.name, t.description]
    );
    if (res.rows[0].inserted) adHocInserted++;
  }

  console.log(
    `[Seed] workflow_templates: +${workflowsInserted} new, ` +
    `phase_templates: +${phasesInserted} new, ` +
    `ad_hoc_tasks: +${adHocInserted} new`
  );
  return { workflowsInserted, phasesInserted, adHocInserted };
}

module.exports = { seedTemplates };
