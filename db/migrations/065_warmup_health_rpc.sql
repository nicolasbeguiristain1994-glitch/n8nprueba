-- ============================================================
-- Migration 065: Health Score Activo + Anti-Ban Inteligente v2
-- ============================================================
-- Extiende el sistema de warmup para calcular, persistir y actuar
-- sobre el Health Score de cada línea durante el envío, no solo
-- como un reporte diario.
--
-- Cambios:
--   - warmup_activity_log.error_type: clasificación fina de errores
--   - get_line_health_data():         agrega historial 7d para cálculo de score en n8n
--   - warmup_record_activity() v2:    acepta health_score, health_components, error_type,
--                                     persiste en warmup_numbers + warmup_health_history
--
-- Compatibilidad:
--   Los nuevos parámetros de warmup_record_activity() tienen DEFAULT NULL/0,
--   por lo que la llamada anterior (sin health_score) sigue funcionando.
-- ============================================================


-- ============================================================
-- 1. Extender warmup_activity_log con clasificación de error
-- ============================================================
ALTER TABLE warmup_activity_log
  ADD COLUMN IF NOT EXISTS error_type TEXT
    CHECK (
      error_type IS NULL
      OR error_type IN ('permanent_ban','temporary_block','rate_limited','network_error')
    );

COMMENT ON COLUMN warmup_activity_log.error_type IS
  'Clasificación fina del error: permanent_ban | temporary_block | rate_limited | network_error. NULL para envíos exitosos.';

CREATE INDEX IF NOT EXISTS idx_warmup_log_error_type
  ON warmup_activity_log (warmup_number_id, error_type)
  WHERE error_type IS NOT NULL;


-- ============================================================
-- 2. RPC: get_line_health_data(p_warmup_number_id)
-- ============================================================
-- Agrega estadísticas de warmup_activity_log de los últimos 7 días
-- para una línea específica. El Code node de n8n usa este resultado
-- para calcular el Health Score (0-100) y aplicar overrides adaptativos
-- de delay y daily_limit.
--
-- Retorna JSON con:
--   sent_7d, failed_7d, banned_7d  → conteos por resultado
--   errors_24h, errors_6h          → errores recientes (para burst penalty)
--   total_7d                       → total de intentos en la ventana
--   last_sent_at, last_error_at    → timestamps del último evento por tipo
-- ============================================================
CREATE OR REPLACE FUNCTION get_line_health_data(p_warmup_number_id UUID)
RETURNS JSON
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT json_build_object(
    'sent_7d',       COUNT(*)    FILTER (WHERE status = 'sent'),
    'failed_7d',     COUNT(*)    FILTER (WHERE status = 'failed'),
    'banned_7d',     COUNT(*)    FILTER (WHERE status IN ('banned') OR error_type = 'permanent_ban'),
    'errors_24h',    COUNT(*)    FILTER (WHERE status IN ('failed','banned')
                                           AND sent_at > NOW() - INTERVAL '24 hours'),
    'errors_6h',     COUNT(*)    FILTER (WHERE status IN ('failed','banned')
                                           AND sent_at > NOW() - INTERVAL '6 hours'),
    'total_7d',      COUNT(*),
    'last_sent_at',  MAX(sent_at) FILTER (WHERE status = 'sent'),
    'last_error_at', MAX(sent_at) FILTER (WHERE status IN ('failed','banned'))
  )
  FROM warmup_activity_log
  WHERE warmup_number_id = p_warmup_number_id
    AND sent_at          > NOW() - INTERVAL '7 days';
$$;

COMMENT ON FUNCTION get_line_health_data(UUID) IS
  'Agrega stats de los últimos 7 días para calcular el Health Score en n8n. 1 llamada Supabase → datos completos.';


-- ============================================================
-- 3. RPC: warmup_record_activity() v2
-- ============================================================
-- Reemplaza la versión de 064 con soporte para:
--   p_health_score      → actualiza warmup_numbers.health_score
--   p_health_components → guarda el desglose en warmup_health_history
--   p_error_type        → clasifica el error en warmup_activity_log
--   p_daily_quota       → registra el cupo adaptado en warmup_health_history
--
-- Comportamiento en errores:
--   permanent_ban  → warmup_status = 'banned'
--   temporary_block → warmup_status no cambia (el health_score bajo frenará envíos)
--   rate_limited   → warmup_status no cambia (idem)
--   network_error  → warmup_status no cambia
--
-- Compatibilidad hacia atrás:
--   Todos los parámetros nuevos tienen DEFAULT, la firma anterior sigue válida.
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
  p_is_banned         BOOLEAN DEFAULT false,
  p_health_score      INT     DEFAULT NULL,
  p_health_components JSONB   DEFAULT NULL,
  p_error_type        TEXT    DEFAULT NULL,
  p_daily_quota       INT     DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_messages_sent INT;
BEGIN
  -- ── 1. Log de actividad ─────────────────────────────────────────────────
  INSERT INTO warmup_activity_log (
    warmup_number_id,
    phone_number,
    recipient,
    message_type,
    message_preview,
    status,
    warmup_day,
    error_type
  ) VALUES (
    p_warmup_number_id,
    p_phone_number,
    p_recipient,
    p_message_type,
    LEFT(COALESCE(p_message_preview, ''), 180),
    CASE
      WHEN p_success                             THEN 'sent'
      WHEN p_is_banned
        OR p_error_type = 'permanent_ban'        THEN 'banned'
      ELSE                                            'failed'
    END,
    p_warmup_day,
    CASE WHEN NOT p_success THEN p_error_type ELSE NULL END
  );

  IF p_success THEN
    -- ── 2a. Incrementar contador y actualizar health en warmup_numbers ───
    UPDATE warmup_numbers
    SET
      messages_sent_today = messages_sent_today + 1,
      last_message_at     = NOW(),
      health_score        = COALESCE(p_health_score,  health_score),
      health_updated_at   = CASE WHEN p_health_score IS NOT NULL THEN NOW() ELSE health_updated_at END,
      updated_at          = NOW()
    WHERE id = p_warmup_number_id
    RETURNING messages_sent_today INTO v_messages_sent;

    -- ── 2b. Actualizar estadísticas del contacto ─────────────────────────
    UPDATE warmup_contacts
    SET
      message_count = COALESCE(message_count, 0) + 1,
      last_used_at  = NOW()
    WHERE id = p_contact_id;

    -- ── 2c. Snapshot en warmup_health_history (solo si recibimos el score) ──
    IF p_health_score IS NOT NULL THEN
      INSERT INTO warmup_health_history (
        warmup_number_id,
        score,
        components,
        daily_quota,
        messages_sent
      ) VALUES (
        p_warmup_number_id,
        p_health_score,
        COALESCE(p_health_components, '{}'::JSONB),
        p_daily_quota,
        COALESCE(v_messages_sent, 0)
      );
    END IF;

  ELSE
    -- ── 3. En error: actualizar status y health ──────────────────────────
    UPDATE warmup_numbers
    SET
      -- Ban permanente cambia el status; los demás tipos NO (el score bajo los frena)
      warmup_status     = CASE
                            WHEN p_is_banned OR p_error_type = 'permanent_ban' THEN 'banned'
                            ELSE warmup_status
                          END,
      -- En error no mejoramos el score: tomamos el menor entre el calculado y el actual
      health_score      = CASE
                            WHEN p_health_score IS NOT NULL
                            THEN GREATEST(0, LEAST(p_health_score, health_score))
                            ELSE health_score
                          END,
      health_updated_at = CASE WHEN p_health_score IS NOT NULL THEN NOW() ELSE health_updated_at END,
      updated_at        = NOW()
    WHERE id = p_warmup_number_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION warmup_record_activity(UUID,UUID,TEXT,TEXT,TEXT,TEXT,INT,BOOLEAN,BOOLEAN,INT,JSONB,TEXT,INT) IS
  'v2: registra actividad + actualiza health_score + persiste en warmup_health_history. Backward-compatible con v1.';


-- ============================================================
-- 4. Grants
-- ============================================================
GRANT EXECUTE ON FUNCTION get_line_health_data(UUID)
  TO service_role;

GRANT EXECUTE ON FUNCTION warmup_record_activity(UUID,UUID,TEXT,TEXT,TEXT,TEXT,INT,BOOLEAN,BOOLEAN,INT,JSONB,TEXT,INT)
  TO service_role;
