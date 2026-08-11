'use strict';
// Bruno 07-11: sexta é dia de limpeza — todo mundo 9:30–18:30 (não o horário normal).
// A escala estava com o horário de dia normal na sexta (Bruno até 20:30) → alarme
// "tinha permissão" até 20:30. Corrige DOW=5 pros 4 operadores.
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const IDS = [6, 4, 5, 7]; // Ana, Vitor, Simone, Bruno Sarmento
(async () => {
  const before = (await p.query(
    `SELECT o.display_name, s.expected_start_time st, s.expected_end_time en FROM v3.operator_schedules s
       JOIN v3.persons o ON o.id=s.person_id WHERE s.day_of_week=5 AND s.person_id=ANY($1) ORDER BY o.display_name`, [IDS])).rows;
  console.log('ANTES (sexta):'); before.forEach(r => console.log('  ', r.display_name.padEnd(16), String(r.st).slice(0,5)+'-'+String(r.en).slice(0,5)));
  const r = await p.query(
    `UPDATE v3.operator_schedules SET expected_start_time='09:30', expected_end_time='18:30', is_workday=true, updated_at=NOW()
      WHERE day_of_week=5 AND person_id=ANY($1)`, [IDS]);
  const after = (await p.query(
    `SELECT o.display_name, s.expected_start_time st, s.expected_end_time en FROM v3.operator_schedules s
       JOIN v3.persons o ON o.id=s.person_id WHERE s.day_of_week=5 AND s.person_id=ANY($1) ORDER BY o.display_name`, [IDS])).rows;
  console.log('\nDEPOIS (sexta) —', r.rowCount, 'linhas:'); after.forEach(r => console.log('  ', r.display_name.padEnd(16), String(r.st).slice(0,5)+'-'+String(r.en).slice(0,5)));
})().catch(e => { console.error('ERR', e.message); process.exit(1); }).finally(() => p.end());
