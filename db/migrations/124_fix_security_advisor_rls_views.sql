-- ============================================================
-- Migration 124: Cerrar los 21 errores del Security Advisor
-- ============================================================
-- El Security Advisor de Supabase (splinter) reporta dos familias
-- de errores en el schema public:
--
--   1. rls_disabled_in_public  — 17 tablas sin RLS. Todas tienen
--      GRANT ALL para anon y authenticated (default privileges de
--      Supabase), así que hoy la anon key puede leer y escribir
--      sobre ellas vía PostgREST. Incluye rbac_audit_log (20k filas
--      de auditoría), tickets/ticket_notes/ticket_events,
--      prospect_lists/prospect_list_members (30k filas) y 5 tablas
--      _backup_segment_* con ~225k filas de contactos cada una.
--
--   2. security_definer_view — 3 vistas creadas sin security_invoker.
--      Una vista sin esa opción se evalúa con los permisos de su
--      dueño (postgres), por lo que atraviesa el RLS de sus tablas
--      base: la anon key puede leer contacts, whatsapp_lines y
--      métricas de mensajes a través de v_contacts_active_detailed,
--      v_latest_messages_by_contact y v_line_status aunque esas
--      tablas sí tengan RLS activado desde la migración 032.
--
-- La corrección mantiene la estrategia de 032 y 094: RLS activado
-- sin policies. La anon key queda bloqueada; el backend usa conexión
-- directa a PostgreSQL como postgres (dueño de las tablas), que no
-- se ve afectado por RLS. Ninguna de estas tablas ni vistas se
-- consume vía PostgREST: la app sólo usa supabase-js para Storage
-- (frontend/app/api/upload/route.ts) y los workflows de n8n pegan a
-- rest/v1 únicamente contra tablas de warmup con la service_role key,
-- que ignora RLS.
--
-- Igual que en 094, cada objeto se modifica condicionalmente (bloque
-- DO + EXECUTE) porque ALTER TABLE / ALTER VIEW no soportan IF EXISTS
-- y no todos los entornos tienen todas las tablas.
--
-- No se crean policies intencionalmente. Ver migración 032.
-- ============================================================


-- ── 1. RLS en las 17 tablas que quedaron afuera ──────────────────────────
DO $$
DECLARE
  t      TEXT;
  tables TEXT[] := ARRAY[

    -- Backups de segmentación (snapshots de contacts, ~225k filas c/u)
    '_backup_segment_20260809',
    '_backup_segment_pre_bet30',
    '_backup_segment_pre_fix_divisor',
    '_backup_segment_pre_mayo',
    '_backup_segment_pre_sync',

    -- Tracking de migraciones (scripts/ops/run-migrations.mjs)
    '_migrations',

    -- Cloud WhatsApp API (nombres reales, distintos de los de 094)
    'cloud_numbers',
    'cloud_sync_state',

    -- Permisos por línea
    'line_grants',

    -- Calendario de marketing (db/migrations/marketing_calendar.sql)
    'marketing_calendar',

    -- Listas de difusión (migraciones 096-097)
    'prospect_lists',
    'prospect_list_members',

    -- Auditoría RBAC (migración 017)
    'rbac_audit_log',

    -- Reportes de envío (migración 090)
    'sending_reports',

    -- Módulo de tickets (migración 022)
    'tickets',
    'ticket_notes',
    'ticket_events'

  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (
      SELECT 1 FROM pg_tables
      WHERE schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    ELSE
      RAISE NOTICE 'Migration 124: tabla %  no existe en este entorno — omitida.', t;
    END IF;
  END LOOP;
END;
$$;


-- ── 2. security_invoker en las 3 vistas ──────────────────────────────────
-- Con security_invoker = true la vista se evalúa con los permisos y el
-- RLS del rol que la consulta. postgres sigue viendo todo (es dueño de
-- las tablas base); anon y authenticated quedan cortados por el RLS de
-- contacts / whatsapp_lines / line_metrics.
DO $$
DECLARE
  v     TEXT;
  views TEXT[] := ARRAY[
    'v_contacts_active_detailed',    -- db/schema/init.sql:708
    'v_latest_messages_by_contact',  -- db/schema/init.sql:694
    'v_line_status'                  -- db/migrations/092_whatsapp_lines_cloud_schema.sql:10
  ];
BEGIN
  FOREACH v IN ARRAY views LOOP
    IF EXISTS (
      SELECT 1 FROM pg_views
      WHERE schemaname = 'public' AND viewname = v
    ) THEN
      EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', v);
    ELSE
      RAISE NOTICE 'Migration 124: vista %  no existe en este entorno — omitida.', v;
    END IF;
  END LOOP;
END;
$$;


-- ============================================================
-- Verificación: debe devolver 0 filas en ambos casos.
-- Copiar y ejecutar en el SQL Editor de Supabase.
-- ============================================================
-- -- Tablas de public sin RLS:
-- SELECT c.relname
-- FROM pg_class c
-- JOIN pg_namespace n ON n.oid = c.relnamespace
-- WHERE n.nspname = 'public'
--   AND c.relkind IN ('r', 'p')
--   AND NOT c.relrowsecurity
-- ORDER BY 1;
--
-- -- Vistas de public sin security_invoker:
-- SELECT c.relname
-- FROM pg_class c
-- JOIN pg_namespace n ON n.oid = c.relnamespace
-- WHERE n.nspname = 'public'
--   AND c.relkind = 'v'
--   AND COALESCE((
--     SELECT option_value
--     FROM pg_options_to_table(c.reloptions)
--     WHERE option_name = 'security_invoker'
--   ), 'false') <> 'true'
-- ORDER BY 1;
