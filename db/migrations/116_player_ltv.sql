-- 116_player_ltv.sql
-- ── Módulo de LTV (Lifetime Value) para jugadores de casino ──────────────────
--
-- Diseño: el LTV dinámico reemplaza el value_score plano (constante por tier)
-- por un score continuo (0–60) basado en el percentil de NGR real del jugador
-- DENTRO DE SU AGENTE. El percentil es por-agente porque las bases de btcuno,
-- btcdos, ofizeus y royal tienen escalas de montos distintas.
--
-- Flujo:
--   1. refresh_player_ltv() recalcula NGR, ARPU, percentil y ltv_score
--      para todos los jugadores de casino_players.
--   2. mv_player_ltv es una vista materializada para consultas rápidas.
--   3. El job 'ltv_recompute' en system_jobs controla la concurrencia.
--   4. UserPrioritizationService integra ltv_score al recompute diario de
--      contact_priority_scores (ver migración 117 y scoring.ts).
--
-- Mapeo de percentil → ltv_score (escala 0–60, compatible con VALUE_SCORES):
--   ≥ P90 → 60  (super_vip)
--   ≥ P75 → 52  (vip_alto)
--   ≥ P60 → 45  (vip_medio)
--   ≥ P40 → 40  (vip)
--   ≥ P20 → 25  (medio)
--   resto → 10  (bajo)
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Tabla player_ltv ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS player_ltv (
  casino_player_id   UUID         PRIMARY KEY
                                  REFERENCES casino_players(id) ON DELETE CASCADE,

  -- Métricas brutas derivadas de casino_players (calculadas en refresh)
  ngr_total          NUMERIC(18,2),            -- total_cargas - total_retiros
  arpu               NUMERIC(18,2),            -- total_cargas / cant_cargas
  dias_activo        INTEGER,                  -- fecha_ultima - fecha_primera (días)

  -- LTV normalizado por agente
  ltv_percentil      NUMERIC(5,2),             -- 0–100, calculado PARTITION BY agente
  ltv_score          SMALLINT    NOT NULL DEFAULT 0
                                 CHECK (ltv_score BETWEEN 0 AND 60),
  tier_ltv           TEXT        NOT NULL DEFAULT 'bajo'
                                 CHECK (tier_ltv IN (
                                   'super_vip', 'vip_alto', 'vip_medio',
                                   'vip', 'medio', 'bajo'
                                 )),

  calculado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version            INTEGER     NOT NULL DEFAULT 1   -- optimistic locking
);

COMMENT ON TABLE player_ltv IS
  'LTV dinámico por jugador. ltv_score (0–60) reemplaza el value_score plano en scoring.';
COMMENT ON COLUMN player_ltv.ngr_total IS
  'Net Gaming Revenue = total_cargas - total_retiros. Proxy de rentabilidad real.';
COMMENT ON COLUMN player_ltv.ltv_percentil IS
  'Percentil 0–100 dentro del agente (PERCENT_RANK * 100). Comparación justa por escala.';
COMMENT ON COLUMN player_ltv.ltv_score IS
  '0–60, misma escala que VALUE_SCORES en config.ts. Mapeo: P90→60, P75→52, P60→45, P40→40, P20→25, resto→10.';

-- ── 2. Índices ────────────────────────────────────────────────────────────────

-- Join frecuente desde contact_priority_scores via casino_players
CREATE INDEX IF NOT EXISTS idx_player_ltv_player_id
  ON player_ltv (casino_player_id);

-- Top jugadores por agente (panel de settings LTV)
CREATE INDEX IF NOT EXISTS idx_player_ltv_agente_percentil
  ON player_ltv (tier_ltv, ltv_percentil DESC);

-- Filtro por tier en API /api/contacts/ltv
CREATE INDEX IF NOT EXISTS idx_player_ltv_tier
  ON player_ltv (tier_ltv);

-- ── 3. Habilitar RLS (estrategia del proyecto: sin policies, backend usa service_role) ──

ALTER TABLE player_ltv ENABLE ROW LEVEL SECURITY;

-- ── 4. Función refresh_player_ltv ────────────────────────────────────────────
--
-- Recalcula LTV para todos los jugadores (o solo uno si se pasa p_player_id).
-- Idempotente: INSERT ... ON CONFLICT DO UPDATE.
-- Usa PERCENT_RANK() OVER (PARTITION BY agente ORDER BY ngr_total NULLS LAST).
--
-- Edge cases manejados:
--   - Sin depósitos (total_cargas = 0): NGR = 0, ARPU = NULL, percentil bajo.
--   - Sin fecha_primera: dias_activo = NULL.
--   - Agente NULL: se trata como agente 'sin_agente' para no mezclar con los reales.
--   - Un solo jugador en el agente: PERCENT_RANK = 0 → tier bajo (conservador).

CREATE OR REPLACE FUNCTION refresh_player_ltv(
  p_player_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_rows_processed  INTEGER;
  v_started_at      TIMESTAMPTZ := clock_timestamp();
BEGIN
  WITH ranked AS (
    SELECT
      cp.id                                            AS casino_player_id,
      -- NGR: ganancia neta del jugador para el negocio
      ROUND(
        (COALESCE(cp.total_cargas, 0) - COALESCE(cp.total_retiros, 0))::numeric,
        2
      )                                                AS ngr_total,
      -- ARPU: ticket promedio por depósito
      CASE
        WHEN COALESCE(cp.cant_cargas, 0) > 0
          THEN ROUND(cp.total_cargas::numeric / cp.cant_cargas, 2)
        ELSE NULL
      END                                              AS arpu,
      -- Días de vida activa en el casino
      CASE
        WHEN cp.fecha_primera IS NOT NULL AND cp.fecha_ultima IS NOT NULL
          THEN (cp.fecha_ultima - cp.fecha_primera)
        ELSE NULL
      END                                              AS dias_activo,
      -- Percentil por agente (0.0–1.0), NULLS LAST garantiza que NGR NULL va al fondo
      PERCENT_RANK() OVER (
        PARTITION BY COALESCE(cp.agente, 'sin_agente')
        ORDER BY
          (COALESCE(cp.total_cargas, 0) - COALESCE(cp.total_retiros, 0)) ASC
          NULLS LAST
      )                                                AS prank
    FROM casino_players cp
    WHERE (p_player_id IS NULL OR cp.id = p_player_id)
  ),
  scored AS (
    SELECT
      r.casino_player_id,
      r.ngr_total,
      r.arpu,
      r.dias_activo,
      ROUND(r.prank * 100, 2)                          AS ltv_percentil,
      -- Mapeo percentil → ltv_score
      CASE
        WHEN r.prank >= 0.90 THEN 60   -- super_vip
        WHEN r.prank >= 0.75 THEN 52   -- vip_alto
        WHEN r.prank >= 0.60 THEN 45   -- vip_medio
        WHEN r.prank >= 0.40 THEN 40   -- vip
        WHEN r.prank >= 0.20 THEN 25   -- medio
        ELSE                      10   -- bajo
      END                                              AS ltv_score,
      -- Tier correspondiente al score (para urgency window en scoring.ts)
      CASE
        WHEN r.prank >= 0.90 THEN 'super_vip'
        WHEN r.prank >= 0.75 THEN 'vip_alto'
        WHEN r.prank >= 0.60 THEN 'vip_medio'
        WHEN r.prank >= 0.40 THEN 'vip'
        WHEN r.prank >= 0.20 THEN 'medio'
        ELSE                       'bajo'
      END                                              AS tier_ltv
    FROM ranked r
  )
  INSERT INTO player_ltv (
    casino_player_id,
    ngr_total, arpu, dias_activo,
    ltv_percentil, ltv_score, tier_ltv,
    calculado_en, version
  )
  SELECT
    s.casino_player_id,
    s.ngr_total, s.arpu, s.dias_activo,
    s.ltv_percentil, s.ltv_score, s.tier_ltv,
    NOW(), 1
  FROM scored s
  ON CONFLICT (casino_player_id) DO UPDATE SET
    ngr_total    = EXCLUDED.ngr_total,
    arpu         = EXCLUDED.arpu,
    dias_activo  = EXCLUDED.dias_activo,
    ltv_percentil = EXCLUDED.ltv_percentil,
    ltv_score    = EXCLUDED.ltv_score,
    tier_ltv     = EXCLUDED.tier_ltv,
    calculado_en = EXCLUDED.calculado_en,
    version      = player_ltv.version + 1;

  GET DIAGNOSTICS v_rows_processed = ROW_COUNT;

  RETURN jsonb_build_object(
    'rows_processed', v_rows_processed,
    'duration_ms',    EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000,
    'calculated_at',  NOW()
  );
END;
$$;

COMMENT ON FUNCTION refresh_player_ltv IS
  'Recalcula LTV para todos los jugadores (o uno si p_player_id != NULL). Idempotente. Usar via POST /api/contacts/recompute-ltv.';

-- ── 5. Vista materializada mv_player_ltv ─────────────────────────────────────
--
-- Para consultas rápidas en el panel de settings y el endpoint GET /api/contacts/ltv.
-- Se refresca manualmente vía REFRESH MATERIALIZED VIEW CONCURRENTLY (el job LTV lo hace).
-- CONCURRENTLY requiere que exista al menos un índice UNIQUE en la vista.

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_player_ltv AS
SELECT
  cp.id           AS casino_player_id,
  cp.username,
  cp.agente,
  cp.seg_monto,
  pl.ngr_total,
  pl.arpu,
  pl.dias_activo,
  pl.ltv_percentil,
  pl.ltv_score,
  pl.tier_ltv,
  pl.calculado_en
FROM casino_players cp
JOIN player_ltv pl ON pl.casino_player_id = cp.id
WITH DATA;

-- Índice único requerido para REFRESH CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_player_ltv_player_id
  ON mv_player_ltv (casino_player_id);

-- Para filtrar por agente + tier en el panel
CREATE INDEX IF NOT EXISTS idx_mv_player_ltv_agente_tier
  ON mv_player_ltv (agente, tier_ltv, ltv_percentil DESC);

COMMENT ON MATERIALIZED VIEW mv_player_ltv IS
  'Vista desnormalizada para el panel LTV. Refrescar después de refresh_player_ltv().';

-- ── 6. Registrar job ltv_recompute en system_jobs ────────────────────────────
--
-- Mismo patrón que 'prioritization_recompute' (migración 082 + 084).
-- El locking atómico en LtvRepository usa job_name = 'ltv_recompute'.

INSERT INTO system_jobs (job_name)
VALUES ('ltv_recompute')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE system_jobs IS
  'Locking distribuido para jobs de batch. Ver también: prioritization_recompute, ltv_recompute.';

COMMIT;
