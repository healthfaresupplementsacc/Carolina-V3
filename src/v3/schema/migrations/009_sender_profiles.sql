-- ============================================================
-- HEALTHFARE V3 — Migration 009: sender_profiles
-- ============================================================
-- Personas reusáveis pro "Falar como X" — porta de saída MANUAL
-- (Bruno clica/manda, posta no Slack via username override). NÃO
-- tem nada a ver com o Observer/captura — é independente do shadow.
--
-- icon: opcional. Pode ser :emoji: ou URL https://. NULL = ícone
-- default do bot.
--
-- is_default: marca o sender escolhido por padrão no dashboard.
-- Garante 1 default só por trigger ou pela UI (default Carolina seed).
--
-- soft delete via deleted_at — manter histórico de quem foi usado
-- num post antigo (audit_log referencia o nome textual, não o id).
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS v3.sender_profiles (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  icon        TEXT,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sender_profiles_name_active
  ON v3.sender_profiles (LOWER(name)) WHERE deleted_at IS NULL;

COMMENT ON TABLE v3.sender_profiles IS
  'Personas usadas no "Falar como" (porta manual). NÃO afeta captura. icon opcional (:emoji: ou URL).';

INSERT INTO v3.sender_profiles (name, icon, is_default)
VALUES ('Carolina', NULL, true)
ON CONFLICT DO NOTHING;

COMMIT;
