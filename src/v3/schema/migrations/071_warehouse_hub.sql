-- 071 — Warehouse hub, Fase 1 (Bruno 08-18, estudo S15).
-- UMA página passa a gerenciar o estoque inteiro do armazém (fluxo ②, P&P
-- direto-ao-cliente). Três coisas faltavam no modelo do 058/060 pra isso:
--
--   1) FILA DE APROVAÇÃO (v3.stock_change_requests). Regra do Bruno: operador
--      PROPÕE, admin/manager DECIDE. Tudo que muda o total do produto (entrada,
--      saída, contagem, devolução, soltar das Separadas, ajuste) entra aqui como
--      'pending' e só vira movimento quando alguém aprova. A "saída provisória"
--      (O2, round 2) sai do Disponível na hora sem virar movimento — o número
--      pendente aparece do lado do total, nunca dentro dele. REGRA #0: a proposta
--      é sempre registrada, o operador nunca é bloqueado.
--
--   2) "A ORGANIZAR" (v3.stock_unplaced). Bruno 08-18: garrafa pode estar no
--      armazém e ainda não estar em prateleira nem em caixa (acabou de chegar da
--      linha, está no palete). Total no armazém = prateleira + caixa + a organizar.
--      Bucket por produto, mexido SÓ pelo StockService (store_in sem local → +,
--      place → move pro bin/caixa).
--
--   3) Dois CHECKs velhos apertados demais: stock_movements.kind não aceitava
--      'place'/'move' e stock_issues.reason não aceitava 'return' (devolução de
--      cliente cai nas Separadas, nunca direto no vendável). Alargados aqui,
--      além de stock_issues.order_number pro número do pedido devolvido.
--
-- Aditivo: nenhuma linha existente muda de valor; nenhum fluxo atual quebra.
-- Princípio #24: tudo schema-qualificado v3.*.

BEGIN;

-- 1) FILA DE APROVAÇÃO ---------------------------------------------------------
-- kind = o que a proposta faz quando aprovada; direction = de que lado do total
-- ela pesa enquanto está pendente ('out' sai do Disponível na hora, 'in' não
-- entra no total até aprovar). applied_movement_id liga a decisão ao movimento
-- real que o StockService gerou (rastro fechado proposta → livro-razão).
CREATE TABLE IF NOT EXISTS v3.stock_change_requests (
  id            SERIAL PRIMARY KEY,
  product_id    INT NOT NULL REFERENCES v3.products(id),
  kind          TEXT NOT NULL
                  CHECK (kind IN ('take','entrada','count','return_in','issue_release','adjust')),
  direction     TEXT NOT NULL CHECK (direction IN ('out','in')),
  qty           INT  NOT NULL CHECK (qty > 0),
  bin_id        INT REFERENCES v3.stock_bins(id),
  box_id        INT REFERENCES v3.stock_boxes(id),
  issue_id      INT REFERENCES v3.stock_issues(id),   -- Separadas → volta pro estoque
  reason        TEXT,                                  -- motivo curto (obrigatório na UI)
  note          TEXT,
  proposed_by_person_id INT REFERENCES v3.persons(id), -- operador do kiosk
  proposed_by_login     TEXT,                          -- nome do login do dashboard
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected')),
  decided_by_login      TEXT,
  decided_by_person_id  INT REFERENCES v3.persons(id),
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,
  applied_movement_id   INT REFERENCES v3.stock_movements(id),
  is_test       BOOLEAN NOT NULL DEFAULT false,        -- sandbox nunca vira aprovação real
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- a fila é lida o tempo todo ("Aprovações (3)"); só as pendentes importam.
CREATE INDEX IF NOT EXISTS idx_stock_requests_pending
  ON v3.stock_change_requests (product_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_stock_requests_created
  ON v3.stock_change_requests (created_at DESC);

-- 2) "A ORGANIZAR" por produto --------------------------------------------------
CREATE TABLE IF NOT EXISTS v3.stock_unplaced (
  product_id  INT PRIMARY KEY REFERENCES v3.products(id),
  qty         INT NOT NULL DEFAULT 0 CHECK (qty >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3) CHECKs alargados -----------------------------------------------------------
-- 'place' = a organizar → prateleira/caixa; 'move' = transferência genérica
-- bin↔caixa (restock continua sendo o caso caixa→bin do kiosk).
ALTER TABLE v3.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_kind_check;
ALTER TABLE v3.stock_movements ADD CONSTRAINT stock_movements_kind_check
  CHECK (kind IN ('store_in','pick','restock','adjust','damaged','count','place','move'));

-- 'return' = devolução de cliente: entra nas Separadas SEM deduzir prateleira
-- (a garrafa voltou de fora, não saiu do bin) e só vira vendável com aprovação.
ALTER TABLE v3.stock_issues DROP CONSTRAINT IF EXISTS stock_issues_reason_check;
ALTER TABLE v3.stock_issues ADD CONSTRAINT stock_issues_reason_check
  CHECK (reason IN ('label','seal','other','return'));
ALTER TABLE v3.stock_issues ADD COLUMN IF NOT EXISTS order_number TEXT;

COMMIT;
