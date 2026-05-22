-- ============================================================
-- HEALTHFARE V3 — Migration 007: deadlines configuráveis
-- ============================================================
-- Bloco 3. Deadlines por fluxo, editáveis pelo admin (handoff §7.7).
-- Recorrentes (todo dia 13:00) ou pontuais (corte do FBA nesta sexta).
-- Princípio #12: nunca hardcoded; o admin define e ajusta.
--
-- Incremental. Transação única. DOWN: 007_deadlines.down.sql.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS v3.deadlines (
  id           SERIAL PRIMARY KEY,
  flow         TEXT REFERENCES v3.flows(slug),     -- NULL = deadline geral
  label        TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'recurring'
                 CHECK (kind IN ('recurring', 'one_off')),
  time_of_day  TEXT,                               -- 'HH:MM' (America/New_York)
  weekdays     INTEGER[] NOT NULL DEFAULT '{1,2,3,4,5}', -- 0=dom..6=sáb (recorrente)
  due_date     DATE,                               -- p/ one_off
  active       BOOLEAN NOT NULL DEFAULT true,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deadlines_flow ON v3.deadlines(flow);

COMMENT ON TABLE v3.deadlines IS
  'V3 deadlines configuráveis por fluxo (Bloco 3). INSERT/UPDATE via DeadlineService.';

-- deadline default observado no handoff §6: P&P até ~13:00 (correio).
INSERT INTO v3.deadlines (flow, label, kind, time_of_day, weekdays)
SELECT 'pnp', 'Corte do correio', 'recurring', '13:00', '{1,2,3,4,5}'
WHERE NOT EXISTS (SELECT 1 FROM v3.deadlines);

COMMIT;
