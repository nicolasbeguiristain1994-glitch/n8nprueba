-- ============================================================
-- 125_backfill_platform_inequivocos.sql — MANUAL Y REVISABLE
-- ============================================================
-- NO se ejecuta automáticamente y termina en ROLLBACK a propósito.
-- Requiere la migración 125 aplicada y la salida del preflight
-- (db/manual/125_preflight_readonly.sql §3 y §6) revisada y aprobada.
--
-- Asigna plataforma SOLO a filas históricas de agentes que existen en una única
-- plataforma. Mapeo tomado de frontend/lib/casino-agents.ts y
-- scripts/pipeline-diario.js:
--
--   Zeus  : betcoin, ofizeus, royal, farabet, lasvegas
--   Bet30 : btcuno, btcdos, zeus, zeusroyal
--
-- NO toca:
--   - bigwin (existe en Zeus y en Bet30): resolución manual, fila por fila o
--     por criterio documentado y aprobado. Mientras tenga filas NULL, el runner
--     falla con LEGACY_UNCLASSIFIED para zeus/bigwin y bet30/bigwin en los rangos
--     afectados.
--   - agentes SIN_MAPEO del preflight.
--
-- Advertencia: el agente 'zeus' es de Bet30. Si el preflight muestra filas con
-- agente 'zeus' anteriores a la integración de Bet30, revisarlas antes de correr
-- esto (podrían venir de un seed viejo con otra semántica).
-- ============================================================

BEGIN;

-- Conteo previo (debe coincidir con el preflight §3)
SELECT LOWER(agente) AS agente, COUNT(*) AS filas_null
FROM casino_transactions
WHERE platform IS NULL
GROUP BY LOWER(agente)
ORDER BY 1;

UPDATE casino_transactions
SET platform = 'zeus'
WHERE platform IS NULL
  AND LOWER(agente) IN ('betcoin', 'ofizeus', 'royal', 'farabet', 'lasvegas');

UPDATE casino_transactions
SET platform = 'bet30'
WHERE platform IS NULL
  AND LOWER(agente) IN ('btcuno', 'btcdos', 'zeus', 'zeusroyal');

-- Verificación: lo que queda sin clasificar (debería ser bigwin + SIN_MAPEO)
SELECT LOWER(agente) AS agente, COALESCE(platform, '(NULL)') AS platform, COUNT(*) AS filas
FROM casino_transactions
GROUP BY LOWER(agente), platform
ORDER BY 1, 2;

-- Si los números coinciden con lo aprobado, reemplazar ROLLBACK por COMMIT.
-- Si algún UPDATE falló por idx_casino_transactions_platform_dedup, hay filas
-- sin ID que difieren solo en mayúsculas (preflight §6): resolver antes.
ROLLBACK;
