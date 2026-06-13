-- ============================================================
-- HEALTHFARE V3 — Migration 020: dedupe Slack ↔ Operator Page
-- ============================================================
-- ADITIVO. v3.notifications e events.superseded_by_event_id já
-- vieram na 018. Aqui só a tabela de links de dedupe.
-- Critério de match (P9): mesma pessoa + mesmo activity_type +
-- janela ±120s + batch compatível (igual ou um dos dois NULL).
-- Idempotente. DOWN: 020_dedupe_links.down.sql
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS v3.dedupe_links (
  id             BIGSERIAL PRIMARY KEY,
  slack_event_id BIGINT NOT NULL REFERENCES v3.events(id),
  page_event_id  BIGINT NOT NULL REFERENCES v3.events(id),
  match_reason   VARCHAR(100) NOT NULL DEFAULT 'same_person_slug_window',
  matched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (slack_event_id),
  UNIQUE (page_event_id)
);

COMMENT ON TABLE v3.dedupe_links IS
  'Par slack_event ↔ page_event detectado pelo dedupe-watcher (cron 60s). '
  'O slack event vira superseded_by_event_id=page_event (soft hidden, sem delete).';

COMMIT;
