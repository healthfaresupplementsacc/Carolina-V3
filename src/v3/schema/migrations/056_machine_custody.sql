-- 056 — Custódia de máquina com CONFIRMAÇÃO no retorno (Bruno 07-07/08).
-- Substitui a devolução AUTOMÁTICA por um fluxo explícito e escalável:
--   • dono vai pra pausa → máquina(s) passam pro substituto (jobs marcados com
--     bg_handoff_from_person_id = dono) E registra COBERTURA ativa aqui;
--   • jobs que o substituto roda enquanto cobre também ficam marcados pro dono;
--   • job concluído → fecha + avisa (substituto CONTINUA responsável);
--   • dono volta → o app pergunta "assumir a máquina? SIM/NÃO" e ele escolhe
--     QUAIS jobs abertos assumir; o resto continua com o substituto.
-- Escala a N operadores: 1 cobertura ATIVA por dono; jobs carregam o dono real.

CREATE TABLE IF NOT EXISTS v3.machine_custody (
  id               BIGSERIAL PRIMARY KEY,
  owner_person_id  INTEGER NOT NULL REFERENCES v3.persons(id),  -- de quem é a máquina
  cover_person_id  INTEGER NOT NULL REFERENCES v3.persons(id),  -- quem está cobrindo agora
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ,                                 -- NULL = cobertura ATIVA
  resolution       TEXT,        -- taken_over | partial | declined | stopped | expired | superseded
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- no máximo 1 cobertura ATIVA por dono (o retorno resolve). Também acelera o lookup.
CREATE UNIQUE INDEX IF NOT EXISTS uq_machine_custody_active_owner
  ON v3.machine_custody (owner_person_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_machine_custody_active_cover
  ON v3.machine_custody (cover_person_id) WHERE ended_at IS NULL;
