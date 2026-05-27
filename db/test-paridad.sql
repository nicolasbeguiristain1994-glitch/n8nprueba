-- test-paridad.sql
--
-- Verifica que los valores en las nuevas tablas (segmentation_tiers, scoring_config)
-- producen exactamente los mismos resultados que los valores hardcodeados en
-- frontend/lib/user-prioritization/config.ts y scoring.ts.
--
-- Caso de prueba canónico:
--   contacto con days_inactive = 30, value_tier = 'medio'
--
-- Resultados esperados (calculados manualmente y verificados contra TypeScript):
--   value_score      = 25
--   urgency_score    = 26
--   priority_score   = 51
--
-- ── Derivación manual del urgency_score ──────────────────────────────────────
--
-- TypeScript (scoring.ts:scoreUrgency):
--   tier    = 'medio' → minDays=14, maxDays=60
--   span    = 60 - 14 = 46
--   position = Math.min(1, (30 - 14) / 46) = Math.min(1, 16/46) = 0.34782...
--   urgency  = Math.max(0, Math.round((1 - 0.34782) * 40))
--            = Math.round(0.65217 * 40)
--            = Math.round(26.087)
--            = 26
--
-- SQL equivalente (usando ROUND para paridad exacta con Math.round):
--   ROUND((1 - LEAST(1, (30-14)::numeric / (60-14))) * 40)
--   = ROUND((1 - LEAST(1, 16/46)) * 40)
--   = ROUND((1 - 0.34782608...) * 40)
--   = ROUND(0.65217391... * 40)
--   = ROUND(26.08695...)
--   = 26
--
-- Nota: la instrucción original usa FLOOR en su descripción del caso de prueba.
-- Para este valor (26.087) FLOOR y ROUND producen el mismo resultado (26).
-- Se usa ROUND aquí para paridad exacta con Math.round de TypeScript.
-- En valores donde FLOOR ≠ ROUND (ej: 26.5), ROUND es el correcto.
--
-- ── Query de paridad ──────────────────────────────────────────────────────────

WITH params AS (
  SELECT
    30 AS days_inactive,
    'medio' AS test_tier
),
tier_data AS (
  SELECT
    st.tier,
    st.min_days_inactive,
    st.max_days_inactive,
    st.value_score,
    (st.max_days_inactive - st.min_days_inactive) AS span
  FROM segmentation_tiers st
  CROSS JOIN params p
  WHERE st.tier = p.test_tier
    AND st.workspace_id = 'default'
    AND st.is_active = true
),
score_data AS (
  SELECT
    (SELECT value::integer FROM scoring_config
     WHERE key = 'urgency_score_max' AND workspace_id = 'default') AS urgency_max
),
computed AS (
  SELECT
    td.tier,
    td.value_score,
    td.min_days_inactive,
    td.max_days_inactive,
    td.span,
    p.days_inactive,
    -- Posición en la ventana [0, 1]
    LEAST(1, (p.days_inactive - td.min_days_inactive)::numeric / td.span) AS position,
    -- urgency_score: decaimiento lineal desde urgency_max hasta 0
    GREATEST(0,
      ROUND(
        (1 - LEAST(1, (p.days_inactive - td.min_days_inactive)::numeric / td.span))
        * sd.urgency_max
      )
    )::integer AS urgency_score,
    sd.urgency_max,
    td.value_score AS value_score_final
  FROM tier_data td
  CROSS JOIN params p
  CROSS JOIN score_data sd
)
SELECT
  tier,
  days_inactive,
  value_score_final                          AS value_score,
  urgency_score,
  (value_score_final + urgency_score)        AS priority_score,
  -- Validaciones de paridad
  (value_score_final = 25)                   AS value_score_ok,     -- esperado: 25
  (urgency_score = 26)                       AS urgency_score_ok,   -- esperado: 26
  (value_score_final + urgency_score = 51)   AS priority_score_ok,  -- esperado: 51
  -- Detalle de cálculo para debugging
  min_days_inactive,
  max_days_inactive,
  span,
  position,
  urgency_max
FROM computed;

-- ── Resultado esperado ────────────────────────────────────────────────────────
--
--   tier  | days_inactive | value_score | urgency_score | priority_score | value_score_ok | urgency_score_ok | priority_score_ok
--   ------+---------------+-------------+---------------+----------------+----------------+------------------+------------------
--   medio |            30 |          25 |            26 |             51 | t              | t                | t
--
-- Todas las columnas _ok deben ser TRUE para confirmar paridad.


-- ── Verificación adicional: invariantes de scoring_config ────────────────────
--
-- Los pesos del risk score deben sumar exactamente 100.
-- allow_threshold debe ser menor que delay_threshold.

SELECT
  SUM(value) FILTER (
    WHERE key IN ('risk_weight_daily', 'risk_weight_weekly', 'risk_weight_cooldown')
  )::integer                                              AS sum_risk_weights,    -- debe ser 100
  (SUM(value) FILTER (
    WHERE key IN ('risk_weight_daily', 'risk_weight_weekly', 'risk_weight_cooldown')
  ) = 100)                                                AS weights_sum_100_ok,  -- debe ser true
  MIN(value) FILTER (WHERE key = 'allow_threshold')       AS allow_threshold,     -- debe ser 30
  MIN(value) FILTER (WHERE key = 'delay_threshold')       AS delay_threshold,     -- debe ser 60
  MIN(value) FILTER (WHERE key = 'allow_threshold') <
  MIN(value) FILTER (WHERE key = 'delay_threshold')       AS allow_lt_delay_ok   -- debe ser true
FROM scoring_config
WHERE workspace_id = 'default';


-- ── Verificación de los 4 tiers con sus scores canónicos ─────────────────────

SELECT
  tier,
  value_score,
  min_days_inactive,
  max_days_inactive,
  recontact_cooldown_days,
  -- Verificaciones contra valores de config.ts
  (tier = 'vip'   AND value_score = 60 AND min_days_inactive = 7  AND max_days_inactive = 180 AND recontact_cooldown_days = 3)  OR
  (tier = 'alto'  AND value_score = 45 AND min_days_inactive = 7  AND max_days_inactive = 150 AND recontact_cooldown_days = 5)  OR
  (tier = 'medio' AND value_score = 25 AND min_days_inactive = 14 AND max_days_inactive = 60  AND recontact_cooldown_days = 7)  OR
  (tier = 'bajo'  AND value_score = 10 AND min_days_inactive = 30 AND max_days_inactive = 45  AND recontact_cooldown_days = 14)
    AS values_match_config_ts
FROM segmentation_tiers
WHERE workspace_id = 'default'
ORDER BY value_score DESC;

-- Resultado esperado: values_match_config_ts = true en las 4 filas.
