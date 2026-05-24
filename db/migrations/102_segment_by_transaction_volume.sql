-- Migration 102: Recomputar segmento de contactos basado en volumen real de cargas
--
-- Reglas:
--   Super Vip (vip)  — máximo acumulado en una ventana de 30 días >= $1.000.000
--   Vip       (alto) — máximo acumulado en una ventana de 30 días >= $500.000
--   Resto           — se conserva el seg_monto del casino (bajo/medio)
--                     Si el casino decía vip/alto pero no llega a los umbrales,
--                     se baja a 'medio'.
--
-- La ventana es ROLLING: para cada carga se suman los 30 días anteriores.
-- Se toma el máximo de todos esos sumas parciales (no importa en qué momento
-- del historial ocurrió, solo que haya existido ese volumen en algún momento).

BEGIN;

WITH rolling_max AS (
  -- Máximo de la suma móvil de 30 días por jugador (solo cargas)
  SELECT LOWER(username) AS uname, MAX(window_sum) AS max_30d
  FROM (
    SELECT username,
           SUM(monto) OVER (
             PARTITION BY LOWER(username)
             ORDER BY fecha
             RANGE BETWEEN INTERVAL '30 days' PRECEDING AND CURRENT ROW
           ) AS window_sum
    FROM casino_transactions
    WHERE tipo = 'carga'
  ) t
  GROUP BY LOWER(username)
),
matched AS (
  -- Unir cada contacto con su casino_player y el rolling max correspondiente
  -- DISTINCT ON garantiza una sola fila por contacto si hay múltiples matches
  SELECT DISTINCT ON (c.id)
    c.id,
    cp.seg_monto,
    COALESCE(rm.max_30d, 0)      AS max_30d,
    rm.max_30d IS NOT NULL       AS has_tx
  FROM contacts c
  JOIN casino_players cp ON (
    cp.username_lower = LOWER(TRIM(COALESCE(c.first_name, '')))
    OR cp.username_lower = REGEXP_REPLACE(
         LOWER(TRIM(COALESCE(c.first_name, ''))),
         '^[a-z]+/\s*', ''
       )
  )
  LEFT JOIN rolling_max rm ON rm.uname = cp.username_lower
  WHERE cp.seg_monto IS NOT NULL
  ORDER BY c.id, rm.max_30d DESC NULLS LAST
),
new_segments AS (
  SELECT
    id,
    CASE
      WHEN max_30d >= 1000000                            THEN 'vip'::contact_segment
      WHEN max_30d >= 500000                             THEN 'alto'::contact_segment
      WHEN has_tx AND seg_monto IN ('vip','alto')        THEN 'medio'::contact_segment
      ELSE seg_monto::contact_segment
    END AS new_segment
  FROM matched
)
UPDATE contacts c
SET
  segment    = ns.new_segment,
  updated_at = NOW()
FROM new_segments ns
WHERE c.id = ns.id
  AND c.segment IS DISTINCT FROM ns.new_segment;

COMMIT;
