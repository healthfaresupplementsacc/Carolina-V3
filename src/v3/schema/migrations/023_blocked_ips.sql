-- 023 — IPs bloqueados por brute-force (Fase D / persistência).
-- Antes o ban vivia só em memória do processo: sumia a cada restart/redeploy
-- do Railway. Esta tabela torna o bloqueio durável e auditável.
CREATE TABLE IF NOT EXISTS v3.blocked_ips (
  ip_address  VARCHAR(45) PRIMARY KEY,           -- IPv4 ou IPv6
  blocked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  reason      VARCHAR(100),
  block_count INT NOT NULL DEFAULT 1             -- quantas vezes esse IP já foi banido
);
CREATE INDEX IF NOT EXISTS idx_blocked_ips_expires ON v3.blocked_ips(expires_at);
