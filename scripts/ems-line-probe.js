'use strict';
/* Probe READ-ONLY do EMS p/ catálogo de detecção: enumera TODOS os equipamentos
   de /line (name + equipment_type + running + operator), os stages com operator
   no /pipeline, e a forma de /formulas + /overview. railway run node scripts/ems-line-probe.js */
const { ems } = require('../src/v3/services/ems-api');
function flat(node) {
  if (Array.isArray(node)) return node.slice();
  if (node && typeof node === 'object') { const o = []; for (const k of Object.keys(node)) if (Array.isArray(node[k])) node[k].forEach((b) => o.push(Object.assign({ _stage: k }, b))); return o; }
  return [];
}
(async () => {
  if (!ems.configured()) { console.error('EMS sem chave'); process.exit(2); }
  const [line, pipeline, formulas, overview] = await Promise.all([
    ems.line().catch((e) => ({ _err: e.message })),
    ems.pipeline().catch((e) => ({ _err: e.message })),
    ems.formulas().catch((e) => ({ _err: e.message })),
    ems.overview().catch((e) => ({ _err: e.message })),
  ]);

  console.log('\n=== /line EQUIPAMENTOS (name | equipment_type | running | operator | batch/stage | in_use_since) ===');
  const eq = (line && Array.isArray(line.equipment)) ? line.equipment : [];
  const types = new Set();
  eq.forEach((m) => {
    types.add((m.equipment_type || '?') + ' :: ' + (m.name || '?'));
    const cb = m.current_batch || {};
    console.log([m.name, m.equipment_type, m.running, (m.operator && m.operator.name) || (cb.operator && cb.operator.name) || null, (cb.batch_record_number || '-') + '/' + (cb.status || '-'), m.in_use_since || '-'].join(' | '));
  });
  console.log('\n--- equipment_type :: name ÚNICOS ---');
  [...types].sort().forEach((t) => console.log('  ' + t));

  console.log('\n=== /pipeline STAGES (chaves + se trazem operator) ===');
  ['pending_queue', 'formulation', 'production_line'].forEach((g) => {
    const node = pipeline ? pipeline[g] : null;
    const subkeys = (node && !Array.isArray(node) && typeof node === 'object') ? Object.keys(node) : (Array.isArray(node) ? ['(array)'] : ['(vazio)']);
    const items = flat(node);
    const withOp = items.filter((b) => b && b.operator && b.operator.name).length;
    console.log('  ' + g + ' → sub-stages: [' + subkeys.join(', ') + '] · itens: ' + items.length + ' · com operator: ' + withOp);
    items.slice(0, 4).forEach((b) => console.log('      ' + (b.batch_record_number || '?') + ' [' + (b.status || b._stage || '?') + '] op=' + ((b.operator && b.operator.name) || 'null') + ' prod=' + ((b.product && b.product.name) || (b.formula && b.formula.name) || '?')));
  });
  if (pipeline && pipeline.bottles_in_production_by_formula) {
    console.log('\n  bottles_in_production_by_formula: ' + JSON.stringify(pipeline.bottles_in_production_by_formula).slice(0, 400));
  }

  console.log('\n=== /formulas (shape do 1º) ===');
  const f = Array.isArray(formulas) ? formulas[0] : (formulas && formulas.formulas && formulas.formulas[0]);
  console.log('  keys: ' + (f ? Object.keys(f).join(', ') : '(?)'));
  if (f) console.log('  sample: ' + JSON.stringify(f).slice(0, 500));

  console.log('\n=== /overview (keys) ===');
  console.log('  ' + (overview && typeof overview === 'object' ? Object.keys(overview).join(', ') : JSON.stringify(overview)).slice(0, 400));
  process.exit(0);
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
