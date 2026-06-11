-- Índices GIN trigram para búsquedas ILIKE en contacts (phone, name).
--
-- Sin estos índices, cualquier búsqueda textual hace un seq scan de 220k+ filas.
-- pg_trgm ya está habilitado en migración 101 (prospects_trgm_index).
-- CONCURRENTLY: no bloquea lecturas/escrituras durante la creación.
--
-- Mejora esperada en búsqueda de contactos:
--   ANTES:  Seq Scan ~800ms–3s (220k rows)
--   DESPUÉS: Index Scan ~5–30ms

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_phone_trgm
  ON contacts USING gin(phone_number gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_first_name_trgm
  ON contacts USING gin(first_name gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_last_name_trgm
  ON contacts USING gin(last_name gin_trgm_ops);

ANALYZE contacts;

-- DOWN: DROP INDEX CONCURRENTLY IF EXISTS idx_contacts_phone_trgm;
-- DOWN: DROP INDEX CONCURRENTLY IF EXISTS idx_contacts_first_name_trgm;
-- DOWN: DROP INDEX CONCURRENTLY IF EXISTS idx_contacts_last_name_trgm;
