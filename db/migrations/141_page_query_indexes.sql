-- Run outside a transaction: CONCURRENTLY keeps production reads/writes available.
-- Reversible with DROP INDEX CONCURRENTLY; no business data is changed.
-- Latest import dates group by platform/agent and need both timestamped and
-- date-only records. Cover the aggregate without reading the entire cash ledger.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_casino_history_scope_cover
  ON public.casino_transactions (platform, agente) INCLUDE (fecha_hora_utc, fecha)
  WHERE platform IS NOT NULL;

-- Inbox joins normalize optional '+' prefixes; the plain phone index cannot
-- serve that expression and previously scanned all contacts for each refresh.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_inbox_phone
  ON public.contacts ((REPLACE(phone_number, '+', '')));
