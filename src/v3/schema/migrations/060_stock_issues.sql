-- 060 — Garrafas separadas ("garrafa com problema") (Bruno 08-01).
-- O buraco conhecido: garrafa com label torta / lacre ruim é posta DE LADO e
-- nunca contabilizada → o bin "tem" estoque que fisicamente não existe.
-- Captura em 2 toques no kiosk: produto → qty+motivo. A garrafa vai pra cá
-- (status='separated') e o StockService.damaged() deduz o bin na mesma hora.
-- Aba "Separadas" no dashboard mostra até resolver (relabel/volta/estoque/descarte).

CREATE TABLE IF NOT EXISTS v3.stock_issues (
  id          SERIAL PRIMARY KEY,
  product_id  INT NOT NULL REFERENCES v3.products(id),
  qty         INT NOT NULL CHECK (qty > 0),
  reason      TEXT NOT NULL CHECK (reason IN ('label','seal','other')),
  bin_id      INT REFERENCES v3.stock_bins(id),
  person_id   INT REFERENCES v3.persons(id),
  status      TEXT NOT NULL DEFAULT 'separated'
                CHECK (status IN ('separated','relabeled','restocked','discarded')),
  resolved_by_person_id INT REFERENCES v3.persons(id),
  resolved_at TIMESTAMPTZ,
  note        TEXT,
  is_test     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_issues_open
  ON v3.stock_issues (status) WHERE status = 'separated';
