-- 071 DOWN — desfaz o warehouse hub (Fase 1).
-- Derruba as duas tabelas novas e volta os CHECKs aos conjuntos do 058/060.
-- ATENÇÃO: movimentos 'place'/'move' e issues com reason 'return' precisam ter
-- sumido antes, senão o CHECK antigo não recria (é isso que queremos: o down
-- falha alto em vez de mentir sobre o estado do livro-razão).

BEGIN;

DROP TABLE IF EXISTS v3.stock_change_requests;
DROP TABLE IF EXISTS v3.stock_unplaced;

ALTER TABLE v3.stock_issues DROP COLUMN IF EXISTS order_number;

ALTER TABLE v3.stock_issues DROP CONSTRAINT IF EXISTS stock_issues_reason_check;
ALTER TABLE v3.stock_issues ADD CONSTRAINT stock_issues_reason_check
  CHECK (reason IN ('label','seal','other'));

ALTER TABLE v3.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_kind_check;
ALTER TABLE v3.stock_movements ADD CONSTRAINT stock_movements_kind_check
  CHECK (kind IN ('store_in','pick','restock','adjust','damaged','count'));

COMMIT;
