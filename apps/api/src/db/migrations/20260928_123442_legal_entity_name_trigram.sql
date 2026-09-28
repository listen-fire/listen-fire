
SET search_path = valuations, pg_catalog;

CREATE INDEX legal_entity_legal_name_trgm_idx ON legal_entity USING gin (legal_name public.gin_trgm_ops);

CREATE INDEX legal_entity_name_trgm_idx ON legal_entity USING gin (name public.gin_trgm_ops);
