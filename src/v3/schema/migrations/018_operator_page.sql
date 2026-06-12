-- ============================================================
-- HEALTHFARE V3 — Migration 018: Operator Page (Deploy 2)
-- ============================================================
-- ADITIVO. Suporte à página de operadores (/op):
--   1. v3.persons: PIN (scrypt hash+salt), auto-logoff, flags
--   2. v3.operator_sessions: sessões de login da página
--   3. v3.events.source: origem do event (slack|operator_page|
--      admin_dashboard|manual_catchup)
--   4. v3.events.superseded_by_event_id (adiantado da Fase 4 dedupe)
--   5. v3.audit_log: CHECK actor_type AMPLIADO (+operator_page,
--      +admin_via_slack, +dedupe_worker)
--   6. v3.op_notes: notas livres da página
--   7. v3.notifications (adiantada da Fase 4 — clock-out "Não sei" usa)
--
-- Idempotente (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS).
-- DOWN: 018_operator_page.down.sql
-- ============================================================

BEGIN;

-- 1 ── persons: PIN + auto-logoff ─────────────────────────────
ALTER TABLE v3.persons ADD COLUMN IF NOT EXISTS pin_hash  VARCHAR(255);
ALTER TABLE v3.persons ADD COLUMN IF NOT EXISTS pin_salt  VARCHAR(255);
ALTER TABLE v3.persons ADD COLUMN IF NOT EXISTS auto_logoff_seconds INT DEFAULT 30; -- NULL = desativado
ALTER TABLE v3.persons ADD COLUMN IF NOT EXISTS last_page_login_at TIMESTAMPTZ;
ALTER TABLE v3.persons ADD COLUMN IF NOT EXISTS is_admin_operator BOOLEAN DEFAULT FALSE;
-- Bruno Sarmento (formulador): pode SEMPRE pular bottle count no clock-out (P5)
ALTER TABLE v3.persons ADD COLUMN IF NOT EXISTS count_exempt BOOLEAN DEFAULT FALSE;

-- 2 ── operator_sessions ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS v3.operator_sessions (
  id               BIGSERIAL PRIMARY KEY,
  person_id        INT NOT NULL REFERENCES v3.persons(id),
  session_token    VARCHAR(255) UNIQUE NOT NULL,
  source           VARCHAR(20) DEFAULT 'page',     -- 'page' | 'slack'
  ip_address       VARCHAR(64),
  user_agent       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  logged_out_at    TIMESTAMPTZ,
  logoff_reason    VARCHAR(50)                     -- 'manual' | 'auto_timeout' | 'admin_force' | 'clock_out'
);
CREATE INDEX IF NOT EXISTS idx_op_sessions_active
  ON v3.operator_sessions(person_id) WHERE logged_out_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_op_sessions_token
  ON v3.operator_sessions(session_token) WHERE logged_out_at IS NULL;

-- 3 ── events.source ──────────────────────────────────────────
-- DEFAULT 'slack' preenche as rows existentes; depois corrige as sem msg.
ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'slack';
UPDATE v3.events SET source = 'manual_catchup'
 WHERE source = 'slack' AND source_message_ts IS NULL;

-- 4 ── events.superseded_by_event_id (Fase 4 dedupe, adiantado) ─
ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS superseded_by_event_id BIGINT REFERENCES v3.events(id) DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_events_superseded
  ON v3.events(superseded_by_event_id) WHERE superseded_by_event_id IS NOT NULL;

-- 5 ── audit_log: CHECK actor_type ampliado ───────────────────
ALTER TABLE v3.audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_type_check;
ALTER TABLE v3.audit_log ADD CONSTRAINT audit_log_actor_type_check
  CHECK (actor_type = ANY (ARRAY[
    'admin'::text, 'llm_observer'::text, 'llm_assistant'::text,
    'system'::text, 'app_home'::text,
    'operator_page'::text, 'admin_via_slack'::text, 'dedupe_worker'::text
  ]));

-- 6 ── op_notes: notas livres da página ───────────────────────
CREATE TABLE IF NOT EXISTS v3.op_notes (
  id         BIGSERIAL PRIMARY KEY,
  person_id  INT NOT NULL REFERENCES v3.persons(id),
  text       TEXT NOT NULL,
  source     VARCHAR(20) NOT NULL DEFAULT 'operator_page',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_op_notes_created ON v3.op_notes(created_at DESC);

-- 7 ── notifications (Fase 4, adiantada p/ clock-out "Não sei") ─
CREATE TABLE IF NOT EXISTS v3.notifications (
  id                  BIGSERIAL PRIMARY KEY,
  type                VARCHAR(50) NOT NULL,
    -- 'slack_event_not_on_page' | 'unfilled_bottle_count' | 'operator_long_idle' | ...
  payload             JSONB NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'pending',
    -- 'pending' | 'admin_accepted' | 'admin_rejected' | 'admin_edited' | 'auto_resolved'
  admin_action_by     INT REFERENCES v3.persons(id),
  admin_response_text TEXT,
  carolina_slack_ts   VARCHAR(50),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_notifications_pending
  ON v3.notifications(created_at DESC) WHERE status = 'pending';

COMMENT ON TABLE v3.operator_sessions IS
  'Sessões de login da Operator Page (/op). PIN 4 dígitos → scrypt. Deploy 2 (12/jun).';

COMMIT;
