-- ============================================================
-- Migration 004: Human Handoff + Conversation State
-- Fecha: 2026-04-13
-- Propósito:
--   - Tabla support_agents: agentes humanos disponibles para escalado
--   - Tabla conversation_state: estado del chatbot por contacto
--   - Función get_available_agent(): asignación de agente
--   - Función escalate_to_human(): lógica de escalado atómica
-- ============================================================

BEGIN;

-- ============================================================
-- TABLA: support_agents
-- ============================================================

CREATE TABLE IF NOT EXISTS support_agents (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(100) NOT NULL,
    email           VARCHAR(255) NOT NULL UNIQUE,
    phone           VARCHAR(20),           -- Para notificarle por WhatsApp si aplica
    slack_user_id   VARCHAR(50),           -- Para notificación por Slack
    telegram_user_id VARCHAR(50),

    -- Estado
    status          VARCHAR(20) NOT NULL DEFAULT 'offline',
    -- online | busy | away | offline
    active_chats    INT NOT NULL DEFAULT 0,
    max_chats       INT NOT NULL DEFAULT 5,    -- Máximo simultáneo

    -- Horario (UTC)
    shift_start     TIME,                  -- '09:00' → solo recibe de 9am
    shift_end       TIME,                  -- '18:00'
    timezone        VARCHAR(50) DEFAULT 'America/Argentina/Buenos_Aires',

    -- Auditoría
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE support_agents IS 'Agentes humanos de soporte para escalado desde chatbot';
COMMENT ON COLUMN support_agents.active_chats IS 'Conversaciones activas asignadas actualmente';
COMMENT ON COLUMN support_agents.max_chats IS 'Máximo de chats simultáneos antes de marcarse como busy';

CREATE INDEX IF NOT EXISTS idx_agents_status ON support_agents(status) WHERE status IN ('online','busy');

CREATE TRIGGER trg_support_agents_updated_at
    BEFORE UPDATE ON support_agents
    FOR EACH ROW EXECUTE FUNCTION update_timestamp();


-- ============================================================
-- TABLA: conversation_state
-- Estado del chatbot para cada número de teléfono activo.
-- Una fila por conversación abierta (resolved_at IS NULL).
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_state (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    contact_id       UUID REFERENCES contacts(id) ON DELETE SET NULL,
    phone_number     VARCHAR(20) NOT NULL,
    line_id          UUID REFERENCES whatsapp_lines(id) ON DELETE SET NULL,

    -- Estado del flujo del chatbot
    current_intent   VARCHAR(100),          -- Último intent detectado
    current_flow     VARCHAR(100),          -- Flujo activo: 'menu', 'bonus', 'deposit'
    step_in_flow     INT NOT NULL DEFAULT 0,
    awaiting_input   BOOLEAN NOT NULL DEFAULT false,
    input_type       VARCHAR(50),           -- 'text' | 'number' | 'option'
    input_options    JSONB,                 -- Opciones válidas si input_type='option': ["SI","NO"]

    -- Escalado a humano
    is_escalated     BOOLEAN NOT NULL DEFAULT false,
    assigned_agent_id UUID REFERENCES support_agents(id) ON DELETE SET NULL,
    escalated_at     TIMESTAMPTZ,
    escalation_reason VARCHAR(255),

    -- Ventana de contexto (últimos 10 mensajes para el agente)
    context          JSONB NOT NULL DEFAULT '[]'::JSONB,

    -- Contadores de intención desconocida (para auto-escalar)
    unknown_intent_count INT NOT NULL DEFAULT 0,

    -- Timestamps
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at      TIMESTAMPTZ,           -- NULL = conversación abierta
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE conversation_state IS 'Estado del chatbot por número. Una fila por conversación activa (resolved_at IS NULL).';
COMMENT ON COLUMN conversation_state.awaiting_input IS 'Si true, el próximo mensaje del contacto es la respuesta esperada';
COMMENT ON COLUMN conversation_state.context IS 'Últimos 10 mensajes [{role, text, ts}] para contexto del agente';
COMMENT ON COLUMN conversation_state.unknown_intent_count IS 'Intenciones no reconocidas seguidas. Si >= 2, escalar a humano';

-- Solo una conversación activa por teléfono
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_state_active_phone
    ON conversation_state(phone_number)
    WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conv_state_contact  ON conversation_state(contact_id);
CREATE INDEX IF NOT EXISTS idx_conv_state_escalated ON conversation_state(is_escalated, last_activity_at DESC)
    WHERE is_escalated = true AND resolved_at IS NULL;

CREATE TRIGGER trg_conversation_state_updated_at
    BEFORE UPDATE ON conversation_state
    FOR EACH ROW EXECUTE FUNCTION update_timestamp();


-- ============================================================
-- FUNCIÓN: get_available_agent()
-- Retorna el agente disponible con menor carga.
-- ============================================================

CREATE OR REPLACE FUNCTION get_available_agent()
RETURNS TABLE (
    agent_id       UUID,
    agent_name     VARCHAR,
    slack_user_id  VARCHAR,
    active_chats   INT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        a.id,
        a.name,
        a.slack_user_id,
        a.active_chats
    FROM support_agents a
    WHERE a.status = 'online'
      AND a.active_chats < a.max_chats
      -- Verificar horario de turno si está configurado
      AND (
          a.shift_start IS NULL
          OR (NOW() AT TIME ZONE a.timezone)::TIME BETWEEN a.shift_start AND a.shift_end
      )
    ORDER BY a.active_chats ASC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_available_agent IS 'Retorna el agente online con menor carga y dentro de su horario.';


-- ============================================================
-- FUNCIÓN: escalate_to_human(phone, reason, context_json)
-- Marca la conversación como escalada y asigna agente si hay uno.
-- Retorna el agente asignado (o NULL si no hay disponible).
-- ============================================================

CREATE OR REPLACE FUNCTION escalate_to_human(
    p_phone   VARCHAR,
    p_reason  VARCHAR DEFAULT 'user_requested',
    p_context JSONB   DEFAULT '[]'::JSONB
)
RETURNS TABLE (
    conv_id       UUID,
    agent_id      UUID,
    agent_name    VARCHAR,
    slack_user_id VARCHAR,
    queued        BOOLEAN   -- true si no había agente disponible
) AS $$
DECLARE
    v_conv   conversation_state%ROWTYPE;
    v_agent  RECORD;
BEGIN
    -- Buscar o crear conversación activa
    SELECT * INTO v_conv
    FROM conversation_state
    WHERE phone_number = p_phone AND resolved_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO conversation_state (phone_number, is_escalated, escalated_at, escalation_reason, context)
        VALUES (p_phone, true, NOW(), p_reason, p_context)
        RETURNING * INTO v_conv;
    ELSE
        UPDATE conversation_state
        SET is_escalated       = true,
            escalated_at       = NOW(),
            escalation_reason  = p_reason,
            context            = p_context,
            awaiting_input     = false,
            updated_at         = NOW()
        WHERE id = v_conv.id;
    END IF;

    -- Intentar asignar agente
    SELECT * INTO v_agent FROM get_available_agent();

    IF FOUND THEN
        UPDATE conversation_state
        SET assigned_agent_id = v_agent.agent_id
        WHERE id = v_conv.id;

        UPDATE support_agents
        SET active_chats = active_chats + 1,
            status = CASE WHEN active_chats + 1 >= max_chats THEN 'busy' ELSE status END,
            updated_at = NOW()
        WHERE id = v_agent.agent_id;

        RETURN QUERY SELECT v_conv.id, v_agent.agent_id, v_agent.agent_name, v_agent.slack_user_id, false;
    ELSE
        RETURN QUERY SELECT v_conv.id, NULL::UUID, NULL::VARCHAR, NULL::VARCHAR, true;
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION escalate_to_human IS 'Escala una conversación a humano. Asigna agente si hay disponible, sino encola. Retorna datos del agente o queued=true.';


-- ============================================================
-- FUNCIÓN: resolve_conversation(phone, agent_id)
-- Cierra la conversación y libera el slot del agente.
-- ============================================================

CREATE OR REPLACE FUNCTION resolve_conversation(
    p_phone    VARCHAR,
    p_agent_id UUID DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    UPDATE conversation_state
    SET resolved_at = NOW(),
        updated_at  = NOW()
    WHERE phone_number = p_phone
      AND resolved_at IS NULL;

    -- Liberar slot del agente
    IF p_agent_id IS NOT NULL THEN
        UPDATE support_agents
        SET active_chats = GREATEST(0, active_chats - 1),
            status = CASE WHEN status = 'busy' AND active_chats - 1 < max_chats THEN 'online' ELSE status END,
            updated_at = NOW()
        WHERE id = p_agent_id;
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION resolve_conversation IS 'Cierra una conversación y decrementa active_chats del agente asignado.';


-- ============================================================
-- DATOS INICIALES: un agente de ejemplo
-- ============================================================

INSERT INTO support_agents (name, email, slack_user_id, status, max_chats, shift_start, shift_end)
VALUES
    ('Soporte 1', 'soporte1@platform.local', 'UXXXXXXXX1', 'offline', 5, '09:00', '18:00'),
    ('Soporte 2', 'soporte2@platform.local', 'UXXXXXXXX2', 'offline', 5, '09:00', '18:00')
ON CONFLICT (email) DO NOTHING;

COMMIT;
