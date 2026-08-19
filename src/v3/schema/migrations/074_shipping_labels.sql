-- 074 — ETIQUETAS DE ENVIO impressas do NOSSO sistema (S15.37, Bruno 08-19).
--
-- O QUE MUDA NA VIDA REAL
-- Hoje a Simone imprime as etiquetas de dentro da tela da Veeqo, uma a uma, na
-- ordem que a Veeqo quiser. O papel sai sem dizer QUAL produto é, ONDE ele mora
-- na prateleira, QUANTAS garrafas vão dentro nem QUE envelope pegar — tudo isso
-- mora na cabeça de quem separa. Agora o PDF sai do nosso sistema: agrupado por
-- produto, na ordem de caminhada do armazém, com uma folha divisória por grupo e
-- um RODAPÉ em cada etiqueta com nickname · local · garrafas · envelope · quem
-- separou / quem embalou.
--
-- POR QUE O PDF FICA NO BANCO (print_files)
-- O compose acontece quando o admin pede (celular) e a impressão acontece depois,
-- na estação. Entre um e outro o processo pode reiniciar (Railway) — se o PDF
-- morasse em disco ou em memória, o job da fila viraria um ponteiro pra lixo e a
-- estação abriria uma janela em branco. Um bytea de ~60KB por etiqueta é barato
-- perto de reimprimir tudo. Mesmo motivo do payload da 073: a etiqueta é a FOTO
-- de um momento, não uma consulta ao vivo — reimprimir tem que sair IGUAL.
--
-- POR QUE shipping_label_prints EXISTE (e o UNIQUE que ela carrega)
-- Etiqueta impressa duas vezes = pacote com duas etiquetas = pacote perdido, ou
-- postagem paga duas vezes. O UNIQUE (source, shipment_id) é a trava física: um
-- shipment só entra uma vez na tabela, então "já imprimi isso?" é uma pergunta que
-- o banco responde, não a memória de quem está no turno. Reimpressão continua
-- possível (reprint:true) — mas vira uma DECISÃO explícita, com linha de auditoria,
-- em vez de um acidente de clicar duas vezes.
--
-- printed_at NULL = composto mas ainda não saiu no papel. Só o /done da fila
-- carimba (o papel saiu de verdade). Compor não é imprimir.
--
-- REGRA #0: nada aqui apaga nada. is_test fica na tabela e some das listas.
-- Nenhuma escrita de estoque mora aqui — quem mexe em quantidade é o StockService.
-- Aditivo: só o CHECK do kind da 073 muda (ganha um valor), nenhuma coluna some.

BEGIN;

-- ── 1. a fila aprende um tipo novo de trabalho ──────────────────────────────
-- CHECK não se "altera": derruba e recria com o valor a mais. As linhas antigas
-- continuam válidas (os três kinds velhos seguem na lista).
ALTER TABLE v3.print_queue DROP CONSTRAINT IF EXISTS print_queue_kind_check;
ALTER TABLE v3.print_queue ADD CONSTRAINT print_queue_kind_check
  CHECK (kind IN ('bin_labels','box_label','picklist','shipping_labels'));

-- ── 2. o PDF já montado ─────────────────────────────────────────────────────
-- job_id é NULL até o job existir (compõe primeiro, enfileira depois) e fica
-- ON DELETE SET NULL: apagar um job velho nunca pode arrastar o arquivo junto
-- e quebrar um link que alguém guardou.
CREATE TABLE IF NOT EXISTS v3.print_files (
  id         SERIAL PRIMARY KEY,
  job_id     INT REFERENCES v3.print_queue(id) ON DELETE SET NULL,
  mime       TEXT NOT NULL DEFAULT 'application/pdf',
  bytes      BYTEA NOT NULL,
  pages      INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_print_files_job ON v3.print_files (job_id);

-- ── 3. o histórico por ETIQUETA (uma linha por shipment) ────────────────────
-- product_ids/nicknames são arrays porque um pedido pode ter mais de um produto
-- (pedido misto). Guardamos o que foi IMPRESSO, não uma chave estrangeira viva:
-- se o nickname do produto mudar amanhã, o histórico continua contando o que o
-- papel dizia naquele dia.
CREATE TABLE IF NOT EXISTS v3.shipping_label_prints (
  id                SERIAL PRIMARY KEY,
  source            TEXT NOT NULL DEFAULT 'veeqo',
  external_order_id TEXT,
  shipment_id       TEXT,
  order_number      TEXT,
  channel           TEXT,
  product_ids       INT[],
  nicknames         TEXT[],
  bottles           INT,
  envelope          TEXT,
  picker_ids        TEXT[],
  packer_id         TEXT,
  job_id            INT REFERENCES v3.print_queue(id) ON DELETE SET NULL,
  composed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  printed_at        TIMESTAMPTZ,
  is_test           BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (source, shipment_id)
);
-- "o que já imprimi hoje" e "o que falta" — as duas perguntas da tela.
CREATE INDEX IF NOT EXISTS idx_ship_prints_job ON v3.shipping_label_prints (job_id);
CREATE INDEX IF NOT EXISTS idx_ship_prints_printed ON v3.shipping_label_prints (printed_at);
CREATE INDEX IF NOT EXISTS idx_ship_prints_order ON v3.shipping_label_prints (external_order_id);

COMMIT;
