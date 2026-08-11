-- 069 — Watchdog de divergência de impressão (Bruno 08-06).
-- Todo dia 12pm NY: compara (1ª+2ª impressão digitadas) vs Veeqo impresso no dia.
-- Divergiu → pergunta pra Simone no #orders-and-inventory citando SÓ a DIFERENÇA
-- (nunca os totais — pra capturar o motivo real, não um ajuste de número).
-- A resposta dela (thread) é gravada aqui TODO dia → histórico pra investigar.
CREATE TABLE IF NOT EXISTS v3.print_divergence_log (
  id             SERIAL PRIMARY KEY,
  ny_date        DATE NOT NULL UNIQUE,
  operator_total INT NOT NULL,           -- 1ª+2ª impressão digitadas (não-teste)
  veeqo_total    INT NOT NULL,           -- labels impressas no Veeqo no dia
  diff           INT NOT NULL,           -- operator - veeqo
  asked          BOOLEAN NOT NULL DEFAULT false,
  question_ts    TEXT,                   -- ts da pergunta no Slack (thread)
  question_channel TEXT,
  answer_text    TEXT,                   -- resposta da Simone (1ª resposta humana na thread)
  answer_by      TEXT,                   -- user id/nome de quem respondeu
  answered_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
