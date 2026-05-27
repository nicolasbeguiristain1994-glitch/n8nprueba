-- Migration 103: segmentation_tiers
--
-- Tabla normalizada de configuración de tiers de segmentación de contactos.
-- Migra los valores hardcodeados de frontend/lib/user-prioritization/config.ts
-- a una tabla configurable en DB, permitiendo ajuste sin deploy.
--
-- Additive: no modifica tablas existentes.
-- Idempotente: CREATE TABLE IF NOT EXISTS / ON CONFLICT DO NOTHING.
--
-- Diseño multi-tenant: workspace_id TEXT NOT NULL DEFAULT 'default'.
-- El sistema es mono-tenant hoy. 'default' como valor placeholder hace el schema
-- multi-tenant-ready sin overhead operativo. Sin FK por ahora.
--
-- Los triggers de audit log se crean en la migración 105 (settings_audit_log).
-- Los INSERTs de seed data a continuación NO disparan audit log (el trigger no
-- existe aún). En migración 105 se insertan los registros retroactivos en
-- settings_audit_log con changed_by = 'migration:103'.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. TABLA: segmentation_tiers
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS segmentation_tiers (
  tier                    TEXT          NOT NULL
                          CHECK (tier IN ('vip', 'alto', 'medio', 'bajo')),
  min_days_inactive       INTEGER       NOT NULL
                          CHECK (min_days_inactive >= 0),
  max_days_inactive       INTEGER       NOT NULL,
  value_score             INTEGER       NOT NULL
                          CHECK (value_score BETWEEN 0 AND 100),
  deposit_threshold_min   INTEGER       NOT NULL
                          CHECK (deposit_threshold_min >= 0),
  recontact_cooldown_days INTEGER       NOT NULL
                          CHECK (recontact_cooldown_days >= 1),
  is_active               BOOLEAN       NOT NULL DEFAULT true,
  workspace_id            TEXT          NOT NULL DEFAULT 'default',
  updated_by              UUID          REFERENCES users(id) ON DELETE SET NULL,
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE (tier, workspace_id),
  CHECK (min_days_inactive < max_days_inactive)
);

COMMENT ON TABLE segmentation_tiers IS
  'Configuración de tiers de segmentación de contactos para campañas de reactivación. '
  'Migrado desde frontend/lib/user-prioritization/config.ts. '
  'Un tier define la ventana de inactividad, el score de valor base, el umbral de depósito '
  'y el cooldown de recontacto. Gestionado via GET /api/settings/segmentation.';

COMMENT ON COLUMN segmentation_tiers.min_days_inactive IS
  'Días mínimos de inactividad para que el contacto sea elegible (INACTIVITY_WINDOWS.minDays).';
COMMENT ON COLUMN segmentation_tiers.max_days_inactive IS
  'Días máximos de inactividad. Más allá de este valor el ROI es negativo para el tier.';
COMMENT ON COLUMN segmentation_tiers.value_score IS
  'Score de valor base del tier (0–100). Refleja el LTV relativo (VALUE_SCORES en config.ts).';
COMMENT ON COLUMN segmentation_tiers.deposit_threshold_min IS
  'Monto mínimo de depósito total para clasificar en este tier (DEPOSIT_AMOUNT_TIERS).';
COMMENT ON COLUMN segmentation_tiers.recontact_cooldown_days IS
  'Días mínimos entre mensajes para el mismo contacto según tier (RECONTACT_COOLDOWN_DAYS).';
COMMENT ON COLUMN segmentation_tiers.workspace_id IS
  'Identificador del workspace. DEFAULT ''default'': sistema mono-tenant hoy, '
  'placeholder para futura arquitectura multi-tenant.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. RLS
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE segmentation_tiers ENABLE ROW LEVEL SECURITY;

-- service_role bypasses RLS automáticamente en Supabase (atributo BYPASSRLS).
-- Política explícita para claridad documental.
CREATE POLICY "segmentation_tiers_service_role_all"
  ON segmentation_tiers
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- authenticated: solo lectura.
-- El control fino de permisos (settings:read) se aplica en la API route
-- via checkPermissionWithUser — RLS aquí bloquea acceso directo anon/anónimo.
CREATE POLICY "segmentation_tiers_authenticated_read"
  ON segmentation_tiers
  FOR SELECT
  TO authenticated
  USING (true);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. SEED DATA
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Valores migrados exactamente desde frontend/lib/user-prioritization/config.ts:
--   INACTIVITY_WINDOWS  → min_days_inactive, max_days_inactive
--   VALUE_SCORES        → value_score
--   DEPOSIT_AMOUNT_TIERS → deposit_threshold_min
--   RECONTACT_COOLDOWN_DAYS → recontact_cooldown_days
--
-- updated_by = NULL: esta inserción es de sistema (migración), sin usuario humano.
-- El audit log retroactivo se inserta en migración 105.

INSERT INTO segmentation_tiers
  (tier, min_days_inactive, max_days_inactive, value_score, deposit_threshold_min, recontact_cooldown_days, updated_by)
VALUES
  ('vip',   7,  180, 60, 10000,  3, NULL),
  ('alto',  7,  150, 45,  3000,  5, NULL),
  ('medio', 14,  60, 25,   500,  7, NULL),
  ('bajo',  30,  45, 10,     0, 14, NULL)
ON CONFLICT (tier, workspace_id) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════════════
-- Validación (ejecutar en Supabase SQL Editor para confirmar):
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- SELECT tier, min_days_inactive, max_days_inactive, value_score,
--        deposit_threshold_min, recontact_cooldown_days
-- FROM segmentation_tiers
-- ORDER BY value_score DESC;
--
-- Resultado esperado:
--   tier  | min | max | value | deposit | cooldown
--   ------+-----+-----+-------+---------+---------
--   vip   |   7 | 180 |    60 |   10000 |        3
--   alto  |   7 | 150 |    45 |    3000 |        5
--   medio |  14 |  60 |    25 |     500 |        7
--   bajo  |  30 |  45 |    10 |       0 |       14
