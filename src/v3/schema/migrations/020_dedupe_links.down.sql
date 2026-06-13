-- DOWN da 020 — dropa a tabela de links (dados de dedupe re-deriváveis).
BEGIN;
DROP TABLE IF EXISTS v3.dedupe_links;
COMMIT;
