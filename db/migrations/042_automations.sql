-- Migration 042: Módulo de Automatizaciones / Bots
-- Tabla principal de automatizaciones y logs de ejecución.
-- conversation_state ya existe (migration 004) — solo agregamos la columna tags.

-- ── Agregar tags a conversation_state si no existe ────────────────────────────
ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

-- ── Tabla: automations ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS automations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  description     TEXT,

  -- Tipo de automatización
  type            TEXT        NOT NULL DEFAULT 'reply'
                              CHECK (type IN ('reply', 'flow', 'handoff')),

  -- Tipo de trigger
  trigger_type    TEXT        NOT NULL DEFAULT 'keyword'
                              CHECK (trigger_type IN ('keyword', 'contains', 'any_inbound')),

  -- Configuración del trigger (JSON)
  -- reply/handoff: { keywords: string[] }
  -- any_inbound:   {}
  trigger_config  JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- Configuración de la acción (JSON)
  -- reply:   { message: string }
  -- flow:    { steps: [{message: string, delay_sec?: number}] }
  -- handoff: { message?: string }
  action_config   JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- Estado
  is_active       BOOLEAN     NOT NULL DEFAULT true,

  -- Prioridad: menor número = mayor prioridad (se evalúan en orden)
  priority        INT         NOT NULL DEFAULT 100,

  -- Auditoría
  created_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automations_active
  ON automations (priority ASC, created_at ASC)
  WHERE is_active = true;

-- ── Tabla: automation_logs ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS automation_logs (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id       UUID        REFERENCES automations(id) ON DELETE SET NULL,
  automation_name     TEXT,       -- snapshotear nombre en momento de ejecución
  conversation_phone  TEXT        NOT NULL,
  message_id          UUID        REFERENCES whatsapp_messages(id) ON DELETE SET NULL,
  result              TEXT        NOT NULL DEFAULT 'executed'
                                  CHECK (result IN ('executed', 'skipped', 'error')),
  details             TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automation_logs_automation ON automation_logs (automation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_logs_phone      ON automation_logs (conversation_phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_logs_message    ON automation_logs (message_id);

-- ── Datos iniciales de ejemplo ────────────────────────────────────────────────

INSERT INTO automations (name, description, type, trigger_type, trigger_config, action_config, is_active, priority)
VALUES
  (
    'Respuesta: precio / info',
    'Responde automáticamente cuando alguien consulta por precios o información.',
    'reply',
    'contains',
    '{"keywords": ["precio", "info", "información", "costo", "tarifa"]}'::jsonb,
    '{"message": "Hola {{nombre}}! Gracias por contactarnos. Un asesor se comunicará con vos a la brevedad con toda la información. 😊"}'::jsonb,
    false,
    10
  ),
  (
    'Handoff: solicitud de asesor humano',
    'Deriva a humano cuando el cliente solicita hablar con un asesor.',
    'handoff',
    'contains',
    '{"keywords": ["asesor", "humano", "agente", "persona", "hablar con alguien", "operador"]}'::jsonb,
    '{"message": "Entendido, {{nombre}}! Te estamos conectando con un asesor. En breve alguien del equipo se comunicará contigo. 🙏"}'::jsonb,
    false,
    5
  )
ON CONFLICT DO NOTHING;
