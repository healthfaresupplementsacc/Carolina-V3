-- ============================================================
-- HEALTHFARE V3 — Migration 001: schema inicial (UP)
-- ============================================================
-- Sprint 1 / FASE 1 / PARTE 1.1
-- Referências: HEALTHFARE_VISION_V3.md §3.1 + reforços
--              §6.3 (contas compartilhadas), §6.7 (stale check),
--              §6.12 (prefix log), §6.13 (Sprint 1 atualizado).
--
-- Cria 17 tabelas NOVAS em paralelo. NÃO toca nenhuma tabela
-- legada — operators, tasks, pauses, workflow_instances,
-- phase_instances, ad_hoc_task_instances, operator_activity_log,
-- supplements, supplement_catalog permanecem 100% intactas.
--
-- Ordem de criação respeita FKs (pais antes de filhos).
-- DOWN reversível em 001_v3_initial.down.sql (PARTE 1.2).
-- Transação única — se qualquer DDL falhar, ROLLBACK total.
--
-- AINDA NÃO EXECUTADA contra o DB — apenas o arquivo.
-- Execução prevista: psql "$DATABASE_URL" -f 001_v3_initial.sql
-- ============================================================

BEGIN;

-- 1 ── persons ───────────────────────────────────────────────
-- slack_user_id NULL é permitido: pessoa sem conta Slack própria
-- (ex.: Bruno Sarmento, que posta de contas compartilhadas).
CREATE TABLE persons (
  id            SERIAL PRIMARY KEY,
  slack_user_id TEXT,
  slack_dm_id   TEXT,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','manager','operator')),
  active        BOOLEAN NOT NULL DEFAULT true,
  hired_at      TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ,
  deleted_by    INTEGER REFERENCES persons(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- §6.3: UNIQUE parcial — slack_user_id único só quando presente.
CREATE UNIQUE INDEX persons_slack_user_id_unique
  ON persons(slack_user_id) WHERE slack_user_id IS NOT NULL;

-- 2 ── shared_accounts ───────────────────────────────────────
-- Conta Slack usada por mais de uma pessoa. PK = o slack_user_id
-- da conta. §6.3.
CREATE TABLE shared_accounts (
  slack_user_id    TEXT PRIMARY KEY,
  primary_owner_id INTEGER REFERENCES persons(id),   -- NULL p/ conta neutra (ex.: Production Line)
  description      TEXT
);

-- 3 ── shared_account_users ──────────────────────────────────
-- Quem pode postar de uma conta compartilhada + como se
-- identifica no texto (prefixos). §6.3.
CREATE TABLE shared_account_users (
  id                SERIAL PRIMARY KEY,
  shared_account_id TEXT NOT NULL REFERENCES shared_accounts(slack_user_id),
  person_id         INTEGER NOT NULL REFERENCES persons(id),
  identifies_as     TEXT[] NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(shared_account_id, person_id)
);

-- 4 ── activity_types ────────────────────────────────────────
CREATE TABLE activity_types (
  id               SERIAL PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  category         TEXT NOT NULL
                     CHECK (category IN ('production_phase','support','meta')),
  requires_product BOOLEAN NOT NULL DEFAULT false,
  emoji            TEXT,
  color            TEXT,
  active           BOOLEAN NOT NULL DEFAULT true
);

-- 5 ── products ──────────────────────────────────────────────
CREATE TABLE products (
  id             SERIAL PRIMARY KEY,
  canonical_name TEXT NOT NULL UNIQUE,
  aliases        TEXT[] NOT NULL DEFAULT '{}',
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6 ── product_batches ───────────────────────────────────────
CREATE TABLE product_batches (
  id           SERIAL PRIMARY KEY,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  batch_number TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL,
  finished_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'in_progress'
                 CHECK (status IN ('in_progress','completed','cancelled','on_hold')),
  notes        TEXT,
  deleted_at   TIMESTAMPTZ,
  deleted_by   INTEGER REFERENCES persons(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(product_id, batch_number)
);

-- 7 ── events ────────────────────────────────────────────────
-- A entidade central do V3: a timeline de cada pessoa.
-- cowork_with é INTEGER[] (sem FK — Postgres não suporta FK em
-- array; integridade mantida por EventService.syncCoworkLinks).
CREATE TABLE events (
  id                  SERIAL PRIMARY KEY,
  person_id           INTEGER NOT NULL REFERENCES persons(id),
  activity_type_id    INTEGER REFERENCES activity_types(id),
  product_batch_id    INTEGER REFERENCES product_batches(id),
  started_at          TIMESTAMPTZ NOT NULL,
  ended_at            TIMESTAMPTZ,
  phase_label         TEXT,
  description         TEXT,
  source_message_ts   TEXT,
  confidence          TEXT NOT NULL DEFAULT 'high'
                         CHECK (confidence IN ('high','medium','low','unconfirmed')),
  cowork_with         INTEGER[] NOT NULL DEFAULT '{}',
  closed_reason       TEXT,
  last_stale_check_at TIMESTAMPTZ,
  stale_check_count   INTEGER NOT NULL DEFAULT 0,
  deleted_at          TIMESTAMPTZ,
  deleted_by          INTEGER REFERENCES persons(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE events IS
  'V3 timeline por pessoa. INSERT/UPDATE DIRETO PROIBIDO — toda mutacao via EventService.upsert() (V3 doc 6.4). Idempotencia por source_message_ts.';
COMMENT ON COLUMN events.cowork_with IS
  'person_ids que trabalharam junto no mesmo intervalo. Sem FK (array). Bidirecional, mantido por EventService.';
COMMENT ON COLUMN events.closed_reason IS
  'Motivo do fechamento. Valores conhecidos: next_event, manual, auto_timeout, admin_close, cowork_pause, auto_timeout_unanswered, source_deleted. Sem CHECK — a lista evolui (D-3).';

CREATE INDEX idx_events_person_started
  ON events(person_id, started_at DESC);
CREATE INDEX idx_events_active
  ON events(person_id) WHERE ended_at IS NULL;
CREATE INDEX idx_events_batch
  ON events(product_batch_id) WHERE product_batch_id IS NOT NULL;
CREATE INDEX idx_events_low_confidence
  ON events(confidence) WHERE confidence IN ('low','unconfirmed');
-- Idempotência §6.4: 1 event por mensagem-fonte.
CREATE UNIQUE INDEX idx_events_source_ts
  ON events(source_message_ts) WHERE source_message_ts IS NOT NULL;

-- 8 ── production_counts ─────────────────────────────────────
-- Contagens de garrafas. superseded_by (self-FK) preserva
-- histórico em correções (§3.12).
CREATE TABLE production_counts (
  id                    SERIAL PRIMARY KEY,
  product_id            INTEGER NOT NULL REFERENCES products(id),
  product_batch_id      INTEGER REFERENCES product_batches(id),
  bottles               INTEGER NOT NULL CHECK (bottles >= 0),
  reported_at           TIMESTAMPTZ NOT NULL,
  production_date       DATE NOT NULL,
  reported_by_person_id INTEGER NOT NULL REFERENCES persons(id),
  source_message_ts     TEXT,
  source_event_id       INTEGER REFERENCES events(id),
  notes                 TEXT,
  confidence            TEXT NOT NULL DEFAULT 'high'
                          CHECK (confidence IN ('high','medium','low','unconfirmed')),
  superseded_by         INTEGER REFERENCES production_counts(id),
  deleted_at            TIMESTAMPTZ,
  deleted_by            INTEGER REFERENCES persons(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_counts_batch
  ON production_counts(product_batch_id) WHERE product_batch_id IS NOT NULL;
CREATE INDEX idx_counts_product_date
  ON production_counts(product_id, production_date);

-- 9 ── messages ──────────────────────────────────────────────
-- Log de toda mensagem recebida do Slack. Fonte do Observer.
CREATE TABLE messages (
  id                SERIAL PRIMARY KEY,
  slack_ts          TEXT NOT NULL UNIQUE,
  slack_channel_id  TEXT NOT NULL,
  slack_user_id     TEXT NOT NULL,
  person_id         INTEGER REFERENCES persons(id),
  raw_text          TEXT NOT NULL,
  llm_processed_at  TIMESTAMPTZ,
  llm_result        JSONB,
  llm_provider_used TEXT,
  events_created    INTEGER[] NOT NULL DEFAULT '{}',
  events_updated    INTEGER[] NOT NULL DEFAULT '{}',
  processing_error  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10 ── prefix_resolution_log ────────────────────────────────
-- Auditoria de cada resolução de autor (§6.12).
CREATE TABLE prefix_resolution_log (
  id                   SERIAL PRIMARY KEY,
  message_id           INTEGER NOT NULL REFERENCES messages(id),
  source_slack_user_id TEXT NOT NULL,
  detected_prefix      TEXT,
  resolved_person_id   INTEGER REFERENCES persons(id),
  resolution_method    TEXT,
  confidence           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11 ── admin_chats ──────────────────────────────────────────
CREATE TABLE admin_chats (
  id         SERIAL PRIMARY KEY,
  person_id  INTEGER NOT NULL REFERENCES persons(id),
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  tool_calls JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 12 ── proposals ────────────────────────────────────────────
CREATE TABLE proposals (
  id          SERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','rejected','expired')),
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by INTEGER REFERENCES persons(id),
  expiry_at   TIMESTAMPTZ
);

-- 13 ── audit_log ────────────────────────────────────────────
CREATE TABLE audit_log (
  id              SERIAL PRIMARY KEY,
  actor_type      TEXT NOT NULL
                    CHECK (actor_type IN ('admin','llm_observer','llm_assistant','system')),
  actor_person_id INTEGER REFERENCES persons(id),
  action          TEXT NOT NULL,
  target_type     TEXT,
  target_id       INTEGER,
  before_data     JSONB,
  after_data      JSONB,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_recent ON audit_log(created_at DESC);

-- 14 ── llm_corrections ──────────────────────────────────────
CREATE TABLE llm_corrections (
  id                       SERIAL PRIMARY KEY,
  message_id               INTEGER NOT NULL REFERENCES messages(id),
  event_id                 INTEGER REFERENCES events(id),
  original_interpretation  JSONB NOT NULL,
  corrected_interpretation JSONB NOT NULL,
  correction_note          TEXT,
  corrected_by             INTEGER NOT NULL REFERENCES persons(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active_in_prompt         BOOLEAN NOT NULL DEFAULT true
);

-- 15 ── vocabulary ───────────────────────────────────────────
CREATE TABLE vocabulary (
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

-- 16 ── person_language_profile ──────────────────────────────
CREATE TABLE person_language_profile (
  person_id        INTEGER PRIMARY KEY REFERENCES persons(id),
  common_phrases   JSONB,
  abbreviation_map JSONB,
  message_style    TEXT,
  language         TEXT NOT NULL DEFAULT 'pt-BR',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 17 ── settings ─────────────────────────────────────────────
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  INTEGER REFERENCES persons(id)
);

COMMIT;

-- ============================================================
-- FIM — 17 tabelas, 9 índices (2 deles UNIQUE parciais:
-- persons_slack_user_id_unique, idx_events_source_ts).
-- ============================================================
