-- 074_add_indexes_casino_performance.sql
--
-- Índices de rendimiento para las tablas casino_players y casino_transactions.
--
-- Contexto:
--   Los índices existentes (migraciones 025-031) cubren bien los upserts y los
--   filtros simples por agente y fecha. Con la incorporación de Bet30 al sistema,
--   el volumen de transacciones creció y emergieron tres patrones de acceso que
--   quedaban sin soporte eficiente:
--
--   1. Historial de un jugador filtrado por rango de fechas (dashboard / reportes)
--   2. Targeting de campañas: "jugadores inactivos del agente X" (caso de uso
--      central de casino_players)
--   3. Ordenamiento y filtro por última actividad (análisis de churn)
--
-- Criterio de diseño: prudente sobre agresivo.
--   - Solo 3 adiciones + 1 eliminación (el índice de una columna que queda redundante).
--   - Se prefieren índices parciales (WHERE) para excluir filas que nunca
--     aparecen en los queries relevantes, reduciendo tamaño y costo de escritura.

BEGIN;

-- ── 1. casino_transactions: historial de jugador con filtro de fecha ──────────
--
-- Problema: idx_casino_transactions_username (username) cubre "dame todo de X"
-- pero para queries con rango de fecha el planner lee todas las filas del jugador
-- y aplica el filtro en memoria (segundo scan).
--
-- Solución: (username, fecha) permite que el planner delimite el rango de fecha
-- directamente en el índice. Cubre todos los patrones:
--   - WHERE username = ?                      (prefix match — igual que antes)
--   - WHERE username = ? AND fecha = ?
--   - WHERE username = ? AND fecha BETWEEN ? AND ?
--   - WHERE username = ? ORDER BY fecha DESC   (sin sort adicional)
--
-- El índice de una sola columna queda completamente redundante → se elimina
-- para no pagar el costo de escritura dos veces.

DROP INDEX IF EXISTS idx_casino_transactions_username;

CREATE INDEX IF NOT EXISTS idx_casino_transactions_username_fecha
  ON casino_transactions (username, fecha);

-- ── 2. casino_players: targeting por agente + segmento de actividad ───────────
--
-- Problema: el uso central de casino_players es identificar jugadores por
-- segmento dentro de un agente específico — e.g. "todos los inactivos del agente
-- betcoin" — para enviar campañas de WhatsApp.
-- Con los índices separados (idx_casino_players_agente, idx_casino_players_seg_actividad)
-- el planner elige uno y filtra el otro recorriendo las filas resultantes.
-- Un índice compuesto elimina esa segunda pasada y soporta directamente el JOIN
-- implícito de ambas condiciones.
--
-- WHERE partial: excluye filas sin agente o sin segmento (jugadores importados
-- antes de que el campo existiera o sin transacciones suficientes para segmentar).
-- Son filas que nunca aparecen en queries de targeting, así que no deben ocupar
-- espacio en el índice.

CREATE INDEX IF NOT EXISTS idx_casino_players_agente_seg
  ON casino_players (agente, seg_actividad)
  WHERE agente IS NOT NULL AND seg_actividad IS NOT NULL;

-- ── 3. casino_players: recencia de última actividad ───────────────────────────
--
-- Problema: fecha_ultima es la base de dias_desde_ultimo y del cálculo de
-- seg_actividad. Queries de análisis de churn como "jugadores sin actividad
-- desde fecha X" o listados ordenados por última actividad no tienen soporte
-- eficiente hoy (seq scan sobre toda la tabla).
--
-- WHERE partial: ignora filas con fecha_ultima NULL, que son jugadores sin
-- ninguna transacción registrada (estado inicial antes del primer sync).

CREATE INDEX IF NOT EXISTS idx_casino_players_fecha_ultima
  ON casino_players (fecha_ultima)
  WHERE fecha_ultima IS NOT NULL;

COMMIT;

-- ── Nota sobre columna platform ───────────────────────────────────────────────
-- Actualmente Zeus y Bet30 se diferencian implícitamente por nombre de agente
-- (con mapeo canónico en casino-agents.ts). No existe columna platform en la DB.
-- Si en el futuro se agrega una columna platform a casino_transactions y/o
-- casino_players para filtros explícitos por plataforma, agregar:
--   CREATE INDEX idx_casino_transactions_platform_fecha ON casino_transactions (platform, fecha);
--   CREATE INDEX idx_casino_players_platform_agente     ON casino_players (platform, agente);
