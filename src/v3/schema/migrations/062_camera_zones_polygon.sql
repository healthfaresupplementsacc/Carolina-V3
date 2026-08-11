-- 062: zonas por POLÍGONO (Bruno 08-01). Máquinas nas câmeras aéreas ficam em
-- ângulo → retângulo pega chão/vizinho demais. Agora o Bruno clica pontos e liga
-- (qualquer forma). `points` = array de {x,y} em fração 0..1. x0/y0/x1/y1 viram a
-- bounding box (derivada dos pontos) — mantida pra compatibilidade/consultas.
BEGIN;
ALTER TABLE v3.camera_zones ADD COLUMN IF NOT EXISTS points JSONB;
-- retângulos antigos (se houver) viram polígono de 4 cantos
UPDATE v3.camera_zones
   SET points = jsonb_build_array(
     jsonb_build_object('x', x0, 'y', y0), jsonb_build_object('x', x1, 'y', y0),
     jsonb_build_object('x', x1, 'y', y1), jsonb_build_object('x', x0, 'y', y1))
 WHERE points IS NULL;
COMMIT;
