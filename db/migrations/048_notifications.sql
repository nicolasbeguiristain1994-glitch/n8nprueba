-- Migration 048: Módulo de Notificaciones internas
-- Tablas: notifications (bandeja), notification_preferences (preferencias por usuario)
-- Seguro de re-ejecutar (IF NOT EXISTS en todo).

-- ── Tabla principal: notifications ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Tipo de notificación (valores fijos)
  type         TEXT        NOT NULL
               CHECK (type IN (
                 'tarea_asignada',
                 'tarea_estado',
                 'mensaje_nuevo',
                 'campana_finalizada',
                 'alerta_operativa'
               )),

  title        TEXT        NOT NULL,
  body         TEXT,

  -- Link al recurso relacionado (ruta interna, e.g. '/tareas?id=...')
  link         TEXT,

  -- Recurso relacionado para lookup rápido
  related_type TEXT,        -- 'task' | 'conversation' | 'campaign' | 'line'
  related_id   TEXT,        -- UUID o teléfono según el tipo

  -- Estado
  is_read      BOOLEAN     NOT NULL DEFAULT FALSE,
  read_at      TIMESTAMPTZ,

  -- Metadatos extra (libre)
  metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices de uso frecuente
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id, created_at DESC)
  WHERE is_read = FALSE;

CREATE INDEX IF NOT EXISTS idx_notifications_user_all
  ON notifications (user_id, created_at DESC);

-- ── Tabla: notification_preferences ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id               UUID    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- Activar/desactivar por tipo
  notify_tarea_asignada   BOOLEAN NOT NULL DEFAULT TRUE,
  notify_tarea_estado     BOOLEAN NOT NULL DEFAULT TRUE,
  notify_mensaje_nuevo    BOOLEAN NOT NULL DEFAULT TRUE,
  notify_campana          BOOLEAN NOT NULL DEFAULT TRUE,
  notify_alerta_operativa BOOLEAN NOT NULL DEFAULT TRUE,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
