-- 061: zonas fixas nas câmeras (Bruno 08-01). Máquinas/áreas NÃO se movem → o Bruno
-- desenha o retângulo UMA vez e o Claude sabe pra sempre onde olhar (máquina de
-- cápsulas, mixer, saída das cápsulas, mesa de P&P, computador, aspirador, etc).
-- Coordenadas em FRAÇÃO do frame (0..1) → resiliente a resolução/reescala.
BEGIN;
CREATE TABLE IF NOT EXISTS v3.camera_zones (
  id           SERIAL PRIMARY KEY,
  cam          TEXT NOT NULL,                 -- 'warehouse' | 'packaging' | 'formulation'
  name         TEXT NOT NULL,                 -- nome do Bruno: "Máquina de cápsulas", "Mixer", "Saída das cápsulas"...
  kind         TEXT NOT NULL DEFAULT 'machine', -- machine | output | area | object | computer | table
  x0           REAL NOT NULL,                 -- fração 0..1
  y0           REAL NOT NULL,
  x1           REAL NOT NULL,
  y1           REAL NOT NULL,
  notes        TEXT,                          -- ex.: "se sair menos cápsula aqui, problema na máquina"
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS camera_zones_cam_idx ON v3.camera_zones (cam) WHERE active = TRUE;
COMMIT;
