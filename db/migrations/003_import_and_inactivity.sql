-- ============================================================
-- Migration 003: Contact Import + Inactivity support
-- Fecha: 2026-04-13
-- Propósito:
--   - Tabla import_logs: historial de cada importación de contactos
--   - Tabla contact_tags: tags flexibles por contacto
--   - Función upsert_contact: importación idempotente con deduplicación
--   - Función get_inactive_contacts: para WF-018 Inactivity Trigger
--   - Índice adicional en contacts para consultas de inactividad
-- ============================================================

BEGIN;

-- ============================================================
-- TABLA: import_logs
-- Registro de cada job de importación (CSV, API, manual)
-- ============================================================

CREATE TABLE IF NOT EXISTS import_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Origen
    source          VARCHAR(20) NOT NULL,  -- 'csv' | 'api' | 'manual'
    filename        VARCHAR(255),          -- nombre del archivo si es CSV
    triggered_by    VARCHAR(255),          -- usuario o workflow que disparó

    -- Resultado
    total_rows      INT NOT NULL DEFAULT 0,
    imported        INT NOT NULL DEFAULT 0,   -- insertados nuevos
    updated         INT NOT NULL DEFAULT 0,   -- actualizados (ya existían)
    skipped         INT NOT NULL DEFAULT 0,   -- duplicados sin cambios
    failed          INT NOT NULL DEFAULT 0,   -- filas con error
    invalid_phones  INT NOT NULL DEFAULT 0,   -- teléfonos inválidos filtrados

    -- Estado del job
    status          VARCHAR(20) NOT NULL DEFAULT 'running',
    -- running | completed | failed

    -- Errores y warnings (JSONB para flexibilidad)
    error_rows      JSONB DEFAULT '[]'::JSONB,
    -- [{row: 5, phone: "123", reason: "INVALID_FORMAT"}, ...]

    -- Timings
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    duration_ms     INT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE import_logs IS 'Historial de importaciones de contactos. Una fila por job.';
COMMENT ON COLUMN import_logs.source IS 'csv | api | manual';
COMMENT ON COLUMN import_logs.error_rows IS 'Array JSON de filas con error: [{row, phone, reason}]';

CREATE INDEX IF NOT EXISTS idx_import_logs_status  ON import_logs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_logs_created ON import_logs(created_at DESC);


-- ============================================================
-- TABLA: contact_tags
-- Tags flexibles M:N para contactos (VIP, churned, hot-lead, etc.)
-- ============================================================

CREATE TABLE IF NOT EXISTS contact_tags (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    tag         VARCHAR(100) NOT NULL,
    added_by    VARCHAR(255),
    added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (contact_id, tag)
);

COMMENT ON TABLE contact_tags IS 'Tags flexibles por contacto. M:N. Deduplicados por (contact_id, tag).';

CREATE INDEX IF NOT EXISTS idx_contact_tags_contact ON contact_tags(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_tags_tag     ON contact_tags(tag);


-- ============================================================
-- ÍNDICES adicionales en contacts para WF-018
-- ============================================================

-- Consulta principal de inactividad: contactos activos sin actividad reciente
CREATE INDEX IF NOT EXISTS idx_contacts_inactivity
    ON contacts(last_activity_at ASC)
    WHERE status = 'active'
      AND opt_in_marketing = true
      AND do_not_contact = false;


-- ============================================================
-- FUNCIÓN: upsert_contact(phone, name, external_id, source, tags[])
-- Importación idempotente. Normaliza teléfono, deduplica, retorna acción.
-- Usada por WF-014 nodo a nodo.
-- ============================================================

CREATE OR REPLACE FUNCTION upsert_contact(
    p_phone       VARCHAR,
    p_first_name  VARCHAR  DEFAULT NULL,
    p_last_name   VARCHAR  DEFAULT NULL,
    p_external_id VARCHAR  DEFAULT NULL,
    p_source      VARCHAR  DEFAULT 'csv',
    p_tags        TEXT[]   DEFAULT '{}'
)
RETURNS TABLE (
    contact_id UUID,
    action     VARCHAR   -- 'inserted' | 'updated' | 'skipped'
) AS $$
DECLARE
    v_normalized  VARCHAR;
    v_contact_id  UUID;
    v_action      VARCHAR;
BEGIN
    -- Normalizar: quitar todo excepto + y dígitos
    v_normalized := REGEXP_REPLACE(p_phone, '[^0-9+]', '', 'g');

    -- Asegurar que empiece con +
    IF v_normalized !~ '^\+' THEN
        v_normalized := '+' || v_normalized;
    END IF;

    -- Validar largo mínimo E.164
    IF v_normalized !~ '^\+[0-9]{10,15}$' THEN
        RAISE EXCEPTION 'INVALID_PHONE_FORMAT: %', p_phone;
    END IF;

    -- UPSERT principal
    INSERT INTO contacts (
        phone_number,
        first_name,
        last_name,
        external_id,
        platform_source,
        status,
        opt_in_marketing,
        phone_verified
    )
    VALUES (
        v_normalized,
        p_first_name,
        p_last_name,
        COALESCE(p_external_id, v_normalized),  -- fallback: usar teléfono como external_id
        p_source,
        'active',
        true,
        false
    )
    ON CONFLICT (phone_number) DO UPDATE
        SET
            first_name      = COALESCE(EXCLUDED.first_name, contacts.first_name),
            last_name       = COALESCE(EXCLUDED.last_name,  contacts.last_name),
            platform_source = COALESCE(EXCLUDED.platform_source, contacts.platform_source),
            updated_at      = NOW()
        WHERE
            -- Solo actualizar si hay datos nuevos
            EXCLUDED.first_name IS DISTINCT FROM contacts.first_name
            OR EXCLUDED.last_name IS DISTINCT FROM contacts.last_name
    RETURNING id INTO v_contact_id;

    -- Determinar acción
    IF v_contact_id IS NULL THEN
        -- El ON CONFLICT WHERE no actualizó → skipped
        SELECT id INTO v_contact_id FROM contacts WHERE phone_number = v_normalized;
        v_action := 'skipped';
    ELSIF (SELECT created_at FROM contacts WHERE id = v_contact_id) > NOW() - INTERVAL '1 second' THEN
        v_action := 'inserted';
    ELSE
        v_action := 'updated';
    END IF;

    -- Insertar tags si hay
    IF array_length(p_tags, 1) > 0 THEN
        INSERT INTO contact_tags (contact_id, tag)
        SELECT v_contact_id, unnest(p_tags)
        ON CONFLICT (contact_id, tag) DO NOTHING;
    END IF;

    RETURN QUERY SELECT v_contact_id, v_action;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION upsert_contact IS
    'Importación idempotente de contacto. Normaliza E.164, deduplica por phone_number, retorna action=inserted|updated|skipped.';


-- ============================================================
-- FUNCIÓN: get_inactive_contacts(days_inactive, limit_count)
-- Retorna contactos activos sin actividad en los últimos N días
-- que no tengan una secuencia de reactivación activa.
-- Usada por WF-018 Inactivity Trigger.
-- ============================================================

CREATE OR REPLACE FUNCTION get_inactive_contacts(
    p_days_inactive INT     DEFAULT 3,
    p_sequence_name VARCHAR DEFAULT 'reactivation-ladder',
    p_limit         INT     DEFAULT 500
)
RETURNS TABLE (
    contact_id      UUID,
    phone_number    VARCHAR,
    first_name      VARCHAR,
    segment         contact_segment,
    last_activity   TIMESTAMPTZ,
    days_inactive   INT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        c.id,
        c.phone_number,
        c.first_name,
        c.segment,
        c.last_activity_at,
        EXTRACT(DAY FROM NOW() - c.last_activity_at)::INT AS days_inactive
    FROM contacts c
    -- Excluir contactos que ya tienen la secuencia corriendo
    WHERE NOT EXISTS (
        SELECT 1
        FROM sequence_executions se
        JOIN sequences s ON se.sequence_id = s.id
        WHERE se.contact_id = c.id
          AND s.name = p_sequence_name
          AND se.status = 'running'
    )
    -- Solo contactos activos, con marketing opt-in, sin DNC
    AND c.status          = 'active'
    AND c.opt_in_marketing = true
    AND c.do_not_contact   = false
    -- Inactividad: sin actividad en N días
    AND c.last_activity_at < NOW() - (p_days_inactive || ' days')::INTERVAL
    -- Excluir los que nunca tuvieron actividad (recién importados)
    AND c.last_activity_at IS NOT NULL
    ORDER BY c.last_activity_at ASC   -- más antiguos primero
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_inactive_contacts IS
    'Contactos inactivos N días sin secuencia de reactivación activa. Usada por WF-018.';

COMMIT;
