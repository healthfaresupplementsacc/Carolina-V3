-- 093 — TILE NOVO PELA TELA (Bruno 09-12): "se tiver uma função que deveríamos criar um novo task,
-- como podemos fazer? tipo pra criar um novo tile?" → o painel "Outros pra reclassificar" cria a
-- atividade e ela aparece no kiosk sem regenerar o catálogo estático (o kiosk lê kiosk_group via
-- GET /api/v3/kiosk/order e mistura no grupo). build-fuse-data.js também lê estas colunas.
ALTER TABLE v3.activity_types ADD COLUMN IF NOT EXISTS kiosk_group TEXT;
ALTER TABLE v3.activity_types ADD COLUMN IF NOT EXISTS kiosk_label TEXT;
ALTER TABLE v3.activity_types ADD COLUMN IF NOT EXISTS created_via TEXT;
ALTER TABLE v3.activity_types ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
COMMENT ON COLUMN v3.activity_types.kiosk_group IS 'grupo do kiosk (linha|formulacao|limpeza|embalagem|envio|outros) pra tiles criados pela tela; NULL = catálogo estático';
