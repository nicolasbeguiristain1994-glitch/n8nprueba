-- Phase 4: Anti-ban configuration fields
-- Backend warmup engine reads these to control sending behavior

ALTER TABLE warmup_numbers
  ADD COLUMN IF NOT EXISTS delay_min_seconds     INTEGER     DEFAULT 45,
  ADD COLUMN IF NOT EXISTS delay_max_seconds     INTEGER     DEFAULT 180,
  ADD COLUMN IF NOT EXISTS sending_window_start  TIME        DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS sending_window_end    TIME        DEFAULT '22:00',
  ADD COLUMN IF NOT EXISTS active_days           INTEGER[]   DEFAULT '{1,2,3,4,5,6,7}',
  ADD COLUMN IF NOT EXISTS anti_ban_enabled      BOOLEAN     DEFAULT false,
  ADD COLUMN IF NOT EXISTS randomness_level      VARCHAR(10) DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS natural_distribution  BOOLEAN     DEFAULT false;

COMMENT ON COLUMN warmup_numbers.delay_min_seconds    IS 'Minimum seconds between messages (anti-ban)';
COMMENT ON COLUMN warmup_numbers.delay_max_seconds    IS 'Maximum seconds between messages (anti-ban)';
COMMENT ON COLUMN warmup_numbers.sending_window_start IS 'Earliest allowed send time (local timezone)';
COMMENT ON COLUMN warmup_numbers.sending_window_end   IS 'Latest allowed send time (local timezone)';
COMMENT ON COLUMN warmup_numbers.active_days          IS '1=Mon … 7=Sun, days on which warmup runs';
COMMENT ON COLUMN warmup_numbers.anti_ban_enabled     IS 'Enable advanced anti-ban protection mode';
COMMENT ON COLUMN warmup_numbers.randomness_level     IS 'low | medium | high — delay variance factor';
COMMENT ON COLUMN warmup_numbers.natural_distribution IS 'Simulate natural human sending distribution';
