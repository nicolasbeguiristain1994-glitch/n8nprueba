-- Migration 104: scoring_config
--
-- Tabla key-value para constantes escalares del motor de scoring de priorización
-- y del ContactFrequencyEngine.
--
-- Migra los valores hardcodeados de:
--   frontend/lib/contact-frequency/rules.ts  → umbrales y pesos del risk score
--   frontend/lib/user-prioritization/scoring.ts → constante urgency_score_max
--
-- Diseño: PRIMARY KEY (key, workspace_id) permite upsert limpio por workspace.
-- description NOT NULL: no se acepta una fila sin documentación de su propósito.
--
-- Additive: no modifica tablas existentes. Idempotente: ON CONFLICT DO NOTHING.
--
-- Nota sobre block_threshold: NO se crea. BLOCK es implícitamente > delay_threshold.
-- Tener ambas keys sería redundancia que puede desincronizarse.
--
-- Los triggers de audit log se crean en migración 105. Los INSERTs de seed data
-- aquí NO disparan audit log. Migración 105 inserta los registros retroactivos
-- con changed_by = 'migration:104'.


-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. TABLA: scoring_config
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS scoring_config (
  key           TEXT          NOT NULL,
  value         NUMERIC       NOT NULL,
  description   TEXT          NOT NULL,
  workspace_id  TEXT          NOT NULL DEFAULT 'default',
  updated_by    UUID          REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  PRIMARY KEY (key, workspace_id)
);

COMMENT ON TABLE scoring_config IS
  'Configuración escalar del motor de scoring de priorización y frecuencia. '
  'Cada fila es una constante nombrada con su valor y descripción obligatoria. '
  'Migrado desde frontend/lib/contact-frequency/rules.ts y scoring.ts. '
  'Gestionado via GET /api/settings/scoring.';

COMMENT ON COLUMN scoring_config.key IS
  'Nombre de la constante. Tipo union: urgency_score_max | risk_weight_daily | '
  'risk_weight_weekly | risk_weight_cooldown | allow_threshold | delay_threshold | cooldown_multiplier.';
COMMENT ON COLUMN scoring_config.value IS
  'Valor numérico de la constante. NUMERIC para soportar decimales futuros.';
COMMENT ON COLUMN scoring_config.description IS
  'Descripción obligatoria del propósito y origen de la constante. NOT NULL.';
COMMENT ON COLUMN scoring_config.workspace_id IS
  'Identificador del workspace. DEFAULT ''default'': mono-tenant hoy, '
  'placeholder para futura arquitectura multi-tenant.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. RLS
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE scoring_config ENABLE ROW LEVEL SECURITY;

-- service_role bypasses RLS automáticamente en Supabase (atributo BYPASSRLS).
-- Política explícita para claridad documental.
CREATE POLICY "scoring_config_service_role_all"
  ON scoring_config
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- authenticated: solo lectura.
-- El control fino de permisos (settings:read) se aplica en la API route.
CREATE POLICY "scoring_config_authenticated_read"
  ON scoring_config
  FOR SELECT
  TO authenticated
  USING (true);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. SEED DATA
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Valores migrados exactamente desde sus fuentes en TypeScript:
--
--   urgency_score_max    = 40   → literal `* 40` en scoring.ts:scoreUrgency()
--   risk_weight_daily    = 40   → RISK_WEIGHTS.daily    en rules.ts
--   risk_weight_weekly   = 35   → RISK_WEIGHTS.weekly   en rules.ts
--   risk_weight_cooldown = 25   → RISK_WEIGHTS.cooldown en rules.ts
--   allow_threshold      = 30   → ALLOW_THRESHOLD       en rules.ts
--   delay_threshold      = 60   → DELAY_THRESHOLD       en rules.ts
--   cooldown_multiplier  = 2    → COOLDOWN_PROPORTIONAL_MULTIPLIER en rules.ts
--
-- Invariante: risk_weight_daily + risk_weight_weekly + risk_weight_cooldown = 100
--             allow_threshold < delay_threshold
--
-- updated_by = NULL: inserción de sistema (migración), sin usuario humano.
-- El audit log retroactivo se inserta en migración 105.

INSERT INTO scoring_config (key, value, description, updated_by)
VALUES
  ('urgency_score_max',
   40,
   'Multiplicador máximo del score de urgencia en priority_score. '
   'Fuente: constante literal en scoring.ts:scoreUrgency() → Math.round((1-position)*40).',
   NULL),

  ('risk_weight_daily',
   40,
   'Peso del componente de envíos del día en el Risk Score (0–100). '
   'Fuente: RISK_WEIGHTS.daily en rules.ts. '
   'La suma risk_weight_daily + risk_weight_weekly + risk_weight_cooldown DEBE ser 100.',
   NULL),

  ('risk_weight_weekly',
   35,
   'Peso del componente de envíos de la semana en el Risk Score. '
   'Fuente: RISK_WEIGHTS.weekly en rules.ts.',
   NULL),

  ('risk_weight_cooldown',
   25,
   'Peso del componente de cooldown en el Risk Score. '
   'Fuente: RISK_WEIGHTS.cooldown en rules.ts.',
   NULL),

  ('allow_threshold',
   30,
   'Risk Score máximo para decisión ALLOW. Por encima → evaluación DELAY. '
   'Fuente: ALLOW_THRESHOLD en rules.ts. Debe ser < delay_threshold.',
   NULL),

  ('delay_threshold',
   60,
   'Risk Score máximo para decisión DELAY. Por encima → decisión BLOCK. '
   'Fuente: DELAY_THRESHOLD en rules.ts. '
   'No existe key block_threshold: BLOCK es implícitamente > delay_threshold.',
   NULL),

  ('cooldown_multiplier',
   2,
   'Multiplicador de la ventana de cálculo proporcional del cooldown: '
   'ventana_efectiva = min_hours_between_sends × cooldown_multiplier. '
   'Fuente: COOLDOWN_PROPORTIONAL_MULTIPLIER en rules.ts.',
   NULL)

ON CONFLICT (key, workspace_id) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════════════
-- Validación (ejecutar en Supabase SQL Editor para confirmar):
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- SELECT key, value FROM scoring_config ORDER BY key;
--
-- Resultado esperado (7 filas):
--   key                     | value
--   ------------------------+-------
--   allow_threshold         |    30
--   cooldown_multiplier     |     2
--   delay_threshold         |    60
--   risk_weight_cooldown    |    25
--   risk_weight_daily       |    40
--   risk_weight_weekly      |    35
--   urgency_score_max       |    40
--
-- Verificar invariantes:
-- SELECT
--   SUM(value) FILTER (WHERE key IN ('risk_weight_daily','risk_weight_weekly','risk_weight_cooldown')) AS sum_weights,
--   MIN(value) FILTER (WHERE key = 'allow_threshold') < MIN(value) FILTER (WHERE key = 'delay_threshold') AS allow_lt_delay
-- FROM scoring_config;
-- → sum_weights = 100, allow_lt_delay = true
