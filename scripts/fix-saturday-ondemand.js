'use strict';
// Bruno 07-11: sábado é serviço EXTRA/sob demanda, NÃO escala fixa. Estava
// cadastrado como workday=true (8-17 etc.) → o sistema tratava sábado como dia
// normal e o modo sob demanda nunca ligava. Marca DOW=6 como is_workday=false.
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const IDS = [6, 4, 5, 7];
(async () => {
  const r = await p.query(
    `UPDATE v3.operator_schedules SET is_workday=false, updated_at=NOW()
      WHERE day_of_week=6 AND person_id=ANY($1)`, [IDS]);
  const after = (await p.query(
    `SELECT o.display_name nm, s.is_workday w FROM v3.operator_schedules s JOIN v3.persons o ON o.id=s.person_id
      WHERE s.day_of_week=6 AND s.person_id=ANY($1) ORDER BY o.display_name`, [IDS])).rows;
  console.log('DEPOIS (sábado) —', r.rowCount, 'linhas:');
  after.forEach(x => console.log('  ', x.nm.padEnd(16), 'is_workday=' + x.w));
})().catch(e => { console.error('ERR', e.message); process.exit(1); }).finally(() => p.end());
