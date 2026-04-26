-- ============================================
-- Schema: WhatsApp Automation Platform
-- Archivo: db/schema/01_core.sql
-- ============================================
-- LEGACY BOOTSTRAP FILE — NOT THE ACTIVE SCHEMA
-- This file reflects an early prototype with a `players` table.
-- The live schema uses the `contacts` table defined in db/schema/init.sql
-- and the migration sequence in scripts/ops/run-migrations.mjs.
-- Current segment vocabulary: bajo | medio | alto | vip  (see migration 026)
-- Do NOT run this file on a production or staging database.
-- ============================================

-- Extensiones necesarias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- PLAYERS (mirror/cache de datos relevantes)
-- ============================================
CREATE TABLE IF NOT EXISTS players (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    external_id VARCHAR(100) UNIQUE NOT NULL, -- ID en el sistema del casino
    phone VARCHAR(20),                         -- Formato E.164: +5491112345678
    phone_verified BOOLEAN DEFAULT false,
    first_name VARCHAR(100),
    email VARCHAR(255),
    country_code CHAR(2),                      -- ISO 3166-1 alpha-2
    status VARCHAR(20) DEFAULT 'active',       -- active | suspended | closed
    segment VARCHAR(20) DEFAULT NULL,          -- LEGACY prototype default was 'casual'; current values: bajo|medio|alto|vip
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- WHATSAPP MESSAGES (log de mensajes enviados)
-- ============================================
CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    player_id UUID REFERENCES players(id),
    phone VARCHAR(20) NOT NULL,
    message_type VARCHAR(50),                  -- onboarding | retention | payment | support | risk
    template_name VARCHAR(100),
    message_body TEXT,
    status VARCHAR(20) DEFAULT 'sent',         -- sent | delivered | read | failed
    evolution_message_id VARCHAR(255),         -- ID retornado por Evolution API
    workflow_name VARCHAR(100),                -- qué workflow lo envió
    sent_at TIMESTAMPTZ DEFAULT NOW(),
    error_detail TEXT
);

-- ============================================
-- WHATSAPP TEMPLATES
-- ============================================
CREATE TABLE IF NOT EXISTS whatsapp_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) UNIQUE NOT NULL,
    domain VARCHAR(50),                        -- onboarding | retention | payments | etc
    language VARCHAR(10) DEFAULT 'es',
    body TEXT NOT NULL,
    variables JSONB,                           -- lista de variables: ["nombre", "monto"]
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- WORKFLOW EXECUTIONS (auditoría de ejecuciones)
-- ============================================
CREATE TABLE IF NOT EXISTS workflow_executions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workflow_name VARCHAR(100) NOT NULL,
    trigger_event VARCHAR(100),
    player_id UUID REFERENCES players(id),
    status VARCHAR(20),                        -- success | error | skipped
    input_data JSONB,
    output_data JSONB,
    error_message TEXT,
    executed_at TIMESTAMPTZ DEFAULT NOW(),
    duration_ms INTEGER
);

-- ============================================
-- RISK FLAGS
-- ============================================
CREATE TABLE IF NOT EXISTS risk_flags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    player_id UUID REFERENCES players(id),
    flag_type VARCHAR(50),                     -- bonus_abuse | multi_account | high_withdrawal | etc
    severity VARCHAR(20) DEFAULT 'medium',     -- low | medium | high | critical
    detail TEXT,
    resolved BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

-- ============================================
-- ÍNDICES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_players_external_id ON players(external_id);
CREATE INDEX IF NOT EXISTS idx_players_phone ON players(phone);
CREATE INDEX IF NOT EXISTS idx_wa_messages_player ON whatsapp_messages(player_id);
CREATE INDEX IF NOT EXISTS idx_wa_messages_sent_at ON whatsapp_messages(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_flags_player ON risk_flags(player_id);
CREATE INDEX IF NOT EXISTS idx_risk_flags_unresolved ON risk_flags(player_id) WHERE resolved = false;
