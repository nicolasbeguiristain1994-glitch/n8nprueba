ALTER TABLE warmup_numbers
  ADD COLUMN IF NOT EXISTS delay_preset VARCHAR(20) DEFAULT 'normal';
