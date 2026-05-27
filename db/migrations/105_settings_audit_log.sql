-- Migration 105: settings_audit_log
--
-- Tabla append-only de auditoría para todos los cambios en tablas de configuración.
-- Registra INSERT y UPDATE en segmentation_tiers y scoring_config.
--
-- Diseño append-only:
--   - No existe política de escritura para el rol authenticated.
--   - Solo escribe el trigger SECURITY DEFINER (o SettingsAuditService vía service_role).
--   - Sin UPDATE ni DELETE: si alguien borra un registro, es una anomalía de seguridad.
--
-- Nota sobre secuencia de migraciones:
--   Los INSERTs de seed data en migraciones 103 y 104 ocurrieron ANTES de que esta
--   migración existiera, por lo que los triggers no los capturaron automáticamente.
--   Al final de esta migración se insertan los registros retroactivos correspondientes
--   con changed_by = 'migration:103' / 'migration:104' para mantener la trazabilidad.
--
-- Additive: no modifica tablas existentes.


-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. TABLA: settings_audit_log
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS settings_audit_log (
  id            UUID          NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  table_name    TEXT          NOT NULL,
  record_id     TEXT          NOT NULL,
  operation     TEXT          NOT NULL
                CHECK (operation IN ('INSERT', 'UPDATE')),
  old_value     JSONB,                          -- NULL en INSERT (intencional)
  new_value     JSONB         NOT NULL,
  changed_by    TEXT          NOT NULL,         -- TEXT, no UUID: admite 'migration:103'
  changed_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  workspace_id  TEXT          NOT NULL DEFAULT 'default',
  reason        TEXT                            -- opcional hoy, requerido en UI futura
);

COMMENT ON TABLE settings_audit_log IS
  'Registro append-only de cambios en tablas de configuración del sistema. '
  'Solo escritura vía trigger SECURITY DEFINER o SettingsAuditService (service_role). '
  'Sin UPDATE ni DELETE permitidos para roles normales.';

COMMENT ON COLUMN settings_audit_log.record_id IS
  'PK del registro modificado como texto. Formato: "tier:workspace_id" para '
  'segmentation_tiers, "key:workspace_id" para scoring_config.';
COMMENT ON COLUMN settings_audit_log.changed_by IS
  'Quién realizó el cambio. UUID del usuario como texto, o identificador de proceso '
  'como ''migration:103''. TEXT (no UUID) para soportar ambos formatos.';
COMMENT ON COLUMN settings_audit_log.old_value IS
  'Estado anterior del registro. NULL en operaciones INSERT (primera inserción).';
COMMENT ON COLUMN settings_audit_log.reason IS
  'Motivo del cambio. Opcional hoy — se hará requerido cuando se implemente '
  'el endpoint PATCH de configuración en la UI.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. ÍNDICES
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_settings_audit_log_table_changed_at
  ON settings_audit_log (table_name, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_settings_audit_log_workspace
  ON settings_audit_log (workspace_id, changed_at DESC);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. RLS
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE settings_audit_log ENABLE ROW LEVEL SECURITY;

-- service_role: acceso total, incluye INSERT desde triggers SECURITY DEFINER.
CREATE POLICY "settings_audit_log_service_role_all"
  ON settings_audit_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- authenticated: solo lectura. Sin política de escritura → INSERT bloqueado para authenticated.
CREATE POLICY "settings_audit_log_authenticated_read"
  ON settings_audit_log
  FOR SELECT
  TO authenticated
  USING (true);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. TRIGGER: segmentation_tiers
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION log_segmentation_tier_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER                    -- necesario: permite escribir en audit_log sin que RLS lo bloquee
SET search_path = public            -- evita search_path injection en funciones SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO settings_audit_log
      (table_name, record_id, operation, old_value, new_value, changed_by, workspace_id)
    VALUES
      ('segmentation_tiers',
       NEW.tier || ':' || NEW.workspace_id,
       'INSERT',
       NULL,
       row_to_json(NEW)::jsonb,
       -- updated_by = NULL en migraciones de sistema → identificador de proceso
       COALESCE(NEW.updated_by::text, 'migration:103'),
       NEW.workspace_id);

  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO settings_audit_log
      (table_name, record_id, operation, old_value, new_value, changed_by, workspace_id)
    VALUES
      ('segmentation_tiers',
       NEW.tier || ':' || NEW.workspace_id,
       'UPDATE',
       row_to_json(OLD)::jsonb,
       row_to_json(NEW)::jsonb,
       -- En UPDATE sin usuario explícito: 'unknown' como centinela
       COALESCE(NEW.updated_by::text, 'unknown'),
       NEW.workspace_id);
  END IF;

  RETURN NULL;  -- AFTER trigger: el valor de retorno se ignora para FOR EACH ROW
END;
$$;

DROP TRIGGER IF EXISTS trg_segmentation_tiers_audit ON segmentation_tiers;

CREATE TRIGGER trg_segmentation_tiers_audit
  AFTER INSERT OR UPDATE ON segmentation_tiers
  FOR EACH ROW
  EXECUTE FUNCTION log_segmentation_tier_change();


-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. TRIGGER: scoring_config
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION log_scoring_config_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO settings_audit_log
      (table_name, record_id, operation, old_value, new_value, changed_by, workspace_id)
    VALUES
      ('scoring_config',
       NEW.key || ':' || NEW.workspace_id,
       'INSERT',
       NULL,
       row_to_json(NEW)::jsonb,
       COALESCE(NEW.updated_by::text, 'migration:104'),
       NEW.workspace_id);

  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO settings_audit_log
      (table_name, record_id, operation, old_value, new_value, changed_by, workspace_id)
    VALUES
      ('scoring_config',
       NEW.key || ':' || NEW.workspace_id,
       'UPDATE',
       row_to_json(OLD)::jsonb,
       row_to_json(NEW)::jsonb,
       COALESCE(NEW.updated_by::text, 'unknown'),
       NEW.workspace_id);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_scoring_config_audit ON scoring_config;

CREATE TRIGGER trg_scoring_config_audit
  AFTER INSERT OR UPDATE ON scoring_config
  FOR EACH ROW
  EXECUTE FUNCTION log_scoring_config_change();


-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. REGISTROS RETROACTIVOS DE SEED DATA (migraciones 103 y 104)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Los INSERTs de migraciones 103 y 104 ocurrieron antes de que los triggers
-- existieran. Estos INSERTs manuales retroactivos garantizan que todos los
-- registros de configuración tengan su entrada inicial en el audit log.
--
-- changed_by = 'migration:103' / 'migration:104': identifica el origen exacto.
-- changed_at usa NOW() de esta migración (105), no el timestamp original —
-- es el momento en que se establece la trazabilidad, no cuando se insertó el dato.

INSERT INTO settings_audit_log
  (table_name, record_id, operation, old_value, new_value, changed_by, workspace_id)
SELECT
  'segmentation_tiers',
  t.tier || ':' || t.workspace_id,
  'INSERT',
  NULL,
  row_to_json(t)::jsonb,
  'migration:103',
  t.workspace_id
FROM segmentation_tiers t;

INSERT INTO settings_audit_log
  (table_name, record_id, operation, old_value, new_value, changed_by, workspace_id)
SELECT
  'scoring_config',
  s.key || ':' || s.workspace_id,
  'INSERT',
  NULL,
  row_to_json(s)::jsonb,
  'migration:104',
  s.workspace_id
FROM scoring_config s;


-- ═══════════════════════════════════════════════════════════════════════════════
-- Validación (ejecutar en Supabase SQL Editor para confirmar):
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- SELECT table_name, record_id, operation, changed_by, changed_at
-- FROM settings_audit_log
-- ORDER BY table_name, changed_at;
--
-- Resultado esperado: 11 filas
--   4 de segmentation_tiers (changed_by = 'migration:103')
--   7 de scoring_config     (changed_by = 'migration:104')
--
-- Verificar que los triggers funcionan para cambios futuros:
-- UPDATE segmentation_tiers SET value_score = 60 WHERE tier = 'vip';
-- SELECT * FROM settings_audit_log WHERE operation = 'UPDATE';
-- → debe aparecer 1 fila con old_value y new_value
