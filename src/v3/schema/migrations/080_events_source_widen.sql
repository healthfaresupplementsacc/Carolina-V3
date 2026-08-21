-- 080 — v3.events.source: VARCHAR(20) -> TEXT (Bruno 08-21).
--
-- Bug de campo: o operador que tentava adicionar uma task esquecida (retroativa)
-- via /op batia em "value too long for type character varying(20)" e NAO conseguia
-- prosseguir. O INSERT do retroativo grava source='operator_page_retroactive'
-- (25 chars) numa coluna de 20. O caminho do admin usa 'admin_retroactive' (17)
-- e por isso passava — so o operador quebrava.
--
-- Nunca houve UM evento com esse source no banco: o retroativo do operador
-- nunca funcionou desde que foi escrito. Nao ha dado a migrar.
--
-- Por que TEXT e nao VARCHAR(40): no Postgres TEXT e varchar tem o mesmo custo
-- de armazenamento, e o limite arbitrario so volta a morder quando alguem
-- inventar o proximo source descritivo. As outras colunas source da base
-- (037, 058, 064, 074) ja sao TEXT — isso alinha events com elas.
--
-- A matview v3.events_enriched (028_metrics) le e.source, e o Postgres recusa
-- ALTER TYPE numa coluna usada por view ("cannot alter type of a column used by
-- a view or rule"). Entao ela e derrubada e recriada IDENTICA (mesma definicao,
-- mesmos 4 indices) dentro da mesma transacao.
--
-- RULE #0: o sistema nunca pode impedir o operador de registrar a realidade.

BEGIN;

DROP MATERIALIZED VIEW IF EXISTS v3.events_enriched;

ALTER TABLE v3.events ALTER COLUMN source TYPE TEXT;

COMMENT ON COLUMN v3.events.source IS
  'Origem do event: slack | operator_page | operator_page_retroactive | admin_retroactive | print_station | ems_auto | ems_passive_detect | manual_catchup | admin_cowork_mirror. TEXT (nao varchar) — nome descritivo novo nao pode quebrar o registro.';

-- recriada byte-a-byte a partir de pg_get_viewdef da producao (nada mudou aqui)
CREATE MATERIALIZED VIEW v3.events_enriched AS
  SELECT e.id,
    e.person_id,
    e.activity_type_id,
    e.product_batch_id,
    e.started_at,
    e.ended_at,
    e.is_long_running,
    e.orders_printed,
    e.cowork_with,
    e.closed_reason,
    e.source,
    p.display_name AS person_name,
    p.role AS person_role,
    at.slug,
    at.display_name AS task_name,
    at.category,
    pb.batch_number,
    pr.canonical_name AS product_name,
    pb.product_id,
    EXTRACT(epoch FROM COALESCE(e.ended_at, now()) - e.started_at) / 60.0 AS duration_min,
    EXTRACT(dow FROM (e.started_at AT TIME ZONE 'America/New_York'::text))::integer AS day_of_week,
    EXTRACT(hour FROM (e.started_at AT TIME ZONE 'America/New_York'::text))::integer AS hour_of_day,
    (e.started_at AT TIME ZONE 'America/New_York'::text)::date AS date_edt
   FROM v3.events e
     JOIN v3.persons p ON p.id = e.person_id
     LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
     LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
     LEFT JOIN v3.products pr ON pr.id = pb.product_id
  WHERE e.deleted_at IS NULL;

CREATE UNIQUE INDEX idx_ee_id ON v3.events_enriched USING btree (id);
CREATE INDEX idx_ee_person_date ON v3.events_enriched USING btree (person_id, date_edt);
CREATE INDEX idx_ee_slug ON v3.events_enriched USING btree (slug);
CREATE INDEX idx_ee_started ON v3.events_enriched USING btree (started_at);

COMMIT;
