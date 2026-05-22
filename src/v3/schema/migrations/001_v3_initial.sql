-- ============================================================
-- HEALTHFARE V3 — Migration 001: schema inicial (UP)
-- ============================================================
-- Sprint 1 / FASE 1 / PARTE 1.1  (Opção B — namespace dedicado)
-- Referências: HEALTHFARE_VISION_V3.md §3.1 + reforços
--              §6.3, §6.7, §6.12, §6.13.
--
-- As 17 tabelas V3 vivem no schema Postgres dedicado `v3`
-- (princípio #24). Isolamento total do legado em `public` —
-- resolve a colisão de nomes com public.messages (legado, vivo)
-- e public.production_counts (legado).
--
-- NÃO toca nenhuma tabela legada (tudo em public permanece).
-- Ordem de criação respeita FKs (pais antes de filhos).
-- DOWN: 001_v3_initial.down.sql → DROP SCHEMA v3 CASCADE.
-- Transação única — falha em qualquer DDL → ROLLBACK total.
--
-- Execução: runner node-pg (psql indisponível no ambiente).
-- ============================================================

BEGIN;

CREATE SCHEMA v3;

-- 1 ── v3.persons ────────────────────────────────────────────
-- slack_user_id NULL é permitido: pessoa sem conta Slack própria.
CREATE TABLE v3.persons (
  id            SERIAL PRIMARY KEY,
  slack_user_id TEXT,
  slack_dm_id   TEXT,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','manager','operator')),
  active        BOOLEAN NOT NULL DEFAULT true,
  hired_at      TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ,
  deleted_by    INTEGER REFERENCES v3.persons(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- §6.3: UNIQUE parcial — slack_user_id único só quando presente.
CREATE UNIQUE INDEX persons_slack_user_id_unique
  ON v3.persons(slack_user_id) WHERE slack_user_id IS NOT NULL;

-- 2 ── v3.shared_accounts ────────────────────────────────────
CREATE TABLE v3.shared_accounts (
  slack_user_id    TEXT PRIMARY KEY,
  primary_owner_id INTEGER REFERENCES v3.persons(id),  -- NULL p/ conta neutra (ex.: Production Line)
  slack_dm_id      TEXT,                               -- DM channel da conta (preserva ex.: D0B5YDY3S8G)
  description      TEXT
);

-- 3 ── v3.shared_account_users ───────────────────────────────
CREATE TABLE v3.shared_account_users (
  id                SERIAL PRIMARY KEY,
  shared_account_id TEXT NOT NULL REFERENCES v3.shared_accounts(slack_user_id),
  person_id         INTEGER NOT NULL REFERENCES v3.persons(id),
  identifies_as     TEXT[] NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(shared_account_id, person_id)
);

-- 4 ── v3.flows + v3.activity_types ──────────────────────────
-- v3.flows: os 3 fluxos independentes (Bloco 1 / migration 004).
CREATE TABLE v3.flows (
  slug         TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  is_ordered   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE v3.activity_types (
  id               SERIAL PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  category         TEXT NOT NULL
                     CHECK (category IN ('production_phase','support','meta','pnp_phase')),
  requires_product BOOLEAN NOT NULL DEFAULT false,
  emoji            TEXT,
  color            TEXT,
  active           BOOLEAN NOT NULL DEFAULT true,
  flow             TEXT REFERENCES v3.flows(slug),  -- Bloco 1: fluxo do activity_type
  phase_order      INTEGER                          -- Bloco 1: posição na sequência
);

-- 5 ── v3.products ───────────────────────────────────────────
CREATE TABLE v3.products (
  id             SERIAL PRIMARY KEY,
  canonical_name TEXT NOT NULL UNIQUE,
  aliases        TEXT[] NOT NULL DEFAULT '{}',
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6 ── v3.product_batches ────────────────────────────────────
CREATE TABLE v3.product_batches (
  id           SERIAL PRIMARY KEY,
  product_id   INTEGER NOT NULL REFERENCES v3.products(id),
  batch_number TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL,
  finished_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'in_progress'
                 CHECK (status IN ('in_progress','completed','cancelled','on_hold')),
  notes        TEXT,
  deleted_at   TIMESTAMPTZ,
  deleted_by   INTEGER REFERENCES v3.persons(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(product_id, batch_number)
);

-- 7 ── v3.events ─────────────────────────────────────────────
-- A entidade central do V3: a timeline de cada pessoa.
CREATE TABLE v3.events (
  id                  SERIAL PRIMARY KEY,
  person_id           INTEGER NOT NULL REFERENCES v3.persons(id),
  activity_type_id    INTEGER REFERENCES v3.activity_types(id),
  product_batch_id    INTEGER REFERENCES v3.product_batches(id),
  started_at          TIMESTAMPTZ NOT NULL,
  ended_at            TIMESTAMPTZ,
  phase_label         TEXT,
  description         TEXT,
  source_message_ts   TEXT,
  confidence          TEXT NOT NULL DEFAULT 'high'
                         CHECK (confidence IN ('high','medium','low','unconfirmed')),
  cowork_with         INTEGER[] NOT NULL DEFAULT '{}',
  closed_reason       TEXT,
  flow_override       TEXT REFERENCES v3.flows(slug),  -- Bloco 1: override opcional de fluxo
  last_stale_check_at TIMESTAMPTZ,
  stale_check_count   INTEGER NOT NULL DEFAULT 0,
  deleted_at          TIMESTAMPTZ,
  deleted_by          INTEGER REFERENCES v3.persons(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE v3.events IS
  'V3 timeline por pessoa. INSERT/UPDATE DIRETO PROIBIDO — toda mutacao via EventService.upsert() (V3 doc 6.4). Idempotencia por source_message_ts.';
COMMENT ON COLUMN v3.events.cowork_with IS
  'person_ids que trabalharam junto no mesmo intervalo. Sem FK (array). Bidirecional, mantido por EventService.';
COMMENT ON COLUMN v3.events.closed_reason IS
  'Motivo do fechamento. Valores conhecidos: next_event, manual, auto_timeout, admin_close, cowork_pause, auto_timeout_unanswered, source_deleted. Sem CHECK — a lista evolui (D-3).';

CREATE INDEX idx_events_person_started
  ON v3.events(person_id, started_at DESC);
CREATE INDEX idx_events_active
  ON v3.events(person_id) WHERE ended_at IS NULL;
CREATE INDEX idx_events_batch
  ON v3.events(product_batch_id) WHERE product_batch_id IS NOT NULL;
CREATE INDEX idx_events_low_confidence
  ON v3.events(confidence) WHERE confidence IN ('low','unconfirmed');
-- Idempotência §6.4: 1 event por mensagem-fonte.
CREATE UNIQUE INDEX idx_events_source_ts
  ON v3.events(source_message_ts) WHERE source_message_ts IS NOT NULL;

-- 8 ── v3.production_counts ──────────────────────────────────
CREATE TABLE v3.production_counts (
  id                    SERIAL PRIMARY KEY,
  product_id            INTEGER NOT NULL REFERENCES v3.products(id),
  product_batch_id      INTEGER REFERENCES v3.product_batches(id),
  bottles               INTEGER NOT NULL CHECK (bottles >= 0),
  reported_at           TIMESTAMPTZ NOT NULL,
  production_date       DATE NOT NULL,
  reported_by_person_id INTEGER NOT NULL REFERENCES v3.persons(id),
  source_message_ts     TEXT,
  source_event_id       INTEGER REFERENCES v3.events(id),
  notes                 TEXT,
  confidence            TEXT NOT NULL DEFAULT 'high'
                          CHECK (confidence IN ('high','medium','low','unconfirmed')),
  superseded_by         INTEGER REFERENCES v3.production_counts(id),
  deleted_at            TIMESTAMPTZ,
  deleted_by            INTEGER REFERENCES v3.persons(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_counts_batch
  ON v3.production_counts(product_batch_id) WHERE product_batch_id IS NOT NULL;
CREATE INDEX idx_counts_product_date
  ON v3.production_counts(product_id, production_date);

-- 9 ── v3.messages ───────────────────────────────────────────
-- Log de toda mensagem recebida do Slack. Fonte do Observer.
CREATE TABLE v3.messages (
  id                SERIAL PRIMARY KEY,
  slack_ts          TEXT NOT NULL UNIQUE,
  slack_channel_id  TEXT NOT NULL,
  slack_user_id     TEXT NOT NULL,
  person_id         INTEGER REFERENCES v3.persons(id),
  raw_text          TEXT NOT NULL,
  llm_processed_at  TIMESTAMPTZ,
  llm_result        JSONB,
  llm_provider_used TEXT,
  events_created    INTEGER[] NOT NULL DEFAULT '{}',
  events_updated    INTEGER[] NOT NULL DEFAULT '{}',
  processing_error  TEXT,
  claimed_at        TIMESTAMPTZ,            -- FIX A: claim do worker (ver migration 003)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10 ── v3.prefix_resolution_log ─────────────────────────────
CREATE TABLE v3.prefix_resolution_log (
  id                   SERIAL PRIMARY KEY,
  message_id           INTEGER NOT NULL REFERENCES v3.messages(id),
  source_slack_user_id TEXT NOT NULL,
  detected_prefix      TEXT,
  resolved_person_id   INTEGER REFERENCES v3.persons(id),
  resolution_method    TEXT,
  confidence           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11 ── v3.admin_chats ───────────────────────────────────────
CREATE TABLE v3.admin_chats (
  id         SERIAL PRIMARY KEY,
  person_id  INTEGER NOT NULL REFERENCES v3.persons(id),
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  tool_calls JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 12 ── v3.proposals ─────────────────────────────────────────
CREATE TABLE v3.proposals (
  id          SERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','rejected','expired')),
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by INTEGER REFERENCES v3.persons(id),
  expiry_at   TIMESTAMPTZ
);

-- 13 ── v3.audit_log ─────────────────────────────────────────
CREATE TABLE v3.audit_log (
  id              SERIAL PRIMARY KEY,
  actor_type      TEXT NOT NULL
                    CHECK (actor_type IN ('admin','llm_observer','llm_assistant','system','app_home')),
  actor_person_id INTEGER REFERENCES v3.persons(id),
  action          TEXT NOT NULL,
  target_type     TEXT,
  target_id       INTEGER,
  before_data     JSONB,
  after_data      JSONB,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_recent ON v3.audit_log(created_at DESC);

-- 14 ── v3.llm_corrections ───────────────────────────────────
CREATE TABLE v3.llm_corrections (
  id                       SERIAL PRIMARY KEY,
  message_id               INTEGER NOT NULL REFERENCES v3.messages(id),
  event_id                 INTEGER REFERENCES v3.events(id),
  original_interpretation  JSONB NOT NULL,
  corrected_interpretation JSONB NOT NULL,
  correction_note          TEXT,
  corrected_by             INTEGER NOT NULL REFERENCES v3.persons(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active_in_prompt         BOOLEAN NOT NULL DEFAULT true
);

-- 15 ── v3.vocabulary ────────────────────────────────────────
CREATE TABLE v3.vocabulary (
  id               SERIAL PRIMARY KEY,
  term             TEXT NOT NULL UNIQUE,
  first_seen_at    TIMESTAMPTZ NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  context_examples JSONB,
  meaning          TEXT,
  category         TEXT,
  promoted_at      TIMESTAMPTZ,
  admin_confirmed  BOOLEAN NOT NULL DEFAULT false
);

-- 16 ── v3.person_language_profile ───────────────────────────
CREATE TABLE v3.person_language_profile (
  person_id        INTEGER PRIMARY KEY REFERENCES v3.persons(id),
  common_phrases   JSONB,
  abbreviation_map JSONB,
  message_style    TEXT,
  language         TEXT NOT NULL DEFAULT 'pt-BR',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 17 ── v3.settings ──────────────────────────────────────────
CREATE TABLE v3.settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  INTEGER REFERENCES v3.persons(id)
);

COMMIT;

-- ============================================================
-- FIM — schema v3 + 17 tabelas, 9 índices (2 UNIQUE parciais:
-- persons_slack_user_id_unique, idx_events_source_ts).
-- ============================================================
