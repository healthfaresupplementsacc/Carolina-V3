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

    const pipe = await ems.pipeline();
    console.log('pipeline summary:', JSON.stringify(pipe.summary));
    console.log('  pending_queue:', (pipe.pending_queue || []).length, '| formulation groups:', Object.keys(pipe.formulation || {}).join(',') || '-', '| line groups:', Object.keys(pipe.production_line || {}).join(',') || '-');
    console.log('  bottles por fórmula (top 5):');
    (pipe.bottles_in_production_by_formula || []).slice(0, 5).forEach((f) => console.log('    · ' + f.formula_name + ': ' + f.total_bottles + ' bottles (' + f.batch_count + ' batch)'));

    console.log('\nEMS SMOKE: PASS');
    process.exit(0);
  } catch (e) {
    console.error('EMS SMOKE: FAIL —', e.code || '', e.message);
    process.exit(1);
  }
})();
