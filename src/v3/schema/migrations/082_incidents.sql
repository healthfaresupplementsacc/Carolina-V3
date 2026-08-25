-- 082 — Incidentes (Bruno 08-25: "temos que fechar todas as aberturas de esses
-- erros repentinos e sem sentido de acontecer").
--
-- CONTEXTO: o push de câmera do PC .28 parou em 2026-08-23T23:39:15Z e ficou 42h
-- morto sem ninguém perceber; o encap-monitor, cego, gritou alarme falso pros
-- operadores. Esta tabela é o registro permanente de cada falha dessas: o que
-- aconteceu, quando, e onde está o dossiê com os dados crus.
--
-- dossier_path aponta pro arquivo no Obsidian (G:\...\Incidentes\). Como o
-- servidor roda no Railway e NÃO tem o G:, o markdown inteiro fica em
-- detail->>'dossier_md' até uma máquina com o vault rodar flushDossiers().
-- Assim o incidente NUNCA falha por causa de disco.
--
-- SEM colunas de quantidade: incidente é observação, não estoque. Quem escreve
-- quantidade continua sendo só o StockService.
-- Princípio #24: tudo schema-qualificado v3.*.

BEGIN;

CREATE TABLE IF NOT EXISTS v3.incidents (
  id            BIGSERIAL PRIMARY KEY,
  code          TEXT NOT NULL,
  title         TEXT NOT NULL,
  detail        JSONB NULL,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'claimed', 'resolved')),
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at    TIMESTAMPTZ NULL,
  resolved_at   TIMESTAMPTZ NULL,
  claimed_by    TEXT NULL,
  dossier_path  TEXT NULL,
  slack_ts      TEXT NULL
);

-- "tem incidente aberto desse código?" é a pergunta mais feita.
CREATE INDEX IF NOT EXISTS idx_incidents_code_status
  ON v3.incidents (code, status, opened_at DESC);

-- lista do painel: os mais recentes primeiro.
CREATE INDEX IF NOT EXISTS idx_incidents_opened
  ON v3.incidents (opened_at DESC);

-- dossiês pendentes de gravação no Obsidian (flushDossiers).
CREATE INDEX IF NOT EXISTS idx_incidents_dossier_pending
  ON v3.incidents (opened_at)
  WHERE (detail->>'dossier_md') IS NOT NULL;

COMMENT ON TABLE v3.incidents IS 'Incidentes automáticos do sistema (watchdog de sinais). Um por falha, com dossiê em Markdown.';
COMMENT ON COLUMN v3.incidents.dossier_path IS 'Caminho PRETENDIDO do dossiê no Obsidian. Pode ainda não existir se foi aberto no Railway.';

COMMIT;
