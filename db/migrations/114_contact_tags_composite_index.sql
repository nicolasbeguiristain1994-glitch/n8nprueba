-- Índice compuesto (contact_id, tag) para lookups de tags por contacto.
--
-- Situación actual:
--   idx_contact_tags_contact: (contact_id)  — lookup por contacto, sin filtrar por tag
--   idx_contact_tags_tag:     (tag)         — lookup por tag, sin filtrar por contacto
--
-- El nuevo índice compuesto permite a PostgreSQL resolver en una sola pasada:
--   WHERE contact_id = X AND tag LIKE 'casino:actividad:%'
--   WHERE contact_id = X AND tag = ANY(array)
-- En lugar de: index scan por contact_id → filter en memoria por tag.
--
-- Impacto: afecta a /api/contacts (4 subqueries de tags por fila × 50 filas/página)
-- y a los filtros EXISTS de actividad/antigüedad en la misma ruta.
--
-- Los índices de columna simple (003) se mantienen para queries que solo filtran
-- por contact_id o solo por tag (no los rompemos).
--
-- Mejora esperada en carga de página de contactos con filtros de tags:
--   ANTES:  Bitmap Heap Scan contact_tags ~200–600ms
--   DESPUÉS: Index Only Scan ~10–50ms

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_tags_contact_tag
  ON contact_tags(contact_id, tag);

ANALYZE contact_tags;

-- DOWN: DROP INDEX CONCURRENTLY IF EXISTS idx_contact_tags_contact_tag;
