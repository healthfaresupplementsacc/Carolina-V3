-- 051: "Colocar labels" (labeling) é processo da LINHA DE PRODUÇÃO, não P&P
-- (regra Bruno 06-22). flow=production → sai do cowork/contagem do P&P e do grupo
-- "Envio De Pacotes" (movido pro grupo "Linha de Produção" no build-fuse-data).
BEGIN;
UPDATE v3.activity_types
  SET flow = 'production', category = 'production_phase', counts_as_pp = false
  WHERE slug = 'labeling';
COMMIT;
