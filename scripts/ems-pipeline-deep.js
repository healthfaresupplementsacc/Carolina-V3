'use strict';
const { ems } = require('../src/v3/services/ems-api');
(async () => {
  const pl = await ems.pipeline();
  console.log('summary: ' + JSON.stringify(pl.summary));
  ['formulation', 'production_line'].forEach((g) => {
    const obj = pl[g] || {};
    console.log('\n=== ' + g + ' === sub-stages: ' + Object.keys(obj).join(', '));
    Object.keys(obj).forEach((stage) => {
      const arr = Array.isArray(obj[stage]) ? obj[stage] : [];
      console.log('  • ' + stage + ': ' + arr.length + ' batch(es)');
      if (arr[0]) {
        const b = arr[0];
        console.log('    keys: ' + Object.keys(b).join(','));
        console.log('    operator=' + JSON.stringify(b.operator) + ' tempos=' + Object.keys(b).filter((k) => /_at$|time|since|duration|started|ended/i.test(k)).map((k) => k + ':' + b[k]).join(' | '));
        console.log('    full: ' + JSON.stringify(b).slice(0, 500));
      }
    });
  });
  // overview pra contexto
  console.log('\n=== overview ===\n' + JSON.stringify(await ems.overview(), null, 1).slice(0, 900));
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
