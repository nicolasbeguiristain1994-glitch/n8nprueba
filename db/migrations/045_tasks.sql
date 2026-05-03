-- Migration 045: Módulo de Tareas
-- Tablas: tasks (tarea principal), task_assignees (asignación multi-operador),
-- task_logs (historial de cambios de estado y acciones).

-- ── Tabla principal: tasks ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tasks (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Datos del trabajo
  title            TEXT        NOT NULL,
  description      TEXT,
  type             TEXT        NOT NULL DEFAULT 'otro'
                               CHECK (type IN (
                                 'difusion', 'envio_manual', 'calentamiento',
                                 'atencion', 'seguimiento', 'revision', 'otro'
                               )),
  priority         TEXT        NOT NULL DEFAULT 'media'
                               CHECK (priority IN ('alta', 'media', 'baja')),
  status           TEXT        NOT NULL DEFAULT 'pendiente'
                               CHECK (status IN (
                                 'pendiente', 'en_progreso', 'completada', 'cancelada'
                               )),

  -- Fechas
  due_date         TIMESTAMPTZ,
  scheduled_at     TIMESTAMPTZ,

  -- Integración con otros módulos (JSONB flexible):
  -- Difusión:   { campaign_id, list_id }
  -- Envío:      { contact_ids: [] }
  -- Calentamiento: { line_ids: [] }
  -- Atención:   { conversation_filters: { status, tags } }
  -- Seguimiento: { contact_id, campaign_id, conversation_phone }
  related_data     JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- Notas adicionales del administrador
  notes            TEXT,

  -- Auditoría de creación
  created_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Completado
  completed_at     TIMESTAMPTZ,
  completed_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
  completion_notes TEXT,

  -- Cancelado
  cancelled_at     TIMESTAMPTZ,
  cancelled_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason    TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date   ON tasks (due_date) WHERE due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks (created_by, created_at DESC);

-- ── Tabla: task_assignees (operadores asignados a la tarea) ───────────────────

CREATE TABLE IF NOT EXISTS task_assignees (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_task_assignees_task ON task_assignees (task_id);
CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees (user_id, task_id);

-- ── Tabla: task_logs (historial de cambios de estado y eventos) ───────────────

CREATE TABLE IF NOT EXISTS task_logs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  user_name   TEXT,                  -- snapshot del nombre en el momento del evento
  action      TEXT        NOT NULL,  -- 'creada'|'asignada'|'iniciada'|'completada'|'cancelada'|'editada'
  from_status TEXT,
  to_status   TEXT,
  comment     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_logs_user ON task_logs (user_id, created_at DESC);
