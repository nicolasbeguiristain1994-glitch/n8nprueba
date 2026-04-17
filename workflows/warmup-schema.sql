-- ============================================================
-- WARMUP SCHEMA — Módulo de calentamiento de líneas WhatsApp
-- Ejecutar en Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS warmup_numbers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone_number VARCHAR(20) NOT NULL UNIQUE,
  instance_name VARCHAR(100) NOT NULL,
  warmup_status VARCHAR(20) DEFAULT 'active',  -- active | paused | completed | banned
  current_day INT DEFAULT 1,
  start_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  target_days INT DEFAULT 14,
  messages_sent_today INT DEFAULT 0,
  last_message_at TIMESTAMP WITH TIME ZONE,
  daily_limit INT DEFAULT 10,
  timezone VARCHAR(50) DEFAULT 'America/Argentina/Buenos_Aires',
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS warmup_activity_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  warmup_number_id UUID REFERENCES warmup_numbers(id),
  phone_number VARCHAR(20),
  recipient VARCHAR(20),
  message_type VARCHAR(20),   -- text | emoji | image | link
  message_preview VARCHAR(200),
  status VARCHAR(20),          -- sent | failed | skipped
  warmup_day INT,
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS warmup_contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone_number VARCHAR(20) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  message_count INT DEFAULT 0,
  last_used_at TIMESTAMP WITH TIME ZONE,
  notes TEXT
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_warmup_numbers_status ON warmup_numbers(warmup_status);
CREATE INDEX IF NOT EXISTS idx_warmup_log_number_id  ON warmup_activity_log(warmup_number_id);
CREATE INDEX IF NOT EXISTS idx_warmup_log_sent_at    ON warmup_activity_log(sent_at);
CREATE INDEX IF NOT EXISTS idx_warmup_contacts_active ON warmup_contacts(is_active);
