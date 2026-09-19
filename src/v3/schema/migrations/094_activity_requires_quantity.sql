-- 094 — "Produção manual" (Bruno 09-12): casos raros em que a garrafa é feita à mão. Precisa do
-- suplemento (obrigatório), lote se tiver, e a QUANTIDADE ao terminar (obrigatória). A flag vale pra
-- qualquer tile: o kiosk pede a contagem no fim como faz na linha de produção (production_counts).
ALTER TABLE v3.activity_types ADD COLUMN IF NOT EXISTS requires_quantity BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN v3.activity_types.requires_quantity IS 'pede a quantidade (bottles) ao TERMINAR, obrigatória; grava em production_counts como a linha';
UPDATE v3.activity_types SET display_name = 'Produção manual', kiosk_label = 'Produção manual', requires_product = true, requires_quantity = true
 WHERE slug = 'producao_manual';
