-- Source: 20261104115742_campaign_broadcast_plan.sql (Supabase CLI); numbered for the verified catalog.
-- Immutable plan settings are populated by the server after live revalidation.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.campaigns ADD COLUMN broadcast_plan jsonb;
ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_broadcast_plan_object CHECK (broadcast_plan IS NULL OR jsonb_typeof(broadcast_plan)='object');
COMMENT ON COLUMN public.campaigns.broadcast_plan IS 'Reviewed diffusion window and recipient senders; server-only creation, unchanged by campaign edits.';
ALTER TABLE public.campaigns DROP CONSTRAINT campaigns_pause_reason_check;
ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_pause_reason_check CHECK (pause_reason IN (
 'manual','no_eligible_lines','all_lines_outside_schedule','systemic_error','config_missing',
 'frequency_exhausted','unknown','assigned_line_unavailable','risk_detected','line_budget','broadcast_plan_review'
));
