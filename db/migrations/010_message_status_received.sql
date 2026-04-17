-- Migration 010: Add 'received' to message_status enum
-- Purpose: webhook/evolution/route.ts inserts inbound messages with status='received'.
--          The baseline enum (init.sql) does not include this value; if the enum is
--          enforced in production, every inbound insert fails silently.
-- Safe: ADD VALUE IF NOT EXISTS is idempotent.

ALTER TYPE message_status ADD VALUE IF NOT EXISTS 'received';
