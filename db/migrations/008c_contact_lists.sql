-- Migration 008c: Add contact_lists and contact_list_members tables
-- These were added directly to production outside the migration system.
-- Idempotent: safe to run on production (IF NOT EXISTS guards).

CREATE TABLE IF NOT EXISTS contact_lists (
  id            UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  description   TEXT,
  filters       JSONB        DEFAULT '{}',
  contact_count INT          DEFAULT 0,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contact_list_members (
  list_id    UUID        NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
  contact_id UUID        NOT NULL REFERENCES contacts(id)       ON DELETE CASCADE,
  added_at   TIMESTAMPTZ DEFAULT NOW()
);
