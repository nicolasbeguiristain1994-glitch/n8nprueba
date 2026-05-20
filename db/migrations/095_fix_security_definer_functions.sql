-- ============================================================
-- Migration 095: Fijar search_path en funciones SECURITY DEFINER
-- ============================================================
-- Las funciones con SECURITY DEFINER ejecutan con los privilegios
-- del dueño de la función, no del invocador. Sin un search_path fijo,
-- un atacante con acceso a schema creation podría hacer schema injection
-- (privilege escalation).
--
-- Corrección: agregar SET search_path = public, pg_temp a las 5
-- funciones creadas en migraciones 064 y 065.
--
-- Esta migración usa un bloque DO con EXECUTE porque:
--   1. Las funciones de LANGUAGE sql validan referencias a tablas en el
--      momento de la creación, no en ejecución. Si warmup_phases aún no
--      existe (migración 064 no aplicada), un CREATE OR REPLACE directo
--      falla con "relation does not exist".
--   2. El bloque DO permite verificar prerequisitos y saltar
--      graciosamente en lugar de abortar.
--
-- Si este entorno no tiene warmup_phases, las funciones se crearán
-- directamente desde 064/065 (que deben incluir el fix). Ver nota
-- al final del archivo.
-- ============================================================

DO $migration$
DECLARE
  has_warmup_phases         BOOLEAN;
  has_warmup_health_history BOOLEAN;
BEGIN

  SELECT EXISTS(
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'warmup_phases'
  ) INTO has_warmup_phases;

  SELECT EXISTS(
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'warmup_health_history'
  ) INTO has_warmup_health_history;

  -- ── Guard principal ──────────────────────────────────────────────────────
  IF NOT has_warmup_phases THEN
    RAISE NOTICE
      'Migration 095: warmup_phases no existe en este entorno — '
      'omitiendo (las funciones se crearán con search_path correcto '
      'al ejecutar las migraciones 064 y 065).';
    RETURN;
  END IF;


  -- ============================================================
  -- 1. get_active_warmup_lines()  — LANGUAGE sql  (migración 064)
  --    LANGUAGE sql valida tablas al crear → requiere EXECUTE.
  -- ============================================================
  EXECUTE $f1$
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
    SET search_path = public, pg_temp
    AS $f1_body$
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
    $f1_body$;
  $f1$;

  EXECUTE 'COMMENT ON FUNCTION get_active_warmup_lines() IS
    $c$Retorna líneas activas con su configuración de fase calculada. Reemplaza GET warmup_numbers + lógica de fase en n8n.$c$';

  EXECUTE 'GRANT EXECUTE ON FUNCTION get_active_warmup_lines() TO service_role, authenticated';


  -- ============================================================
  -- 2. warmup_record_activity() v1 — LANGUAGE plpgsql (migración 064)
  --    plpgsql no valida tablas al crear → CREATE OR REPLACE directo.
  -- ============================================================
  EXECUTE $f2$
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
    SET search_path = public, pg_temp
    AS $f2_body$
    BEGIN
      INSERT INTO warmup_activity_log (
        warmup_number_id, phone_number, recipient,
        message_type, message_preview, status, warmup_day
      ) VALUES (
        p_warmup_number_id, p_phone_number, p_recipient,
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
        UPDATE warmup_numbers
        SET
          messages_sent_today = messages_sent_today + 1,
          last_message_at     = NOW(),
          updated_at          = NOW()
        WHERE id = p_warmup_number_id;

        UPDATE warmup_contacts
        SET
          message_count = COALESCE(message_count, 0) + 1,
          last_used_at  = NOW()
        WHERE id = p_contact_id;
      ELSE
        UPDATE warmup_numbers
        SET
          warmup_status = CASE WHEN p_is_banned THEN 'banned' ELSE warmup_status END,
          updated_at    = NOW()
        WHERE id = p_warmup_number_id;
      END IF;
    END;
    $f2_body$;
  $f2$;

  EXECUTE 'GRANT EXECUTE ON FUNCTION warmup_record_activity(UUID,UUID,TEXT,TEXT,TEXT,TEXT,INT,BOOLEAN,BOOLEAN) TO service_role';


  -- ============================================================
  -- 3. warmup_daily_reset() — LANGUAGE plpgsql (migración 064)
  -- ============================================================
  EXECUTE $f3$
    CREATE OR REPLACE FUNCTION warmup_daily_reset()
    RETURNS JSON
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $f3_body$
    DECLARE
      v_completed   INT;
      v_incremented INT;
    BEGIN
      UPDATE warmup_numbers
      SET
        warmup_status       = 'completed',
        messages_sent_today = 0,
        updated_at          = NOW()
      WHERE warmup_status = 'active'
        AND current_day >= target_days;
      GET DIAGNOSTICS v_completed = ROW_COUNT;

      UPDATE warmup_numbers
      SET
        current_day         = current_day + 1,
        messages_sent_today = 0,
        updated_at          = NOW()
      WHERE warmup_status = 'active'
        AND current_day < target_days;
      GET DIAGNOSTICS v_incremented = ROW_COUNT;

      RETURN json_build_object(
        'completed',   v_completed,
        'incremented', v_incremented,
        'executed_at', NOW()
      );
    END;
    $f3_body$;
  $f3$;

  EXECUTE 'GRANT EXECUTE ON FUNCTION warmup_daily_reset() TO service_role';


  -- ============================================================
  -- 4 & 5. get_line_health_data() y warmup_record_activity v2
  --         dependen de warmup_health_history (migración 061).
  -- ============================================================
  IF NOT has_warmup_health_history THEN
    RAISE NOTICE
      'Migration 095: warmup_health_history no existe — '
      'omitiendo get_line_health_data y warmup_record_activity v2 '
      '(migración 061 no aplicada).';
    RETURN;
  END IF;


  -- ============================================================
  -- 4. get_line_health_data(UUID) — LANGUAGE sql (migración 065)
  -- ============================================================
  EXECUTE $f4$
    CREATE OR REPLACE FUNCTION get_line_health_data(p_warmup_number_id UUID)
    RETURNS JSON
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $f4_body$
      SELECT json_build_object(
        'sent_7d',
            COUNT(*) FILTER (WHERE status = 'sent'),
        'failed_7d',
            COUNT(*) FILTER (WHERE status = 'failed'),
        'banned_7d',
            COUNT(*) FILTER (WHERE status IN ('banned') OR error_type = 'permanent_ban'),
        'errors_24h',
            COUNT(*) FILTER (WHERE status IN ('failed','banned')
                               AND sent_at > NOW() - INTERVAL '24 hours'),
        'errors_6h',
            COUNT(*) FILTER (WHERE status IN ('failed','banned')
                               AND sent_at > NOW() - INTERVAL '6 hours'),
        'total_7d',      COUNT(*),
        'last_sent_at',  MAX(sent_at) FILTER (WHERE status = 'sent'),
        'last_error_at', MAX(sent_at) FILTER (WHERE status IN ('failed','banned'))
      )
      FROM warmup_activity_log
      WHERE warmup_number_id = p_warmup_number_id
        AND sent_at          > NOW() - INTERVAL '7 days';
    $f4_body$;
  $f4$;

  EXECUTE 'GRANT EXECUTE ON FUNCTION get_line_health_data(UUID) TO service_role';


  -- ============================================================
  -- 5. warmup_record_activity() v2 — LANGUAGE plpgsql (migración 065)
  -- ============================================================
  EXECUTE $f5$
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
    SET search_path = public, pg_temp
    AS $f5_body$
    DECLARE
      v_messages_sent INT;
    BEGIN
      -- ── 1. Log de actividad ───────────────────────────────────────────────
      INSERT INTO warmup_activity_log (
        warmup_number_id, phone_number, recipient,
        message_type, message_preview, status, warmup_day, error_type
      ) VALUES (
        p_warmup_number_id, p_phone_number, p_recipient, p_message_type,
        LEFT(COALESCE(p_message_preview, ''), 180),
        CASE
          WHEN p_success                          THEN 'sent'
          WHEN p_is_banned
            OR p_error_type = 'permanent_ban'    THEN 'banned'
          ELSE                                        'failed'
        END,
        p_warmup_day,
        CASE WHEN NOT p_success THEN p_error_type ELSE NULL END
      );

      IF p_success THEN
        -- ── 2a. Contador + health en warmup_numbers ───────────────────────
        UPDATE warmup_numbers
        SET
          messages_sent_today = messages_sent_today + 1,
          last_message_at     = NOW(),
          health_score        = COALESCE(p_health_score, health_score),
          health_updated_at   = CASE WHEN p_health_score IS NOT NULL THEN NOW() ELSE health_updated_at END,
          updated_at          = NOW()
        WHERE id = p_warmup_number_id
        RETURNING messages_sent_today INTO v_messages_sent;

        -- ── 2b. Estadísticas del contacto ─────────────────────────────────
        UPDATE warmup_contacts
        SET
          message_count = COALESCE(message_count, 0) + 1,
          last_used_at  = NOW()
        WHERE id = p_contact_id;

        -- ── 2c. Snapshot health history ───────────────────────────────────
        IF p_health_score IS NOT NULL THEN
          INSERT INTO warmup_health_history (
            warmup_number_id, score, components, daily_quota, messages_sent
          ) VALUES (
            p_warmup_number_id,
            p_health_score,
            COALESCE(p_health_components, '{}'::JSONB),
            p_daily_quota,
            COALESCE(v_messages_sent, 0)
          );
        END IF;

      ELSE
        -- ── 3. Error: actualizar status y health ──────────────────────────
        UPDATE warmup_numbers
        SET
          warmup_status     = CASE
                                WHEN p_is_banned OR p_error_type = 'permanent_ban'
                                THEN 'banned'
                                ELSE warmup_status
                              END,
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
    $f5_body$;
  $f5$;

  EXECUTE 'GRANT EXECUTE ON FUNCTION warmup_record_activity(UUID,UUID,TEXT,TEXT,TEXT,TEXT,INT,BOOLEAN,BOOLEAN,INT,JSONB,TEXT,INT) TO service_role';

  RAISE NOTICE 'Migration 095: completada — search_path fijado en 5 funciones SECURITY DEFINER.';

END;
$migration$;


-- ============================================================
-- NOTA PARA ENTORNOS DONDE 064/065 AÚN NO SE EJECUTARON:
-- ============================================================
-- Esta migración se saltea graciosamente si warmup_phases no existe.
-- Las funciones afectadas se crean desde 064 y 065.
-- Para que esos entornos queden correctos, editar los archivos:
--
--   db/migrations/064_warmup_phases.sql
--   db/migrations/065_warmup_health_rpc.sql
--
-- y agregar en cada CREATE OR REPLACE FUNCTION:
--
--   SECURITY DEFINER
--   SET search_path = public, pg_temp   ← agregar esta línea
--   AS $$
--
-- Luego agregar 060-065 al runner (run-migrations.mjs) y ejecutarlos.
-- ============================================================


-- ============================================================
-- Verificación (ejecutar manualmente en Supabase SQL Editor):
-- ============================================================
-- SELECT
--   proname                    AS function_name,
--   prosecdef                  AS security_definer,
--   proconfig                  AS config   -- debe incluir search_path=public, pg_temp
-- FROM pg_proc p
-- JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public'
--   AND p.prosecdef = true
-- ORDER BY proname;
