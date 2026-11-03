-- Preserve the existing number presentation until an administrator changes it.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.crm_agents ADD COLUMN phone_format text NOT NULL DEFAULT 'separated'
  CHECK (phone_format IN ('separated','plain'));
-- Existing RLS, Data API revocations and stored E.164 phone numbers are unchanged.
