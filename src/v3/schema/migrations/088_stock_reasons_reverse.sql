-- 088 — Fase B do controle de estoque (Bruno 09-10): o VOCABULARIO de fabrica no livro
-- + Desfazer + os verbos Saida e Transferencia.
--
-- "A gente nao compra: a gente produz, transfere, recebe retornos usaveis e faz
-- restock. Toda acao anotada no log e salva." Ate aqui o livro so tinha `kind`
-- (o verbo mecanico) e uma `note` em texto livre. Agora todo movimento pode dizer
-- POR QUE (reason_code, de uma lista fechada), a REFERENCIA (lote, pedido, remessa)
-- e, se foi desfeito, QUAL movimento o reverteu.
--
-- Sem "compra": nao existe codigo de compra. Codigos:
--   in       producao (lote) · devolucao_usavel (pedido) · transferencia_volta (remessa)
--   out      venda (Veeqo, automatico) · transferencia (FBA/WFS/DC) · amostra · uso_interno
--            · extra_no_pedido (pedido) · descarte
--   count    contagem (fisica) · erro_registro · dano
--   internal organizar · mover · separar · liberar
--
-- Aditivo. Nada de quantidade muda aqui.

BEGIN;

CREATE TABLE IF NOT EXISTS v3.stock_reasons (
  code       TEXT PRIMARY KEY,
  label_pt   TEXT NOT NULL,
  direction  TEXT NOT NULL CHECK (direction IN ('in','out','count','internal')),
  sort       INT  NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO v3.stock_reasons (code, label_pt, direction, sort) VALUES
  ('producao',            'Produção (lote da linha)',            'in',       10),
  ('devolucao_usavel',    'Devolução usável (volta ao estoque)', 'in',       20),
  ('transferencia_volta', 'Voltou de transferência',             'in',       30),
  ('venda',               'Venda (Veeqo)',                       'out',      40),
  ('transferencia',       'Transferência (FBA / WFS / DC)',      'out',      50),
  ('amostra',             'Amostra',                             'out',      60),
  ('uso_interno',         'Uso interno',                         'out',      70),
  ('extra_no_pedido',     'Extra num pedido já etiquetado',      'out',      80),
  ('descarte',            'Descarte',                            'out',      90),
  ('contagem',            'Contagem física',                     'count',   100),
  ('erro_registro',       'Erro de registro',                    'count',   110),
  ('dano',                'Dano / perda',                        'count',   120),
  ('organizar',           'Organizar (A organizar → local)',     'internal', 130),
  ('mover',               'Mover entre locais',                  'internal', 140),
  ('separar',             'Separar (fora do vendável)',          'internal', 150),
  ('liberar',             'Liberar (quarentena → vendável)',     'internal', 160)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE v3.stock_movements
  ADD COLUMN IF NOT EXISTS reason_code           TEXT REFERENCES v3.stock_reasons(code),
  ADD COLUMN IF NOT EXISTS ref_type              TEXT,      -- 'batch' | 'order' | 'shipment' | 'request'
  ADD COLUMN IF NOT EXISTS ref_id                TEXT,      -- lote, numero do pedido, remessa
  ADD COLUMN IF NOT EXISTS reverses_movement_id  INT REFERENCES v3.stock_movements(id);

CREATE INDEX IF NOT EXISTS idx_stock_movements_reverses ON v3.stock_movements (reverses_movement_id)
  WHERE reverses_movement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movements_reason ON v3.stock_movements (reason_code, created_at DESC);

-- verbos novos: take (saida sem venda) e transfer (FBA / WFS / DC)
ALTER TABLE v3.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_kind_check;
ALTER TABLE v3.stock_movements ADD CONSTRAINT stock_movements_kind_check
  CHECK (kind IN ('store_in','pick','restock','adjust','damaged','count','place','move','import','take','transfer'));

COMMENT ON COLUMN v3.stock_movements.reason_code IS 'Por que (lista fechada em v3.stock_reasons). NULL = movimento anterior a 088 ou automatico sem motivo.';
COMMENT ON COLUMN v3.stock_movements.reverses_movement_id IS 'Se este movimento e um DESFAZER, o id do movimento original (24 h, mesmo local, quantidade oposta). O original nunca e apagado.';

COMMIT;
