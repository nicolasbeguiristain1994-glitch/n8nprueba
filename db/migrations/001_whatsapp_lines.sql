-- ============================================================
-- Migration 001: whatsapp_lines + line_metrics
-- Fecha: 2026-04-13
-- Propósito: Soporte de hasta 30 líneas WhatsApp simultáneas
--            con rate limiting, routing por región y health tracking.
-- ============================================================

BEGIN;

-- ============================================================
-- TABLA: whatsapp_lines
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_lines (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Identificación
    line_key             VARCHAR(20) NOT NULL UNIQUE,  -- 'line_01' .. 'line_30'
    display_name         VARCHAR(100),
    phone_number         VARCHAR(20),                  -- E.164, se rellena tras conectar QR

    -- Evolution API
    evolution_instance   VARCHAR(100) NOT NULL UNIQUE, -- nombre de instancia en Evolution API
    evolution_url        VARCHAR(255) NOT NULL,         -- base URL: http://evolution:8080

    -- Estado de conexión
    status               VARCHAR(20) NOT NULL DEFAULT 'active',
    -- active | paused | error | offline | maintenance
    is_connected         BOOLEAN NOT NULL DEFAULT false,
    last_seen_at         TIMESTAMPTZ,
    session_qr_url       VARCHAR(500),                 -- URL del QR para vincular

    -- Rate limiting
    msg_per_hour         INT NOT NULL DEFAULT 50,      -- mensajes/hora permitidos
    msg_per_day          INT NOT NULL DEFAULT 500,     -- mensajes/día permitidos
    msgs_sent_hour       INT NOT NULL DEFAULT 0,       -- contador ventana actual
    msgs_sent_today      INT NOT NULL DEFAULT 0,       -- contador día actual
    hour_reset_at        TIMESTAMPTZ,                  -- cuándo se reinicia el contador hora
    day_reset_at         TIMESTAMPTZ,                  -- cuándo se reinicia el contador día

    -- Routing
    priority             INT NOT NULL DEFAULT 5,       -- 1=alta prioridad, 10=baja
    allowed_types        JSONB NOT NULL DEFAULT '["campaign","chatbot","sequence"]'::JSONB,
    assigned_region      VARCHAR(10),                  -- AR | BR | MX | UY | null=cualquiera

    -- Estadísticas acumuladas (se resetean diariamente vía WF-016)
    total_sent           BIGINT NOT NULL DEFAULT 0,
    total_failed         BIGINT NOT NULL DEFAULT 0,
    total_delivered      BIGINT NOT NULL DEFAULT 0,

    -- Auditoría
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE whatsapp_lines IS 'Pool de líneas WhatsApp disponibles (hasta 30). Cada línea es una instancia de Evolution API.';
COMMENT ON COLUMN whatsapp_lines.line_key IS 'Identificador corto: line_01 .. line_30';
COMMENT ON COLUMN whatsapp_lines.evolution_instance IS 'Nombre de instancia en Evolution API (debe coincidir exactamente)';
COMMENT ON COLUMN whatsapp_lines.status IS 'active|paused|error|offline|maintenance';
COMMENT ON COLUMN whatsapp_lines.priority IS '1=máxima prioridad de selección, 10=mínima';
COMMENT ON COLUMN whatsapp_lines.allowed_types IS 'Tipos de mensaje permitidos: campaign, chatbot, sequence';
COMMENT ON COLUMN whatsapp_lines.assigned_region IS 'Código ISO país o NULL para aceptar cualquier región';
COMMENT ON COLUMN whatsapp_lines.msg_per_hour IS 'Rate limit por hora. Evolution API / WhatsApp recomienda ≤ 50/h por número nuevo';

CREATE INDEX IF NOT EXISTS idx_lines_status_active ON whatsapp_lines(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_lines_region ON whatsapp_lines(assigned_region, status);
CREATE INDEX IF NOT EXISTS idx_lines_priority ON whatsapp_lines(priority, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_lines_connected ON whatsapp_lines(is_connected) WHERE is_connected = true;

-- Constraint: line_key debe ser line_01 .. line_30
ALTER TABLE whatsapp_lines
    ADD CONSTRAINT chk_line_key_format
    CHECK (line_key ~ '^line_[0-3][0-9]$');

-- Constraint: status válido
ALTER TABLE whatsapp_lines
    ADD CONSTRAINT chk_line_status
    CHECK (status IN ('active', 'paused', 'error', 'offline', 'maintenance'));

-- Constraint: priority en rango
ALTER TABLE whatsapp_lines
    ADD CONSTRAINT chk_line_priority
    CHECK (priority BETWEEN 1 AND 10);

-- Trigger updated_at (reutiliza función existente del schema base)
CREATE TRIGGER trg_whatsapp_lines_updated_at
    BEFORE UPDATE ON whatsapp_lines
    FOR EACH ROW EXECUTE FUNCTION update_timestamp();


-- ============================================================
-- TABLA: line_metrics
-- ============================================================

CREATE TABLE IF NOT EXISTS line_metrics (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    line_id         UUID NOT NULL REFERENCES whatsapp_lines(id) ON DELETE CASCADE,
    metric_date     DATE NOT NULL,

    msgs_sent       INT NOT NULL DEFAULT 0,
    msgs_delivered  INT NOT NULL DEFAULT 0,
    msgs_failed     INT NOT NULL DEFAULT 0,
    msgs_read       INT NOT NULL DEFAULT 0,

    -- Tasas calculadas al cierre del día
    delivery_rate   DECIMAL(5,2),   -- % delivered / sent
    error_rate      DECIMAL(5,2),   -- % failed / sent

    -- Health del día
    downtime_minutes INT NOT NULL DEFAULT 0,
    reconnects       INT NOT NULL DEFAULT 0,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (line_id, metric_date)
);

COMMENT ON TABLE line_metrics IS 'Métricas diarias por línea WhatsApp. Una fila por línea por día.';

CREATE INDEX IF NOT EXISTS idx_line_metrics_date ON line_metrics(metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_line_metrics_line_date ON line_metrics(line_id, metric_date DESC);

CREATE TRIGGER trg_line_metrics_updated_at
    BEFORE UPDATE ON line_metrics
    FOR EACH ROW EXECUTE FUNCTION update_timestamp();


-- ============================================================
-- VISTA: v_line_status (para dashboards y WF-013)
-- ============================================================

CREATE OR REPLACE VIEW v_line_status AS
SELECT
    l.id,
    l.line_key,
    l.display_name,
    l.phone_number,
    l.evolution_instance,
    l.status,
    l.is_connected,
    l.last_seen_at,
    l.priority,
    l.assigned_region,
    l.msg_per_hour,
    l.msg_per_day,
    l.msgs_sent_hour,
    l.msgs_sent_today,
    ROUND(100.0 * l.msgs_sent_hour  / NULLIF(l.msg_per_hour, 0), 1) AS hour_capacity_pct,
    ROUND(100.0 * l.msgs_sent_today / NULLIF(l.msg_per_day,  0), 1) AS day_capacity_pct,
    (l.msg_per_hour  - l.msgs_sent_hour)  AS remaining_hour,
    (l.msg_per_day   - l.msgs_sent_today) AS remaining_day,
    lm.msgs_sent    AS today_sent,
    lm.msgs_failed  AS today_failed,
    lm.error_rate   AS today_error_rate
FROM whatsapp_lines l
LEFT JOIN line_metrics lm
    ON l.id = lm.line_id AND lm.metric_date = CURRENT_DATE;

COMMENT ON VIEW v_line_status IS 'Estado en tiempo real de todas las líneas con capacidad restante y métricas del día';


-- ============================================================
-- FUNCIÓN: get_available_line(p_region, p_type)
-- Retorna la mejor línea disponible para un envío.
-- Usada por WF-012 como fallback si Redis no está disponible.
-- ============================================================

CREATE OR REPLACE FUNCTION get_available_line(
    p_region VARCHAR DEFAULT NULL,
    p_type   VARCHAR DEFAULT 'campaign'
)
RETURNS TABLE (
    line_id            UUID,
    line_key           VARCHAR,
    evolution_instance VARCHAR,
    evolution_url      VARCHAR,
    remaining_hour     INT,
    remaining_day      INT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        l.id,
        l.line_key,
        l.evolution_instance,
        l.evolution_url,
        (l.msg_per_hour  - l.msgs_sent_hour)  AS remaining_hour,
        (l.msg_per_day   - l.msgs_sent_today) AS remaining_day
    FROM whatsapp_lines l
    WHERE l.status = 'active'
      AND l.is_connected = true
      AND l.msgs_sent_hour  < l.msg_per_hour
      AND l.msgs_sent_today < l.msg_per_day
      AND l.allowed_types @> to_jsonb(p_type)
      AND (p_region IS NULL OR l.assigned_region IS NULL OR l.assigned_region = p_region)
    ORDER BY
        l.priority ASC,
        l.msgs_sent_hour ASC   -- menor carga primero
    LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_available_line IS 'Retorna la línea óptima disponible. WF-012 la usa como fallback si Redis no responde.';


-- ============================================================
-- FUNCIÓN: increment_line_counters(p_line_id)
-- Incrementa msgs_sent_hour y msgs_sent_today atómicamente.
-- Llama desde WF-012 después de seleccionar la línea.
-- ============================================================

CREATE OR REPLACE FUNCTION increment_line_counters(p_line_id UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE whatsapp_lines
    SET
        msgs_sent_hour  = msgs_sent_hour  + 1,
        msgs_sent_today = msgs_sent_today + 1,
        total_sent      = total_sent      + 1,
        hour_reset_at   = COALESCE(hour_reset_at, NOW() + INTERVAL '1 hour'),
        day_reset_at    = COALESCE(day_reset_at,  NOW() + INTERVAL '24 hours'),
        updated_at      = NOW()
    WHERE id = p_line_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION increment_line_counters IS 'Incrementa contadores de envío de una línea. Llamar tras selección en WF-012.';


-- ============================================================
-- FUNCIÓN: reset_line_counters_if_due()
-- Reinicia contadores vencidos. Cron cada 5min o desde WF-013.
-- ============================================================

CREATE OR REPLACE FUNCTION reset_line_counters_if_due()
RETURNS INT AS $$
DECLARE
    v_count INT;
BEGIN
    UPDATE whatsapp_lines
    SET
        msgs_sent_hour = 0,
        hour_reset_at  = NOW() + INTERVAL '1 hour',
        updated_at     = NOW()
    WHERE hour_reset_at IS NOT NULL
      AND hour_reset_at <= NOW();

    GET DIAGNOSTICS v_count = ROW_COUNT;

    UPDATE whatsapp_lines
    SET
        msgs_sent_today = 0,
        day_reset_at    = NOW() + INTERVAL '24 hours',
        updated_at      = NOW()
    WHERE day_reset_at IS NOT NULL
      AND day_reset_at <= NOW();

    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reset_line_counters_if_due IS 'Reinicia msgs_sent_hour y msgs_sent_today cuando venció el período. Llamar desde WF-013.';


-- ============================================================
-- DATOS INICIALES: 30 líneas (todas offline hasta vincular QR)
-- ============================================================

INSERT INTO whatsapp_lines (
    line_key, display_name, evolution_instance, evolution_url,
    status, is_connected, priority, msg_per_hour, msg_per_day
)
SELECT
    'line_' || LPAD(n::TEXT, 2, '0'),
    'Línea ' || LPAD(n::TEXT, 2, '0'),
    'wa-instance-' || LPAD(n::TEXT, 2, '0'),
    'http://evolution-api:8080',
    'offline',
    false,
    CASE WHEN n <= 10 THEN 1 WHEN n <= 20 THEN 2 ELSE 3 END,  -- prioridad escalonada
    50,   -- msg/hora
    500   -- msg/día
FROM generate_series(1, 30) AS n
ON CONFLICT (line_key) DO NOTHING;

COMMIT;
