'use strict';
/* Verifica a conexão com o EMS Production API. Lê a chave do ambiente
   (EMS_PRODUCTION_API_KEY) — rode via `railway run node scripts/ems-smoke.js`
   pra usar o segredo do Railway sem expor a chave. NÃO imprime a chave. */
const { ems } = require('../src/v3/services/ems-api');

(async () => {
  if (!ems.configured()) {
    console.log('EMS_PRODUCTION_API_KEY não está setada neste ambiente.');
    console.log('Defina (a chave NÃO vai pro chat/commit):');
    console.log('  railway variables --set EMS_PRODUCTION_API_KEY=<sua-chave>');
    console.log('Depois: railway run node scripts/ems-smoke.js');
    process.exit(2);
  }
  console.log('base:', ems.baseUrl);
  try {
    const ov = await ems.overview();
    console.log('overview @', ov.generated_at);
    console.log('  formulas:', JSON.stringify(ov.formulas), '| products:', JSON.stringify(ov.products));
    console.log('  production:', JSON.stringify(ov.production), '| line:', JSON.stringify(ov.line), '| employees w/ photo:', ov.employees && ov.employees.with_photo);

    const emp = await ems.employees();
    console.log('employees (' + emp.count + '):');
    (emp.employees || []).forEach((e) => console.log('  · ' + (e.name || '(sem nome)') + ' [' + (e.roles || []).join(', ') + ']'));

    const line = await ems.line();
    console.log('line running:', line.running_count);
    (line.equipment || []).filter((e) => e.running).forEach((e) => {
      console.log('  · ' + e.name + ' ← ' + ((e.operator && e.operator.name) || '?') + ' (' + ((e.current_batch && e.current_batch.batch_record_number) || '-') + ')');
    });

    console.log('\nEMS SMOKE: PASS');
    process.exit(0);
  } catch (e) {
    console.error('EMS SMOKE: FAIL —', e.code || '', e.message);
    process.exit(1);
  }
})();
