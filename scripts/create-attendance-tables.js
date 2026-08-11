'use strict';
// Bruno 07-22: integração do relógio de ponto NGTeco (NG-TC2).
// att_punch = cada batida crua (interna, NUNCA mostrada pro funcionário);
// att_state = estado do dia por pessoa (checkin/checkout/almoço/nudges);
// persons.clock_code = employee_code do relógio (mapeamento inquebrável por ID).
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  await p.query(`ALTER TABLE v3.persons ADD COLUMN IF NOT EXISTS clock_code TEXT`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS v3.att_punch (
      id            SERIAL PRIMARY KEY,
      person_id     INT REFERENCES v3.persons(id),
      employee_code TEXT NOT NULL,
      att_date      DATE NOT NULL,
      punch_time    TIMESTAMPTZ NOT NULL,
      seq           INT,               -- posição no dia (1º, 2º...)
      status        TEXT,              -- status cru do NGTeco
      raw           JSONB,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (employee_code, punch_time)
    )`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_att_punch_day ON v3.att_punch (person_id, att_date)`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS v3.att_state (
      person_id     INT NOT NULL REFERENCES v3.persons(id),
      att_date      DATE NOT NULL,
      checkin_at    TIMESTAMPTZ,       -- 1ª batida do dia
      checkout_at   TIMESTAMPTZ,       -- batida de saída (fim de dia)
      state         TEXT NOT NULL DEFAULT 'out',  -- in | out | break
      break_started_at TIMESTAMPTZ,    -- pausa em andamento (interno)
      punches_count INT NOT NULL DEFAULT 0,
      last_in_at    TIMESTAMPTZ,       -- última batida de ENTRADA (chegada ou volta)
      nudged_no_task_at TIMESTAMPTZ,   -- "chegou e não registrou tarefa" (1x por batida-in)
      noclockin_callout_at TIMESTAMPTZ,-- "esqueceu de bater o ponto" (1x/dia)
      checkin_notified BOOLEAN NOT NULL DEFAULT false,
      checkout_notified BOOLEAN NOT NULL DEFAULT false,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (person_id, att_date)
    )`);
  // Mapeamento conhecido (doc + Bruno): Vitor=8, Ana Kesya=39. O employee_code do
  // NGTeco pode vir "8" ou "08" — normalizamos SEM zeros à esquerda no worker.
  // Simone e Bruno Sarmento: completar após puxar o roster (script map-clock-roster).
  await p.query(`UPDATE v3.persons SET clock_code='8'  WHERE id=4 AND (clock_code IS NULL OR clock_code='')`);   // Vitor
  await p.query(`UPDATE v3.persons SET clock_code='39' WHERE id=6 AND (clock_code IS NULL OR clock_code='')`);   // Ana (Ana Kesya)
  const m = (await p.query(`SELECT id, display_name, clock_code FROM v3.persons WHERE clock_code IS NOT NULL ORDER BY id`)).rows;
  console.log('tabelas OK. mapeados:', m.map(x => `#${x.id} ${x.display_name}→clock ${x.clock_code}`).join(', ') || '(nenhum)');
})().catch(e => { console.error('ERR', e.message); process.exit(1); }).finally(() => p.end());
