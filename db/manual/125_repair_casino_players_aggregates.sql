-- ============================================================
-- 125_repair_casino_players_aggregates.sql — MANUAL, REVISABLE, DRY-RUN
-- ============================================================
-- Recalcula los agregados de TODOS los jugadores existentes en casino_players
-- desde casino_transactions, con la misma semántica que
-- BaseCasinoConnector.recomputePlayers:
--
--   - por LOWER(username), sumando todas las filas de cualquier agente y
--     plataforma, incluidas las históricas sin plataforma;
--   - excluyendo filas con username = agente (movimientos entre agentes);
--   - ASIGNANDO totales, cantidades y fechas (no suma).
--
-- Por qué hace falta: el sync incremental solo recalcula a los jugadores con
-- movimientos en el rango sincronizado. Un jugador inactivo que quedó inflado por
-- el bug anterior (total + EXCLUDED) nunca vuelve a aparecer y seguiría inflado.
--
-- Qué NO hace:
--   - no inserta jugadores nuevos ni borra jugadores sin transacciones (quedan
--     intactos: pueden venir de cargas anteriores a casino_transactions);
--   - no toca seg_monto, seg_actividad, labels ni ninguna otra columna. Si los
--     totales cambian, la segmentación se recalcula aparte, con el procedimiento
--     habitual (scripts/segmentar-casino-players.js), una vez aprobado.
--
-- Termina en ROLLBACK a propósito. Correr primero así, revisar la salida y
-- recién después, con aprobación, reemplazar el ROLLBACK final por COMMIT.
-- Aplicar con el sync detenido (el LOCK de abajo lo exige de todos modos).
-- ============================================================

BEGIN;

-- Sin escrituras concurrentes mientras se recalcula (el sync esperaría).
LOCK TABLE casino_transactions IN SHARE MODE;
LOCK TABLE casino_players      IN SHARE ROW EXCLUSIVE MODE;

-- ── 1. Foto previa ───────────────────────────────────────────────────────────
-- Fila COMPLETA (todas las columnas, incluidas updated_at, labels y segmentos):
-- las verificaciones del §5 comparan contra esta foto.
CREATE TEMP TABLE _cp_antes ON COMMIT DROP AS
SELECT * FROM casino_players;

-- ── 2. Fuente con la semántica del recompute ─────────────────────────────────
CREATE TEMP TABLE _cp_fuente ON COMMIT DROP AS
WITH fuente AS (
  SELECT LOWER(ct.username) AS uname, ct.agente, ct.platform, ct.tipo, ct.monto,
         ct.fecha, ct.fecha_hora_utc, ct.id
  FROM casino_transactions ct
  WHERE LOWER(ct.username) <> LOWER(ct.agente)
),
agregado AS (
  SELECT uname,
         COALESCE(SUM(monto) FILTER (WHERE tipo = 'carga'),  0) AS total_cargas,
         COALESCE(SUM(monto) FILTER (WHERE tipo = 'retiro'), 0) AS total_retiros,
         COUNT(*) FILTER (WHERE tipo = 'carga')::int            AS cant_cargas,
         COUNT(*) FILTER (WHERE tipo = 'retiro')::int           AS cant_retiros,
         MIN(fecha) AS fecha_primera,
         MAX(fecha) AS fecha_ultima
  FROM fuente
  GROUP BY uname
),
reciente AS (
  SELECT DISTINCT ON (uname) uname, agente, platform
  FROM fuente
  ORDER BY uname, fecha DESC, fecha_hora_utc DESC NULLS LAST, id DESC
)
SELECT a.*, r.agente, r.platform
FROM agregado a
JOIN reciente r USING (uname);

CREATE INDEX ON _cp_fuente (uname);

-- ── 3. Diferencias antes de reparar ─────────────────────────────────────────
-- jugadores_a_corregir usa las MISMAS seis columnas que el UPDATE del §4
-- (totales, cantidades y fechas); el desglose muestra de qué tipo es cada una.
SELECT
  COUNT(*)                                                         AS jugadores_con_fuente,
  COUNT(*) FILTER (WHERE cp.total_cargas  IS DISTINCT FROM f.total_cargas
                      OR cp.total_retiros IS DISTINCT FROM f.total_retiros
                      OR cp.cant_cargas   IS DISTINCT FROM f.cant_cargas
                      OR cp.cant_retiros  IS DISTINCT FROM f.cant_retiros
                      OR cp.fecha_primera IS DISTINCT FROM f.fecha_primera
                      OR cp.fecha_ultima  IS DISTINCT FROM f.fecha_ultima) AS jugadores_a_corregir,
  COUNT(*) FILTER (WHERE cp.total_cargas  IS DISTINCT FROM f.total_cargas
                      OR cp.total_retiros IS DISTINCT FROM f.total_retiros
                      OR cp.cant_cargas   IS DISTINCT FROM f.cant_cargas
                      OR cp.cant_retiros  IS DISTINCT FROM f.cant_retiros) AS con_totales_distintos,
  COUNT(*) FILTER (WHERE cp.fecha_primera IS DISTINCT FROM f.fecha_primera
                      OR cp.fecha_ultima  IS DISTINCT FROM f.fecha_ultima) AS con_fechas_distintas,
  SUM(cp.total_cargas  - f.total_cargas)                           AS exceso_cargas,
  SUM(cp.total_retiros - f.total_retiros)                          AS exceso_retiros
FROM casino_players cp
JOIN _cp_fuente f ON f.uname = cp.username_lower;

-- Muestra de los mayores desvíos (revisar a mano), incluidos los de solo fechas
SELECT cp.username_lower,
       cp.total_cargas  AS cargas_actual,  f.total_cargas  AS cargas_fuente,
       cp.cant_cargas   AS cant_actual,    f.cant_cargas   AS cant_fuente,
       cp.fecha_primera AS primera_actual, f.fecha_primera AS primera_fuente,
       cp.fecha_ultima  AS ultima_actual,  f.fecha_ultima  AS ultima_fuente
FROM casino_players cp
JOIN _cp_fuente f ON f.uname = cp.username_lower
WHERE cp.total_cargas  IS DISTINCT FROM f.total_cargas
   OR cp.total_retiros IS DISTINCT FROM f.total_retiros
   OR cp.cant_cargas   IS DISTINCT FROM f.cant_cargas
   OR cp.cant_retiros  IS DISTINCT FROM f.cant_retiros
   OR cp.fecha_primera IS DISTINCT FROM f.fecha_primera
   OR cp.fecha_ultima  IS DISTINCT FROM f.fecha_ultima
ORDER BY ABS(COALESCE(cp.total_cargas, 0) - f.total_cargas) DESC, cp.username_lower
LIMIT 20;

-- ── 4. Reparación de agregados (solo filas existentes) ───────────────────────
UPDATE casino_players cp SET
  total_cargas  = f.total_cargas,
  total_retiros = f.total_retiros,
  cant_cargas   = f.cant_cargas,
  cant_retiros  = f.cant_retiros,
  fecha_primera = f.fecha_primera,
  fecha_ultima  = f.fecha_ultima,
  updated_at    = NOW()
FROM _cp_fuente f
WHERE f.uname = cp.username_lower
  AND (cp.total_cargas  IS DISTINCT FROM f.total_cargas
    OR cp.total_retiros IS DISTINCT FROM f.total_retiros
    OR cp.cant_cargas   IS DISTINCT FROM f.cant_cargas
    OR cp.cant_retiros  IS DISTINCT FROM f.cant_retiros
    OR cp.fecha_primera IS DISTINCT FROM f.fecha_primera
    OR cp.fecha_ultima  IS DISTINCT FROM f.fecha_ultima);

-- ── 4b. OPCIONAL — alinear agente/platform con el recompute ─────────────────
-- (agente/plataforma de la transacción más reciente). Cambia los filtros por
-- agente del dashboard para jugadores que operan en varias plataformas.
-- Dejar comentado salvo decisión explícita.
-- UPDATE casino_players cp SET
--   agente   = f.agente,
--   platform = COALESCE(f.platform, cp.platform),
--   updated_at = NOW()
-- FROM _cp_fuente f
-- WHERE f.uname = cp.username_lower
--   AND (cp.agente IS DISTINCT FROM f.agente
--     OR cp.platform IS DISTINCT FROM COALESCE(f.platform, cp.platform));

-- ── 5. Verificación (todas deben dar 0) ─────────────────────────────────────
-- 5a. Sin diferencias restantes contra la fuente (las seis columnas del §4)
SELECT COUNT(*) AS diferencias_restantes
FROM casino_players cp
JOIN _cp_fuente f ON f.uname = cp.username_lower
WHERE cp.total_cargas  IS DISTINCT FROM f.total_cargas
   OR cp.total_retiros IS DISTINCT FROM f.total_retiros
   OR cp.cant_cargas   IS DISTINCT FROM f.cant_cargas
   OR cp.cant_retiros  IS DISTINCT FROM f.cant_retiros
   OR cp.fecha_primera IS DISTINCT FROM f.fecha_primera
   OR cp.fecha_ultima  IS DISTINCT FROM f.fecha_ultima;

-- 5b. Ningún jugador agregado ni borrado
SELECT (SELECT COUNT(*) FROM casino_players) - (SELECT COUNT(*) FROM _cp_antes) AS delta_jugadores;

-- 5c. Segmentación intacta
SELECT COUNT(*) AS segmentos_modificados
FROM casino_players cp
JOIN _cp_antes a ON a.id = cp.id
WHERE cp.seg_monto     IS DISTINCT FROM a.seg_monto
   OR cp.seg_actividad IS DISTINCT FROM a.seg_actividad;

-- 5d. Jugadores sin fuente intactos: la fila COMPLETA, incluido updated_at
SELECT COUNT(*) AS sin_fuente_modificados
FROM casino_players cp
JOIN _cp_antes a ON a.id = cp.id
WHERE NOT EXISTS (SELECT 1 FROM _cp_fuente f WHERE f.uname = cp.username_lower)
  AND to_jsonb(cp.*) IS DISTINCT FROM to_jsonb(a.*);

-- 5e. agente/platform intactos (si 4b quedó comentado)
SELECT COUNT(*) AS agente_o_platform_modificados
FROM casino_players cp
JOIN _cp_antes a ON a.id = cp.id
WHERE cp.agente IS DISTINCT FROM a.agente OR cp.platform IS DISTINCT FROM a.platform;

-- 5f. Metadatos intactos en TODOS los jugadores: toda columna que no sea una de
-- las seis reparadas ni updated_at (segmentos, labels, agente, platform, user_id,
-- freq_semanal, dias_desde_ultimo y cualquier columna futura).
SELECT COUNT(*) AS metadatos_modificados
FROM casino_players cp
JOIN _cp_antes a ON a.id = cp.id
WHERE (to_jsonb(cp.*) - ARRAY['total_cargas', 'total_retiros', 'cant_cargas', 'cant_retiros',
                              'fecha_primera', 'fecha_ultima', 'updated_at'])
      IS DISTINCT FROM
      (to_jsonb(a.*)  - ARRAY['total_cargas', 'total_retiros', 'cant_cargas', 'cant_retiros',
                              'fecha_primera', 'fecha_ultima', 'updated_at']);

-- 5g. updated_at solo cambió donde cambiaron datos (el UPDATE no toca filas ya correctas)
SELECT COUNT(*) AS updated_at_sin_cambio_de_datos
FROM casino_players cp
JOIN _cp_antes a ON a.id = cp.id
WHERE cp.updated_at IS DISTINCT FROM a.updated_at
  AND cp.total_cargas  IS NOT DISTINCT FROM a.total_cargas
  AND cp.total_retiros IS NOT DISTINCT FROM a.total_retiros
  AND cp.cant_cargas   IS NOT DISTINCT FROM a.cant_cargas
  AND cp.cant_retiros  IS NOT DISTINCT FROM a.cant_retiros
  AND cp.fecha_primera IS NOT DISTINCT FROM a.fecha_primera
  AND cp.fecha_ultima  IS NOT DISTINCT FROM a.fecha_ultima;

-- Dry-run: nada queda escrito. Reemplazar por COMMIT solo con aprobación.
ROLLBACK;
