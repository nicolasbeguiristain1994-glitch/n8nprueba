-- ============================================================
-- Migration 002: Sequence Engine support tables
-- Fecha: 2026-04-13
-- Propósito: Soporte completo para secuencias automáticas
--            (drip campaigns, onboarding, reactivación, etc.)
--            Las tablas sequences y sequence_executions ya existen
--            en init.sql — esta migración agrega columnas faltantes
--            y funciones necesarias para WF-011.
-- ============================================================

BEGIN;

-- ============================================================
-- ALTER sequences: agregar columnas que el engine necesita
-- ============================================================

ALTER TABLE sequences
    ADD COLUMN IF NOT EXISTS max_concurrent_per_contact INT DEFAULT 1,
    -- Cuántas ejecuciones simultáneas permite por contacto (default: 1)
    ADD COLUMN IF NOT EXISTS cooldown_hours INT DEFAULT 0;
    -- Horas de espera entre dos ejecuciones consecutivas del mismo contacto

COMMENT ON COLUMN sequences.max_concurrent_per_contact IS
    'Máximo de ejecuciones activas simultáneas por contacto. Default 1 evita duplicados.';
COMMENT ON COLUMN sequences.cooldown_hours IS
    'Horas de cooldown entre ejecuciones para el mismo contacto. 0 = sin cooldown.';


-- ============================================================
-- ALTER sequence_executions: agregar columnas de control
-- ============================================================

ALTER TABLE sequence_executions
    ADD COLUMN IF NOT EXISTS last_error       TEXT,
    ADD COLUMN IF NOT EXISTS last_step_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS dry_run          BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN sequence_executions.last_error IS
    'Último error ocurrido al intentar ejecutar un paso.';
COMMENT ON COLUMN sequence_executions.last_step_at IS
    'Timestamp del último paso ejecutado (para auditoría).';
COMMENT ON COLUMN sequence_executions.dry_run IS
    'Si true, ejecuta la secuencia sin enviar mensajes reales.';


-- ============================================================
-- FUNCIÓN: start_sequence(contact_id, sequence_name)
-- Inicia una secuencia para un contacto dado.
-- Verifica cooldown y max_concurrent antes de insertar.
-- Llamar desde WF-018 (Inactivity Trigger) o cualquier trigger.
-- ============================================================

CREATE OR REPLACE FUNCTION start_sequence(
    p_contact_id    UUID,
    p_sequence_name VARCHAR,
    p_dry_run       BOOLEAN DEFAULT false
)
RETURNS TABLE (
    execution_id UUID,
    status       VARCHAR,
    reason       VARCHAR
) AS $$
DECLARE
    v_sequence          sequences%ROWTYPE;
    v_active_count      INT;
    v_last_completed_at TIMESTAMPTZ;
    v_exec_id           UUID;
BEGIN
    -- Buscar la secuencia activa
    SELECT * INTO v_sequence
    FROM sequences
    WHERE name = p_sequence_name AND active = true
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN QUERY SELECT NULL::UUID, 'error'::VARCHAR, 'SEQUENCE_NOT_FOUND'::VARCHAR;
        RETURN;
    END IF;

    -- Verificar max_concurrent_per_contact
    SELECT COUNT(*) INTO v_active_count
    FROM sequence_executions
    WHERE contact_id = p_contact_id
      AND sequence_id = v_sequence.id
      AND status = 'running';

    IF v_active_count >= v_sequence.max_concurrent_per_contact THEN
        RETURN QUERY SELECT NULL::UUID, 'skipped'::VARCHAR, 'MAX_CONCURRENT_REACHED'::VARCHAR;
        RETURN;
    END IF;

    -- Verificar cooldown_hours
    IF v_sequence.cooldown_hours > 0 THEN
        SELECT MAX(completed_at) INTO v_last_completed_at
        FROM sequence_executions
        WHERE contact_id = p_contact_id
          AND sequence_id = v_sequence.id
          AND status = 'completed';

        IF v_last_completed_at IS NOT NULL
           AND v_last_completed_at > NOW() - (v_sequence.cooldown_hours || ' hours')::INTERVAL
        THEN
            RETURN QUERY SELECT NULL::UUID, 'skipped'::VARCHAR, 'COOLDOWN_ACTIVE'::VARCHAR;
            RETURN;
        END IF;
    END IF;

    -- Verificar max_runs_per_contact
    IF v_sequence.max_runs_per_contact IS NOT NULL THEN
        SELECT COUNT(*) INTO v_active_count
        FROM sequence_executions
        WHERE contact_id = p_contact_id
          AND sequence_id = v_sequence.id;

        IF v_active_count >= v_sequence.max_runs_per_contact THEN
            RETURN QUERY SELECT NULL::UUID, 'skipped'::VARCHAR, 'MAX_RUNS_REACHED'::VARCHAR;
            RETURN;
        END IF;
    END IF;

    -- Calcular total_steps desde el JSON de steps
    DECLARE v_total_steps INT;
    BEGIN
        v_total_steps := jsonb_array_length(v_sequence.steps);
    END;

    -- Insertar ejecución
    INSERT INTO sequence_executions (
        sequence_id, contact_id,
        current_step, total_steps,
        status,
        started_at,
        next_step_scheduled_for,
        dry_run
    )
    VALUES (
        v_sequence.id, p_contact_id,
        0, v_total_steps,
        'running',
        NOW(),
        NOW() + COALESCE(
            ((v_sequence.steps->0->>'delay_hours')::NUMERIC * INTERVAL '1 hour'),
            INTERVAL '0 seconds'
        ),
        p_dry_run
    )
    RETURNING id INTO v_exec_id;

    RETURN QUERY SELECT v_exec_id, 'started'::VARCHAR, 'OK'::VARCHAR;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION start_sequence IS
    'Inicia una secuencia para un contacto. Verifica cooldown, concurrent y max_runs antes de insertar.';


-- ============================================================
-- FUNCIÓN: get_due_sequence_steps(limit_count)
-- Retorna los pasos vencidos listos para ejecutar.
-- Llamada por WF-011 en cada tick del cron.
-- ============================================================

CREATE OR REPLACE FUNCTION get_due_sequence_steps(p_limit INT DEFAULT 100)
RETURNS TABLE (
    execution_id          UUID,
    sequence_id           UUID,
    sequence_name         VARCHAR,
    contact_id            UUID,
    phone_number          VARCHAR,
    first_name            VARCHAR,
    current_step          INT,
    total_steps           INT,
    step_config           JSONB,   -- el objeto del paso actual: {delay_hours, template_id, ...}
    dry_run               BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        se.id                                   AS execution_id,
        se.sequence_id,
        s.name                                  AS sequence_name,
        se.contact_id,
        c.phone_number,
        c.first_name,
        se.current_step,
        se.total_steps,
        s.steps->se.current_step               AS step_config,
        se.dry_run
    FROM sequence_executions se
    JOIN sequences  s ON se.sequence_id = s.id
    JOIN contacts   c ON se.contact_id  = c.id
    WHERE se.status = 'running'
      AND se.next_step_scheduled_for <= NOW()
      AND c.status = 'active'
      AND c.opt_in_marketing = true
      AND c.do_not_contact = false
      AND s.active = true
    ORDER BY se.next_step_scheduled_for ASC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_due_sequence_steps IS
    'Retorna hasta N pasos de secuencia vencidos. WF-011 la llama en cada ejecución de cron.';


-- ============================================================
-- FUNCIÓN: advance_sequence_step(execution_id, success)
-- Avanza al siguiente paso o marca la secuencia como completada.
-- Llamada por WF-011 después de intentar enviar el mensaje.
-- ============================================================

CREATE OR REPLACE FUNCTION advance_sequence_step(
    p_execution_id UUID,
    p_success      BOOLEAN,
    p_error_msg    TEXT DEFAULT NULL
)
RETURNS VARCHAR AS $$
DECLARE
    v_exec     sequence_executions%ROWTYPE;
    v_seq      sequences%ROWTYPE;
    v_next_step INT;
    v_next_delay_hours NUMERIC;
    v_new_status VARCHAR;
BEGIN
    SELECT * INTO v_exec FROM sequence_executions WHERE id = p_execution_id FOR UPDATE;
    SELECT * INTO v_seq  FROM sequences WHERE id = v_exec.sequence_id;

    v_next_step := v_exec.current_step + 1;

    IF p_success THEN
        -- Avanzar o completar
        IF v_next_step >= v_exec.total_steps THEN
            v_new_status := 'completed';
            UPDATE sequence_executions
            SET current_step     = v_next_step,
                status           = 'completed',
                completed_at     = NOW(),
                last_step_at     = NOW(),
                messages_sent    = messages_sent + 1,
                updated_at       = NOW()
            WHERE id = p_execution_id;
        ELSE
            -- Calcular delay del próximo paso
            v_next_delay_hours := COALESCE(
                (v_seq.steps->v_next_step->>'delay_hours')::NUMERIC,
                0
            );
            v_new_status := 'running';
            UPDATE sequence_executions
            SET current_step              = v_next_step,
                next_step_scheduled_for   = NOW() + (v_next_delay_hours * INTERVAL '1 hour'),
                messages_sent             = messages_sent + 1,
                last_step_at              = NOW(),
                last_error                = NULL,
                updated_at                = NOW()
            WHERE id = p_execution_id;
        END IF;
    ELSE
        -- Fallo: incrementar retry o abandonar
        IF v_exec.messages_failed >= 2 THEN
            -- 3 fallos consecutivos → abandonar
            v_new_status := 'abandoned';
            UPDATE sequence_executions
            SET status           = 'abandoned',
                last_error       = p_error_msg,
                messages_failed  = messages_failed + 1,
                updated_at       = NOW()
            WHERE id = p_execution_id;
        ELSE
            -- Reintentar en 1 hora
            v_new_status := 'running';
            UPDATE sequence_executions
            SET next_step_scheduled_for = NOW() + INTERVAL '1 hour',
                messages_failed         = messages_failed + 1,
                last_error              = p_error_msg,
                updated_at              = NOW()
            WHERE id = p_execution_id;
        END IF;
    END IF;

    RETURN v_new_status;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION advance_sequence_step IS
    'Avanza un paso de secuencia. Si es el último, marca completed. Si falla 3 veces, marca abandoned.';


-- ============================================================
-- DATOS INICIALES: secuencias de marketing estándar
-- ============================================================

-- Actualizar la secuencia de onboarding existente con la estructura correcta
UPDATE sequences
SET steps = '[
  {"delay_hours": 0,   "template_name": "onboarding-welcome-default",  "description": "Bienvenida inmediata"},
  {"delay_hours": 2,   "template_name": "onboarding-deposit-invite",   "description": "Invitación a depositar"},
  {"delay_hours": 24,  "template_name": "onboarding-platform-guide",   "description": "Guía de la plataforma"},
  {"delay_hours": 72,  "template_name": "onboarding-first-bonus",      "description": "Primer bono D+3"},
  {"delay_hours": 168, "template_name": "onboarding-check-in",         "description": "Check in D+7"}
]'::JSONB,
cooldown_hours = 0,
max_runs_per_contact = 1
WHERE name = 'onboarding-flow-default';

-- Secuencia: Reactivación (ladder de 4 pasos)
INSERT INTO sequences (
    name, description, active, type,
    trigger_event, trigger_delay_seconds,
    cooldown_hours, max_runs_per_contact,
    steps
) VALUES (
    'reactivation-ladder',
    'Secuencia de reactivación para contactos inactivos D+3',
    true,
    'retention',
    'inactivity_3d',
    0,
    168,   -- cooldown 7 días entre ejecuciones
    4,     -- max 4 veces por contacto
    '[
      {"delay_hours": 0,   "template_name": "retention-inactive-7d",   "offer": "10% recarga",     "description": "Te echamos de menos"},
      {"delay_hours": 48,  "template_name": "retention-offer-medium",  "offer": "20% recarga",     "description": "Oferta mejorada D+2"},
      {"delay_hours": 96,  "template_name": "retention-offer-strong",  "offer": "30% + giro",      "description": "Oferta fuerte D+4"},
      {"delay_hours": 168, "template_name": "retention-last-chance",   "offer": "oferta final 48h","description": "Última oportunidad D+7"}
    ]'::JSONB
) ON CONFLICT (name) DO UPDATE
    SET steps = EXCLUDED.steps,
        cooldown_hours = EXCLUDED.cooldown_hours,
        updated_at = NOW();

COMMIT;
