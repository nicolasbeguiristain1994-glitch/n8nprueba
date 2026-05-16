BEGIN;

-- ── Índices para queries de operadores en contact_priority_scores ─────────────
--
-- Los filtros más frecuentes del operador son:
--   1. Por segmento de difusión → ORDER BY priority_score DESC  (ya cubierto)
--   2. Por value_tier → ORDER BY priority_score DESC            (nuevo)
--   3. Por días de inactividad (rango minDaysInactive–maxDaysInactive)          (nuevo)
--
-- idx_cps_segment_score ya existe (migration 079).
-- idx_cps_tier_score cubre el filtro valueTier que faltaba.

CREATE INDEX IF NOT EXISTS idx_cps_tier_score
  ON contact_priority_scores (value_tier, priority_score DESC)
  WHERE is_eligible = true;

COMMENT ON INDEX idx_cps_tier_score IS
  'Cubre filtros por value_tier del operador, ordenados por prioridad descendente.';

-- idx_cps_days_inactive cubre filtros de rango en la UI (minDaysInactive / maxDaysInactive).
CREATE INDEX IF NOT EXISTS idx_cps_days_inactive
  ON contact_priority_scores (days_inactive)
  WHERE is_eligible = true;

COMMENT ON INDEX idx_cps_days_inactive IS
  'Cubre filtros de ventana de inactividad en la lista de difusión.';

-- GIN sobre contacts.platforms para el filtro de plataforma.
-- El índice anterior (idx_contacts_platforms de migration 075) puede ser B-Tree;
-- GIN es necesario para el operador ANY($1).
CREATE INDEX IF NOT EXISTS idx_contacts_platforms_gin
  ON contacts USING GIN (platforms);

COMMENT ON INDEX idx_contacts_platforms_gin IS
  'Soporte eficiente para $platform = ANY(c.platforms) en el listado de difusión.';

COMMIT;
