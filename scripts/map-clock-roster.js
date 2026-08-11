'use strict';
// Bruno 07-22: puxa o roster do relógio NGTeco e mostra/confere o mapeamento
// clock_code → person. Uso:
//   railway run --service ProductionLineService node scripts/map-clock-roster.js          (só lista)
//   railway run ... node scripts/map-clock-roster.js --set 5=<code> --set 7=<code>        (grava)
// Regra do Bruno: mapear POR ID (inquebrável): Vitor=#4, Simone=#5, Ana(Kesya)=#6, Bruno Sarmento=#7.
// Ana Kesya = código 39 no relógio (NÃO confundir com Ana Maria/outras Anas).
const { Pool } = require('pg');
const ngteco = require('../src/v3/services/ngteco');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  if (!ngteco.configured()) { console.log('NGTECO_USER/PASS ausentes no env'); process.exit(1); }
  const day = ngteco.nyToday();
  const roster = await ngteco.currentDay(day);
  console.log('=== ROSTER DO RELÓGIO (hoje ' + day + ') ===');
  roster.forEach((r) => console.log(`  code=${String(r.employee_code).padStart(3)} | ${r.employee_name || (r.first_name + ' ' + r.last_name)} | ${r.att_status || '?'}`));
  const ours = (await p.query(`SELECT id, display_name, clock_code FROM v3.persons WHERE id IN (4,5,6,7) ORDER BY id`)).rows;
  console.log('\n=== NOSSOS (tracker) ===');
  ours.forEach((x) => console.log(`  #${x.id} ${x.display_name} → clock_code=${x.clock_code || '(não mapeado)'}`));
  // --set id=code
  const sets = process.argv.filter((a) => a.startsWith('--set')).length
    ? process.argv.slice(2).filter((a) => /^\d+=\S+$/.test(a) || a === '--set').filter((a) => a !== '--set')
    : [];
  for (const s of sets) {
    const [id, code] = s.split('=');
    await p.query(`UPDATE v3.persons SET clock_code=$1 WHERE id=$2`, [String(code).replace(/^0+/, ''), parseInt(id, 10)]);
    console.log(`gravado: person #${id} → clock ${code}`);
  }
  // confere: nome do relógio bate com o nosso? (primeiro nome contido)
  console.log('\n=== CONFERÊNCIA nome↔código ===');
  const after = (await p.query(`SELECT id, display_name, clock_code FROM v3.persons WHERE clock_code IS NOT NULL AND clock_code <> ''`)).rows;
  for (const x of after) {
    const norm = (s) => String(s || '').trim().replace(/^0+/, '');
    const hit = roster.find((r) => norm(r.employee_code) === norm(x.clock_code));
    const clockName = hit ? (hit.employee_name || (hit.first_name + ' ' + hit.last_name)) : null;
    const first = x.display_name.toLowerCase().split(/\s+/)[0];
    const ok = clockName && clockName.toLowerCase().includes(first);
    console.log(`  #${x.id} ${x.display_name} ↔ clock ${x.clock_code} (${clockName || 'NÃO ACHADO NO ROSTER'}) ${ok ? '✓' : '⚠ CONFERIR'}`);
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); }).finally(() => p.end());
