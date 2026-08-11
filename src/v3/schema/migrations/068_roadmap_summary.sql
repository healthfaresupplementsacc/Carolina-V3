-- 068 — Roadmap: campo SUMMARY rico por card (Bruno 08-06).
-- Bruno quer, ao clicar num card, ver um RESUMO do que a gente conversou + a
-- ideia do plano. detail = 1 linha; summary = o contexto completo (mantido
-- atualizado a cada projeto). Aditivo.
ALTER TABLE v3.roadmap_cards ADD COLUMN IF NOT EXISTS summary TEXT;
