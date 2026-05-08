-- ============================================================
-- Migration 064: Warmup Config-Driven Phases + RPCs
-- ============================================================
-- Crea la tabla warmup_phases y 3 funciones RPC que consolidan
-- llamadas HTTP individuales, reduciendo el tráfico a Supabase
-- >60% durante los ciclos de calentamiento.
--
-- Cambios vs. estado anterior:
--   - warmup_phases:       tabla de configuración de fases (antes hard-coded en n8n)
--   - get_active_warmup_lines(): reemplaza GET warmup_numbers + lookup de fase en JS
--   - warmup_record_activity():  reemplaza POST log + PATCH counter + PATCH contact (3→1)
--   - warmup_daily_reset():      reemplaza N PATCHs individuales con 2 UPDATEs batch
-- ============================================================

-- ============================================================
-- 1. Tabla de configuración de fases
-- ============================================================
CREATE TABLE IF NOT EXISTS warmup_phases (
  id                 SERIAL      PRIMARY KEY,
  phase_number       INT         NOT NULL,
  day_start          INT         NOT NULL CHECK (day_start >= 1),
  day_end            INT         NOT NULL CHECK (day_end >= day_start),
  daily_limit        INT         NOT NULL CHECK (daily_limit > 0),
  min_delay_seconds  INT         NOT NULL CHECK (min_delay_seconds >= 0),
  max_delay_seconds  INT         NOT NULL CHECK (max_delay_seconds >= min_delay_seconds),
  message_type       TEXT        NOT NULL DEFAULT 'text' CHECK (message_type IN ('text','emoji','rich')),
  description        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  warmup_phases IS 'Configuración de fases del warmup. Límites, delays y tipo de mensaje. Editar aquí en lugar de en el workflow.';
COMMENT ON COLUMN warmup_phases.day_start         IS 'Primer día de warmup incluido en la fase (>=1)';
COMMENT ON COLUMN warmup_phases.day_end           IS 'Último día de warmup incluido (usar 999 para "infinito")';
COMMENT ON COLUMN warmup_phases.daily_limit       IS 'Máximo de mensajes permitidos por día para esta fase';
COMMENT ON COLUMN warmup_phases.min_delay_seconds IS 'Delay mínimo (segundos) antes de enviar — simula comportamiento humano';
COMMENT ON COLUMN warmup_phases.max_delay_seconds IS 'Delay máximo (segundos) — el workflow elige un valor aleatorio en [min, max] con jitter ±10%%';

-- Datos iniciales — equivalentes a las 4 fases hard-coded en WF-010 original
INSERT INTO warmup_phases (phase_number, day_start, day_end, daily_limit, min_delay_seconds, max_delay_seconds, message_type, description)
VALUES
  (1,  1,   3,  10,  30,  60, 'text',  'Fase inicial  — texto simple sin emoji, delay alto para no levantar alertas'),
  (2,  4,   7,  20,  20,  45, 'emoji', 'Fase básica   — incorpora emojis simples, delay moderado'),
  (3,  8,  14,  50,  10,  30, 'emoji', 'Fase media    — mensajes conversacionales, delay bajo'),
  (4, 15, 999, 100,   5,  20, 'rich',  'Fase madura   — mensajes largos y ricos, delay mínimo, límite alto');

CREATE UNIQUE INDEX IF NOT EXISTS uq_warmup_phases_number ON warmup_phases (phase_number);
CREATE INDEX        IF NOT EXISTS idx_warmup_phases_range  ON warmup_phases (day_start, day_end);


-- ============================================================
-- 2. RPC: get_active_warmup_lines()
-- ============================================================
-- JOIN warmup_numbers + warmup_phases en una sola llamada.
-- El orquestador n8n llama esto en lugar de:
--   GET /rest/v1/warmup_numbers?warmup_status=eq.active   (1 call)
--   + cálculo de fase en JavaScript                        (0 calls → movido a SQL)
-- Retorna líneas ordenadas por las que menos mensajes enviaron hoy primero.
-- ============================================================
CREATE OR REPLACE FUNCTION get_active_warmup_lines()
RETURNS TABLE (
  id                   UUID,
  phone_number         TEXT,
  instance_name        TEXT,
  current_day          INT,
  messages_sent_today  INT,
  last_message_at      TIMESTAMPTZ,
  target_days          INT,
  phase_number         INT,
  daily_limit          INT,
  min_delay_seconds    INT,
  max_delay_seconds    INT,
  message_type         TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    wn.id,
    wn.phone_number::TEXT,
    wn.instance_name::TEXT,
    wn.current_day,
    wn.messages_sent_today,
    wn.last_message_at,
    wn.target_days,
    wp.phase_number,
    wp.daily_limit,
    wp.min_delay_seconds,
    wp.max_delay_seconds,
    wp.message_type::TEXT
  FROM warmup_numbers wn
  JOIN warmup_phases wp
    ON wn.current_day BETWEEN wp.day_start AND wp.day_end
  WHERE wn.warmup_status = 'active'
  ORDER BY
    wn.messages_sent_today  ASC,
    wn.last_message_at      ASC NULLS FIRST;
$$;

COMMENT ON FUNCTION get_active_warmup_lines() IS
  'Retorna líneas activas con su configuración de fase calculada. Reemplaza GET warmup_numbers + lógica de fase en n8n.';


-- ============================================================
-- 3. RPC: warmup_record_activity(...)
-- ============================================================
-- Consolida 3 operaciones en 1 transacción atómica:
--   INSERT warmup_activity_log    (antes: POST /rest/v1/warmup_activity_log)
--   UPDATE warmup_numbers         (antes: PATCH /rest/v1/warmup_numbers)
--   UPDATE warmup_contacts        (antes: PATCH /rest/v1/warmup_contacts)
-- Si p_success=false y p_is_banned=true, marca la línea como 'banned'.
-- ============================================================
CREATE OR REPLACE FUNCTION warmup_record_activity(
  p_warmup_number_id  UUID,
  p_contact_id        UUID,
  p_phone_number      TEXT,
  p_recipient         TEXT,
  p_message_type      TEXT,
  p_message_preview   TEXT,
  p_warmup_day        INT,
  p_success           BOOLEAN,
  p_is_banned         BOOLEAN DEFAULT false
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Insertar registro de actividad (siempre, independiente del resultado)
  INSERT INTO warmup_activity_log (
    warmup_number_id,
    phone_number,
    recipient,
    message_type,
    message_preview,
    status,
    warmup_day
  ) VALUES (
    p_warmup_number_id,
    p_phone_number,
    p_recipient,
    p_message_type,
    LEFT(COALESCE(p_message_preview, ''), 180),
    CASE
      WHEN p_success   THEN 'sent'
      WHEN p_is_banned THEN 'banned'
      ELSE                  'failed'
    END,
    p_warmup_day
  );

  IF p_success THEN
    -- Incrementar contador de mensajes enviados hoy
    UPDATE warmup_numbers
    SET
      messages_sent_today = messages_sent_today + 1,
      last_message_at     = NOW(),
      updated_at          = NOW()
    WHERE id = p_warmup_number_id;

    -- Actualizar estadísticas del contacto receptor
    UPDATE warmup_contacts
    SET
      message_count = COALESCE(message_count, 0) + 1,
      last_used_at  = NOW()
    WHERE id = p_contact_id;

  ELSE
    -- En error: marcar ban permanente si corresponde, de lo contrario no tocar el status
    UPDATE warmup_numbers
    SET
      warmup_status = CASE WHEN p_is_banned THEN 'banned' ELSE warmup_status END,
      updated_at    = NOW()
    WHERE id = p_warmup_number_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION warmup_record_activity(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INT, BOOLEAN, BOOLEAN) IS
  'Registra actividad de warmup en 1 transacción. Reemplaza 3 llamadas HTTP separadas (log + counter + contact).';


-- ============================================================
-- 4. RPC: warmup_daily_reset()
-- ============================================================
-- Reset nocturno en 2 UPDATEs batch en lugar de N PATCHs individuales.
-- Retorna JSON con resumen para logging en n8n.
-- ============================================================
CREATE OR REPLACE FUNCTION warmup_daily_reset()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_completed   INT;
  v_incremented INT;
BEGIN
  -- Marcar como completados los que alcanzaron target_days
  UPDATE warmup_numbers
  SET
    warmup_status       = 'completed',
    messages_sent_today = 0,
    updated_at          = NOW()
  WHERE warmup_status = 'active'
    AND current_day >= target_days;
  GET DIAGNOSTICS v_completed = ROW_COUNT;

  -- Incrementar día y resetear contador para los que continúan el proceso
  UPDATE warmup_numbers
  SET
    current_day         = current_day + 1,
    messages_sent_today = 0,
    updated_at          = NOW()
  WHERE warmup_status = 'active'
    AND current_day < target_days;
  GET DIAGNOSTICS v_incremented = ROW_COUNT;

  RETURN json_build_object(
    'completed',    v_completed,
    'incremented',  v_incremented,
    'executed_at',  NOW()
  );
END;
$$;

COMMENT ON FUNCTION warmup_daily_reset() IS
  'Reset diario batch: completa los que llegaron al target + incrementa día de los demás. Reemplaza N PATCHs individuales.';


-- ============================================================
-- 5. Grants al service_role (usado por n8n vía SUPABASE_SERVICE_KEY)
-- ============================================================
GRANT EXECUTE ON FUNCTION get_active_warmup_lines()
  TO service_role, authenticated;

GRANT EXECUTE ON FUNCTION warmup_record_activity(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INT, BOOLEAN, BOOLEAN)
  TO service_role;

GRANT EXECUTE ON FUNCTION warmup_daily_reset()
  TO service_role;
