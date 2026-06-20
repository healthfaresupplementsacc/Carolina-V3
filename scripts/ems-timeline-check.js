'use strict';
/* CONFIRMA se o /pipeline já traz o novo `timeline` + operator.user_id (UUID). */
const { ems } = require('../src/v3/services/ems-api');
function flat(node){ if(Array.isArray(node))return node.slice(); if(node&&typeof node==='object'){const o=[];for(const k of Object.keys(node))if(Array.isArray(node[k]))node[k].forEach(b=>o.push(Object.assign({_g:k},b)));return o;} return []; }
(async () => {
  if (!ems.configured()) { console.error('EMS sem chave'); process.exit(2); }
  const pl = await ems.pipeline();
  const batches = [].concat(flat(pl.pending_queue), flat(pl.formulation), flat(pl.production_line));
  console.log('total batches: ' + batches.length);
  const withTimeline = batches.filter(b => b.timeline).length;
  const withOpUuid = batches.filter(b => b.operator && b.operator.user_id).length;
  console.log('com timeline: ' + withTimeline + ' | com operator.user_id (UUID): ' + withOpUuid);
  // mostra 1 batch encapsulating + 1 production_line com timeline cru
  const ex = batches.find(b => b.status === 'encapsulating' && b.timeline) || batches.find(b => b.timeline);
  if (ex) {
    console.log('\n=== EXEMPLO (' + ex.batch_record_number + ' / ' + ex.status + ') ===');
    console.log('operator: ' + JSON.stringify(ex.operator));
    console.log('timeline: ' + JSON.stringify(ex.timeline, null, 1));
  } else {
    console.log('\n>>> NENHUM batch tem timeline ainda (doc à frente do deploy).');
    console.log('keys do 1o batch: ' + JSON.stringify(Object.keys(batches[0] || {})));
  }
  process.exit(0);
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
