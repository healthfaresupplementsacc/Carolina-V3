'use strict';
const { ems } = require('../src/v3/services/ems-api');
function flat(n){if(Array.isArray(n))return n.slice();if(n&&typeof n==='object'){const o=[];for(const k of Object.keys(n))if(Array.isArray(n[k]))n[k].forEach(b=>o.push(b));return o;}return[];}
(async () => {
  if (!ems.configured()) { console.error('sem chave'); process.exit(2); }
  const [pl, line, formulas] = await Promise.all([ems.pipeline().catch(()=>null), ems.line().catch(()=>null), ems.formulas().catch(()=>null)]);
  const batches = pl ? ['pending_queue','formulation','production_line'].flatMap(g=>flat(pl[g])) : [];
  console.log('=== TIMELINE live? ===');
  const wt = batches.filter(b=>b.timeline).length;
  console.log('batches com timeline: ' + wt + '/' + batches.length);
  const ex = batches.find(b=>b.timeline);
  if (ex) console.log('exemplo timeline ('+ex.batch_record_number+'): ' + JSON.stringify(ex.timeline));
  console.log('\n=== units_per_bottle / formula no batch? ===');
  const b0 = batches.find(b=>b.formula);
  console.log('formula no batch: ' + JSON.stringify(b0 && b0.formula));
  console.log('\n=== /formulas tem units_per_bottle + total_weight_mg? ===');
  const fa = formulas && (formulas.active || []);
  console.log('1a formula: ' + JSON.stringify(fa && fa[0] ? { code: fa[0].formula_code, name: fa[0].name, type: fa[0].formula_type, units_per_bottle: fa[0].units_per_bottle, total_weight_mg: fa[0].total_weight_mg } : null));
  console.log('\n=== /line cleaning fields? ===');
  console.log('statuses: ' + JSON.stringify(line && line.statuses) + ' | status_counts: ' + JSON.stringify(line && line.status_counts) + ' | needs_cleaning_count: ' + (line && line.needs_cleaning_count));
  const m = (line && line.equipment || [])[0];
  if (m) console.log('máquina[0]: ' + JSON.stringify({ name: m.name, status: m.status, needs_cleaning: m.needs_cleaning, last_cleaning: m.last_cleaning }));
  process.exit(0);
})().catch(e=>{console.error('ERRO',e.message);process.exit(1);});
