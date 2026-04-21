-- Migration 008b: Add gaming_type enum and panel/gaming columns to contacts
-- These were added directly to production outside the migration system.
-- This migration is idempotent: safe to run on production (already has these)
-- and required on fresh DBs (staging) so that 009_performance_indexes can run.

-- Create gaming_type enum if it doesn't already exist
DO $$ BEGIN
  CREATE TYPE gaming_type AS ENUM ('slots', 'deportivas', 'ambas');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add columns only if they don't exist (no-op on production)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS panel  VARCHAR(100);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS gaming gaming_type;
