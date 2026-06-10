-- ============================================================
-- Migration 110: Re-segmentar contactos usando casino_transactions
--
-- Problema: casino_players.fecha_ultima puede estar desactualizada
-- (sinceronizada hace meses), causando que jugadores sin actividad
-- reciente aparezcan como "frecuente" en lugar de "perdido"/"inactivo".
--
-- Solución:
--   1. Recalcular seg_monto y seg_actividad en casino_players usando
--      MAX(fecha) de casino_transactions como fecha real del último depósito.
--   2. Sincronizar contacts.segment desde casino_players actualizado,
--      joineando también por casino_accounts (multi-usuario por contacto).
--   3. Re-aplicar contact_tags (actividad, antiguedad, valor_riesgo).
--   4. Sincronizar last_deposit_at y contadores de depósitos.
-- ============================================================

BEGIN;

-- ── Paso 1: Recalcular casino_players con fecha real de casino_transactions ──
WITH has_tx AS (
  SELECT EXISTS(SELECT 1 FROM casino_transactions WHERE tipo = 'carga') AS any_tx
),
active_months AS (
  SELECT
    LOWER(ct.username)                                AS username_lower,
    COUNT(DISTINCT DATE_TRUNC('month', ct.fecha))::int AS meses_con_cargas,
    MAX(ct.fecha)::date                               AS last_tx_date
  FROM casino_transactions ct
  WHERE ct.tipo = 'carga'
  GROUP BY LOWER(ct.username)
),
carga_mensual AS (
  SELECT
    cp.id,
    cp.username_lower,
    cp.total_cargas,
    COALESCE(am.meses_con_cargas, 1)           AS meses_activos,
    ROUND(
      cp.total_cargas::numeric /
      GREATEST(COALESCE(am.meses_con_cargas, 1), 1)
    )                                           AS avg_mensual,
    CASE
      WHEN ht.any_tx AND am.last_tx_date IS NULL THEN NULL
      ELSE COALESCE(am.last_tx_date, cp.fecha_ultima)
    END                                        AS fecha_real_ultima
  FROM casino_players cp
  CROSS JOIN has_tx ht
  LEFT JOIN active_months am ON am.username_lower = cp.username_lower
)
UPDATE casino_players cp
SET
  dias_desde_ultimo = CASE
    WHEN cm.fecha_real_ultima IS NOT NULL THEN (CURRENT_DATE - cm.fecha_real_ultima)
    ELSE NULL
  END,

  seg_monto = CASE
    WHEN cm.avg_mensual >= 3200000 THEN 'super_vip'
    WHEN cm.avg_mensual >= 1500000 THEN 'vip_alto'
    WHEN cm.avg_mensual >= 1000000 THEN 'vip_medio'
    WHEN cm.avg_mensual >=  500000 THEN 'vip'
    WHEN cm.avg_mensual >=  100000 THEN 'medio'
    ELSE                                'bajo'
  END,

  seg_actividad = CASE
    WHEN cm.fecha_real_ultima IS NULL
      OR (CURRENT_DATE - cm.fecha_real_ultima) > 180         THEN 'perdido'
    WHEN (CURRENT_DATE - cm.fecha_real_ultima) >  60         THEN 'inactivo'
    WHEN (CURRENT_DATE - cm.fecha_real_ultima) >  30         THEN 'en_riesgo'
    WHEN cp.fecha_primera IS NOT NULL
      AND (CURRENT_DATE - cp.fecha_primera) <= 30            THEN 'nuevo'
    WHEN cp.fecha_primera IS NOT NULL
      AND (cp.cant_cargas::numeric
           / GREATEST((CURRENT_DATE - cp.fecha_primera)::numeric / 7.0, 1)) >= 3
                                                             THEN 'frecuente'
    WHEN cp.fecha_primera IS NOT NULL
      AND (cp.cant_cargas::numeric
           / GREATEST((CURRENT_DATE - cp.fecha_primera)::numeric / 7.0, 1)) >= 1
                                                             THEN 'regular'
    ELSE                                                          'ocasional'
  END,

  updated_at = NOW()
FROM carga_mensual cm
WHERE cm.id = cp.id;

-- ── Paso 2: Sync contacts.segment (first_name + casino_accounts) ─────────────
UPDATE contacts c
SET segment = cp.seg_monto::contact_segment,
    updated_at = NOW()
FROM casino_players cp
WHERE (
  LOWER(TRIM(c.first_name)) = cp.username_lower
  OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(c.casino_accounts) acc
    WHERE LOWER(acc->>'username') = cp.username_lower
  )
)
  AND cp.seg_monto IS NOT NULL
  AND c.segment::text IS DISTINCT FROM cp.seg_monto;

-- ── Paso 3a: Borrar tags de actividad/antiguedad/valor_riesgo obsoletos ───────
DELETE FROM contact_tags ct
WHERE (ct.tag LIKE 'casino:actividad:%'
    OR ct.tag LIKE 'casino:antiguedad:%'
    OR ct.tag LIKE 'casino:valor_riesgo:%')
  AND ct.contact_id IN (
    SELECT c.id
    FROM contacts c
    JOIN casino_players cp ON (
      LOWER(TRIM(c.first_name)) = cp.username_lower
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(c.casino_accounts) acc
        WHERE LOWER(acc->>'username') = cp.username_lower
      )
    )
    WHERE cp.seg_monto IS NOT NULL AND cp.seg_actividad IS NOT NULL
  );

-- ── Paso 3b: Re-insertar tags actualizados ────────────────────────────────────
INSERT INTO contact_tags (id, contact_id, tag, added_by, added_at)
SELECT
  gen_random_uuid(),
  c.id,
  unnest(array_remove(ARRAY[
    'casino:actividad:' || cp.seg_actividad,
    CASE
      WHEN cp.fecha_primera IS NULL                             THEN NULL
      WHEN (CURRENT_DATE - cp.fecha_primera) <  30             THEN 'casino:antiguedad:nuevo'
      WHEN (CURRENT_DATE - cp.fecha_primera) <  90             THEN 'casino:antiguedad:reciente'
      WHEN (CURRENT_DATE - cp.fecha_primera) < 150             THEN 'casino:antiguedad:establecido'
      WHEN (CURRENT_DATE - cp.fecha_primera) < 270             THEN 'casino:antiguedad:veterano'
      ELSE                                                           'casino:antiguedad:leal'
    END,
    CASE
      WHEN cp.seg_actividad IN ('perdido','inactivo','en_riesgo')
        AND cp.seg_monto IN ('super_vip','vip_alto','vip_medio','vip') THEN 'casino:valor_riesgo:critico'
      WHEN cp.seg_actividad IN ('perdido','inactivo','en_riesgo')
        AND cp.seg_monto = 'medio'                                     THEN 'casino:valor_riesgo:medio'
      WHEN cp.seg_actividad IN ('perdido','inactivo','en_riesgo')
        AND cp.seg_monto = 'bajo'                                      THEN 'casino:valor_riesgo:bajo'
      ELSE NULL
    END
  ], NULL)),
  'migration_110',
  NOW()
FROM contacts c
JOIN casino_players cp ON (
  LOWER(TRIM(c.first_name)) = cp.username_lower
  OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(c.casino_accounts) acc
    WHERE LOWER(acc->>'username') = cp.username_lower
  )
)
WHERE cp.seg_monto IS NOT NULL AND cp.seg_actividad IS NOT NULL
ON CONFLICT (contact_id, tag) DO NOTHING;

-- ── Paso 4: Sync last_deposit_at y contadores ─────────────────────────────────
UPDATE contacts c
SET
  total_deposits    = cp.cant_cargas,
  total_withdrawals = cp.cant_retiros,
  last_deposit_at   = cp.fecha_ultima::timestamptz,
  updated_at        = NOW()
FROM casino_players cp
WHERE (
  LOWER(TRIM(c.first_name)) = cp.username_lower
  OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(c.casino_accounts) acc
    WHERE LOWER(acc->>'username') = cp.username_lower
  )
)
  AND cp.fecha_ultima IS NOT NULL
  AND (
    c.total_deposits    IS DISTINCT FROM cp.cant_cargas
    OR c.total_withdrawals IS DISTINCT FROM cp.cant_retiros
    OR c.last_deposit_at::date IS DISTINCT FROM cp.fecha_ultima
  );

COMMIT;
