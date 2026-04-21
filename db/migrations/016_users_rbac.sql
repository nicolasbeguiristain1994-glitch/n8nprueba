-- Migration 016: Users table and RBAC
-- Idempotent: safe to run multiple times

-- role type
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'operator', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- users table
CREATE TABLE IF NOT EXISTS users (
  id               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email            TEXT        NOT NULL,
  password_hash    TEXT        NOT NULL,
  name             TEXT,
  role             user_role   NOT NULL DEFAULT 'viewer',
  sectors          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  session_version  INTEGER     NOT NULL DEFAULT 1,
  last_login_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_sectors_is_array CHECK (jsonb_typeof(sectors) = 'array')
);

-- unique email (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));

-- role index
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

-- active users index
CREATE INDEX IF NOT EXISTS idx_users_active ON users (id) WHERE is_active = true;

-- GIN index for sector queries
CREATE INDEX IF NOT EXISTS idx_users_sectors ON users USING gin (sectors);
