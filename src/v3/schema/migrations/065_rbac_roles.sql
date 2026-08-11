-- 065 — RBAC: roles por FUNÇÃO + logins do dashboard (Bruno 08-03).
-- Requisito fundacional: o sistema pensa em CARGO/FUNÇÃO, não em nome de pessoa.
-- Pessoas = perfis; roles concedem FUNÇÕES do sistema; automações leem a função.
--
-- Pedido concreto do Bruno (08-03):
--   • Consolidar Config + Admin + Painel do admin sob o perfil ADMIN.
--   • Login atual (510510) vira "Henrique", role MANAGER — NÃO vê a página de admin.
--   • Novo login ADMIN (150000), role OWNER — vê Config (câmeras + settings) + admin,
--     e configura o que o Henrique (manager) pode acessar.
-- Aditivo. Não muda comportamento até o login/gating passar a ler isto.

BEGIN;

-- 1) FUNÇÕES do sistema (o vocabulário que as automações/páginas seguem) --------
CREATE TABLE IF NOT EXISTS v3.app_functions (
  key         TEXT PRIMARY KEY,          -- ex.: 'admin_page','config_cameras','do_pnp'
  label       TEXT NOT NULL,             -- rótulo humano
  category    TEXT,                      -- agrupamento na UI ('admin','operacao','estoque'...)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) ROLES (cargos) -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS v3.app_roles (
  id          SERIAL PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,      -- 'admin','manager','operator',...
  name        TEXT NOT NULL,
  rank        INT  NOT NULL DEFAULT 0,   -- maior = mais poder (admin>manager>operator)
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3) role -> funções concedidas ------------------------------------------------
CREATE TABLE IF NOT EXISTS v3.role_functions (
  role_id      INT  NOT NULL REFERENCES v3.app_roles(id) ON DELETE CASCADE,
  function_key TEXT NOT NULL REFERENCES v3.app_functions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, function_key)
);

-- 4) LOGINS do dashboard (perfis com PIN) — identidade + role -------------------
-- Separado de v3.persons (operadores /op) e do legado v3.admin_users. Este é o
-- login do dashboard-v4. person_id opcional liga o login a um perfil de pessoa.
CREATE TABLE IF NOT EXISTS v3.app_logins (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,             -- 'Admin', 'Henrique' (placeholder editável)
  role_id     INT  NOT NULL REFERENCES v3.app_roles(id),
  pin         TEXT NOT NULL,             -- PIN do dashboard (numérico; troca pela página admin)
  person_id   INT  REFERENCES v3.persons(id),   -- opcional: perfil de pessoa ligado
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_logins_pin ON v3.app_logins(pin) WHERE active;

-- 5) SEED das funções (o vocabulário inicial) ----------------------------------
INSERT INTO v3.app_functions (key, label, category) VALUES
  ('admin_page',      'Página de Admin',            'admin'),
  ('config_page',     'Configurações (geral)',      'admin'),
  ('config_cameras',  'Config de câmeras',          'admin'),
  ('manage_users',    'Gerenciar usuários/roles',   'admin'),
  ('manage_system',   'Saúde do sistema',           'admin'),
  ('view_stock',      'Ver estoque',                'estoque'),
  ('manage_stock',    'Editar estoque/suprimentos', 'estoque'),
  ('product_setup',   'Product Setup',              'estoque'),
  ('view_production', 'Ver produção',               'operacao'),
  ('manage_people',   'Ver/gerir pessoas (ponto)',  'operacao'),
  ('do_pnp',          'Fazer P&P',                  'operacao'),
  ('print_labels',    'Imprimir labels',            'operacao'),
  ('watch_formulation','Vigiar formulação',         'operacao'),
  ('printing_page',   'Página de Impressão',        'operacao'),
  ('cameras_view',    'Ver câmeras',                'fabrica'),
  ('assistant',       'Assistente/Carolina',        'assistente')
ON CONFLICT (key) DO NOTHING;

-- 6) SEED dos roles ------------------------------------------------------------
INSERT INTO v3.app_roles (key, name, rank) VALUES
  ('admin',    'Admin',    100),
  ('manager',  'Manager',   50),
  ('operator', 'Operador',  10)
ON CONFLICT (key) DO NOTHING;

-- ADMIN = todas as funções.
INSERT INTO v3.role_functions (role_id, function_key)
SELECT r.id, f.key FROM v3.app_roles r CROSS JOIN v3.app_functions f
WHERE r.key = 'admin'
ON CONFLICT DO NOTHING;

-- MANAGER = tudo MENOS o bloco de admin (não vê admin_page/config/users/system).
INSERT INTO v3.role_functions (role_id, function_key)
SELECT r.id, f.key FROM v3.app_roles r CROSS JOIN v3.app_functions f
WHERE r.key = 'manager'
  AND f.key NOT IN ('admin_page','config_page','config_cameras','manage_users','manage_system')
ON CONFLICT DO NOTHING;

-- OPERATOR = mínimo operacional (base; ajustável depois pela página).
INSERT INTO v3.role_functions (role_id, function_key)
SELECT r.id, f.key FROM v3.app_roles r CROSS JOIN v3.app_functions f
WHERE r.key = 'operator'
  AND f.key IN ('do_pnp','print_labels','view_production','cameras_view')
ON CONFLICT DO NOTHING;

-- 7) SEED dos dois logins do Bruno --------------------------------------------
--   Admin  = PIN 150000 (owner/admin, tudo)
--   Henrique = PIN 510510 (manager) — o login que já existia vira o dele
INSERT INTO v3.app_logins (name, role_id, pin)
SELECT 'Admin', r.id, '150000' FROM v3.app_roles r WHERE r.key = 'admin'
  AND NOT EXISTS (SELECT 1 FROM v3.app_logins WHERE pin = '150000');
INSERT INTO v3.app_logins (name, role_id, pin)
SELECT 'Henrique', r.id, '510510' FROM v3.app_roles r WHERE r.key = 'manager'
  AND NOT EXISTS (SELECT 1 FROM v3.app_logins WHERE pin = '510510');

COMMIT;
