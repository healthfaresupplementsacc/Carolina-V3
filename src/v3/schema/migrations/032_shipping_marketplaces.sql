-- ============================================================
-- HEALTHFARE V3 — Migration 032: envio por marketplace (Walmart/Amazon)
-- ============================================================
-- ADITIVO (mudança #4). "Envio" deixa de ser uma task genérica e ganha
-- destinos: Envio Walmart + Envio Amazon. NÃO renomeia 'shipping' (já existe
-- 'shipping_other' — renomear colidiria); 'shipping' fica no banco pro
-- histórico, mas sai do menu /op (via build-fuse-data). Sem lote, sem nota.
-- Idempotente. DOWN: 032_shipping_marketplaces.down.sql
-- ============================================================
BEGIN;

INSERT INTO v3.activity_types (slug, display_name, category, requires_product, active)
VALUES
  ('shipping_walmart', 'Envio Walmart', 'pnp_phase', false, true),
  ('shipping_amazon',  'Envio Amazon',  'pnp_phase', false, true)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
