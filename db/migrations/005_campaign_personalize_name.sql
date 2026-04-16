-- Add personalize_name flag to campaigns
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS personalize_name BOOLEAN NOT NULL DEFAULT true;
