-- Reverte 023. Apaga só a tabela de IPs bloqueados (dado operacional,
-- não histórico) — audit_log dos bans permanece intacto.
DROP INDEX IF EXISTS v3.idx_blocked_ips_expires;
DROP TABLE IF EXISTS v3.blocked_ips;
