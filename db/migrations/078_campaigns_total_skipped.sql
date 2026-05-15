-- Migration 077: Add total_skipped column to campaigns
--
-- total_skipped tracks contacts blocked by the frequency engine (BLOCK decision).
-- These recipients are marked 'skipped' in campaign_recipients and counted here
-- by syncCounters() in the campaign distributor.
--
-- Idempotent: safe to run multiple times.

BEGIN;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS total_skipped INTEGER NOT NULL DEFAULT 0;

COMMIT;
