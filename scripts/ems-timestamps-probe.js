'use strict';
/* Probe FOCADO em TEMPO: o EMS sabe fielmente quando a máquina começou a rodar /
   quando o stage iniciou? Dump de in_use_since + todos os campos de timestamp. */
const { ems } = require('../src/v3/services/ems-api');
const now = Date.now();
const ago = (iso) => { if (!iso) return '—'; const ms = now - Date.parse(iso); const h = ms / 3600000; return h < 1 ? Math.round(ms / 60000) + 'min' : h.toFixed(1) + 'h'; };
const tkeys = (o) => Object.keys(o || {}).filter((k) => /_at$|_since$|time|date|started|updated|created/i.test(k));
function flat(node) { if (Array.isArray(node)) return node.slice(); if (node && typeof node === 'object') { const o = []; for (const k of Object.keys(node)) if (Array.isArray(node[k])) node[k].forEach((b) => o.push(Object.assign({ _stage: k }, b))); return o; } return []; }
(async () => {
  if (!ems.configured()) { console.error('EMS sem chave'); process.exit(2); }
  const [line, pipeline] = await Promise.all([ems.line().catch(() => null), ems.pipeline().catch(() => null)]);
  console.log('AGORA: ' + new Date(now).toISOString() + '\n');

  console.log('=== MÁQUINAS (/line) — in_use_since é fiel? ===');
  (line && line.equipment || []).forEach((m) => {
    console.log(`\n${m.name} (${m.equipment_type}) running=${m.running}`);
    console.log('  campos de tempo na máquina: ' + JSON.stringify(tkeys(m)));
    console.log('  in_use_since=' + (m.in_use_since || '—') + '  (há ' + ago(m.in_use_since) + ')');
    if (m.current_batch) {
      const cb = m.current_batch;
      console.log('  current_batch=' + cb.batch_record_number + ' status=' + cb.status);
      console.log('  campos de tempo no batch: ' + JSON.stringify(tkeys(cb)));
      console.log('    created_at=' + (cb.created_at || '—') + ' (há ' + ago(cb.created_at) + ')  updated_at=' + (cb.updated_at || '—') + ' (há ' + ago(cb.updated_at) + ')');
    }
  });

  console.log('\n=== STAGES (/pipeline) — quando o mixing/encapsulação iniciou? ===');
  ['formulation', 'production_line'].forEach((g) => {
    flat(pipeline ? pipeline[g] : null).slice(0, 6).forEach((b) => {
      console.log(`\n${g}.${b._stage || b.status} ${b.batch_record_number} op=${(b.operator && b.operator.name) || 'null'}`);
      console.log('  campos de tempo: ' + JSON.stringify(tkeys(b)));
      console.log('    created_at=' + (b.created_at || '—') + ' (há ' + ago(b.created_at) + ')  updated_at=' + (b.updated_at || '—') + ' (há ' + ago(b.updated_at) + ')');
      if (b.stage_started_at || b.started_at || b.stage_entered_at) console.log('    >>> TEM stage start: ' + JSON.stringify({ stage_started_at: b.stage_started_at, started_at: b.started_at, stage_entered_at: b.stage_entered_at }));
    });
  });
  process.exit(0);
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
