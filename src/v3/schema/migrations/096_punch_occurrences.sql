-- 096 — OCORRENCIAS DE PONTO FALTANDO (Bruno 09-28): registro do aviso do DIA
-- SEGUINTE. O sistema NAO avisa mais no mesmo dia (NGTeco atrasa ~45min e acusa
-- inocente). No dia seguinte as 9:40am, com o relogio ja sincronizado, o worker
-- confere os registros de ontem e SO entao registra uma ocorrencia por dia/pessoa
-- quando a falta e CONFIRMADA. A contagem dos ultimos 30 dias escolhe o nivel de
-- punicao (1-2=dia, 3=semana, 4=+semana, 5=+semana, 6+=reuniao+2 meses).
-- REMOCAO REAL do beneficio e MANUAL (Bruno faz na mao); aqui so registra e avisa.
CREATE TABLE IF NOT EXISTS v3.punch_occurrence (
  id           BIGSERIAL PRIMARY KEY,
  person_id    INTEGER NOT NULL REFERENCES v3.persons(id),
  occ_date     DATE NOT NULL,                 -- o DIA em que faltou a batida (NY)
  missing_in   BOOLEAN NOT NULL DEFAULT false, -- faltou entrada (manha ou volta do almoco)
  missing_out  BOOLEAN NOT NULL DEFAULT false, -- faltou saida (almoco ou fim do dia)
  detail       TEXT,                           -- ex.: 'entrada do almoco', 'saida do dia'
  occ_index    INTEGER,                        -- a quantas ocorrencias em 30 dias esta chegou (1..N)
  level        INTEGER,                        -- nivel de punicao aplicado no aviso (1..6)
  notified_at  TIMESTAMPTZ,                    -- quando o aviso foi postado no canal dos operadores
  notify_ts    TEXT,                           -- ts da msg no Slack (pra referencia/apagar se preciso)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (person_id, occ_date)                 -- 1 ocorrencia por dia/pessoa (regra do Bruno)
);
CREATE INDEX IF NOT EXISTS idx_punch_occurrence_person_date ON v3.punch_occurrence (person_id, occ_date);
CREATE INDEX IF NOT EXISTS idx_punch_occurrence_date ON v3.punch_occurrence (occ_date);
