-- 073 — FILA DE IMPRESSÃO (S15.34) + índice de velocidade (S15.30).
-- Bruno 08-19: "dá pra usar o sistema de inventário todo e impressão todo do iPhone".
--
-- POR QUE UMA FILA E NÃO UMA CHAMADA DIRETA
-- O iPhone não fala com a impressora do armazém. E o servidor não alcança o PC .28
-- (rede da casa, sem porta aberta) — abrir uma seria rede nova pra manter e caminho
-- novo pra quebrar. O .28 SEMPRE foi quem inicia a conversa (é assim que o
-- /api/print-event funciona desde o começo). Então o celular só ENFILEIRA, e a
-- estação puxa: GET /api/v3/print-queue → toma → imprime → marca done.
--
-- O QUE VAI NO payload
-- As etiquetas JÁ RESOLVIDAS no momento do pedido (mesmo formato do GET /labels:
-- {kind, code, line2, line3, url}). De propósito: se a caixa mudar de quantidade
-- entre o pedido e a impressão, o papel sai com o que o admin VIU quando apertou o
-- botão. Uma etiqueta é a foto de um momento, não uma consulta ao vivo.
--
-- ESTADOS: queued → taken → done | error, e cancelled (só quem pediu, ou admin).
-- Nada some: a fila é histórico de impressão também.
--
-- is_test: pedido vindo de sessão de operador SANDBOX. Fica na tabela (REGRA #0:
-- registrar sempre) mas some das contagens e das listas de trabalho.
--
-- Aditivo: nenhuma tabela existente muda. Princípio #24: tudo v3.*.

BEGIN;

CREATE TABLE IF NOT EXISTS v3.print_queue (
  id                 SERIAL PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('bin_labels','box_label','picklist')),
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by       TEXT,
  requested_login_id INT,
  target             TEXT NOT NULL DEFAULT 'any',
  status             TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','taken','done','error','cancelled')),
  taken_by           TEXT,
  taken_at           TIMESTAMPTZ,
  done_at            TIMESTAMPTZ,
  error_note         TEXT,
  is_test            BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- o poll da estação é sempre "o que está esperando, mais antigo primeiro"
CREATE INDEX IF NOT EXISTS idx_print_queue_status ON v3.print_queue (status, created_at);
-- a tela do celular mostra "meus últimos pedidos"
CREATE INDEX IF NOT EXISTS idx_print_queue_created ON v3.print_queue (created_at DESC);

-- ── velocidade de venda (S15.30) ────────────────────────────────────────────
-- overview() faz LEFT JOIN em pnp_order_lines filtrando status='shipped' por
-- product_id + janela de shipped_at. Sem índice isso é seq scan na tabela inteira
-- a cada abertura do hub — e agora o CELULAR também abre (bootstrap). Índice
-- parcial: só as linhas enviadas, que é o único recorte que a conta usa.
CREATE INDEX IF NOT EXISTS idx_pnp_lines_shipped_product
  ON v3.pnp_order_lines (product_id, shipped_at)
  WHERE status = 'shipped';

COMMIT;
