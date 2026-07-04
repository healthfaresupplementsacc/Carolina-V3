'use strict';
// Escalas (Bruno 07-04): Vitor/Ana 8–17 · Bruno Sarmento 10–20:30 · Simone 9:30–18:30.
// Seg(1)–Sáb(6) workday; Dom(0) folga. O fim de expediente REAL usado pelo
// absence-alert é MAX(1º check-in + 9h, fim da escala) — então a Simone chegando
// 8h "vira" 8–17 sozinha. Editável depois no /admin (aba Operadores → escala).
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const SHIFTS = [
  { name: 'Vitor', start: '08:00', end: '17:00' },
  { name: 'Ana', start: '08:00', end: '17:00' },
  { name: 'Bruno Sarmento', start: '10:00', end: '20:30' },
  { name: 'Simone', start: '09:30', end: '18:30' },
];
(async () => {
  for (const s of SHIFTS) {
    const pr = await p.query("SELECT id, display_name FROM v3.persons WHERE display_name ILIKE $1 || '%' AND role='operator' AND deleted_at IS NULL LIMIT 1", [s.name]);
    if (!pr.rows[0]) { console.log('⚠️ não achei:', s.name); continue; }
    const pid = pr.rows[0].id;
    for (let dow = 0; dow <= 6; dow++) {
      const workday = dow >= 1 && dow <= 6; // seg–sáb
      await p.query(
        `INSERT INTO v3.operator_schedules (person_id, day_of_week, expected_start_time, expected_end_time, is_workday, notes)
         VALUES ($1, $2, $3, $4, $5, 'seed Bruno 07-04')
         ON CONFLICT (person_id, day_of_week)
         DO UPDATE SET expected_start_time = $3, expected_end_time = $4, is_workday = $5, updated_at = NOW()`,
        [pid, dow, workday ? s.start : null, workday ? s.end : null, workday]);
    }
    console.log('✓', pr.rows[0].display_name, s.start + '–' + s.end, '(seg–sáb)');
  }
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
