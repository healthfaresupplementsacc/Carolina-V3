'use strict';
/* Pesquisa read-only do EMS: mapeia endpoints + payloads + candidatos. Não muda nada. */
const { ems } = require('../src/v3/services/ems-api');
const keys = (o) => (o && typeof o === 'object' && !Array.isArray(o)) ? Object.keys(o) : (Array.isArray(o) ? '[array ' + o.length + ']' : typeof o);
const j = (o, n) => JSON.stringify(o).slice(0, n || 600);

async function probe(path) {
  try { const r = await ems.get(path); return { ok: true, data: r }; }
  catch (e) { return { ok: false, code: e.code || '', status: e.status || '', msg: e.message }; }
}

(async () => {
  console.log('========== ENDPOINTS CONHECIDOS ==========');
  for (const ep of ['overview', 'formulas', 'pipeline', 'line', 'products', 'employees']) {
    const r = await probe(ep);
    if (!r.ok) { console.log('\n/' + ep + ' → ' + r.status + ' ' + r.code + ' ' + r.msg); continue; }
    const d = r.data;
    console.log('\n=== /' + ep + ' === topo: ' + keys(d));
    if (Array.isArray(d)) console.log('  array[' + d.length + '] item keys: ' + keys(d[0]) + '\n  sample: ' + j(d[0], 700));
    else { Object.keys(d).forEach((k) => { const v = d[k]; if (Array.isArray(v)) console.log('  .' + k + ' [array ' + v.length + '] item keys: ' + keys(v[0])); else if (v && typeof v === 'object') console.log('  .' + k + ' {obj} keys: ' + keys(v)); else console.log('  .' + k + ' = ' + JSON.stringify(v)); }); }
  }

  console.log('\n\n========== PIPELINE — STAGES DA FORMULAÇÃO (quem/quando/duração) ==========');
  const pl = (await probe('pipeline')).data || {};
  ['pending_queue', 'formulation', 'production_line'].forEach((g) => {
    const arr = Array.isArray(pl[g]) ? pl[g] : [];
    console.log('\n--- ' + g + ': ' + arr.length + ' batches ---');
    const byStage = {};
    arr.forEach((b) => { byStage[b.status] = (byStage[b.status] || 0) + 1; });
    console.log('  por stage: ' + JSON.stringify(byStage));
    if (arr[0]) console.log('  EXEMPLO COMPLETO: ' + JSON.stringify(arr[0], null, 1).slice(0, 1100));
    // procura campos de operador/tempo/histórico
    const sample = arr[0] || {};
    console.log('  tem operator? ' + ('operator' in sample) + ' = ' + JSON.stringify(sample.operator));
    console.log('  campos de tempo: ' + Object.keys(sample).filter((k) => /_at$|time|date|started|ended|duration|since/i.test(k)).join(', '));
    console.log('  campos de histórico/stage: ' + Object.keys(sample).filter((k) => /history|stage|step|log|events|timeline/i.test(k)).join(', '));
  });

  console.log('\n\n========== LINE — equipamentos (operador + in_use_since) ==========');
  const ln = (await probe('line')).data || {};
  (Array.isArray(ln.equipment) ? ln.equipment : []).forEach((e) => {
    console.log('  ' + e.name + ' (' + e.equipment_type + ') running=' + e.running + ' in_use_since=' + e.in_use_since + ' operator=' + JSON.stringify(e.operator) + ' batch=' + (e.current_batch ? e.current_batch.batch_record_number + '/' + e.current_batch.status : '-'));
  });

  console.log('\n\n========== /employees (mapping) ==========');
  const emp = (await probe('employees')).data;
  const earr = Array.isArray(emp) ? emp : (emp && emp.employees) || [];
  console.log('  total: ' + earr.length);
  earr.slice(0, 20).forEach((e) => console.log('  ' + JSON.stringify(e).slice(0, 200)));

  console.log('\n\n========== ENDPOINTS CANDIDATOS (200 vs 404) ==========');
  const cands = ['inventory', 'raw-materials', 'raw_materials', 'materials', 'orders', 'sales', 'demand', 'low-stock', 'alerts', 'quality', 'qc', 'machines', 'equipment', 'history', 'activity-log', 'activity', 'stages', 'batches', 'batch', 'formulation', 'encapsulation', 'weighing', 'shipments', 'skus', 'stock', 'health', 'status'];
  for (const c of cands) {
    const r = await probe(c);
    console.log('  /' + c + ' → ' + (r.ok ? '200 OK · ' + (Array.isArray(r.data) ? 'array[' + r.data.length + ']' : keys(r.data)) : (r.status || r.code || 'ERR')));
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
