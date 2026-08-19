-- 075 — PREFERÊNCIAS POR CONTA (v3.user_prefs).
-- Bruno 08-19: "como eu salvo os widgets do jeito que eu quero (salvar na conta)?"
--
-- O PROBLEMA
-- O layout da página Hoje mora em localStorage ('hf-hoje-layout-v2'). Isso é POR
-- NAVEGADOR: o Bruno arruma a grade no desktop e abre o notebook — e encontra a
-- configuração de fábrica. Pior, dois logins no MESMO navegador enxergam a
-- configuração um do outro, que é exatamente o oposto do que "minha conta"
-- significa.
--
-- A DECISÃO
-- Uma tabela genérica de chave/valor POR LOGIN, não uma coluna 'hoje_layout' em
-- app_logins. A próxima preferência (tema, colunas de uma tabela, filtros
-- favoritos, página inicial) entra sem migração nenhuma — só um key novo.
--
--   PRIMARY KEY (login_id, key)  → um valor por chave por pessoa, upsert direto.
--   ON DELETE CASCADE            → login apagado leva as preferências junto; nada
--                                  de linha órfã apontando pra ninguém.
--   value JSONB                  → o formato é do dono da chave (a página Hoje
--                                  guarda {grid, stack}); o banco não opina.
--
-- LOGIN DE EMERGÊNCIA NÃO ENTRA AQUI
-- O fallback do ADMIN_PIN (src/v3/data/auth.js) devolve um login SEM id de banco
-- (id 0, "Admin (emergência)"). Ele existe pra nunca trancar o Bruno pra fora
-- quando o banco está fora do ar — e é justamente por isso que não pode ter
-- linha nesta tabela: não há app_logins.id 0 pra referenciar, e gravar id 0 seria
-- inventar uma conta compartilhada por qualquer um que saiba o PIN de emergência.
-- Quem entra por emergência continua salvando NO NAVEGADOR (localStorage), e a
-- API responde 409 'no_account' em PUT/DELETE dizendo isso em português.
--
-- Aditivo: nenhuma tabela existente muda. Princípio #24: tudo em v3.*.

BEGIN;

CREATE TABLE IF NOT EXISTS v3.user_prefs (
  login_id   INT NOT NULL REFERENCES v3.app_logins(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (login_id, key)
);

COMMENT ON TABLE v3.user_prefs IS
  'Preferências por CONTA (login), chave/valor. Escrita só por src/v3/prefs/router.js. Login de emergência (sem id) não entra aqui: fica no localStorage.';

COMMIT;
