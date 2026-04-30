-- 030_cleanup_ghost_agent_players.sql
--
-- Limpieza puntual de filas fantasma generadas por ingestión histórica de
-- "Carga/Retiro indirecto" (transferencias de capital entre agentes).
--
-- El script sync-casino-players-live.js (anterior al fix en commits recientes)
-- procesaba filas cuyo detalles contenía "indirecto" y hacía upsert en
-- casino_players con username=agente — registrando al agente como si fuera
-- un jugador propio.
--
-- ALCANCE ESTRICTO:
--   - Solo borra filas donde la cuenta de agente coincide con el username.
--   - Solo actúa sobre los 5 agentes permitidos en el sistema.
--   - No toca ningún jugador legítimo.
--
-- PRECONDICIÓN verificada: correr las queries de verificación (sección V) antes de
-- ejecutar los DELETEs en producción para confirmar los row counts esperados.

-- ─── V: Verificación previa (ejecutar antes del DELETE) ─────────────────────
-- Muestra exactamente qué filas se van a eliminar.
-- Resultado esperado: ≤ 5 filas (una por agente contaminado).
--
-- SELECT id, username, agente, total_cargas, total_retiros, cant_cargas, updated_at
-- FROM   casino_players
-- WHERE  username_lower = LOWER(agente)
--   AND  agente = ANY('{bigwin,ofizeus,betcoin,royal,farabet}'::text[])
-- ORDER BY agente;
--
-- Para casino_transactions (filas indirecto ya almacenadas):
-- SELECT agente, COUNT(*) AS filas, SUM(monto) AS monto_total
-- FROM   casino_transactions
-- WHERE  LOWER(username) = LOWER(agente)
--   AND  agente = ANY('{bigwin,ofizeus,betcoin,royal,farabet}'::text[])
-- GROUP BY agente
-- ORDER BY agente;

-- ─── Cleanup 1: casino_players — filas fantasma agente-como-jugador ─────────

DELETE FROM casino_players
WHERE  username_lower = LOWER(agente)
  AND  agente = ANY('{bigwin,ofizeus,betcoin,royal,farabet}'::text[]);

-- ─── Cleanup 2: casino_transactions — filas "indirecto" ya almacenadas ──────
-- Estas filas representan transferencias de capital (Carga/Retiro indirecto)
-- donde username = agente. Ya están excluidas a nivel de consulta por el
-- filtro `ct.username != ct.agente` en players/route.ts, pero se borran
-- aquí para que la tabla sea consistente y los exports directos sean exactos.

DELETE FROM casino_transactions
WHERE  LOWER(username) = LOWER(agente)
  AND  agente = ANY('{bigwin,ofizeus,betcoin,royal,farabet}'::text[]);
