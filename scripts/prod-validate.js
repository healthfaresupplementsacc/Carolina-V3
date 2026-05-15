'use strict';
// Run via: railway run --service ProductionLineService node scripts/prod-validate.js
// Validates that the deployed parseMessage handles every hotfix + Entrega 1 case correctly.
// Pure parser exercise — no DB writes, no Slack posts.

const { parseMessage } = require('../src/parser');

const cases = [
  // ─── Hotfix N1 + Item A ─────────────────────────────────────────────────
  { id: 'N1.a', label: '"Ana - voltei" from Vitor account → operator=Ana',
    msg: { text: 'Ana - voltei', user: 'U08JC85HMNE' },
    expect: { type: 'pause_end', operator: 'Ana' } },

  { id: 'N1.b', label: '"Bruno - S: Berberine 0119" from Vitor → operator=Bruno',
    msg: { text: 'Bruno - S: Berberine 0119', user: 'U08JC85HMNE' },
    expect: { type: 'start', operator: 'Bruno', supplement: 'Berberine', batch: '0119' } },

  { id: 'N1.c', label: 'no prefix on Vitor account → operator=Vitor',
    msg: { text: 'S: Berberine 0119', user: 'U08JC85HMNE' },
    expect: { type: 'start', operator: 'Vitor' } },

  { id: 'ItemA', label: '"Bruno - S: Fenugreek 0123" from Vitor opens task as Bruno',
    msg: { text: 'Bruno - S: Fenugreek 0123', user: 'U08JC85HMNE' },
    expect: { type: 'start', operator: 'Bruno', supplement: 'Fenugreek' } },

  // ─── Hotfix Item B ──────────────────────────────────────────────────────
  { id: 'ItemB.a', label: '"vou almoçar" (cedilla) → pause_start',
    msg: { text: 'vou almoçar', user: 'U08JC85HMNE' },
    expect: { type: 'pause_start' } },

  { id: 'ItemB.b', label: '"indo almoçar" → pause_start',
    msg: { text: 'indo almoçar', user: 'U08JC85HMNE' },
    expect: { type: 'pause_start' } },

  { id: 'ItemB.c', label: '"saindo pro almoço" → pause_start',
    msg: { text: 'saindo pro almoço', user: 'U08JC85HMNE' },
    expect: { type: 'pause_start' } },

  { id: 'ItemB.d', label: '"hora do almoço" → pause_start',
    msg: { text: 'hora do almoço', user: 'U08JC85HMNE' },
    expect: { type: 'pause_start' } },

  // ─── Entrega 1 spot-checks (B1, B2, B3, B8, B10, B11, B13) ──────────────
  { id: 'B1', label: '"Bruno- Green Tea-0098-S" → start Green Tea',
    msg: { text: 'Bruno- Green Tea-0098-S', user: 'U0AU8N8FA00' },
    expect: { type: 'start', supplement: 'Green Tea', batch: '0098', operator: 'Bruno' } },

  { id: 'B2', label: '"S; revisao Glutathione" → start Glutathione revisao',
    msg: { text: 'S; revisao Glutathione', user: 'U08JC85HMNE' },
    expect: { type: 'start', supplement: 'Glutathione', taskType: 'revisao' } },

  { id: 'B3', label: '"F/ Berberine" → finish Berberine',
    msg: { text: 'F/ Berberine', user: 'U08JC85HMNE' },
    expect: { type: 'finish', supplement: 'Berberine' } },

  { id: 'B8', label: '"Ana - ajudando o Vitor na linha de producao" → join_producao',
    msg: { text: 'Ana - ajudando o Vitor na linha de producao', user: 'U0AU8N8FA00' },
    expect: { type: 'join_producao', operator: 'Ana' } },

  { id: 'B10', label: '"F- ordens da segunda impressao feitas" → orders_finish',
    msg: { text: 'F- ordens da segunda impressao feitas', user: 'U07FG34TMPF' },
    expect: { type: 'orders_finish' } },

  { id: 'B11', label: '"impacotei + iniciei Revisao Ginger" → orders_finish + next',
    msg: { text: 'Ja impacotei e ja iniciei a Revisao do Ginger', user: 'U07FG34TMPF' },
    expect: { type: 'orders_finish', nextSupplement: 'Ginger Root', nextTaskType: 'revisao' } },

  { id: 'B13', label: '"F Limpeza" → finish',
    msg: { text: 'F Limpeza', user: 'U08JC85HMNE' },
    expect: { type: 'finish' } },
];

let passed = 0;
let failed = 0;
const fails = [];

for (const c of cases) {
  const r = parseMessage({ ts: '1700000000.000000', username: 'x', ...c.msg });
  if (!r) {
    fails.push(`[${c.id}] ${c.label} — parseMessage returned null`);
    failed++;
    continue;
  }
  const mismatches = [];
  for (const [k, v] of Object.entries(c.expect)) {
    if (r[k] !== v) mismatches.push(`${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(r[k])}`);
  }
  if (mismatches.length === 0) {
    console.log(`PASS [${c.id}] ${c.label}`);
    passed++;
  } else {
    console.log(`FAIL [${c.id}] ${c.label}`);
    mismatches.forEach((m) => console.log(`       ${m}`));
    fails.push(`[${c.id}] ${c.label}: ${mismatches.join('; ')}`);
    failed++;
  }
}

console.log('');
console.log(`==== Summary: ${passed} passed, ${failed} failed (out of ${cases.length}) ====`);
if (failed > 0) process.exit(1);
