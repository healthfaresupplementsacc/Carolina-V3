-- ============================================================
-- HEALTHFARE V3 — Migration 025: Admin RBAC (PINs individuais + roles)
-- ============================================================
-- ADITIVO. Bloco final / Fase 1.
-- Antes /admin usava ADMIN_PASSWORD único compartilhado (token HMAC
-- stateless). Agora: PIN individual por admin (scrypt, igual operadores)
-- + 2 tiers de role (owner|manager) + sessões persistidas no DB.
-- ADMIN_PASSWORD vira fallback de EMERGÊNCIA: só funciona enquanto
-- não houver nenhum admin_user ativo (ver src/routes/admin.js).
-- Idempotente. DOWN: 025_admin_rbac.down.sql
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS v3.admin_users (
  id            BIGSERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  role          VARCHAR(20)  NOT NULL CHECK (role IN ('owner', 'manager')),
  pin_hash      TEXT NOT NULL,
  pin_salt      TEXT NOT NULL,
  slack_user_id VARCHAR(20),
  email         VARCHAR(200),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- PIN único entre admins ativos (hash; salt por linha, mas colisão de hash
-- só ocorreria com mesmo salt+pin — o índice protege contra duplicar a linha)
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_pin ON v3.admin_users(pin_hash) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_admin_users_role ON v3.admin_users(role) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS v3.admin_sessions (
  id               BIGSERIAL PRIMARY KEY,
  admin_user_id    BIGINT NOT NULL REFERENCES v3.admin_users(id),
  session_token    TEXT UNIQUE NOT NULL,
  ip_address       VARCHAR(45),
  user_agent       TEXT,
  expires_at       TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  logged_out_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON v3.admin_sessions(session_token) WHERE logged_out_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON v3.admin_sessions(admin_user_id);

COMMIT;
