-- 117_cps_ltv_columns.sql
-- ── Integra LTV en contact_priority_scores ────────────────────────────────────
--
-- Agrega dos columnas que persisten el resultado del LTV lookup durante el
-- recompute diario de prioridades:
--
--   ltv_score  SMALLINT NULL  — copia del player_ltv.ltv_score (0–60) en el
--                               momento del recompute. NULL si el contacto no
--                               tiene registro en player_ltv (jugador sin datos).
--
--   ltv_tier   TEXT NULL      — copia del player_ltv.tier_ltv en el momento del
--                               recompute. NULL mismo caso que ltv_score.
--
-- Estas columnas actúan como snapshot: permiten auditar con qué valor de LTV
-- se computó cada score sin necesidad de re-joinear con player_ltv.
--
-- El valor_score efectivo en el scoring es:
--   COALESCE(ltv_score, value_score_plano_del_tier)
-- ver scoring.ts → computeScore(metrics.ltvScore).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE contact_priority_scores
  ADD COLUMN IF NOT EXISTS ltv_score SMALLINT
    CHECK (ltv_score IS NULL OR ltv_score BETWEEN 0 AND 60),
  ADD COLUMN IF NOT EXISTS ltv_tier  TEXT
    CHECK (ltv_tier IS NULL OR ltv_tier IN (
      'super_vip', 'vip_alto', 'vip_medio', 'vip', 'medio', 'bajo'
    ));

COMMENT ON COLUMN contact_priority_scores.ltv_score IS
  'LTV score (0–60) del jugador en el momento del recompute. NULL = sin datos LTV (fallback a value_score plano).';
COMMENT ON COLUMN contact_priority_scores.ltv_tier IS
  'Tier LTV del jugador en el momento del recompute. Determina la ventana de inactividad en scoring.';

-- Índice para filtrar contactos por tier LTV en el dashboard (opcional ahora, útil en v2)
CREATE INDEX IF NOT EXISTS idx_cps_ltv_tier
  ON contact_priority_scores (ltv_tier)
  WHERE ltv_tier IS NOT NULL AND is_eligible = true;

COMMIT;
