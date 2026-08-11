-- 067 — ROADMAP / planning board (Bruno 08-05).
-- Um board (kanban) do sistema INTEIRO: dashboard, employee page, P&P, inventário,
-- impressão. Bruno comenta + desenha; o Claude marca feito. Tudo sincronizado no
-- banco (fonte da verdade, cross-device). Aditivo.

BEGIN;

-- Áreas (workstreams) — as colunas/agrupamentos do board
CREATE TABLE IF NOT EXISTS v3.roadmap_areas (
  id          SERIAL PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,       -- 'dashboard','employee','pnp','inventory','printing','tiktok'...
  name        TEXT NOT NULL,
  color       TEXT,                       -- accent p/ a UI
  sort        INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cards (jobs). status = coluna do kanban.
CREATE TABLE IF NOT EXISTS v3.roadmap_cards (
  id          SERIAL PRIMARY KEY,
  area_id     INT NOT NULL REFERENCES v3.roadmap_areas(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  detail      TEXT,
  status      TEXT NOT NULL DEFAULT 'todo'
                CHECK (status IN ('backlog','todo','doing','blocked','done')),
  priority    TEXT NOT NULL DEFAULT 'normal'
                CHECK (priority IN ('low','normal','high','urgent')),
  blocks_on   TEXT,                       -- texto livre "precisa da cor das garrafas"
  sort        INT NOT NULL DEFAULT 0,
  done_at     TIMESTAMPTZ,
  created_by  TEXT NOT NULL DEFAULT 'claude',   -- 'claude' | 'bruno'
  archived    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_roadmap_cards_area ON v3.roadmap_cards(area_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_cards_status ON v3.roadmap_cards(status);

-- Comentários por card (Bruno + Claude conversam no board)
CREATE TABLE IF NOT EXISTS v3.roadmap_comments (
  id          SERIAL PRIMARY KEY,
  card_id     INT NOT NULL REFERENCES v3.roadmap_cards(id) ON DELETE CASCADE,
  author      TEXT NOT NULL DEFAULT 'bruno',    -- 'bruno' | 'claude'
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_roadmap_comments_card ON v3.roadmap_comments(card_id);

-- Desenhos/sketches (Bruno rabisca o que precisa). PNG data-url no body.
CREATE TABLE IF NOT EXISTS v3.roadmap_sketches (
  id          SERIAL PRIMARY KEY,
  title       TEXT,
  area_id     INT REFERENCES v3.roadmap_areas(id) ON DELETE SET NULL,
  card_id     INT REFERENCES v3.roadmap_cards(id) ON DELETE SET NULL,
  data_url    TEXT NOT NULL,              -- image/png;base64 do canvas
  created_by  TEXT NOT NULL DEFAULT 'bruno',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Áreas iniciais
INSERT INTO v3.roadmap_areas (key, name, color, sort) VALUES
  ('base_data',  'Dados-base (Bruno)',      '#96690a', 1),
  ('pnp',        'P&P / Picklist',          '#1a3a6b', 2),
  ('printing',   'Impressão / Labels',      '#5b4a9e', 3),
  ('inventory',  'Inventário / Estoque',    '#1a7a7a', 4),
  ('employee',   'Página do funcionário',   '#2e8b3c', 5),
  ('dashboard',  'Dashboard / Sistema',     '#0d1f3c', 6),
  ('tiktok',     'TikTok',                  '#c0392b', 7),
  ('usps',       'USPS / SCAN form',        '#54687c', 8)
ON CONFLICT (key) DO NOTHING;

COMMIT;
