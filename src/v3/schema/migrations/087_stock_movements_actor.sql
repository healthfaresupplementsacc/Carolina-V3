-- 087 — v3.stock_movements: QUEM do dashboard fez o movimento (Bruno 09-10, Fase A).
--
-- Auditoria do estoque (S15-ADMIN-CONTROL-AUDIT, D16): toda ação feita pelo
-- dashboard gravava person_id = NULL (os logins Admin e Henrique nao sao pessoas
-- do chao de fabrica) e escondia o nome do login dentro da note ("[Admin] ...").
-- A coluna "Quem" do historico ficava vazia para o admin. Regra do Bruno:
-- "toda acao tem que ficar anotada no log e salva" — com quem.
--
-- person_id continua sendo o operador (kiosk). actor_login_id/actor_name sao o
-- login do dashboard. Os dois podem coexistir (admin aprovando proposta de
-- operador: person_id = quem propos, actor = quem aprovou).

BEGIN;

ALTER TABLE v3.stock_movements
  ADD COLUMN IF NOT EXISTS actor_login_id INT REFERENCES v3.app_logins(id),
  ADD COLUMN IF NOT EXISTS actor_name     TEXT;

COMMENT ON COLUMN v3.stock_movements.actor_login_id IS
  'Login do dashboard (v3.app_logins) que executou o movimento. NULL = veio do kiosk/worker (ver person_id/source).';
COMMENT ON COLUMN v3.stock_movements.actor_name IS
  'Nome do login no momento (desnormalizado: o historico nao muda se o login for renomeado).';

CREATE INDEX IF NOT EXISTS idx_stock_movements_actor ON v3.stock_movements (actor_login_id)
  WHERE actor_login_id IS NOT NULL;

COMMIT;
