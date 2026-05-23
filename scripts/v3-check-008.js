'use strict';
const { makeV3Pool } = require('../src/v3/utils/v3-pool');
(async () => {
  const p = makeV3Pool();
  try {
    const cols = await p.query(
      `SELECT column_name, data_type, column_default FROM information_schema.columns
       WHERE table_schema='v3' AND table_name='activity_types' AND column_name IN ('is_background','expected_seconds')`);
    console.log('activity_types novas colunas:', cols.rows);
    const ec = await p.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema='v3' AND table_name='events' AND column_name IN ('quantity','quantity_unit')`);
    console.log('events novas colunas:', ec.rows);
    const seed = await p.query(
      "SELECT id, slug, display_name, is_background, expected_seconds FROM v3.activity_types WHERE slug IN ('formulation','mixing','encapsulation') ORDER BY slug");
    console.log('seed is_background:', seed.rows);
    const st = await p.query(
      "SELECT key, value FROM v3.settings WHERE key IN ('meta_pauses_foreground','break_assumed_seconds','expedient_end_hour_ny','captura_aprimorada_cutover_date') ORDER BY key");
    console.log('settings:', st.rows);
  } catch (e) { console.error('ERRO:', e.message); process.exitCode = 1; }
  finally { await p.end(); }
})();
