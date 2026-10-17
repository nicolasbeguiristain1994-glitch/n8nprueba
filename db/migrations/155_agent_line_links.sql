-- Additive migration: existing agents continue sharing their phone numbers.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.crm_agents ADD COLUMN delivery_mode text NOT NULL DEFAULT 'phone'
  CHECK (delivery_mode IN ('phone','link'));
ALTER TABLE public.agent_contact_lines ADD COLUMN link_url text
  CHECK (link_url IS NULL OR (length(link_url) BETWEEN 1 AND 2048 AND link_url ~* '^https?://[^[:space:]]+$'));
ALTER TABLE public.agent_contact_lines ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE public.agent_contact_lines ADD CONSTRAINT agent_line_destination_required
  CHECK (phone IS NOT NULL OR link_url IS NOT NULL);
-- Existing RLS and revoked Data API grants remain in force.
