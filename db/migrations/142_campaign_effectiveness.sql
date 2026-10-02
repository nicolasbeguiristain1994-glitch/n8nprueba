-- migrate: nontransactional
-- Account + time/date access for
-- campaign attribution, including honest reporting of historical date-only rows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_casino_campaign_deposits_time
  ON public.casino_transactions (platform, lower(username), fecha_hora_utc)
  WHERE tipo='carga' AND monto>0 AND fecha_hora_utc IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_casino_campaign_deposits_date
  ON public.casino_transactions (platform, lower(username), fecha)
  WHERE tipo='carga' AND monto>0 AND fecha_hora_utc IS NULL;
