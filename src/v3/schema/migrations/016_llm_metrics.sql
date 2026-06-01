-- ============================================================
-- HEALTHFARE V3 — Migration 016: v3.llm_metrics
-- ============================================================
-- ADITIVO. Tabela de telemetria por chamada LLM pra medir economia
-- do prompt caching (Fase 1 do bloco 1/jun cost optimization).
--
-- Captura input/output tokens, cache hit/miss, custo USD estimado,
-- model usado, message_id ligado. Permite calcular % cache hit e
-- economia mensal pós-implementação.
--
-- Caso motivador: pesquisa GitHub mostra 80-90% economia com prompt
-- caching Anthropic em system prompts grandes (regras + catálogos
-- fixos).
--
-- Idempotente. DOWN: DROP TABLE.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS v3.llm_metrics (
  id                              BIGSERIAL    PRIMARY KEY,
  message_id                      INTEGER,                  -- v3.messages.id (NULL pra chamadas fora do classify)
  caller                          TEXT         NOT NULL,    -- 'observer' | 'person_resolver' | 'command_handler' | etc
  model                           TEXT         NOT NULL,    -- 'claude-sonnet-4-6' | 'claude-haiku-4-5' | ...
  provider                        TEXT         NOT NULL DEFAULT 'anthropic',
  input_tokens                    INTEGER      NOT NULL DEFAULT 0,
  output_tokens                   INTEGER      NOT NULL DEFAULT 0,
  cache_creation_input_tokens     INTEGER      NOT NULL DEFAULT 0,
  cache_read_input_tokens         INTEGER      NOT NULL DEFAULT 0,
  cost_estimate_usd               NUMERIC(10,6) NOT NULL DEFAULT 0,
  processing_ms                   INTEGER      NOT NULL DEFAULT 0,
  cache_enabled                   BOOLEAN      NOT NULL DEFAULT false,
  created_at                      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Agregação por dia/caller (dashboards de custo)
CREATE INDEX IF NOT EXISTS idx_llm_metrics_created_at
  ON v3.llm_metrics (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_llm_metrics_caller_created
  ON v3.llm_metrics (caller, created_at DESC);

-- Diagnóstico por msg (pesquisar gasto/cache hit em msgs específicas)
CREATE INDEX IF NOT EXISTS idx_llm_metrics_message_id
  ON v3.llm_metrics (message_id) WHERE message_id IS NOT NULL;

COMMENT ON TABLE v3.llm_metrics IS
  'Telemetria por chamada LLM — input/output tokens, cache hit/miss, '
  'custo estimado. Bloco 1/jun cost optimization Fase 1 (prompt caching).';

COMMIT;
