-- =============================================================================
-- Migration 072: Campos Anti-Ban en campaigns
-- =============================================================================
-- Agrega campos de configuración anti-ban a la tabla campaigns para que
-- cada campaña pueda override el perfil/delay del sistema.
-- =============================================================================

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS delay_type            TEXT    DEFAULT 'gaussian'
    CHECK (delay_type IN ('gaussian', 'human_noisy', 'uniform')),
  ADD COLUMN IF NOT EXISTS custom_delay_seconds  INTEGER DEFAULT 18
    CHECK (custom_delay_seconds >= 5),
  ADD COLUMN IF NOT EXISTS daily_limit_override  INTEGER DEFAULT NULL
    CHECK (daily_limit_override IS NULL OR daily_limit_override >= 5),
  ADD COLUMN IF NOT EXISTS anti_ban_profile_id   UUID    DEFAULT NULL
    REFERENCES anti_ban_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS enable_mini_sessions  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS mini_session_text     TEXT    DEFAULT '👍';

COMMENT ON COLUMN campaigns.delay_type           IS 'Algoritmo de distribución de delays: gaussian | human_noisy | uniform';
COMMENT ON COLUMN campaigns.custom_delay_seconds IS 'Delay base en segundos para esta campaña (override del perfil)';
COMMENT ON COLUMN campaigns.daily_limit_override IS 'Límite máximo de mensajes por línea por día solo para esta campaña. NULL = sin override.';
COMMENT ON COLUMN campaigns.anti_ban_profile_id  IS 'Perfil anti-ban asignado a esta campaña. NULL = usa perfil por defecto.';
COMMENT ON COLUMN campaigns.enable_mini_sessions IS 'Si true, envía mini_session_text tras cada mensaje exitoso en esta campaña';
COMMENT ON COLUMN campaigns.mini_session_text    IS 'Texto corto de seguimiento (emoji o frase) si enable_mini_sessions = true';
