-- Migration 043: personality_config column for WhatsApp lines
--
-- Adds the JSONB column that the line-personality.ts module reads/writes
-- to persist behavioral profiles across process restarts.
--
-- Why this exists:
--   line-personality.ts maintains a per-line behavioral profile in memory
--   (activeHours, aggressiveness, burstiness, lastActiveAt, etc.).
--   Without this column, every process restart resets all lines to the
--   'normal' profile with lastActiveAt = now(), discarding accumulated
--   inertia state and per-line jitter values.
--
-- What gets stored:
--   Serialized output of savePersonalityToDB(lineId):
--   {
--     "activeHours":          [8.7, 21.3],   -- jittered at creation time
--     "aggressiveness":       1.04,
--     "burstiness":           0.21,
--     "preferredDelayPreset": "normal",
--     "sleepProbability":     0.20,
--     "lastActiveAt":         "2026-05-02T14:30:00.000Z",
--     "profileType":          "normal",
--     "timezoneOffsetHours":  -3
--   }
--
-- Additive: ADD COLUMN IF NOT EXISTS — safe to run with live traffic.
-- Idempotent: running this migration twice has no effect.

ALTER TABLE whatsapp_lines
  ADD COLUMN IF NOT EXISTS personality_config JSONB;

COMMENT ON COLUMN whatsapp_lines.personality_config IS
  'Serialized LinePersonality from line-personality.ts.
   Written by savePersonalityToDB() during campaign heartbeat (every 50 sends).
   Read by loadPersonalityFromDB() when a campaign processor starts.
   NULL = no profile saved yet; system falls back to default normal profile.';
