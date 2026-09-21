-- 127_casino_players_platform_identity.sql
--
-- Fase 1 del plan de sincronización multi-plataforma (D1/D2/D3, hallazgos H1-H3).
--
-- Por qué: casino_players.username_lower es hoy UNIQUE global (migración 025) y el
-- upsert de los conectores acumulaba en vez de recomputar (ver BaseCasinoConnector,
-- corregido en el mismo cambio que esta migración). Con eso arreglado, la identidad
-- de un jugador pasa a ser (platform, username_lower): el mismo username en Zeus y
-- en Bet30 (o, a futuro, Ganamos/Argenbet) son personas potencialmente distintas y
-- deben ser filas independientes, no una sola fila con los montos sumados.
--
-- Además: total_cargas/total_retiros eran BIGINT (migración 025). ZeusConnector
-- redondeaba a pesos enteros (Math.round(Math.abs(valor))) precisamente porque
-- casino_players no tenía dónde guardar centavos — eso también se corrige en este
-- cambio (ya no redondea). casino_transactions.monto ya es NUMERIC(20,2) desde la
-- migración 126; persistir el agregado en BIGINT volvería a introducir la pérdida
-- de centavos que esa migración resolvió para el detalle. Se amplían aquí a
-- NUMERIC(20,2), igual que casino_transactions.
--
-- casino_segmentation_players y casino_contact_account_links (migración 126) hacen
-- SELECT directo de casino_players.total_cargas/total_retiros, y PostgreSQL prohíbe
-- ALTER COLUMN TYPE mientras haya vistas dependientes ("cannot alter type of a column
-- used by a view or rule"). Se recrean idénticas (mismo texto, mismo
-- security_invoker) después del ALTER — no se edita la migración 126, solo se
-- reproduce su definición para poder recrearla. refresh_player_ltv() (migración 116)
-- no se ve afectada: PL/pgSQL no registra una dependencia de columna sobre el cuerpo
-- de la función, y su aritmética (::numeric ya explícito) sigue siendo válida con el
-- tipo ampliado.
--
-- Backfill de platform: SOLO para agentes no ambiguos (aparecen en una única
-- plataforma dentro de PLATFORM_AGENTS de frontend/lib/casino-agents.ts). 'bigwin' es
-- agente tanto de zeus como de bet30 y queda con platform = NULL a propósito — se
-- lista al final de la migración (RAISE NOTICE) para resolución manual, tal como pide
-- el plan (R6). No hay filas nuevas creadas por este backfill: cada username existente
-- sigue teniendo una única fila (se le asigna o no una plataforma, nunca se duplica),
-- así que el índice único compuesto no puede colisionar con esta migración.
--
-- Dueño de la base: correr esta migración ANTES de desplegar el BaseCasinoConnector
-- actualizado (que ya escribe `platform` en cada insert/recompute). No se aplica ni
-- se ejecuta contra ninguna base desde esta sesión — solo se prepara el SQL.

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '10min';

-- ── 1. Drop vistas dependientes (en orden: la que depende primero) ────────────────
DROP VIEW IF EXISTS casino_contact_account_links;
DROP VIEW IF EXISTS casino_segmentation_players;

-- ── 2. Ampliar montos a NUMERIC(20,2) (D3) ────────────────────────────────────────
ALTER TABLE casino_players
  ALTER COLUMN total_cargas  TYPE numeric(20,2) USING total_cargas::numeric(20,2),
  ALTER COLUMN total_retiros TYPE numeric(20,2) USING total_retiros::numeric(20,2);

-- ── 3. Backfill de platform — SOLO agentes no ambiguos ────────────────────────────
-- Listas copiadas de frontend/lib/casino-agents.ts (PLATFORM_AGENTS). Si un agente
-- aparece en más de una plataforma ahí (hoy: 'bigwin'), NO se incluye en ninguna de
-- las dos listas de abajo y su platform queda NULL.
UPDATE casino_players cp
SET platform = 'zeus'
WHERE cp.platform IS NULL
  AND LOWER(TRIM(cp.agente)) = ANY(ARRAY['ofizeus','betcoin','royal','farabet','lasvegas'])
  AND NOT EXISTS (SELECT 1 FROM casino_players other
    WHERE other.platform = 'zeus' AND other.username_lower = cp.username_lower);

UPDATE casino_players cp
SET platform = 'bet30'
WHERE cp.platform IS NULL
  AND LOWER(TRIM(cp.agente)) = ANY(ARRAY['btcuno','btcdos','zeus','zeusroyal'])
  AND NOT EXISTS (SELECT 1 FROM casino_players other
    WHERE other.platform = 'bet30' AND other.username_lower = cp.username_lower);

-- Agentes de Ganamos ya inequívocos hoy (admbigwin/amdfarabet/adminimperio no
-- son agente de ninguna otra plataforma) — mismos 3 que el backfill de
-- casino_transactions más abajo (3b). Ninguna fila existente de casino_players
-- debería tener estos agente hoy (el conector de Ganamos no existe todavía,
-- fase 3), pero se incluye por completitud/consistencia con 3b y por si algún
-- seed manual los cargó (revisión coordinador, mensaje 7 punto 3).
UPDATE casino_players cp
SET platform = 'ganamos'
WHERE cp.platform IS NULL
  AND LOWER(TRIM(cp.agente)) = ANY(ARRAY['admbigwin','amdfarabet','adminimperio'])
  AND NOT EXISTS (SELECT 1 FROM casino_players other
    WHERE other.platform = 'ganamos' AND other.username_lower = cp.username_lower);

-- Reporte de lo que quedó sin resolver, para que el dueño de la base lo vea al
-- correr la migración (no se adivina — R6).
DO $$
DECLARE
  v_ambiguous RECORD;
  v_total     integer;
BEGIN
  SELECT COUNT(*) INTO v_total FROM casino_players WHERE platform IS NULL;
  RAISE NOTICE 'casino_players con platform NULL tras el backfill: %', v_total;
  FOR v_ambiguous IN
    SELECT COALESCE(TRIM(agente), '(sin agente)') AS agente, COUNT(*) AS n
    FROM casino_players
    WHERE platform IS NULL
    GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '  agente=% -> % jugador(es) sin platform (ambiguo o no mapeado)', v_ambiguous.agente, v_ambiguous.n;
  END LOOP;
END $$;

-- ── 3b. Backfill de platform en casino_transactions — MISMOS agentes no ambiguos ──
--
-- Bloqueante encontrado en revisión: BaseCasinoConnector.recomputePlayers() (este
-- mismo cambio) agrega SIEMPRE `WHERE platform = $1`. Si solo se backfillea
-- casino_players y las transacciones históricas quedan con platform IS NULL para
-- siempre, el PRIMER recompute posterior al deploy (para un agente no ambiguo,
-- p.ej. 'betcoin') solo vería las transacciones nuevas insertadas después de esta
-- migración — todo el historial previo desaparecería de casino_players.total_cargas.
-- Por eso casino_transactions necesita el mismo backfill, con las mismas listas
-- (incluye los 3 agentes de Ganamos que ya son inequívocos hoy —admbigwin,
-- amdfarabet, adminimperio— por si algún import los dejó con platform NULL).
--
-- Conservador a propósito:
--   - Nunca toca una fila que YA tiene platform (no reasigna, no hay "corregir").
--   - Antes de escribir, verifica que no exista otra fila con el MISMO
--     (platform destino, id_rec) — eso solo podría pasar si esta migración se
--     re-ejecuta después de que el conector ya sincronizó esa plataforma. Si
--     existiera un choque real (mismo id_rec, platform distinto, datos
--     DISTINTOS), la fila se excluye del backfill y queda reportada como
--     pendiente en vez de sobreescribirse a ciegas.
--   - Idempotente: correrla dos veces no cambia nada la segunda vez (todas las
--     filas backfilleadas ya tienen platform IS NOT NULL).
WITH backfillable AS (
  SELECT
    id, id_rec, fecha, username, tipo, monto, agente,
    CASE
      WHEN LOWER(TRIM(agente)) = ANY(ARRAY['ofizeus','betcoin','royal','farabet','lasvegas']) THEN 'zeus'
      WHEN LOWER(TRIM(agente)) = ANY(ARRAY['btcuno','btcdos','zeus','zeusroyal'])              THEN 'bet30'
      WHEN LOWER(TRIM(agente)) = ANY(ARRAY['admbigwin','amdfarabet','adminimperio'])            THEN 'ganamos'
      ELSE NULL
    END AS resolved_platform
  FROM casino_transactions
  WHERE platform IS NULL
),
safe_to_backfill AS (
  SELECT b.id, b.resolved_platform
  FROM backfillable b
  WHERE b.resolved_platform IS NOT NULL
    -- Dos filas legacy pueden diferir sólo en mayúsculas del username. Ambas
    -- pasan el chequeo contra filas ya clasificadas, pero colisionarían entre
    -- sí al actualizar juntas. Conservar AMBAS sin clasificar para revisión:
    -- no elegir un ganador ni descartar una transacción legítima sin ID.
    AND NOT EXISTS (
      SELECT 1 FROM backfillable peer
      WHERE b.id_rec IS NULL AND peer.id_rec IS NULL AND peer.id <> b.id
        AND peer.resolved_platform = b.resolved_platform
        AND peer.fecha = b.fecha AND LOWER(peer.username) = LOWER(b.username)
        AND peer.tipo = b.tipo AND peer.monto = b.monto AND peer.agente = b.agente
    )
    AND NOT EXISTS (
      -- Ya existe una fila de la plataforma destino con el mismo id_rec: no
      -- pisar nada, dejar que el reporte de abajo lo muestre.
      SELECT 1 FROM casino_transactions other
      WHERE b.id_rec IS NOT NULL
        AND other.platform = b.resolved_platform
        AND other.id_rec   = b.id_rec
    )
    -- Mismo chequeo para filas SIN id_rec (dedup legacy, migración 028): al
    -- backfillear pasan de estar cubiertas por idx_casino_transactions_legacy_dedup
    -- (fecha,username,tipo,monto,agente — username case-SENSITIVE, platform IS NULL)
    -- a idx_casino_transactions_platform_dedup (platform,fecha,lower(username),
    -- tipo,monto,agente — migración 126). Sin este chequeo, un choque real
    -- abortaría la migración entera con un error de constraint a mitad de
    -- camino (BEGIN/COMMIT ya lo hace atómico, pero es mejor excluir y
    -- reportar que dejar que el UPDATE falle en seco).
    AND NOT EXISTS (
      SELECT 1 FROM casino_transactions other
      WHERE b.id_rec IS NULL
        AND other.id_rec IS NULL
        AND other.platform = b.resolved_platform
        AND other.fecha    = b.fecha
        AND LOWER(other.username) = LOWER(b.username)
        AND other.tipo      = b.tipo
        AND other.monto     = b.monto
        AND other.agente    = b.agente
    )
)
UPDATE casino_transactions ct
SET platform = s.resolved_platform
FROM safe_to_backfill s
WHERE ct.id = s.id;

DO $$
DECLARE
  v_tx_ambiguous RECORD;
  v_tx_total     integer;
BEGIN
  SELECT COUNT(*) INTO v_tx_total FROM casino_transactions WHERE platform IS NULL;
  RAISE NOTICE 'casino_transactions con platform NULL tras el backfill: %', v_tx_total;
  FOR v_tx_ambiguous IN
    SELECT COALESCE(TRIM(agente), '(sin agente)') AS agente, COUNT(*) AS n
    FROM casino_transactions
    WHERE platform IS NULL
    GROUP BY 1 ORDER BY 2 DESC
    LIMIT 50
  LOOP
    RAISE NOTICE '  agente=% -> % transaccion(es) sin platform (ambiguo, no mapeado, o choque de id_rec evitado)', v_tx_ambiguous.agente, v_tx_ambiguous.n;
  END LOOP;
END $$;

-- ── 4. Clave de identidad = (platform, username_lower) — D2 ──────────────────────
DROP INDEX IF EXISTS idx_casino_players_username_lower;
CREATE UNIQUE INDEX IF NOT EXISTS idx_casino_players_platform_username
  ON casino_players (platform, username_lower);

COMMENT ON INDEX idx_casino_players_platform_username IS
  'Identidad de jugador = (platform, username_lower) (D2, plan sync 4 plataformas). '
  'Reemplaza el único global de la migración 025: el mismo username en dos '
  'plataformas es un jugador distinto por plataforma, no una fila con montos '
  'sumados. Filas con platform NULL (backfill ambiguo, ver RAISE NOTICE arriba) '
  'no colisionan entre sí porque PostgreSQL trata cada NULL como distinto.';

-- Defensivo (revisión del coordinador): con el único global reemplazado por uno
-- compuesto, nada impide que un script legacy no actualizado (p.ej.
-- scripts/cargar-casino-players.js, ver runbook) inserte una fila NUEVA con
-- platform NULL para un username que ya tiene una fila NULL — el índice
-- compuesto la aceptaría porque Postgres trata cada NULL como distinto. Este
-- índice parcial cierra esa puerta: como máximo una fila NULL por username,
-- igual que garantizaba el único global de la migración 025 para TODAS las
-- filas antes de esta migración.
CREATE UNIQUE INDEX IF NOT EXISTS idx_casino_players_null_platform_username
  ON casino_players (username_lower)
  WHERE platform IS NULL;

-- ── 5. Recrear vistas dependientes — con un ajuste funcional necesario ───────────
--
-- casino_segmentation_players (migración 126) tenía `WHERE source_id IS NOT NULL`
-- en su CTE `imported`, es decir: solo agregaba transacciones cargadas por el
-- importador de Excel. Fuera de eso, los jugadores de Zeus/Bet30 aparecían por la
-- rama `UNION ALL ... FROM casino_players cp`, que hasta esta migración era la
-- única fuente confiable para ellos (el conector nunca escribía `platform`, ver
-- cabecera de esta migración). Con `platform` ahora poblado en casino_transactions
-- (BaseCasinoConnector.insertTransactions, este mismo cambio) y en casino_players
-- (BaseCasinoConnector.recomputePlayers), la exclusión por `source_id` se vuelve un
-- riesgo real: un jugador con ALGO de historial importado por Excel y ALGO
-- sincronizado en vivo (escenario esperado para Ganamos/Argenbet en fase 2/3, que
-- usan el importador de Excel como fallback histórico) perdería silenciosamente la
-- porción sincronizada por API, porque `imported` nunca la vería.
--
-- Fix: `imported` agrega TODA transacción con `platform` (venga de Excel o de la
-- API), agrupando por (platform, username) — igual que
-- BaseCasinoConnector.recomputePlayers, D1/D2 aplicados también en la capa de
-- lectura. La rama `cp` sigue existiendo para filas legacy con `platform IS NULL`.
-- El id se mantiene con el prefijo `'excel:'` a propósito: scripts/segmentar-
-- casino-players.js (`--imported-only`) lo usa tal cual para su optimización
-- incremental — no se toca ese script en esta fase (fuera de alcance, no es un
-- consumidor de identidad, es un ORDER/GROUP key ya usado en producción) y
-- renombrarlo aquí lo rompería sin necesidad.

CREATE OR REPLACE VIEW casino_segmentation_players WITH (security_invoker = true) AS
WITH imported AS (
  SELECT md5('excel:' || platform || ':' || lower(username))::uuid AS id,
    lower(username)::varchar(100) AS username_lower, platform,
    (array_agg(agente ORDER BY COALESCE(fecha_hora_utc, fecha::timestamptz) DESC, id DESC))[1] AS agente,
    coalesce(sum(monto) FILTER (WHERE tipo='carga'),0) AS total_cargas,
    coalesce(sum(monto) FILTER (WHERE tipo='retiro'),0) AS total_retiros,
    count(*) FILTER (WHERE tipo='carga')::integer AS cant_cargas,
    count(*) FILTER (WHERE tipo='retiro')::integer AS cant_retiros,
    min(fecha) FILTER (WHERE tipo='carga') AS fecha_primera,
    max(fecha) FILTER (WHERE tipo='carga') AS fecha_ultima,
    count(DISTINCT date_trunc('month',fecha)) FILTER (WHERE tipo='carga') AS meses_activos
  FROM casino_transactions WHERE platform IS NOT NULL AND username <> agente
  GROUP BY platform,lower(username)
), scored AS (
  SELECT *, total_cargas/greatest(meses_activos,1) AS promedio,
    cant_cargas/greatest((current_date-fecha_primera)::numeric/7,1) AS frecuencia
  FROM imported
)
SELECT id,username_lower,platform,agente,total_cargas,total_retiros,cant_cargas,cant_retiros,
  fecha_primera,fecha_ultima,
  CASE WHEN promedio>=3200000 THEN 'super_vip' WHEN promedio>=1500000 THEN 'vip_alto'
    WHEN promedio>=1000000 THEN 'vip_medio' WHEN promedio>=500000 THEN 'vip'
    WHEN promedio>=100000 THEN 'medio' ELSE 'bajo' END AS seg_monto,
  CASE WHEN fecha_ultima IS NULL OR current_date-fecha_ultima>180 THEN 'perdido'
    WHEN current_date-fecha_ultima>60 THEN 'inactivo' WHEN current_date-fecha_ultima>30 THEN 'en_riesgo'
    WHEN current_date-fecha_primera<=30 THEN 'nuevo' WHEN frecuencia>=3 THEN 'frecuente'
    WHEN frecuencia>=1 THEN 'regular' ELSE 'ocasional' END AS seg_actividad
FROM scored
UNION ALL
SELECT cp.id,cp.username_lower,cp.platform,cp.agente,cp.total_cargas,cp.total_retiros,
  cp.cant_cargas,cp.cant_retiros,cp.fecha_primera,cp.fecha_ultima,cp.seg_monto,cp.seg_actividad
FROM casino_players cp
WHERE NOT EXISTS (SELECT 1 FROM imported i WHERE i.username_lower=cp.username_lower
  AND (i.platform=cp.platform OR (cp.platform IS NULL AND lower(trim(cp.agente))=i.agente)));

-- Corrección aplicada al recrear esta vista (no se edita la 126): 'adminimperio'
-- e 'imperio' mapeaban a 'bigwin', pero según casino-agents.ts (PLATFORM_AGENTS /
-- AGENT_TO_CANONICAL, plan §8.2) 'imperio' es su PROPIO operador canónico, no un
-- alias de 'bigwin' — confundirlos habría linkeado contactos de un operador al
-- panel equivocado. Revisión del coordinador, 2026-09-21.
CREATE OR REPLACE VIEW casino_contact_account_links WITH (security_invoker = true) AS
WITH players AS MATERIALIZED (SELECT *, count(*) OVER (PARTITION BY username_lower) AS name_count,
 CASE lower(trim(agente))
 WHEN 'adminroyal' THEN 'royal' WHEN 'adminfara' THEN 'farabet' WHEN 'adminbtc' THEN 'betcoin'
 WHEN 'adminzeus' THEN 'ofizeus' WHEN 'admbigwin' THEN 'bigwin' WHEN 'adminbigwin' THEN 'bigwin'
 WHEN 'adminimperio' THEN 'imperio' WHEN 'imperio' THEN 'imperio' WHEN 'amdfarabet' THEN 'farabet'
 WHEN 'btcuno' THEN 'betcoin' WHEN 'btcdos' THEN 'farabet' WHEN 'zeus' THEN 'ofizeus'
 WHEN 'zeusroyal' THEN 'royal' ELSE lower(trim(agente)) END AS panel FROM casino_segmentation_players),
unique_panels AS (
 SELECT username_lower,panel,min(id::text)::uuid AS player_id FROM (
   SELECT username_lower,panel,id FROM players
   UNION SELECT username_lower,lower(trim(agente)),id FROM players
 ) names GROUP BY username_lower,panel HAVING count(DISTINCT id)=1
),
tokens AS (
 SELECT c.id, lower(tok) AS username FROM contacts c
 CROSS JOIN LATERAL regexp_split_to_table(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,''),'[^a-zA-Z0-9_]+') tok
 WHERE c.deleted_at IS NULL AND length(tok)>=4
), explicit AS MATERIALIZED (
 SELECT c.id, lower(trim(a->>'username')) AS username, a->>'platform' AS platform, lower(a->>'panel') AS panel
 FROM contacts c CROSS JOIN LATERAL jsonb_array_elements(c.casino_accounts) a
 WHERE c.deleted_at IS NULL
)
SELECT e.id AS contact_id,p.id AS player_id,p.username_lower,p.platform
FROM explicit e JOIN players p ON p.username_lower=e.username AND p.platform=e.platform
UNION
SELECT e.id,p.id,p.username_lower,p.platform FROM explicit e
JOIN unique_panels up ON up.username_lower=e.username AND up.panel=e.panel
JOIN players p ON p.id=up.player_id WHERE e.platform IS NULL
UNION
SELECT e.id,p.id,p.username_lower,p.platform FROM explicit e
JOIN players p ON p.username_lower=e.username AND p.name_count=1
WHERE e.platform IS NULL AND e.panel IS NULL
UNION
SELECT t.id,p.id,p.username_lower,p.platform
FROM tokens t JOIN players p ON p.username_lower=t.username AND p.name_count=1
LEFT JOIN explicit e ON e.id=t.id AND e.username=t.username
WHERE e.id IS NULL
 AND t.username NOT IN ('farabet','betcoin','bigwin','royal','ofizeus','zeus','zeusroyal','btcuno','btcdos','adminbet','surmar','lemon','apolo','horus','peaky','soporte','reclamos','linea','admin','mismo','usuario','titular','carga','mucho');

-- ── 6. refresh_player_ltv() — PARTITION BY platform TAMBIÉN, no solo agente ──────
--
-- Bloqueante encontrado en revisión: la función de la migración 116 calcula el
-- percentil de LTV con `PARTITION BY COALESCE(cp.agente, 'sin_agente')`. Sin
-- platform en la clave de partición, 'bigwin' (agente de zeus Y bet30) mezclaba
-- los NGR de dos plataformas distintas en un solo percentil — y lo mismo pasará
-- con 'adminbtc'/'adminzeus'/'adminroyal' en cuanto Ganamos/Argenbet tengan datos
-- (mismo nombre de agente, negocio potencialmente distinto). Esto NO edita la
-- migración 116 — CREATE OR REPLACE FUNCTION sobre la misma función, mismo
-- nombre/firma, coherente con cómo Postgres versiona funciones entre
-- migraciones. El cuerpo es una copia fiel del original salvo la línea de
-- PARTITION BY (y COALESCE(cp.platform,'sin_platform') para no perder las filas
-- con platform NULL fuera de cualquier percentil).
--
-- mv_player_ltv (116) no se ve afectada: no llama a esta función ni depende de
-- su definición, solo lee la tabla player_ltv que la función escribe.
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
      -- Percentil por (platform, agente) — antes solo agente, mezclaba
      -- plataformas cuando el nombre de agente se repite (bigwin, adminbtc...).
      PERCENT_RANK() OVER (
        PARTITION BY COALESCE(cp.platform, 'sin_platform'), COALESCE(cp.agente, 'sin_agente')
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
  'Recalcula LTV para todos los jugadores (o uno si p_player_id != NULL). Idempotente. '
  'PARTITION BY (platform, agente) desde la migración 127 (antes solo agente — '
  'mezclaba plataformas con nombres de agente compartidos). Usar via POST /api/contacts/recompute-ltv.';

COMMIT;
