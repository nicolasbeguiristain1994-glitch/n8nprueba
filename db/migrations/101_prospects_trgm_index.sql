-- Índices GIN trigram para búsquedas ILIKE en prospects.
--
-- Las búsquedas por phone_number, first_name y last_name usan ILIKE '%...%'
-- que no pueden aprovechar un índice B-tree estándar. pg_trgm permite que
-- el planner use un índice GIN para estos patrones, lo que reduce el costo
-- de un seq scan completo a una búsqueda de índice.
--
-- pg_trgm viene incluida en el paquete postgresql-contrib y está disponible
-- en Railway, Supabase y la mayoría de proveedores managed.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_prospects_phone_trgm
  ON prospects USING GIN (phone_number gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_prospects_first_name_trgm
  ON prospects USING GIN (first_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_prospects_last_name_trgm
  ON prospects USING GIN (last_name gin_trgm_ops);
