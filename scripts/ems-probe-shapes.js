'use strict';
/* Imprime o SHAPE (chaves + 1 amostra) de products/pipeline/line do EMS. read-only.
   railway run node scripts/ems-probe-shapes.js */
const { ems } = require('../src/v3/services/ems-api');
(async () => {
  if (!ems.configured()) { console.log('EMS sem chave (config). abortando.'); process.exit(1); }
  for (const ep of ['products', 'pipeline', 'line']) {
    try {
      const data = await ems[ep]();
      const arr = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : (data && Array.isArray(data[ep]) ? data[ep] : null));
      console.log(`\n=== ${ep} ===`);
      if (arr) {
        console.log(`  (array de ${arr.length}) keys[0]: ${Object.keys(arr[0] || {}).join(', ')}`);
        console.log('  amostra[0]: ' + JSON.stringify(arr[0]).slice(0, 400));
      } else {
        console.log('  (objeto) keys: ' + Object.keys(data || {}).join(', '));
        console.log('  amostra: ' + JSON.stringify(data).slice(0, 400));
      }
    } catch (e) { console.log(`  ${ep} ERRO: ${e.code || ''} ${e.message}`); }
  }
  process.exit(0);
})();
