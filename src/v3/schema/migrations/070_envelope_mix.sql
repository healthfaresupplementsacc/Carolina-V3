-- 070 — Combinações de cor por envelope + perguntas pendentes (Bruno 08-07).
-- A tabela bottle_size_tiers só sabe "N garrafas de UMA cor". O 9x12 tem regra
-- de MISTURA (preta+branca). Aqui guardamos as combinações explícitas, sem
-- fórmula deduzida — o Bruno confirmou 1P+6B e 2P+4B; 3P+?B ficou PENDENTE.

-- Combinações válidas por envelope: "cabe até black_max pretas E white_max brancas".
CREATE TABLE IF NOT EXISTS v3.envelope_mix (
  id            SERIAL PRIMARY KEY,
  package_size  TEXT NOT NULL,
  black_qty     INT  NOT NULL,         -- nº exato de garrafas pretas
  white_max     INT  NOT NULL,         -- máximo de brancas junto dessas pretas
  confirmed     BOOLEAN NOT NULL DEFAULT true,  -- false = suposição, precisa confirmar
  note          TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (package_size, black_qty)
);

-- Perguntas que o sistema faz ao operador pra resolver dúvidas de embalagem.
-- Quando respondida e confirmada, o admin ajusta a regra e a pergunta some.
CREATE TABLE IF NOT EXISTS v3.packing_questions (
  id            SERIAL PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,  -- ex.: 'mix_9x12_3black'
  question      TEXT NOT NULL,
  context       TEXT,                  -- quando perguntar
  active        BOOLEAN NOT NULL DEFAULT true,
  asked_count   INT NOT NULL DEFAULT 0,
  last_asked_at TIMESTAMPTZ,
  answer        TEXT,                  -- resposta do operador
  answered_by   INT REFERENCES v3.persons(id),
  answered_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9x12: combinações confirmadas pelo Bruno + a suposição pendente.
INSERT INTO v3.envelope_mix (package_size, black_qty, white_max, confirmed, note) VALUES
  ('9x12', 0, 8, true,  'só brancas (Bruno corrigiu de 6 pra 8 em 08-07)'),
  ('9x12', 1, 6, true,  'confirmado pelo Bruno'),
  ('9x12', 2, 4, true,  'confirmado pelo Bruno'),
  ('9x12', 3, 2, false, 'SUPOSIÇÃO: Bruno achou 0, cálculo por volume deu 2. PERGUNTA PENDENTE ao operador.')
ON CONFLICT (package_size, black_qty) DO NOTHING;

INSERT INTO v3.packing_questions (key, question, context) VALUES
  ('mix_9x12_3black',
   'Nesse pedido com 3 garrafas PRETAS, coube alguma garrafa BRANCA junto no envelope 9x12? Se sim, quantas?',
   'Aparece quando um pedido tem 3 pretas + pelo menos 1 branca. Confirma a capacidade real do 9x12.')
ON CONFLICT (key) DO NOTHING;
