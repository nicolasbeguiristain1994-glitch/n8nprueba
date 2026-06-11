-- Índices de performance para contact_priority_scores y whatsapp_messages.
--
-- contact_priority_scores: los filtros más comunes en /prioridades combinan
-- is_eligible + value_tier/is_broadcasted + priority_score, pero solo existe
-- idx_cps_segment_score sobre (reactivation_segment, priority_score DESC).
-- Los nuevos índices parciales (WHERE is_eligible = true) eliminan ~50% de
-- las filas del índice porque los no-elegibles nunca se muestran.
--
-- whatsapp_messages: crecer a ~1M+ filas/año. Sin índice por campaign_id +
-- created_at, las stats de campañas hacen seq scan de la tabla completa.
-- idx_wm_created_status acelera el query de stats del dashboard (counts por status).

-- ── contact_priority_scores ───────────────────────────────────────────────────

-- Filtro: tier de valor + score (pestaña "por tier" en prioridades)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cps_eligible_tier_score
  ON contact_priority_scores(value_tier, priority_score DESC)
  WHERE is_eligible = true;

-- Filtro: no enviados aún (vista principal de prioridades, broadcasted=false)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cps_eligible_not_broadcasted
  ON contact_priority_scores(priority_score DESC, reactivation_segment)
  WHERE is_eligible = true AND is_broadcasted = false;

-- Filtro: days_inactive en rango — BRIN es eficiente para columnas con correlación
-- con el orden de inserción (recomputes sucesivos insertan en lotes temporales).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cps_days_inactive_brin
  ON contact_priority_scores USING brin(days_inactive)
  WITH (pages_per_range = 64);

-- ── whatsapp_messages ─────────────────────────────────────────────────────────

-- Stats de campaña con filter de fecha (evita seq scan de tabla completa)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wm_campaign_created
  ON whatsapp_messages(campaign_id, created_at DESC);

-- Stats del dashboard: counts por status en ventana reciente (24h, outbound)
-- Partial index solo en outbound: los inbound no se cuentan en las métricas de envío.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wm_created_status_outbound
  ON whatsapp_messages(created_at DESC, status)
  WHERE direction = 'outbound';

ANALYZE contact_priority_scores;
ANALYZE whatsapp_messages;

-- DOWN:
-- DROP INDEX CONCURRENTLY IF EXISTS idx_cps_eligible_tier_score;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_cps_eligible_not_broadcasted;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_cps_days_inactive_brin;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_wm_campaign_created;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_wm_created_status_outbound;
