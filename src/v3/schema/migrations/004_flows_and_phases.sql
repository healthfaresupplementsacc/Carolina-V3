-- ============================================================
-- HEALTHFARE V3 — Migration 004: fluxos e fases
-- ============================================================
-- Bloco 1 (Sprint 2). Os 3 fluxos independentes (Produção / P&P /
-- Suporte) e a fase de cada activity_type dentro do seu fluxo.
--
-- - v3.flows: referência dos 3 fluxos (fixos, estruturais).
-- - activity_types.flow + phase_order: a qual fluxo o activity_type
--   pertence e a posição na sequência (NULL = fluxo não-ordenado).
-- - category ganha 'pnp_phase' p/ as fases de Picking & Packing
--   (são "work" — não-meta — então auto-fecham o event anterior).
-- - events.flow_override: propagação OPCIONAL (decisão Bruno). Por
--   padrão o fluxo do event é DERIVADO do activity_type; quando o
--   admin corrige um activity_type e escolhe "só daqui pra frente",
--   os events antigos recebem flow_override = fluxo antigo (congela).
--
-- O preenchimento de flow/phase_order nos activity_types é feito
-- pelo script v3-tag-flows.js (dry-run -> apply), não por esta
-- migration. Aqui só o schema + os 3 fluxos.
--
-- Incremental (001 já rodou). Transação única. DOWN disponível.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS v3.flows (
  slug         TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  is_ordered   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO v3.flows (slug, display_name, is_ordered) VALUES
  ('production', 'Produção',          true),
  ('pnp',        'Picking & Packing', true),
  ('support',    'Suporte',           false)
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE v3.activity_types ADD COLUMN IF NOT EXISTS flow TEXT REFERENCES v3.flows(slug);
ALTER TABLE v3.activity_types ADD COLUMN IF NOT EXISTS phase_order INTEGER;

ALTER TABLE v3.activity_types DROP CONSTRAINT activity_types_category_check;
ALTER TABLE v3.activity_types ADD CONSTRAINT activity_types_category_check
  CHECK (category IN ('production_phase', 'support', 'meta', 'pnp_phase'));

ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS flow_override TEXT REFERENCES v3.flows(slug);

COMMENT ON COLUMN v3.activity_types.flow IS
  'Fluxo (v3.flows.slug): production | pnp | support. NULL = ainda não classificado.';
COMMENT ON COLUMN v3.activity_types.phase_order IS
  'Posição na sequência do fluxo (1,2,3...). NULL em fluxo não-ordenado (support) ou atividade genérica.';
COMMENT ON COLUMN v3.events.flow_override IS
  'Bloco 1: override opcional de fluxo. NULL = deriva do activity_type. '
  'Preenchido só quando o admin corrige um activity_type e escolhe congelar os events antigos.';

COMMIT;
