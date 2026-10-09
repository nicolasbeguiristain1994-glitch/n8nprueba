-- migrate: nontransactional
-- Seek to each agent's last Argentina calendar date without scanning all history.
-- Concurrent creation preserves production reads and writes; no rows are changed.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_casino_latest_movement
  ON public.casino_transactions (platform, agente,
    (COALESCE((fecha_hora_utc AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, fecha)) DESC NULLS LAST)
  WHERE platform IS NOT NULL;
