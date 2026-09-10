-- 089 — Fase C do controle de estoque (Bruno 09-10): PERMISSOES POR PESSOA + destinatario
-- nas notificacoes.
--
-- "Ajusta no Usuarios & Acessos e la a gente define como quiser; uma secao
-- especifica de controle de estoque; niveis diferentes; o sistema nunca chama
-- ninguem de manager, supervisor ou gestao."
--
-- 1) Funcoes "Controle de estoque", cumulativas (o rotulo diz o que a pessoa FAZ):
--      stock_organize            Organizar (mover, organizar, separar: total nao muda)
--      stock_propose             Propor (entrada/saida/contagem viram proposta)
--      stock_change              Mudar o total (direto, com motivo + Desfazer 24 h)
--      stock_approve             Aprovar (decide propostas dos outros, nunca a propria)
--      stock_receive_production  Receber a producao (avisado quando o lote fecha; diz quanto fica)
--      stock_setup               Configurar (prateleiras e caixas, etiquetas, produtos, limiares)
--    `view_stock` continua = Ver; `manage_stock` continua valendo como TODOS os niveis
--    (compatibilidade: o Admin e quem ja tem manage_stock nao perdem nada).
-- 2) v3.login_functions: ajuste POR PESSOA por cima do perfil (granted=true da,
--    granted=false tira). O perfil vira o modelo inicial; a pessoa e a unidade.
-- 3) v3.notifications.audience/link: a notificacao diz PRA QUEM e (funcoes ou
--    logins) e pra onde o clique leva. Sem audience = todo mundo (como era).
--
-- Aditivo. Nada de quantidade.

BEGIN;

INSERT INTO v3.app_functions (key, label, category) VALUES
  ('stock_organize',           'Estoque: organizar (mover, organizar, separar)',    'estoque'),
  ('stock_propose',            'Estoque: propor (entrada, saida, contagem viram proposta)', 'estoque'),
  ('stock_change',             'Estoque: mudar o total (direto, com motivo e Desfazer)', 'estoque'),
  ('stock_approve',            'Estoque: aprovar propostas dos outros',             'estoque'),
  ('stock_receive_production', 'Estoque: receber a producao (decide quanto fica)', 'estoque'),
  ('stock_setup',              'Estoque: configurar (locais, etiquetas, produtos)', 'estoque')
ON CONFLICT (key) DO NOTHING;

-- Admin = tudo (mesma regra do seed 065)
INSERT INTO v3.role_functions (role_id, function_key)
SELECT r.id, f.key FROM v3.app_roles r CROSS JOIN v3.app_functions f
WHERE r.key = 'admin' AND f.key LIKE 'stock_%'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS v3.login_functions (
  login_id      INT  NOT NULL REFERENCES v3.app_logins(id) ON DELETE CASCADE,
  function_key  TEXT NOT NULL REFERENCES v3.app_functions(key) ON DELETE CASCADE,
  granted       BOOLEAN NOT NULL DEFAULT true,      -- true = da por cima do perfil; false = tira
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    TEXT,
  PRIMARY KEY (login_id, function_key)
);
COMMENT ON TABLE v3.login_functions IS
  'Ajuste de funcao POR PESSOA por cima do perfil (Bruno 09-10: "niveis diferentes, definidos por pessoa"). granted=true da, false tira. O perfil (role_functions) e o modelo inicial.';

ALTER TABLE v3.notifications
  ADD COLUMN IF NOT EXISTS audience JSONB,   -- {"functions":["stock_approve"]} | {"login_ids":[2]} ; NULL = todos
  ADD COLUMN IF NOT EXISTS link     TEXT;    -- hash do dashboard: "#estoque-aprovacoes?req=123"

COMMENT ON COLUMN v3.notifications.audience IS
  'Pra quem e: {"functions":[...]} (quem tem qualquer uma) e/ou {"login_ids":[...]}. NULL = todo mundo (comportamento anterior a 089).';

COMMIT;
