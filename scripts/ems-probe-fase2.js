'use strict';
const { ems } = require('../src/v3/services/ems-api');
const keys = (o) => o && typeof o === 'object' ? Object.keys(o).join(',') : typeof o;
(async () => {
  const pl = await ems.pipeline();
  console.log('pipeline keys:', keys(pl));
  ['pending_queue', 'formulation', 'production_line'].forEach((k) => {
    const arr = Array.isArray(pl[k]) ? pl[k] : [];
    console.log(`\n${k}: ${arr.length} itens`);
    if (arr[0]) { console.log('  keys:', keys(arr[0])); console.log('  sample:', JSON.stringify(arr[0]).slice(0, 500)); }
  });
  const ln = await ems.line();
  console.log('\nline keys:', keys(ln));
  const eq = Array.isArray(ln.equipment) ? ln.equipment : [];
  console.log('equipment:', eq.length);
  eq.slice(0, 3).forEach((e) => console.log('  ' + JSON.stringify(e).slice(0, 300)));
  process.exit(0);
})().catch((e) => { console.error('ERR', e.code, e.message); process.exit(1); });
