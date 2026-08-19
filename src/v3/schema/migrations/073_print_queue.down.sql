-- 073 DOWN — desfaz a fila de impressão (S15.34) e o índice de velocidade.
-- Simétrico ao 073: derruba SÓ o que o 073 criou.
-- ATENÇÃO: derrubar v3.print_queue apaga o histórico de pedidos de impressão do
-- celular e desliga a tela "Imprimir" do /m/. Não roda isso com a fila em uso.

BEGIN;

DROP INDEX IF EXISTS v3.idx_pnp_lines_shipped_product;

DROP INDEX IF EXISTS v3.idx_print_queue_created;
DROP INDEX IF EXISTS v3.idx_print_queue_status;
DROP TABLE IF EXISTS v3.print_queue;

COMMIT;
