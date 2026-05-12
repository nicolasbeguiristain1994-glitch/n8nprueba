-- =============================================================================
-- Migration 071: Sistema de Perfiles Anti-Ban (v2.4)
-- =============================================================================
-- Crea la tabla anti_ban_profiles con 3 perfiles predefinidos y vincula
-- warmup_numbers a un perfil opcional. Si una línea no tiene perfil asignado,
-- el workflow WF-010a carga automáticamente el perfil con is_default = true.
--
-- Perfiles incluidos:
--   Meta-Stealth-2026 (default) → máxima protección, timing gaussiano
--   Balanced                    → equilibrio velocidad/seguridad
--   Aggressive                  → solo líneas maduras con score >= 85
--
-- Para agregar un nuevo perfil, simplemente hace un INSERT en esta tabla.
-- El workflow lo usará inmediatamente sin cambios de código.
--
-- v2.4: Añadidos campos para mini-sesiones:
--   mini_session_text        → mensaje corto de seguimiento (default '👍')
--   mini_session_delay_min   → delay mínimo entre mensaje principal y seguimiento
--   mini_session_delay_max   → delay máximo entre mensaje principal y seguimiento
-- =============================================================================

-- 1. TABLA DE PERFILES
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS anti_ban_profiles (
  id                          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Identificación
  profile_name                TEXT        NOT NULL UNIQUE,

  -- Timing: distribución de delays
  timing_mode                 TEXT        NOT NULL DEFAULT 'gaussian'
                                CHECK (timing_mode IN ('gaussian', 'uniform', 'human_noisy')),
  min_delay_seconds           INTEGER     NOT NULL DEFAULT 12 CHECK (min_delay_seconds >= 5),
  max_delay_seconds           INTEGER     NOT NULL DEFAULT 40 CHECK (max_delay_seconds >= min_delay_seconds + 5),

  -- Mini-sesiones: mensaje corto de seguimiento tras envío exitoso
  enable_mini_sessions        BOOLEAN     NOT NULL DEFAULT FALSE,
  mini_session_followup_count INTEGER     NOT NULL DEFAULT 0
                                CHECK (mini_session_followup_count BETWEEN 0 AND 2),
  -- Texto del seguimiento (emoji o frase corta, editable sin tocar código)
  mini_session_text           TEXT        NOT NULL DEFAULT '👍',
  -- Delay entre mensaje principal y seguimiento (distribución gaussiana)
  mini_session_delay_min      INTEGER     NOT NULL DEFAULT 8  CHECK (mini_session_delay_min >= 5),
  mini_session_delay_max      INTEGER     NOT NULL DEFAULT 25 CHECK (mini_session_delay_max > mini_session_delay_min),

  -- Typing indicator
  typing_style                TEXT        NOT NULL DEFAULT 'variable_by_length'
                                CHECK (typing_style IN ('fixed', 'variable_by_length', 'realistic')),

  -- Tolerancia al riesgo: calibra los umbrales del Health Score override
  -- low    → boost >= 80 / penalidad <= 65  (más conservador)
  -- medium → boost >= 85 / penalidad <= 60  (por defecto)
  -- high   → boost >= 90 / penalidad <= 55  (solo líneas maduras)
  risk_tolerance              TEXT        NOT NULL DEFAULT 'low'
                                CHECK (risk_tolerance IN ('low', 'medium', 'high')),

  -- Micro-ruido adicional en el delay (±5% sobre el delay calculado)
  enable_human_noise          BOOLEAN     NOT NULL DEFAULT TRUE,

  -- Documentación y configuración
  recommended_for             TEXT,
  is_default                  BOOLEAN     NOT NULL DEFAULT FALSE,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Solo un perfil puede ser el default
CREATE UNIQUE INDEX IF NOT EXISTS idx_anti_ban_profiles_default
  ON anti_ban_profiles (is_default)
  WHERE is_default = TRUE;

COMMENT ON TABLE  anti_ban_profiles                          IS 'Perfiles de configuración anti-ban para WF-010a. Editar aquí para cambiar el comportamiento sin tocar código.';
COMMENT ON COLUMN anti_ban_profiles.timing_mode              IS 'gaussian=más natural | uniform=clásico | human_noisy=uniform+pausas largas ocasionales';
COMMENT ON COLUMN anti_ban_profiles.risk_tolerance           IS 'Calibra los umbrales del Health Score: low=conservador | medium=default | high=agresivo';
COMMENT ON COLUMN anti_ban_profiles.enable_human_noise       IS 'Agrega micro-ruido ±5% al delay final para mayor aleatoriedad';
COMMENT ON COLUMN anti_ban_profiles.enable_mini_sessions     IS 'Si true, envía mini_session_text al destinatario después del mensaje principal (solo si envío fue exitoso)';
COMMENT ON COLUMN anti_ban_profiles.mini_session_text        IS 'Mensaje corto de seguimiento. Puede ser emoji, frase corta, etc. Editable sin tocar código.';
COMMENT ON COLUMN anti_ban_profiles.mini_session_delay_min   IS 'Segundos mínimos entre mensaje principal y seguimiento (distribución gaussiana)';
COMMENT ON COLUMN anti_ban_profiles.mini_session_delay_max   IS 'Segundos máximos entre mensaje principal y seguimiento (distribución gaussiana)';
COMMENT ON COLUMN anti_ban_profiles.is_default               IS 'Perfil usado cuando una línea no tiene anti_ban_profile_id asignado';


-- 2. PERFILES PREDEFINIDOS
-- -----------------------------------------------------------------------------
-- Para agregar un perfil personalizado, agrega un INSERT similar aquí o
-- directamente desde el dashboard/Supabase Studio.
-- -----------------------------------------------------------------------------
INSERT INTO anti_ban_profiles (
  profile_name,
  timing_mode,
  min_delay_seconds,
  max_delay_seconds,
  enable_mini_sessions,
  mini_session_followup_count,
  mini_session_text,
  mini_session_delay_min,
  mini_session_delay_max,
  typing_style,
  risk_tolerance,
  enable_human_noise,
  recommended_for,
  is_default
) VALUES

-- PERFIL 1: Meta-Stealth-2026 (DEFAULT — el más seguro)
-- Timing gaussiano + noise humano + typing variable + tolerancia baja al riesgo.
-- Ideal para líneas nuevas, campañas importantes o cualquier caso donde
-- la protección es prioritaria sobre la velocidad.
(
  'Meta-Stealth-2026',
  'gaussian',
  12,     -- min_delay_seconds
  40,     -- max_delay_seconds
  FALSE,  -- enable_mini_sessions
  0,      -- mini_session_followup_count
  '👍',   -- mini_session_text
  8,      -- mini_session_delay_min
  25,     -- mini_session_delay_max
  'variable_by_length',
  'low',
  TRUE,
  'Líneas nuevas y campañas críticas. Timing gaussiano + micro-noise. Máxima protección anti-ban Meta 2026. Recomendado por defecto.',
  TRUE
),

-- PERFIL 2: Balanced
-- Buen equilibrio entre velocidad y protección.
-- Para líneas con 30+ días de historial limpio y score > 70.
(
  'Balanced',
  'gaussian',
  8,      -- min_delay_seconds
  25,     -- max_delay_seconds
  FALSE,  -- enable_mini_sessions (activar manualmente si se desea)
  0,
  '👍',
  6,      -- mini_session_delay_min
  18,     -- mini_session_delay_max
  'variable_by_length',
  'medium',
  TRUE,
  'Equilibrio velocidad/seguridad. Para líneas con 30+ días de historial limpio y score > 70.',
  FALSE
),

-- PERFIL 3: Aggressive
-- Delays cortos, sin noise adicional, tolerancia alta al riesgo.
-- SOLO para líneas con 90+ días de historial completamente limpio y score >= 85.
(
  'Aggressive',
  'uniform',
  5,      -- min_delay_seconds
  15,     -- max_delay_seconds
  FALSE,  -- enable_mini_sessions
  0,
  '👍',
  5,      -- mini_session_delay_min
  12,     -- mini_session_delay_max
  'fixed',
  'high',
  FALSE,
  'Solo para líneas maduras con 90+ días limpios y score >= 85. Mayor velocidad, mayor riesgo. NO usar en líneas nuevas.',
  FALSE
)

ON CONFLICT (profile_name) DO NOTHING;


-- 3. VINCULAR warmup_numbers AL PERFIL
-- -----------------------------------------------------------------------------
-- NULL significa "usar el perfil default (is_default = true)"
-- Si se asigna un UUID, el workflow cargará ese perfil específico.
ALTER TABLE warmup_numbers
  ADD COLUMN IF NOT EXISTS anti_ban_profile_id UUID
    REFERENCES anti_ban_profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN warmup_numbers.anti_ban_profile_id IS
  'Perfil anti-ban para esta línea. NULL = usa el perfil con is_default=true (Meta-Stealth-2026).';


-- 4. TRIGGER: mantener updated_at actualizado
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_anti_ban_profiles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_anti_ban_profiles_updated_at ON anti_ban_profiles;
CREATE TRIGGER trg_anti_ban_profiles_updated_at
  BEFORE UPDATE ON anti_ban_profiles
  FOR EACH ROW EXECUTE FUNCTION update_anti_ban_profiles_updated_at();
