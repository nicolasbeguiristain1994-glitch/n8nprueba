-- ============================================================
-- Migration 094: Habilitar RLS en tablas creadas después de 032
-- ============================================================
-- La migración 032 habilitó RLS en las tablas principales con la
-- estrategia deliberada de "RLS activado, sin policies": la anon key
-- queda bloqueada completamente, el backend (conexión directa a
-- PostgreSQL) no se ve afectado.
--
-- Desde entonces se crearon ~40 tablas nuevas que nunca recibieron
-- el mismo tratamiento. Esta migración cierra esa brecha aplicando
-- exactamente la misma estrategia a todas ellas.
--
-- Cada tabla se habilita condicionalmente (IF EXISTS en pg_tables)
-- para que la migración sea segura incluso si alguna tabla aún no
-- fue creada en este entorno. ALTER TABLE nativo no soporta IF EXISTS,
-- por eso se usa un bloque DO con EXECUTE.
--
-- No se crean policies intencionalmente. Ver migración 032.
-- ============================================================

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[

    -- ── Cloud WhatsApp API (migraciones 067-069, 089-090, 092) ──────────
    'cloud_numbers',
    'cloud_conversations',
    'cloud_messages',
    'cloud_opt_outs',
    'cloud_stop_keywords',
    'cloud_sync_state',
    'cloud_webhook_subscriptions',
    'cloud_consent_log',

    -- ── Sistema de Warmup (warmup-schema.sql + 061-064) ─────────────────
    'warmup_numbers',
    'warmup_activity_log',
    'warmup_contacts',
    'warmup_phases',
    'warmup_alerts',
    'warmup_health_history',
    'warmup_effectiveness_snapshots',

    -- ── Automatizaciones y Conversaciones ───────────────────────────────
    'automations',
    'automation_logs',
    'conversation_notes',
    'conversation_state',

    -- ── Prospectos, Players y CRM ────────────────────────────────────────
    'players',
    'prospects',
    'prospect_import_batches',
    'deals',

    -- ── Contactos extendido ──────────────────────────────────────────────
    'contact_frequency_rules',
    'contact_priority_scores',
    'contact_send_history',
    'operator_contact_visibility',
    'phone_line_assignments',

    -- ── Notificaciones ───────────────────────────────────────────────────
    'notifications',
    'notification_preferences',

    -- ── Soporte y Tareas ─────────────────────────────────────────────────
    'support_agents',
    'tasks',
    'task_logs',
    'task_assignees',

    -- ── Sistema y Configuración ──────────────────────────────────────────
    'app_settings',
    'blacklist',
    'anti_ban_profiles',
    'system_jobs',
    'recompute_runs',
    'throughout'

  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (
      SELECT 1 FROM pg_tables
      WHERE schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END;
$$;


-- ============================================================
-- Verificación: tablas del schema public con su estado RLS.
-- Copiar y ejecutar en Supabase SQL Editor para confirmar.
-- Las tablas con rls_enabled = false son las que aún no existen
-- en este entorno (sus migraciones creadoras no se ejecutaron).
-- ============================================================
-- SELECT
--   tablename,
--   rowsecurity      AS rls_enabled,
--   forcerowsecurity AS rls_forced
-- FROM pg_tables
-- WHERE schemaname = 'public'
-- ORDER BY
--   rls_enabled ASC,
--   tablename   ASC;
