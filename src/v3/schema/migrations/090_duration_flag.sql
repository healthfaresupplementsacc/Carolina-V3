-- 090 — CHECAGEM DE DURAÇÃO (Bruno 09-11).
-- "Tem vezes que a pessoa entra uma tarefa sem querer. Se uma tarefa é feita em
--  menos de 5 min, pergunta no kiosk quando eles forem completar se foi entrada
--  sem querer (tirando as tarefas que geralmente são curtas); se tomou muito
--  tempo também pergunta. Se a pessoa falou que NÃO está certo, marca de um jeito
--  diferente na linha do tempo; quem tem o dashboard revê com o operador e marca
--  como consertado."
-- Só colunas em v3.events; nada muda pra quem não passa pelo kiosk.
ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS duration_flag TEXT;            -- 'too_short' | 'too_long'
ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS duration_flag_status TEXT;     -- 'open' | 'fixed'
ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS duration_flag_at TIMESTAMPTZ;
ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS duration_flag_note TEXT;
ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS duration_flag_fixed_by TEXT;
ALTER TABLE v3.events ADD COLUMN IF NOT EXISTS duration_flag_fixed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_events_duration_flag_open ON v3.events (duration_flag_status) WHERE duration_flag_status = 'open';
