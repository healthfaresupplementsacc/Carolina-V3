'use strict';
/* Enumera TODOS os stages do EMS: chaves de sub-stage por grupo + status distintos
   dos lotes + equipment_types das máquinas. Resposta empírica a "quais são os stages". */
const { ems } = require('../src/v3/services/ems-api');
(async () => {
  if (!ems.configured()) { console.error('EMS sem chave'); process.exit(2); }
  const [pipeline, line] = await Promise.all([ems.pipeline().catch(() => null), ems.line().catch(() => null)]);
  console.log('=== /pipeline: GRUPOS e suas CHAVES de sub-stage ===');
  const groups = ['pending_queue', 'formulation', 'production_line'];
  const allStatus = {};
  groups.forEach((g) => {
    const node = pipeline ? pipeline[g] : null;
    if (Array.isArray(node)) {
      console.log(`\n${g}: (array) — ${node.length} lotes`);
      node.forEach((b) => { allStatus[g] = allStatus[g] || new Set(); if (b.status) allStatus[g].add(b.status); });
    } else if (node && typeof node === 'object') {
      const keys = Object.keys(node);
      console.log(`\n${g}: objeto com sub-stages → [${keys.join(', ')}]`);
      keys.forEach((k) => {
        const arr = node[k] || [];
        const st = new Set(arr.map((b) => b.status).filter(Boolean));
        console.log(`    .${k}: ${arr.length} lotes  (status: ${[...st].join(', ') || '—'})`);
      });
    } else { console.log(`\n${g}: vazio/ausente`); }
  });
  console.log('\nstatus distintos vistos no pending_queue: ' + JSON.stringify(Object.fromEntries(Object.entries(allStatus).map(([k, v]) => [k, [...v]]))));

  console.log('\n=== /line: equipment_types (máquinas) ===');
  const types = new Set();
  (line && line.equipment || []).forEach((m) => types.add(m.equipment_type));
  console.log('  ' + [...types].join(', '));

  console.log('\n=== chaves de outras seções do /pipeline ===');
  console.log('  ' + Object.keys(pipeline || {}).join(', '));
  process.exit(0);
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
